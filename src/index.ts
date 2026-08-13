// CLI entry point.
//
//   npm run check                     verify both connections and the config
//   npm run sync                      incremental sync (only what changed)
//   npm run sync -- --full            re-sync the whole catalogue
//   npm run sync -- --dry-run         show the plan, write nothing
//   npm run sync -- --limit 5         only the first 5 products (smoke test)
//   npm run sync -- --since 2026-08-01T00:00:00Z
//   npm run sync -- --force           rewrite even unchanged products
import { runSync } from "./sync.js";
import { pingShopify } from "./shopify/client.js";
import { pingMedusa } from "./medusa/client.js";
import { verifyStockLocation } from "./medusa/inventory.js";
import { config } from "./config.js";
import { log } from "./logger.js";

function parseArgs(argv: string[]) {
  const args = { command: argv[0] ?? "sync" } as {
    command: string;
    full: boolean;
    dryRun: boolean;
    force: boolean;
    limit: number | null;
    since: string | null;
  };
  args.full = argv.includes("--full");
  args.dryRun = argv.includes("--dry-run");
  args.force = argv.includes("--force");

  const limitIndex = argv.indexOf("--limit");
  const limitValue = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : NaN;
  args.limit = Number.isFinite(limitValue) ? limitValue : null;

  const sinceIndex = argv.indexOf("--since");
  args.since = sinceIndex >= 0 ? argv[sinceIndex + 1] ?? null : null;

  return args;
}

async function check(): Promise<void> {
  log.info("Checking configuration and connectivity…");

  const shop = await pingShopify();
  log.info(`  ✓ Shopify   : ${shop} (API ${config.shopify.apiVersion})`);

  const store = await pingMedusa();
  log.info(`  ✓ Medusa    : ${store} at ${config.medusa.baseUrl}`);

  if (config.medusa.salesChannelId) {
    log.info(`  ✓ Sales channel : ${config.medusa.salesChannelId}`);
  } else {
    log.warn("  ! No MEDUSA_SALES_CHANNEL_ID set - products will not appear in a storefront");
  }

  if (config.medusa.stockLocationId) {
    const name = await verifyStockLocation();
    log.info(`  ✓ Stock location : ${name ?? config.medusa.stockLocationId}`);
  } else {
    log.warn("  ! No MEDUSA_STOCK_LOCATION_ID set - inventory sync is disabled");
  }

  log.info(`  ✓ Price format : ${config.medusa.priceFormat} (${config.medusa.currencyCode})`);
  log.info("All good. Try: npm run sync -- --dry-run --limit 5");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "check":
      await check();
      break;

    case "sync": {
      const summary = await runSync({
        full: args.full,
        dryRun: args.dryRun,
        force: args.force,
        limit: args.limit,
        since: args.since,
      });
      // Non-zero exit code so CI / cron can detect partial failures.
      if (summary.failed > 0) process.exitCode = 1;
      break;
    }

    default:
      log.error(`Unknown command "${args.command}". Use "check" or "sync".`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  log.error("Fatal error", error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
