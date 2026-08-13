// Minimal Shopify GraphQL Admin API client. GraphQL over REST because
// Shopify marked REST Admin legacy in Oct 2024 and product/variant endpoints
// are GraphQL-only for new apps.
//
// Rate limiting here is a cost-point bucket, not requests/sec. Every
// response reports points remaining, so we pause proactively when the
// bucket runs low instead of waiting to get a 429.
import { config } from "../config.js";
import { requestWithRetry, parseJsonOrThrow, sleep } from "../http.js";
import { log } from "../logger.js";

const apiBase = config.shopify.apiBaseUrl ?? `https://${config.shopify.shop}`;
const endpoint = `${apiBase}/admin/api/${config.shopify.apiVersion}/graphql.json`;

interface QueryCost {
  requestedQueryCost: number;
  actualQueryCost: number;
  throttleStatus: {
    maximumAvailable: number;
    currentlyAvailable: number;
    restoreRate: number;
  };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: Record<string, unknown> }[];
  extensions?: { cost?: QueryCost };
}

export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = await requestWithRetry(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.shopify.accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await parseJsonOrThrow<GraphQLResponse<T>>(response, endpoint);

  // GraphQL can return HTTP 200 *and* an errors array. Always check both.
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join(" | ")}`);
  }
  if (!json.data) {
    throw new Error("Shopify GraphQL returned no data");
  }

  await respectCostBudget(json.extensions?.cost);
  return json.data;
}

/** Pause if we are close to exhausting the query-cost bucket. */
async function respectCostBudget(cost: QueryCost | undefined): Promise<void> {
  if (!cost) return;
  const { currentlyAvailable, maximumAvailable, restoreRate } = cost.throttleStatus;
  log.debug(`Shopify cost bucket: ${currentlyAvailable}/${maximumAvailable}`);

  if (currentlyAvailable < maximumAvailable * 0.2) {
    const pointsNeeded = maximumAvailable * 0.5 - currentlyAvailable;
    const waitMs = Math.ceil((pointsNeeded / restoreRate) * 1000);
    log.info(`Shopify rate-limit bucket low - pausing ${waitMs}ms to let it refill`);
    await sleep(waitMs);
  }
}

/** Reads the store's default currency, used when Shopify prices carry no currency. */
export async function fetchShopCurrency(): Promise<string> {
  const data = await shopifyGraphQL<{ shop: { currencyCode: string; name: string } }>(
    `query ShopInfo { shop { name currencyCode } }`
  );
  return data.shop.currencyCode.toLowerCase();
}

/** Used by `npm run check` to prove the credentials work. */
export async function pingShopify(): Promise<string> {
  const data = await shopifyGraphQL<{ shop: { name: string; myshopifyDomain: string } }>(
    `query Ping { shop { name myshopifyDomain } }`
  );
  return `${data.shop.name} (${data.shop.myshopifyDomain})`;
}
