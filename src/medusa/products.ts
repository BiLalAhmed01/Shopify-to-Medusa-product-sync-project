/**
 * medusa/products.ts
 * -----------------------------------------------------------------------------
 * Create and update products in Medusa.
 *
 * The hard part of any sync is not "create a product" — it is "create it if it
 * is new, update it if it already exists, and do not duplicate anything if the
 * script runs twice". That property is called IDEMPOTENCE and it is what the
 * code below is really about.
 *
 * We identify an already-synced product in two ways, in order:
 *   1. the local state file (Shopify product id -> Medusa product id)
 *   2. the `handle`, which is unique in both systems
 * and we always write the Shopify id into `metadata` so the link survives even
 * if the state file is deleted.
 */
import { medusaRequest, HttpError } from "./client.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import type { MedusaProductPayload, MedusaVariantPayload } from "../types.js";

export interface MedusaVariant {
  id: string;
  title: string;
  sku: string | null;
  metadata?: Record<string, unknown> | null;
  inventory_items?: { inventory_item_id: string }[];
}

export interface MedusaProduct {
  id: string;
  handle: string;
  title: string;
  status: string;
  metadata?: Record<string, unknown> | null;
  variants?: MedusaVariant[];
}

const PRODUCT_FIELDS = "*variants,*variants.options,*variants.inventory_items";

export async function findProductByHandle(handle: string): Promise<MedusaProduct | null> {
  const data = await medusaRequest<{ products: MedusaProduct[] }>(
    "GET",
    `/admin/products?handle=${encodeURIComponent(handle)}&limit=1&fields=${PRODUCT_FIELDS}`
  );
  return data.products?.[0] ?? null;
}

export async function findProductById(id: string): Promise<MedusaProduct | null> {
  try {
    const data = await medusaRequest<{ product: MedusaProduct }>(
      "GET",
      `/admin/products/${id}?fields=${PRODUCT_FIELDS}`
    );
    return data.product ?? null;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

export async function createProduct(payload: MedusaProductPayload): Promise<MedusaProduct> {
  const data = await medusaRequest<{ product: MedusaProduct }>(
    "POST",
    "/admin/products",
    payload
  );
  return data.product;
}

/**
 * Updates the product-level fields. Variants are handled separately by
 * `reconcileVariants` so that we never accidentally wipe them.
 */
export async function updateProduct(
  id: string,
  payload: MedusaProductPayload
): Promise<MedusaProduct> {
  const { variants: _variants, ...productLevel } = payload;

  try {
    const data = await medusaRequest<{ product: MedusaProduct }>(
      "POST",
      `/admin/products/${id}`,
      productLevel
    );
    return data.product;
  } catch (error) {
    // Some Medusa versions reject `options` on update. Retry without it rather
    // than failing the whole product, and say so loudly in the logs.
    if (error instanceof HttpError && error.status === 400 && "options" in productLevel) {
      log.warn(
        `Update of "${payload.handle}" was rejected with options included; ` +
          `retrying without them. New option values will not appear until the ` +
          `product is recreated.`
      );
      const { options: _options, ...withoutOptions } = productLevel;
      const data = await medusaRequest<{ product: MedusaProduct }>(
        "POST",
        `/admin/products/${id}`,
        withoutOptions
      );
      return data.product;
    }
    throw error;
  }
}

/* --------------------------------------------------------------------------
 * Variant reconciliation
 * ------------------------------------------------------------------------ */

function keysFor(variant: { sku?: string | null; title?: string; metadata?: Record<string, unknown> | null }) {
  const shopifyId = variant.metadata?.["shopify_variant_id"];
  return {
    sku: variant.sku ? `sku:${variant.sku}` : null,
    shopify: typeof shopifyId === "string" ? `gid:${shopifyId}` : null,
    title: variant.title ? `title:${variant.title}` : null,
  };
}

/**
 * Makes the variants in Medusa match the variants coming from Shopify:
 * updates matches, creates new ones, and removes variants that we previously
 * created but that no longer exist in Shopify.
 *
 * Note the safety rule on deletion: we only delete a variant if *we* created it
 * (it carries a `shopify_variant_id` in metadata). Variants a merchant added by
 * hand in Medusa are left alone.
 */
export async function reconcileVariants(
  productId: string,
  existing: MedusaVariant[],
  desired: MedusaVariantPayload[]
): Promise<{ created: number; updated: number; deleted: number }> {
  const index = new Map<string, MedusaVariant>();
  for (const variant of existing) {
    const keys = keysFor(variant);
    for (const key of [keys.shopify, keys.sku, keys.title]) {
      if (key && !index.has(key)) index.set(key, variant);
    }
  }

  const matchedIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const variant of desired) {
    const keys = keysFor(variant);
    const match =
      (keys.shopify && index.get(keys.shopify)) ||
      (keys.sku && index.get(keys.sku)) ||
      (keys.title && index.get(keys.title)) ||
      null;

    if (match) {
      matchedIds.add(match.id);
      await medusaRequest("POST", `/admin/products/${productId}/variants/${match.id}`, variant);
      updated++;
    } else {
      await medusaRequest("POST", `/admin/products/${productId}/variants`, variant);
      created++;
    }
  }

  for (const variant of existing) {
    if (matchedIds.has(variant.id)) continue;
    const ownedByUs = typeof variant.metadata?.["shopify_variant_id"] === "string";
    if (!ownedByUs) {
      log.debug(`Leaving manually-created Medusa variant "${variant.title}" untouched`);
      continue;
    }
    await medusaRequest("DELETE", `/admin/products/${productId}/variants/${variant.id}`);
    deleted++;
  }

  return { created, updated, deleted };
}

/** Changes only the status field (used when a product is deleted in Shopify). */
export async function setProductStatus(
  id: string,
  status: "published" | "draft"
): Promise<void> {
  await medusaRequest("POST", `/admin/products/${id}`, { status });
}

/** Re-reads a product so we get the ids of freshly created variants. */
export async function reloadProduct(id: string): Promise<MedusaProduct> {
  const product = await findProductById(id);
  if (!product) throw new Error(`Medusa product ${id} disappeared after write`);
  return product;
}

export function salesChannelPayload(): { id: string }[] | undefined {
  return config.medusa.salesChannelId ? [{ id: config.medusa.salesChannelId }] : undefined;
}
