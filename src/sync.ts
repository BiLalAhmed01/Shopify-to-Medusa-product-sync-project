// Sync engine: reads products from Shopify, decides create/update/skip,
// writes to Medusa, then updates stock levels.
//
// Per product, in order: resolve categories (must exist before the product
// references them) -> create/update the product -> reconcile variants
// (needs the product id) -> set stock levels (needs the variant ids).
import { iterateShopifyProducts } from "./shopify/products.js";
import { fetchShopCurrency } from "./shopify/client.js";
import {
  createProduct,
  findProductByHandle,
  findProductById,
  reconcileVariants,
  reloadProduct,
  updateProduct,
  type MedusaProduct,
  type MedusaVariant,
} from "./medusa/products.js";
import { resolveCategoryIds, warmCategoryCache } from "./medusa/categories.js";
import { setVariantStock } from "./medusa/inventory.js";
import { categoryNamesFor, mapProduct, stockFor } from "./mapper.js";
import { loadState, recordProduct, saveState } from "./state.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { ShopifyProduct, SyncState, SyncSummary } from "./types.js";

export interface SyncOptions {
  /** Ignore the last-run timestamp and walk the whole catalogue. */
  full?: boolean;
  /** Read from Shopify and print the plan, but write nothing to Medusa. */
  dryRun?: boolean;
  /** Re-write products even if Shopify says they have not changed. */
  force?: boolean;
  /** Stop after N products. Useful for a first smoke test. */
  limit?: number | null;
  /** Override the incremental cut-off (ISO timestamp). */
  since?: string | null;
}

export async function runSync(options: SyncOptions = {}): Promise<SyncSummary> {
  const summary: SyncSummary = {
    scanned: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const state = await loadState();

  // Capture the start time BEFORE reading anything. If a product is edited
  // while the sync runs, the next run will still pick it up. Saving the end
  // time instead would silently lose those edits.
  const runStartedAt = new Date().toISOString();

  const since = options.full ? null : options.since ?? state.lastRunAt;
  const currencyCode = config.medusa.currencyCode || (await fetchShopCurrency());

  log.info(
    `Starting ${options.full ? "FULL" : "INCREMENTAL"} sync` +
      `${options.dryRun ? " (DRY RUN - nothing will be written)" : ""}` +
      ` | currency=${currencyCode}`
  );

  if (!options.dryRun && config.sync.categories) {
    await warmCategoryCache();
  }

  for await (const product of iterateShopifyProducts({
    updatedSince: since,
    limit: options.limit ?? null,
  })) {
    summary.scanned++;
    try {
      const result = await syncOneProduct(product, state, currencyCode, options);
      if (result === "created") summary.created++;
      else if (result === "updated") summary.updated++;
      else summary.skipped++;
    } catch (error) {
      summary.failed++;
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({ handle: product.handle, message });
      // One bad product must not abort a 5,000-product import.
      log.error(`Failed to sync "${product.handle}"`, message);
    }
  }

  if (!options.dryRun) {
    state.lastRunAt = runStartedAt;
    await saveState(state);
  }

  logSummary(summary, options);
  return summary;
}

type Outcome = "created" | "updated" | "skipped";

export async function syncOneProduct(
  product: ShopifyProduct,
  state: SyncState,
  currencyCode: string,
  options: SyncOptions = {}
): Promise<Outcome> {
  const known = state.products[product.id];

  // Fast path: Shopify says nothing changed since we last wrote this product.
  if (!options.force && known && known.shopifyUpdatedAt === product.updatedAt) {
    log.debug(`Skipping "${product.handle}" - unchanged since ${known.shopifyUpdatedAt}`);
    return "skipped";
  }

  const categoryIds = options.dryRun ? [] : await resolveCategoryIds(categoryNamesFor(product));
  const payload = mapProduct(product, { currencyCode, categoryIds });

  // Find the existing Medusa product: state map first, handle as the fallback.
  let existing: MedusaProduct | null = null;
  if (known?.medusaProductId) existing = await findProductById(known.medusaProductId);
  if (!existing) existing = await findProductByHandle(product.handle);

  if (options.dryRun) {
    log.info(
      `[dry-run] would ${existing ? "UPDATE" : "CREATE"} "${product.handle}" ` +
        `(${payload.variants.length} variants, ${payload.images?.length ?? 0} images, ` +
        `categories: ${categoryNamesFor(product).join(", ") || "none"})`
    );
    return existing ? "updated" : "created";
  }

  let medusaProduct: MedusaProduct;
  let outcome: Outcome;

  if (existing) {
    await updateProduct(existing.id, payload);
    const reconciled = await reconcileVariants(
      existing.id,
      existing.variants ?? [],
      payload.variants
    );
    log.info(
      `Updated "${product.handle}" ` +
        `(variants +${reconciled.created} ~${reconciled.updated} -${reconciled.deleted})`
    );
    medusaProduct = await reloadProduct(existing.id);
    outcome = "updated";
  } else {
    medusaProduct = await createProduct(payload);
    log.info(`Created "${product.handle}" with ${payload.variants.length} variant(s)`);
    medusaProduct = await reloadProduct(medusaProduct.id);
    outcome = "created";
  }

  if (config.sync.inventory && config.medusa.stockLocationId) {
    await syncInventory(product, medusaProduct);
  }

  recordProduct(state, product.id, {
    medusaProductId: medusaProduct.id,
    handle: product.handle,
    shopifyUpdatedAt: product.updatedAt,
    lastSyncedAt: new Date().toISOString(),
  });

  return outcome;
}

/** Matches Medusa variants back to Shopify variants and pushes quantities. */
async function syncInventory(
  product: ShopifyProduct,
  medusaProduct: MedusaProduct
): Promise<void> {
  const bySku = new Map<string, number>();
  const byShopifyId = new Map<string, number>();

  for (const variant of product.variants.nodes) {
    const quantity = stockFor(variant);
    if (variant.sku) bySku.set(variant.sku, quantity);
    byShopifyId.set(variant.id, quantity);
  }

  for (const medusaVariant of medusaProduct.variants ?? []) {
    const quantity = quantityFor(medusaVariant, bySku, byShopifyId);
    if (quantity === undefined) continue;
    try {
      await setVariantStock(medusaVariant, quantity);
    } catch (error) {
      // Stock is recoverable on the next run; do not fail the whole product.
      log.warn(
        `Could not set stock for "${product.handle}" / "${medusaVariant.title}"`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}

function quantityFor(
  variant: MedusaVariant,
  bySku: Map<string, number>,
  byShopifyId: Map<string, number>
): number | undefined {
  const shopifyId = variant.metadata?.["shopify_variant_id"];
  if (typeof shopifyId === "string" && byShopifyId.has(shopifyId)) {
    return byShopifyId.get(shopifyId);
  }
  if (variant.sku && bySku.has(variant.sku)) return bySku.get(variant.sku);
  return undefined;
}

function logSummary(summary: SyncSummary, options: SyncOptions): void {
  log.info("──────────── sync summary ────────────");
  log.info(`  scanned : ${summary.scanned}`);
  log.info(`  created : ${summary.created}${options.dryRun ? " (planned)" : ""}`);
  log.info(`  updated : ${summary.updated}${options.dryRun ? " (planned)" : ""}`);
  log.info(`  skipped : ${summary.skipped}`);
  log.info(`  failed  : ${summary.failed}`);
  for (const error of summary.errors.slice(0, 10)) {
    log.error(`   ✗ ${error.handle}: ${error.message}`);
  }
  log.info("──────────────────────────────────────");
}
