// Unit tests for mapper.ts (npm test). Pure function, no network/DB/mocks
// needed. The dynamic import below is deliberate: config.ts reads env vars
// on first import, so the fake env has to be set before that import runs.
import test from "node:test";
import assert from "node:assert/strict";
import type { ShopifyProduct } from "./types.js";

process.env.SHOPIFY_SHOP = "test.myshopify.com";
process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test";
process.env.MEDUSA_BACKEND_URL = "http://localhost:9000";
process.env.MEDUSA_ADMIN_API_KEY = "sk_test";
process.env.MEDUSA_CURRENCY_CODE = "usd";
process.env.MEDUSA_PRICE_FORMAT = "decimal";
process.env.SYNC_CATEGORIES = "true";
process.env.SYNC_PRODUCT_TYPE_AS_CATEGORY = "true";

const { mapProduct, categoryNamesFor } = await import("./mapper.js");
const { toGrams, toMedusaAmount, htmlToText, slugify } = await import("./utils.js");

function buildProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: "gid://shopify/Product/1",
    handle: "test-product",
    title: "Test Product",
    descriptionHtml: "<p>Hello <strong>world</strong></p>",
    productType: "E-Liquid",
    vendor: "Acme",
    status: "ACTIVE",
    tags: ["a", "b"],
    updatedAt: "2026-08-01T10:00:00Z",
    featuredImage: { url: "https://cdn/1.jpg", altText: null },
    images: { nodes: [{ url: "https://cdn/1.jpg", altText: null }] },
    collections: { nodes: [{ id: "c1", title: "Fruit", handle: "fruit" }] },
    options: [{ id: "o1", name: "Size", position: 1, optionValues: [{ name: "S" }, { name: "M" }] }],
    variants: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "gid://shopify/ProductVariant/11",
          title: "S",
          sku: "SKU-S",
          barcode: null,
          price: "19.99",
          compareAtPrice: "24.99",
          inventoryQuantity: 5,
          inventoryPolicy: "DENY",
          selectedOptions: [{ name: "Size", value: "S" }],
          inventoryItem: { id: "gid://shopify/InventoryItem/21", tracked: true, measurement: { weight: { value: 1, unit: "KILOGRAMS" } } },
        },
      ],
    },
    ...overrides,
  } as ShopifyProduct;
}

test("maps core product fields", () => {
  const result = mapProduct(buildProduct(), { currencyCode: "usd", categoryIds: ["pcat_1"] });

  assert.equal(result.title, "Test Product");
  assert.equal(result.handle, "test-product");
  assert.equal(result.status, "published");
  assert.equal(result.description, "Hello world");
  assert.equal(result.thumbnail, "https://cdn/1.jpg");
  assert.deepEqual(result.category_ids, ["pcat_1"]);
  assert.equal(result.metadata?.["shopify_id"], "gid://shopify/Product/1");
});

test("a non-active Shopify product becomes a Medusa draft", () => {
  const result = mapProduct(buildProduct({ status: "DRAFT" }), { currencyCode: "usd", categoryIds: [] });
  assert.equal(result.status, "draft");
});

test("maps variants with options, price and weight", () => {
  const result = mapProduct(buildProduct(), { currencyCode: "usd", categoryIds: [] });
  const variant = result.variants[0]!;

  assert.deepEqual(variant.options, { Size: "S" });
  assert.deepEqual(variant.prices, [{ currency_code: "usd", amount: 19.99 }]);
  assert.equal(variant.weight, 1000);              // 1 kg → grams
  assert.equal(variant.manage_inventory, true);
  assert.equal(variant.allow_backorder, false);    // DENY
  assert.equal(variant.metadata?.["shopify_variant_id"], "gid://shopify/ProductVariant/11");
});

test("inventoryPolicy CONTINUE enables backorders", () => {
  const product = buildProduct();
  product.variants.nodes[0]!.inventoryPolicy = "CONTINUE";
  const result = mapProduct(product, { currencyCode: "usd", categoryIds: [] });
  assert.equal(result.variants[0]!.allow_backorder, true);
});

test("a product with no options still gets a valid Medusa option", () => {
  const product = buildProduct({ options: [] });
  product.variants.nodes[0]!.selectedOptions = [];
  product.variants.nodes[0]!.title = "Default Title";

  const result = mapProduct(product, { currencyCode: "usd", categoryIds: [] });
  assert.equal(result.options[0]!.title, "Title");
  assert.deepEqual(result.variants[0]!.options, { Title: "Default Title" });
});

test("categories come from collections, falling back to product type", () => {
  assert.deepEqual(categoryNamesFor(buildProduct()), ["Fruit"]);
  assert.deepEqual(
    categoryNamesFor(buildProduct({ collections: { nodes: [] } })),
    ["E-Liquid"]
  );
});

test("price formatting avoids floating point noise", () => {
  assert.equal(toMedusaAmount("19.99"), 19.99);
  assert.equal(toMedusaAmount("0.1"), 0.1);
  assert.equal(toMedusaAmount(null), 0);
});

test("weight conversion", () => {
  assert.equal(toGrams(2, "POUNDS"), 907);
  assert.equal(toGrams(500, "GRAMS"), 500);
  assert.equal(toGrams(undefined, "GRAMS"), null);
});

test("helpers", () => {
  assert.equal(slugify("Men's T-Shirts & Tops"), "mens-t-shirts-tops");
  assert.equal(htmlToText("<p>a</p><p>b</p>"), "a\n\nb");
});
