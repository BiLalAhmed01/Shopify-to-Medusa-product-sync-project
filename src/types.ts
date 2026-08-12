/**
 * types.ts
 * -----------------------------------------------------------------------------
 * The shape of the data we read from Shopify and the shape we send to Medusa.
 * Writing these down is what makes the mapper safe to change later.
 */

/* ------------------------------- Shopify -------------------------------- */

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

export interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;                 // Shopify returns money as a string: "19.99"
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
  inventoryPolicy: "DENY" | "CONTINUE";
  selectedOptions: { name: string; value: string }[];
  inventoryItem: {
    id: string;
    tracked: boolean;
    measurement?: { weight?: { value: number; unit: string } | null } | null;
  } | null;
}

export interface ShopifyProduct {
  id: string;                    // "gid://shopify/Product/12345"
  handle: string;
  title: string;
  descriptionHtml: string | null;
  productType: string | null;
  vendor: string | null;
  status: "ACTIVE" | "ARCHIVED" | "DRAFT";
  tags: string[];
  updatedAt: string;
  featuredImage: ShopifyImage | null;
  images: { nodes: ShopifyImage[] };
  collections: { nodes: { id: string; title: string; handle: string }[] };
  options: { id: string; name: string; position: number; optionValues: { name: string }[] }[];
  variants: {
    nodes: ShopifyVariant[];
    pageInfo: { hasNextPage: boolean };
  };
}

/* -------------------------------- Medusa -------------------------------- */

export interface MedusaPrice {
  currency_code: string;
  amount: number;
}

export interface MedusaVariantPayload {
  id?: string;                   // present only when updating an existing variant
  title: string;
  sku?: string | null;
  barcode?: string | null;
  manage_inventory: boolean;
  allow_backorder: boolean;
  weight?: number | null;        // grams
  options: Record<string, string>;
  prices: MedusaPrice[];
  metadata?: Record<string, unknown>;
}

export interface MedusaProductPayload {
  title: string;
  handle: string;
  description?: string;
  status: "published" | "draft";
  thumbnail?: string | null;
  images?: { url: string }[];
  options: { title: string; values: string[] }[];
  variants: MedusaVariantPayload[];
  tags?: { value: string }[];
  category_ids?: string[];
  sales_channels?: { id: string }[];
  metadata?: Record<string, unknown>;
}

/** What we store on disk so the next run knows what already exists. */
export interface SyncStateEntry {
  medusaProductId: string;
  handle: string;
  shopifyUpdatedAt: string;
  lastSyncedAt: string;
}

export interface SyncState {
  lastRunAt: string | null;
  products: Record<string, SyncStateEntry>;   // key = Shopify product GID
}

export interface SyncSummary {
  scanned: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: { handle: string; message: string }[];
}
