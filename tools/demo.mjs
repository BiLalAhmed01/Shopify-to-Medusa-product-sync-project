// npm run demo - end-to-end run against mock Shopify + Medusa, no
// credentials required. Runs the real sync three times: create, then
// no-op (nothing changed), then --force update, to demonstrate idempotence.
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const env = {
  ...process.env,
  SHOPIFY_SHOP: "mock-store.myshopify.com",
  SHOPIFY_API_BASE_URL: "http://localhost:7000",
  SHOPIFY_ACCESS_TOKEN: "shpat_mock",
  SHOPIFY_API_VERSION: "2026-07",
  MEDUSA_BACKEND_URL: "http://localhost:7001",
  MEDUSA_ADMIN_EMAIL: "admin@example.com",
  MEDUSA_ADMIN_PASSWORD: "mock",
  MEDUSA_ADMIN_API_KEY: "",
  MEDUSA_SALES_CHANNEL_ID: "sc_mock",
  MEDUSA_STOCK_LOCATION_ID: "sloc_mock",
  MEDUSA_CURRENCY_CODE: "usd",
  MEDUSA_PRICE_FORMAT: "decimal",
  SYNC_STATE_FILE: "./.demo-sync-state.json",
  LOG_LEVEL: "info",
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });

const mock = spawn("node", ["tools/mock-server.mjs"], { env, stdio: "inherit" });
const stop = () => mock.kill();
process.on("exit", stop);
process.on("SIGINT", () => { stop(); process.exit(1); });

try {
  await rm("./.demo-sync-state.json", { force: true });
  await new Promise((resolve) => setTimeout(resolve, 700));

  console.log("\n=========== RUN 1: expect 2 products CREATED ===========\n");
  await run("npx", ["tsx", "src/index.ts", "sync", "--full"]);

  console.log("\n=========== RUN 2: expect 0 created, 2 skipped (nothing changed) ===========\n");
  await run("npx", ["tsx", "src/index.ts", "sync", "--full"]);

  console.log("\n=========== RUN 3: --force, expect 2 UPDATED, still no duplicates ===========\n");
  await run("npx", ["tsx", "src/index.ts", "sync", "--full", "--force"]);

  console.log("\nDemo finished. If run 3 says 'updated: 2' and never 'created', the sync is idempotent.\n");
} finally {
  stop();
}
