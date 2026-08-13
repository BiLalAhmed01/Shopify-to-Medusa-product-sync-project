// Reads .env once and exposes it as a typed, validated object so the rest of
// the app never has to deal with `string | undefined`.
import "dotenv/config";

function str(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing required environment variable: ${name}. ` +
      `Copy .env.example to .env and fill it in.`
  );
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function bool(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = optional(name);
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  shopify: {
    /** e.g. "my-store.myshopify.com" - we strip protocol/slashes defensively. */
    shop: str("SHOPIFY_SHOP").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    accessToken: str("SHOPIFY_ACCESS_TOKEN"),
    apiVersion: str("SHOPIFY_API_VERSION", "2026-07"),
    // Dev-only: point at a local mock instead of the real host. Unset in production.
    apiBaseUrl: optional("SHOPIFY_API_BASE_URL"),
    webhookSecret: optional("SHOPIFY_WEBHOOK_SECRET"),
    webhookPort: int("WEBHOOK_PORT", 4000),
  },

  dashboard: {
    port: int("DASHBOARD_PORT", 5050),
  },

  medusa: {
    baseUrl: str("MEDUSA_BACKEND_URL", "http://localhost:9000").replace(/\/$/, ""),
    email: optional("MEDUSA_ADMIN_EMAIL"),
    password: optional("MEDUSA_ADMIN_PASSWORD"),
    apiKey: optional("MEDUSA_ADMIN_API_KEY"),
    salesChannelId: optional("MEDUSA_SALES_CHANNEL_ID"),
    stockLocationId: optional("MEDUSA_STOCK_LOCATION_ID"),
    currencyCode: str("MEDUSA_CURRENCY_CODE", "usd").toLowerCase(),
    // v2 stores prices as decimals (19.99); v1 used integer minor units (1999).
    priceFormat: (optional("MEDUSA_PRICE_FORMAT") ?? "decimal") as "decimal" | "cents",
  },

  sync: {
    pageSize: Math.min(int("SYNC_PAGE_SIZE", 25), 250),
    stateFile: str("SYNC_STATE_FILE", "./.sync-state.json"),
    categories: bool("SYNC_CATEGORIES", true),
    productTypeAsCategory: bool("SYNC_PRODUCT_TYPE_AS_CATEGORY", true),
    inventory: bool("SYNC_INVENTORY", true),
  },

  logLevel: (optional("LOG_LEVEL") ?? "info") as "debug" | "info" | "warn" | "error",
};

/** Fail fast if neither Medusa auth method was configured. */
export function assertMedusaAuthConfigured(): void {
  const hasKey = Boolean(config.medusa.apiKey);
  const hasLogin = Boolean(config.medusa.email && config.medusa.password);
  if (!hasKey && !hasLogin) {
    throw new Error(
      "Medusa auth is not configured. Set MEDUSA_ADMIN_API_KEY, " +
        "or both MEDUSA_ADMIN_EMAIL and MEDUSA_ADMIN_PASSWORD."
    );
  }
}
