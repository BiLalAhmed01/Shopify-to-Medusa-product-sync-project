// Syncs stock quantities.
//
// Medusa v2's inventory chain: ProductVariant (manage_inventory: true) ->
// InventoryItem -> InventoryLevel { stocked_quantity } per stock location.
// A quantity is never stored directly on the variant, which is why
// MEDUSA_STOCK_LOCATION_ID is required here. Shopify's per-location
// quantities are summed into that one Medusa location (single-warehouse
// default; see README for multi-location).
import { medusaRequest, HttpError } from "./client.js";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { MedusaVariant } from "./products.js";

/**
 * Sets the stocked quantity for one variant.
 * Tries to update an existing level first, then falls back to creating one.
 */
export async function setVariantStock(
  variant: MedusaVariant,
  quantity: number
): Promise<boolean> {
  const locationId = config.medusa.stockLocationId;
  if (!locationId) return false;

  const inventoryItemId = variant.inventory_items?.[0]?.inventory_item_id;
  if (!inventoryItemId) {
    log.debug(
      `Variant ${variant.title} has no inventory item ` +
        `(manage_inventory is probably false) - skipping stock update`
    );
    return false;
  }

  const safeQuantity = Math.max(0, Math.round(quantity));

  try {
    await medusaRequest(
      "POST",
      `/admin/inventory-items/${inventoryItemId}/location-levels/${locationId}`,
      { stocked_quantity: safeQuantity }
    );
    return true;
  } catch (error) {
    const notFound = error instanceof HttpError && (error.status === 404 || error.status === 400);
    if (!notFound) throw error;

    // No level exists at this location yet - create it.
    await medusaRequest(
      "POST",
      `/admin/inventory-items/${inventoryItemId}/location-levels`,
      { location_id: locationId, stocked_quantity: safeQuantity }
    );
    return true;
  }
}

/** Confirms the configured stock location actually exists. Used by `check`. */
export async function verifyStockLocation(): Promise<string | null> {
  const locationId = config.medusa.stockLocationId;
  if (!locationId) return null;
  const data = await medusaRequest<{ stock_location: { id: string; name: string } }>(
    "GET",
    `/admin/stock-locations/${locationId}`
  );
  return data.stock_location?.name ?? null;
}
