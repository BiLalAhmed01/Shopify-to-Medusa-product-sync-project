/**
 * mapper.ts
 * -----------------------------------------------------------------------------
 * THE most important file to review.
 *
 * Everything else is plumbing; this is the business logic — the field-by-field
 * translation from Shopify's model to Medusa's model. Keeping it in one pure
 * function (no network calls, no side effects) means you can reason about it,
 * test it with a saved Shopify JSON fixture, and change a mapping rule without
 * touching the sync engine.
 *
 * Mapping table
 * -------------------------------------------------------------------------
 *  Shopify                        Medusa
 *  -----------------------------  ----------------------------------------
 *  title                          title
 *  handle                         handle            (our join key)
 *  descriptionHtml                description       (HTML stripped to text)
 *  status ACTIVE                  status published; anything else -> draft
 *  featuredImage.url              thumbnail
 *  images.nodes[].url             images[].url
 *  collections[].title            product categories (created on demand)
 *  productType                    fallback category + metadata
 *  tags                           tags[].value
 *  options[].name/optionValues    options[].title/values
 *  variant.price                  variant.prices[0].amount
 *  variant.sku / barcode          variant.sku / barcode
 *  variant.inventoryQuantity      inventory level stocked_quantity
 *  variant.inventoryPolicy        variant.allow_backorder (CONTINUE -> true)
 *  inventoryItem.tracked          variant.manage_inventory
 *  inventoryItem.measurement      variant.weight (converted to grams)
 *  id / variant.id                metadata.shopify_id / shopify_variant_id
 */
import { config } from "./config.js";
import { htmlToText, numericIdFromGid, toGrams, toMedusaAmount } from "./utils.js";
import type {
  MedusaProductPayload,
  MedusaVariantPayload,
  ShopifyProduct,
  ShopifyVariant,
} from "./types.js";

/** Shopify's placeholder for products that have no real options. */
const DEFAULT_OPTION = "Title";
const DEFAULT_VALUE = "Default Title";

export function categoryNamesFor(product: ShopifyProduct): string[] {
  if (!config.sync.categories) return [];

  const fromCollections = product.collections.nodes.map((c) => c.title.trim()).filter(Boolean);
  if (fromCollections.length > 0) return [...new Set(fromCollections)];

  if (config.sync.productTypeAsCategory && product.productType?.trim()) {
    return [product.productType.trim()];
  }
  return [];
}

function mapVariant(
  variant: ShopifyVariant,
  productOptions: { name: string }[],
  currencyCode: string
): MedusaVariantPayload {
  // Medusa expects options as { "Size": "M", "Color": "Blue" }.
  const options: Record<string, string> = {};
  for (const selected of variant.selectedOptions) {
    options[selected.name] = selected.value;
  }
  // Products with no real options still need one option/value pair in Medusa.
  if (Object.keys(options).length === 0) {
    const fallbackName = productOptions[0]?.name ?? DEFAULT_OPTION;
    options[fallbackName] = variant.title || DEFAULT_VALUE;
  }

  const weight = toGrams(
    variant.inventoryItem?.measurement?.weight?.value,
    variant.inventoryItem?.measurement?.weight?.unit
  );

  return {
    title: variant.title || DEFAULT_VALUE,
    sku: variant.sku || null,
    barcode: variant.barcode || null,
    // If Shopify does not track the item, Medusa should treat it as always in stock.
    manage_inventory: variant.inventoryItem?.tracked ?? true,
    allow_backorder: variant.inventoryPolicy === "CONTINUE",
    weight,
    options,
    prices: [
      {
        currency_code: currencyCode,
        amount: toMedusaAmount(variant.price),
      },
    ],
    metadata: {
      shopify_variant_id: variant.id,
      shopify_variant_numeric_id: numericIdFromGid(variant.id),
      shopify_inventory_item_id: variant.inventoryItem?.id ?? null,
      // Kept for reference; wiring this into a Medusa price list is a natural
      // next step if the store runs sales.
      shopify_compare_at_price: variant.compareAtPrice ?? null,
    },
  };
}

export function mapProduct(
  product: ShopifyProduct,
  options: { currencyCode: string; categoryIds: string[] }
): MedusaProductPayload {
  const productOptions = product.options.length
    ? product.options.map((option) => ({
        title: option.name,
        values: option.optionValues.map((value) => value.name),
      }))
    : [{ title: DEFAULT_OPTION, values: [DEFAULT_VALUE] }];

  const images = product.images.nodes.map((image) => ({ url: image.url }));

  const payload: MedusaProductPayload = {
    title: product.title,
    handle: product.handle,
    description: htmlToText(product.descriptionHtml),
    status: product.status === "ACTIVE" ? "published" : "draft",
    thumbnail: product.featuredImage?.url ?? images[0]?.url ?? null,
    images,
    options: productOptions,
    variants: product.variants.nodes.map((variant) =>
      mapVariant(variant, product.options, options.currencyCode)
    ),
    tags: product.tags.map((tag) => ({ value: tag })),
    metadata: {
      source: "shopify",
      shopify_id: product.id,
      shopify_numeric_id: numericIdFromGid(product.id),
      shopify_handle: product.handle,
      shopify_updated_at: product.updatedAt,
      shopify_vendor: product.vendor ?? null,
      shopify_product_type: product.productType ?? null,
      synced_at: new Date().toISOString(),
    },
  };

  if (options.categoryIds.length) payload.category_ids = options.categoryIds;
  if (config.medusa.salesChannelId) {
    payload.sales_channels = [{ id: config.medusa.salesChannelId }];
  }

  return payload;
}

/** Total stock Shopify reports for a variant, across all its locations. */
export function stockFor(variant: ShopifyVariant): number {
  return Math.max(0, variant.inventoryQuantity ?? 0);
}
