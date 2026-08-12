/**
 * medusa/inventory.ts
 * -----------------------------------------------------------------------------
 * Sync stock quantities.
 *
 * How inventory is modelled in Medusa v2 (this trips up most beginners):
 *
 *   ProductVariant  --(manage_inventory: true)-->  InventoryItem
 *   InventoryItem   --(per warehouse)---------->  InventoryLevel { stocked_quantity }
 *
 * So a quantity is never stored "on the variant". It lives on an inventory
 * level, which belongs to an inventory item, at a specific stock location.
 * That is why MEDUSA_STOCK_LOCATION_ID is required for inventory sync.
 *
 * Shopify can track stock across many locations too; here we sum Shopify's
 * total available quantity into one Medusa location, which is the right default
 * for a single-warehouse store. Multi-location mapping is noted in the README.
 */
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
        `(manage_inventory is probably false) — skipping stock update`
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

    // No level exists at this location yet — create it.
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
