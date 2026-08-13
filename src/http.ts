// Shared fetch wrapper with exponential backoff, used for every Shopify and
// Medusa call. Retries 429/5xx and network errors; 4xx other than 429 means
// we sent something wrong, so retrying won't help.
import { log } from "./logger.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string
  ) {
    super(`HTTP ${status} for ${url} :: ${body.slice(0, 800)}`);
    this.name = "HttpError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryOptions {
  retries?: number;
  /** Base delay in ms; doubles on every attempt. */
  baseDelayMs?: number;
}

export async function requestWithRetry(
  url: string,
  init: RequestInit,
  { retries = 5, baseDelayMs = 500 }: RetryOptions = {}
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, init);

      // Success, or a client error we should not retry.
      if (response.status !== 429 && response.status < 500) return response;

      // Shopify and Medusa both send Retry-After on 429 when they can.
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : baseDelayMs * 2 ** attempt;

      if (attempt === retries) return response; // give up, let caller read the body
      log.warn(
        `Got HTTP ${response.status} from ${new URL(url).pathname} - ` +
          `retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`
      );
      await sleep(delay);
    } catch (error) {
      // Network-level failure (DNS, socket reset, timeout).
      lastError = error;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt;
      log.warn(`Network error calling ${url} - retrying in ${delay}ms`, String(error));
      await sleep(delay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${url} failed after ${retries} retries`);
}

/** Reads the body once and throws a rich error if the status is not 2xx. */
export async function parseJsonOrThrow<T>(response: Response, url: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, text);
  return (text ? JSON.parse(text) : {}) as T;
}
