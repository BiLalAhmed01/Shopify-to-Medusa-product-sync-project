/**
 * dashboard-server.ts
 * -----------------------------------------------------------------------------
 * A small local web UI for the sync tool: connection status, a button to run a
 * sync (with the same flags the CLI takes), a live log stream, and the last
 * summary. It calls the exact same runSync()/pingShopify()/pingMedusa() used
 * by the CLI — this is a frontend for the existing engine, not a second one.
 *
 * Setup:
 *   npm run dashboard
 *   open http://localhost:5050
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { log } from "./logger.js";
import { onLine, recentLines } from "./log-bus.js";
import { runSync, type SyncOptions } from "./sync.js";
import { loadState } from "./state.js";
import { pingShopify } from "./shopify/client.js";
import { pingMedusa } from "./medusa/client.js";
import { verifyStockLocation } from "./medusa/inventory.js";
import type { SyncSummary } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

let busy = false;
let lastSummary: SyncSummary | null = null;
let lastRunFinishedAt: string | null = null;
let lastError: string | null = null;

app.get("/api/status", async (_req, res) => {
  const state = await loadState();
  res.json({
    shop: config.shopify.shop,
    medusaUrl: config.medusa.baseUrl,
    currency: config.medusa.currencyCode,
    busy,
    lastRunAt: state.lastRunAt,
    lastRunFinishedAt,
    trackedProducts: Object.keys(state.products).length,
    lastSummary,
    lastError,
  });
});

app.get("/api/check", async (_req, res) => {
  const result: Record<string, { ok: boolean; detail: string }> = {};

  try {
    result.shopify = { ok: true, detail: await pingShopify() };
  } catch (error) {
    result.shopify = { ok: false, detail: message(error) };
  }

  try {
    result.medusa = { ok: true, detail: await pingMedusa() };
  } catch (error) {
    result.medusa = { ok: false, detail: message(error) };
  }

  if (config.medusa.stockLocationId) {
    try {
      const name = await verifyStockLocation();
      result.stockLocation = { ok: true, detail: name ?? config.medusa.stockLocationId };
    } catch (error) {
      result.stockLocation = { ok: false, detail: message(error) };
    }
  } else {
    result.stockLocation = { ok: false, detail: "MEDUSA_STOCK_LOCATION_ID not set — inventory sync disabled" };
  }

  result.salesChannel = config.medusa.salesChannelId
    ? { ok: true, detail: config.medusa.salesChannelId }
    : { ok: false, detail: "MEDUSA_SALES_CHANNEL_ID not set — products won't appear in a storefront" };

  res.json(result);
});

app.post("/api/sync", (req, res) => {
  if (busy) {
    res.status(409).json({ error: "A sync is already running" });
    return;
  }

  const body = (req.body ?? {}) as Partial<SyncOptions>;
  const options: SyncOptions = {
    full: Boolean(body.full),
    dryRun: Boolean(body.dryRun),
    force: Boolean(body.force),
    limit: typeof body.limit === "number" && body.limit > 0 ? body.limit : null,
  };

  busy = true;
  lastError = null;
  res.status(202).json({ started: true, options });

  runSync(options)
    .then((summary) => {
      lastSummary = summary;
    })
    .catch((error) => {
      lastError = message(error);
      log.error("Dashboard-triggered sync failed", lastError);
    })
    .finally(() => {
      busy = false;
      lastRunFinishedAt = new Date().toISOString();
    });
});

app.get("/api/logs", (_req, res) => {
  res.json(recentLines());
});

/** Server-sent events: push new log lines to the browser as they happen. */
app.get("/api/logs/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");

  const unsubscribe = onLine((line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  });

  req.on("close", unsubscribe);
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

app.listen(config.dashboard.port, () => {
  log.info(`Dashboard listening on http://localhost:${config.dashboard.port}`);
});
