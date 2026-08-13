// Small pure helpers, kept side-effect free so they're easy to unit-test.
import { config } from "./config.js";

/** "Men's T-Shirts & Tops" -> "mens-t-shirts-tops" */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")   // strip accents
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** Shopify gives HTML; Medusa's description field is plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "gid://shopify/Product/8123456789" -> "8123456789" */
export function numericIdFromGid(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1] ?? gid;
}

/**
 * Shopify sends prices as strings ("19.99").
 * Medusa v2 wants a decimal number (19.99); Medusa v1 wanted minor units (1999).
 * Controlled by MEDUSA_PRICE_FORMAT so this project works against both.
 */
export function toMedusaAmount(shopifyPrice: string | number | null | undefined): number {
  const value = Number(shopifyPrice ?? 0);
  if (!Number.isFinite(value)) return 0;
  if (config.medusa.priceFormat === "cents") return Math.round(value * 100);
  return Math.round(value * 100) / 100;   // guard against float noise like 19.989999
}

/** Normalises Shopify's weight units to grams, which is what Medusa expects. */
export function toGrams(value: number | undefined, unit: string | undefined): number | null {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  switch ((unit ?? "GRAMS").toUpperCase()) {
    case "KILOGRAMS": return Math.round(value * 1000);
    case "POUNDS":    return Math.round(value * 453.59237);
    case "OUNCES":    return Math.round(value * 28.349523);
    case "GRAMS":
    default:          return Math.round(value);
  }
}

/** Runs async work over a list with a cap on how many run at once. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
