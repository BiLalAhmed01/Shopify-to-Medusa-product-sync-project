/**
 * tools/mock-server.mjs
 * -----------------------------------------------------------------------------
 * A fake Shopify + fake Medusa in one small process, using only Node built-ins.
 *
 * Why this exists: you should be able to run and review this project without
 * owning a Shopify store or running a Postgres database. It also makes the sync
 * logic testable — the demo below proves that a second run updates instead of
 * duplicating, which is the single most important property of a sync.
 *
 *   node tools/mock-server.mjs          # listens on :7000 (Shopify) and :7001 (Medusa)
 *   npm run demo                        # starts it, runs a sync twice, prints the result
 */
import http from "node:http";

const SHOPIFY_PORT = Number(process.env.MOCK_SHOPIFY_PORT ?? 7000);
const MEDUSA_PORT = Number(process.env.MOCK_MEDUSA_PORT ?? 7001);

/* ----------------------------- fake Shopify ------------------------------ */

const now = new Date().toISOString();

const shopifyProducts = [
  {
    id: "gid://shopify/Product/1001",
    handle: "mango-ice-60ml",
    title: "Mango Ice 60ml",
    descriptionHtml: "<p>A cold mango <strong>e-liquid</strong>.</p>",
    productType: "E-Liquid",
    vendor: "Maximum Vapor",
    status: "ACTIVE",
    tags: ["fruit", "menthol"],
    updatedAt: now,
    featuredImage: { url: "https://cdn.example.com/mango-1.jpg", altText: "Mango bottle" },
    images: { nodes: [
      { url: "https://cdn.example.com/mango-1.jpg", altText: "Mango bottle" },
      { url: "https://cdn.example.com/mango-2.jpg", altText: "Mango box" },
    ] },
    collections: { nodes: [{ id: "gid://shopify/Collection/1", title: "Fruit Flavours", handle: "fruit-flavours" }] },
    options: [
      { id: "o1", name: "Nicotine", position: 1, optionValues: [{ name: "3mg" }, { name: "6mg" }] },
    ],
    variants: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "gid://shopify/ProductVariant/2001",
          title: "3mg", sku: "MI-60-3", barcode: "5060000000011",
          price: "19.99", compareAtPrice: "24.99",
          inventoryQuantity: 42, inventoryPolicy: "DENY",
          selectedOptions: [{ name: "Nicotine", value: "3mg" }],
          inventoryItem: { id: "gid://shopify/InventoryItem/3001", tracked: true, measurement: { weight: { value: 90, unit: "GRAMS" } } },
        },
        {
          id: "gid://shopify/ProductVariant/2002",
          title: "6mg", sku: "MI-60-6", barcode: "5060000000012",
          price: "19.99", compareAtPrice: null,
          inventoryQuantity: 7, inventoryPolicy: "CONTINUE",
          selectedOptions: [{ name: "Nicotine", value: "6mg" }],
          inventoryItem: { id: "gid://shopify/InventoryItem/3002", tracked: true, measurement: { weight: { value: 90, unit: "GRAMS" } } },
        },
      ],
    },
  },
  {
    id: "gid://shopify/Product/1002",
    handle: "starter-kit-pro",
    title: "Starter Kit Pro",
    descriptionHtml: "<p>Everything you need to begin.</p>",
    productType: "Hardware",
    vendor: "Maximum Vapor",
    status: "ACTIVE",
    tags: ["kit"],
    updatedAt: now,
    featuredImage: { url: "https://cdn.example.com/kit-1.jpg", altText: null },
    images: { nodes: [{ url: "https://cdn.example.com/kit-1.jpg", altText: null }] },
    collections: { nodes: [] },
    options: [{ id: "o2", name: "Title", position: 1, optionValues: [{ name: "Default Title" }] }],
    variants: {
      pageInfo: { hasNextPage: false },
      nodes: [{
        id: "gid://shopify/ProductVariant/2003",
        title: "Default Title", sku: "SKP-1", barcode: null,
        price: "34.50", compareAtPrice: null,
        inventoryQuantity: 15, inventoryPolicy: "DENY",
        selectedOptions: [{ name: "Title", value: "Default Title" }],
        inventoryItem: { id: "gid://shopify/InventoryItem/3003", tracked: true, measurement: { weight: { value: 1.2, unit: "KILOGRAMS" } } },
      }],
    },
  },
];

const shopifyServer = http.createServer(async (req, res) => {
  const body = await readBody(req);
  const query = body?.query ?? "";

  if (query.includes("ShopInfo") || query.includes("Ping")) {
    return json(res, 200, {
      data: { shop: { name: "Mock Vapor Store", currencyCode: "USD", myshopifyDomain: "mock-store.myshopify.com" } },
      extensions: { cost: { requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 998, restoreRate: 50 } } },
    });
  }

  if (query.includes("SyncProducts")) {
    return json(res, 200, {
      data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: shopifyProducts } },
      extensions: { cost: { requestedQueryCost: 30, actualQueryCost: 28, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 940, restoreRate: 50 } } },
    });
  }

  if (query.includes("SyncProduct(")) {
    const found = shopifyProducts.find((p) => p.id === body.variables?.id) ?? null;
    return json(res, 200, { data: { product: found } });
  }

  return json(res, 200, { data: {} });
});

/* ------------------------------ fake Medusa ------------------------------ */

const db = { products: [], categories: [], levels: {} };
let seq = 1;
const id = (prefix) => `${prefix}_${String(seq++).padStart(6, "0")}`;

const medusaServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const body = await readBody(req);
  const method = req.method;

  if (method === "POST" && path === "/auth/user/emailpass") {
    return json(res, 200, { token: "mock.jwt.token" });
  }
  if (method === "GET" && path === "/admin/stores") {
    return json(res, 200, { stores: [{ id: "store_01", name: "Mock Medusa Store" }] });
  }
  if (method === "GET" && path.startsWith("/admin/stock-locations/")) {
    return json(res, 200, { stock_location: { id: path.split("/").pop(), name: "Main Warehouse" } });
  }

  // categories
  if (method === "GET" && path === "/admin/product-categories") {
    const handle = url.searchParams.get("handle");
    const list = handle ? db.categories.filter((c) => c.handle === handle) : db.categories;
    return json(res, 200, { product_categories: list, count: list.length });
  }
  if (method === "POST" && path === "/admin/product-categories") {
    const existing = db.categories.find((c) => c.handle === body.handle);
    if (existing) return json(res, 400, { message: "handle already exists" });
    const category = { id: id("pcat"), name: body.name, handle: body.handle };
    db.categories.push(category);
    return json(res, 200, { product_category: category });
  }

  // products
  if (method === "GET" && path === "/admin/products") {
    const handle = url.searchParams.get("handle");
    const list = handle ? db.products.filter((p) => p.handle === handle) : db.products;
    return json(res, 200, { products: list, count: list.length });
  }
  if (method === "GET" && /^\/admin\/products\/[^/]+$/.test(path)) {
    const product = db.products.find((p) => p.id === path.split("/")[3]);
    return product ? json(res, 200, { product }) : json(res, 404, { message: "not found" });
  }
  if (method === "POST" && path === "/admin/products") {
    const product = {
      id: id("prod"),
      handle: body.handle,
      title: body.title,
      description: body.description,
      status: body.status,
      thumbnail: body.thumbnail,
      images: body.images ?? [],
      options: body.options ?? [],
      category_ids: body.category_ids ?? [],
      metadata: body.metadata ?? {},
      variants: (body.variants ?? []).map((v) => makeVariant(v)),
    };
    db.products.push(product);
    return json(res, 200, { product });
  }
  if (method === "POST" && /^\/admin\/products\/[^/]+$/.test(path)) {
    const product = db.products.find((p) => p.id === path.split("/")[3]);
    if (!product) return json(res, 404, { message: "not found" });
    Object.assign(product, { ...body, variants: product.variants });
    return json(res, 200, { product });
  }
  if (method === "POST" && /^\/admin\/products\/[^/]+\/variants$/.test(path)) {
    const product = db.products.find((p) => p.id === path.split("/")[3]);
    if (!product) return json(res, 404, { message: "not found" });
    const variant = makeVariant(body);
    product.variants.push(variant);
    return json(res, 200, { product });
  }
  if (method === "POST" && /^\/admin\/products\/[^/]+\/variants\/[^/]+$/.test(path)) {
    const [, , , productId, , variantId] = path.split("/");
    const product = db.products.find((p) => p.id === productId);
    const variant = product?.variants.find((v) => v.id === variantId);
    if (!variant) return json(res, 404, { message: "not found" });
    Object.assign(variant, body, { id: variant.id, inventory_items: variant.inventory_items });
    return json(res, 200, { product });
  }
  if (method === "DELETE" && /^\/admin\/products\/[^/]+\/variants\/[^/]+$/.test(path)) {
    const [, , , productId, , variantId] = path.split("/");
    const product = db.products.find((p) => p.id === productId);
    if (product) product.variants = product.variants.filter((v) => v.id !== variantId);
    return json(res, 200, { deleted: true });
  }

  // inventory
  if (method === "POST" && /^\/admin\/inventory-items\/[^/]+\/location-levels\/[^/]+$/.test(path)) {
    const [, , , itemId, , locationId] = path.split("/");
    const key = `${itemId}:${locationId}`;
    if (db.levels[key] === undefined) return json(res, 404, { message: "level not found" });
    db.levels[key] = body.stocked_quantity;
    return json(res, 200, { inventory_item: { id: itemId } });
  }
  if (method === "POST" && /^\/admin\/inventory-items\/[^/]+\/location-levels$/.test(path)) {
    const itemId = path.split("/")[3];
    db.levels[`${itemId}:${body.location_id}`] = body.stocked_quantity;
    return json(res, 200, { inventory_item: { id: itemId } });
  }

  return json(res, 404, { message: `no mock route for ${method} ${path}` });
});

function makeVariant(payload) {
  const inventoryItemId = id("iitem");
  return {
    id: id("variant"),
    title: payload.title,
    sku: payload.sku ?? null,
    barcode: payload.barcode ?? null,
    prices: payload.prices ?? [],
    options: payload.options ?? {},
    manage_inventory: payload.manage_inventory ?? false,
    metadata: payload.metadata ?? {},
    inventory_items: payload.manage_inventory ? [{ inventory_item_id: inventoryItemId }] : [],
  };
}

/* ------------------------------- helpers -------------------------------- */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : null); } catch { resolve(null); }
    });
  });
}

function json(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

shopifyServer.listen(SHOPIFY_PORT, () => console.log(`[mock] Shopify on :${SHOPIFY_PORT}`));
medusaServer.listen(MEDUSA_PORT, () => console.log(`[mock] Medusa  on :${MEDUSA_PORT}`));

// Let the demo script ask for a dump of what ended up "in Medusa".
process.on("SIGUSR2", () => {
  console.log("[mock] final state:", JSON.stringify({ products: db.products, levels: db.levels }, null, 2));
});
