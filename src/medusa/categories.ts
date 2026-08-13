// Maps Shopify collections/product type to Medusa product categories via
// find-or-create, with an in-memory cache so a 2,000-product sync across 40
// collections doesn't issue 2,000 redundant lookups.
import { medusaRequest } from "./client.js";
import { log } from "../logger.js";
import { slugify } from "../utils.js";

interface MedusaCategory {
  id: string;
  name: string;
  handle: string;
}

const cache = new Map<string, string>(); // handle -> category id

/** Loads every existing category once, so later lookups are free. */
export async function warmCategoryCache(): Promise<void> {
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await medusaRequest<{ product_categories: MedusaCategory[]; count: number }>(
      "GET",
      `/admin/product-categories?limit=${limit}&offset=${offset}`
    );
    for (const category of data.product_categories) {
      cache.set(category.handle, category.id);
    }
    offset += limit;
    if (offset >= (data.count ?? 0) || data.product_categories.length === 0) break;
  }

  log.debug(`Loaded ${cache.size} existing Medusa categories`);
}

export async function findOrCreateCategory(name: string): Promise<string | null> {
  const clean = name.trim();
  if (!clean) return null;

  const handle = slugify(clean);
  const cached = cache.get(handle);
  if (cached) return cached;

  try {
    const created = await medusaRequest<{ product_category: MedusaCategory }>(
      "POST",
      "/admin/product-categories",
      { name: clean, handle, is_active: true, is_internal: false }
    );
    cache.set(handle, created.product_category.id);
    log.info(`Created Medusa category "${clean}"`);
    return created.product_category.id;
  } catch (error) {
    // A duplicate handle means another process created it a moment ago.
    // Re-read it instead of failing the whole product.
    log.warn(`Could not create category "${clean}", trying to look it up`, String(error));
    const found = await medusaRequest<{ product_categories: MedusaCategory[] }>(
      "GET",
      `/admin/product-categories?handle=${encodeURIComponent(handle)}&limit=1`
    );
    const existing = found.product_categories?.[0];
    if (existing) {
      cache.set(handle, existing.id);
      return existing.id;
    }
    return null;
  }
}

/** Resolves a list of names to a list of Medusa category ids, skipping failures. */
export async function resolveCategoryIds(names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const id = await findOrCreateCategory(name);
    if (id) ids.push(id);
  }
  return ids;
}
