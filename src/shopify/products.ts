/**
 * shopify/products.ts
 * -----------------------------------------------------------------------------
 * Pulls products out of Shopify, one page at a time.
 *
 * Two ideas worth understanding here:
 *
 * 1. CURSOR PAGINATION. Shopify never gives you "page 3". It gives you a
 *    cursor pointing at the last row you saw, and you ask for "the next N
 *    after this cursor". We loop until `hasNextPage` is false.
 *
 * 2. INCREMENTAL SYNC. The `query` argument accepts a search filter. Passing
 *    `updated_at:>2026-08-01T00:00:00Z` means Shopify only returns products
 *    that changed since the last run — which is what makes a nightly sync take
 *    seconds instead of hours.
 */
import { shopifyGraphQL } from "./client.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import type { ShopifyProduct } from "../types.js";

const PRODUCT_FIELDS = `
  id
  handle
  title
  descriptionHtml
  productType
  vendor
  status
  tags
  updatedAt
  featuredImage { url altText }
  images(first: 20) { nodes { url altText } }
  collections(first: 10) { nodes { id title handle } }
  options { id name position optionValues { name } }
  variants(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      id
      title
      sku
      barcode
      price
      compareAtPrice
      inventoryQuantity
      inventoryPolicy
      selectedOptions { name value }
      inventoryItem {
        id
        tracked
        measurement { weight { value unit } }
      }
    }
  }
`;

const PRODUCTS_QUERY = `
  query SyncProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `
  query SyncProduct($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`;

interface ProductsPage {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: ShopifyProduct[];
  };
}

export interface FetchOptions {
  /** ISO timestamp — only return products updated after this moment. */
  updatedSince?: string | null;
  /** Stop after this many products (handy while testing). */
  limit?: number | null;
}

/**
 * An async generator: the caller can `for await (const product of ...)` and we
 * fetch the next page only when it is actually needed. This keeps memory flat
 * even for a catalogue of 50,000 products.
 */
export async function* iterateShopifyProducts(
  options: FetchOptions = {}
): AsyncGenerator<ShopifyProduct> {
  let cursor: string | null = null;
  let yielded = 0;

  const filters: string[] = [];
  if (options.updatedSince) filters.push(`updated_at:>'${options.updatedSince}'`);
  const searchQuery = filters.length ? filters.join(" AND ") : null;

  if (searchQuery) log.info(`Shopify filter: ${searchQuery}`);
  else log.info("Shopify filter: none (full sync)");

  while (true) {
    const data: ProductsPage = await shopifyGraphQL<ProductsPage>(PRODUCTS_QUERY, {
      first: config.sync.pageSize,
      after: cursor,
      query: searchQuery,
    });

    for (const product of data.products.nodes) {
      if (product.variants.pageInfo.hasNextPage) {
        log.warn(
          `Product "${product.handle}" has more than 100 variants; ` +
            `only the first 100 were synced.`
        );
      }
      yield product;
      yielded++;
      if (options.limit && yielded >= options.limit) return;
    }

    if (!data.products.pageInfo.hasNextPage) return;
    cursor = data.products.pageInfo.endCursor;
    log.debug(`Fetching next Shopify page after cursor ${cursor}`);
  }
}

/** Fetch a single product — used by the webhook server. */
export async function fetchShopifyProduct(gid: string): Promise<ShopifyProduct | null> {
  const data = await shopifyGraphQL<{ product: ShopifyProduct | null }>(
    PRODUCT_BY_ID_QUERY,
    { id: gid }
  );
  return data.product;
}
