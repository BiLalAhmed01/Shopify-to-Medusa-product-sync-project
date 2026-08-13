// Optional near-real-time listener: Shopify POSTs here on product
// create/update/delete, we verify the signature and run the same sync path
// as the CLI.
//
// Signature verification needs the RAW request body (`express.raw()`) - if
// Express parses JSON first, re-serializing changes whitespace and the HMAC
// won't match. We also reply 200 immediately and sync afterward, since
// Shopify expects a 2xx within ~5s and retries otherwise.
//
// Setup:
//   npm run webhooks
//   npx ngrok http 4000          (or deploy somewhere public)
//   In Shopify: Settings -> Notifications -> Webhooks, subscribe
//   products/create, products/update, products/delete to
//   https://<your-url>/webhooks/shopify
import crypto from "node:crypto";
import express from "express";
import { config } from "./config.js";
import { log } from "./logger.js";
import { fetchShopifyProduct } from "./shopify/products.js";
import { syncOneProduct } from "./sync.js";
import { loadState, saveState } from "./state.js";
import { findProductByHandle, setProductStatus } from "./medusa/products.js";

const app = express();

function isValidSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.shopify.webhookSecret) {
    log.warn("SHOPIFY_WEBHOOK_SECRET is not set - refusing to trust this webhook");
    return false;
  }
  if (!signature) return false;

  const digest = crypto
    .createHmac("sha256", config.shopify.webhookSecret)
    .update(rawBody)
    .digest("base64");

  // timingSafeEqual prevents an attacker from guessing the signature byte by
  // byte using response-time differences.
  const a = Buffer.from(digest);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post(
  "/webhooks/shopify",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const signature = req.get("X-Shopify-Hmac-Sha256");
    const topic = req.get("X-Shopify-Topic") ?? "unknown";

    if (!isValidSignature(req.body as Buffer, signature)) {
      log.warn(`Rejected webhook "${topic}": bad signature`);
      res.status(401).send("invalid signature");
      return;
    }

    // Acknowledge first, work second.
    res.status(200).send("ok");

    const payload = JSON.parse((req.body as Buffer).toString("utf8"));
    void handleWebhook(topic, payload).catch((error) =>
      log.error(`Webhook "${topic}" failed`, error instanceof Error ? error.message : String(error))
    );
  }
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", shop: config.shopify.shop });
});

async function handleWebhook(topic: string, payload: { id: number; handle?: string }): Promise<void> {
  const gid = `gid://shopify/Product/${payload.id}`;
  log.info(`Webhook ${topic} for ${gid}`);

  if (topic === "products/delete") {
    await unpublish(payload.handle);
    return;
  }

  // The webhook body is a slimmed-down REST-shaped product, so we re-fetch the
  // full product through GraphQL and reuse the exact same code path as the CLI.
  const product = await fetchShopifyProduct(gid);
  if (!product) {
    log.warn(`Product ${gid} no longer exists in Shopify`);
    return;
  }

  const state = await loadState();
  await syncOneProduct(product, state, config.medusa.currencyCode, { force: true });
  await saveState(state);
}

/**
 * Deleting in Shopify does not delete in Medusa - orders may reference the
 * product. Setting it to draft hides it from the storefront while keeping the
 * history intact. That is the safer default; change it if the business wants
 * hard deletes.
 */
async function unpublish(handle: string | undefined): Promise<void> {
  if (!handle) return;
  const existing = await findProductByHandle(handle);
  if (!existing) return;
  await setProductStatus(existing.id, "draft");
  log.info(`Set "${handle}" to draft in Medusa (deleted in Shopify)`);
}

app.listen(config.shopify.webhookPort, () => {
  log.info(`Webhook server listening on http://localhost:${config.shopify.webhookPort}`);
  log.info(`  POST /webhooks/shopify   GET /health`);
});
