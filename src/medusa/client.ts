// Medusa v2 Admin REST client.
//
// Two auth modes: email/password via POST /auth/user/emailpass (JWT, expires
// so a 401 triggers one re-login + retry), or a secret admin API key sent as
// HTTP Basic auth (doesn't expire, preferred for servers/CI).
import { config, assertMedusaAuthConfigured } from "../config.js";
import { requestWithRetry, parseJsonOrThrow, HttpError } from "../http.js";
import { log } from "../logger.js";

let cachedToken: string | null = null;

async function login(): Promise<string> {
  const url = `${config.medusa.baseUrl}/auth/user/emailpass`;
  const response = await requestWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: config.medusa.email,
      password: config.medusa.password,
    }),
  });

  const data = await parseJsonOrThrow<{ token: string }>(response, url);
  if (!data.token) throw new Error("Medusa login succeeded but returned no token");
  log.debug("Authenticated with Medusa via email/password");
  return data.token;
}

async function authHeader(forceRefresh = false): Promise<string> {
  assertMedusaAuthConfigured();

  if (config.medusa.apiKey) {
    // Basic auth: the key is the username, the password is empty.
    const encoded = Buffer.from(`${config.medusa.apiKey}:`).toString("base64");
    return `Basic ${encoded}`;
  }

  if (!cachedToken || forceRefresh) cachedToken = await login();
  return `Bearer ${cachedToken}`;
}

type Method = "GET" | "POST" | "DELETE";

/**
 * The single entry point for every Medusa call.
 * `path` is relative, e.g. "/admin/products?limit=10".
 */
export async function medusaRequest<T>(
  method: Method,
  path: string,
  body?: unknown,
  { retryOn401 = true }: { retryOn401?: boolean } = {}
): Promise<T> {
  const url = `${config.medusa.baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: await authHeader(),
  };

  const response = await requestWithRetry(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && retryOn401 && !config.medusa.apiKey) {
    log.warn("Medusa token expired - re-authenticating");
    cachedToken = null;
    await authHeader(true);
    return medusaRequest<T>(method, path, body, { retryOn401: false });
  }

  return parseJsonOrThrow<T>(response, url);
}

/** Used by `npm run check`. Returns the store name if the credentials work. */
export async function pingMedusa(): Promise<string> {
  const data = await medusaRequest<{ stores: { id: string; name: string }[] }>(
    "GET",
    "/admin/stores?limit=1"
  );
  const store = data.stores?.[0];
  return store ? `${store.name} (${store.id})` : "connected (no store configured yet)";
}

export { HttpError };
