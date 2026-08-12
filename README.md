# Shopify → Medusa Product Sync

One-way product synchronisation from **Shopify** (GraphQL Admin API) to **MedusaJS v2** (Admin REST API).

Syncs product details, images, categories, prices, options/variants and inventory levels. Runs as a
one-off import, an incremental cron job, or a webhook listener for near-real-time updates. Re-running
it never creates duplicates.

---

## Try it in 60 seconds (no credentials needed)

```bash
npm install
npm run demo
```

`npm run demo` starts a mock Shopify and a mock Medusa on localhost, then runs the **real sync code**
three times:

| Run | Expected result |
|-----|-----------------|
| 1   | `created: 2` — two products imported |
| 2   | `skipped: 2` — nothing changed in Shopify, so nothing is written |
| 3   | `updated: 2` (with `--force`) — the same products are updated, **not** duplicated |

That third line is the whole point of the project: the sync is *idempotent*.

---

## What gets synced

| Shopify | → | Medusa |
|---|---|---|
| `title`, `handle`, `descriptionHtml` | → | `title`, `handle`, `description` (HTML stripped) |
| `status: ACTIVE` | → | `status: published` (anything else → `draft`) |
| `featuredImage`, `images` | → | `thumbnail`, `images[]` |
| Collections (or `productType` as fallback) | → | Product categories, created on demand |
| `tags` | → | `tags[]` |
| Product options + values | → | Product options + values |
| Variant `price` | → | Variant price in the configured currency |
| Variant `sku`, `barcode`, weight | → | Same fields (weight normalised to grams) |
| `inventoryQuantity` | → | Inventory level `stocked_quantity` at your stock location |
| `inventoryPolicy: CONTINUE` | → | `allow_backorder: true` |
| Shopify ids | → | `metadata.shopify_id` / `metadata.shopify_variant_id` |

---

## Step-by-step setup

### Step 1 — Install the tools

You need **Node.js 20 or newer**. Check with `node -v`. If it's older, install from
[nodejs.org](https://nodejs.org) (pick the LTS version).

```bash
npm install
```

### Step 2 — Get your Shopify credentials

1. Shopify admin → **Settings** → **Apps and sales channels** → **Develop apps**
2. **Create an app** → name it `Medusa Sync`
3. **Configure Admin API scopes** and tick:
   - `read_products`
   - `read_inventory`
   - `read_locations`
4. **Install app**, then **reveal the Admin API access token**. It starts with `shpat_`.

> You only get to see that token once. Copy it straight into `.env`.

### Step 3 — Get your Medusa credentials

You need a running Medusa v2 backend. If you don't have one yet:

```bash
npx create-medusa-app@latest my-medusa-store
cd my-medusa-store && npm run dev     # http://localhost:9000
```

Then, from the Medusa dashboard (`http://localhost:9000/app`), collect three things:

| What | Where | Looks like |
|---|---|---|
| Sales channel id | Settings → Sales Channels | `sc_01J...` |
| Stock location id | Settings → Locations | `sloc_01J...` |
| Secret API key *(optional)* | Settings → Secret API Keys | `sk_...` |

If you skip the API key, the script logs in with your admin email and password instead.

### Step 4 — Configure

```bash
cp .env.example .env
```

Open `.env` and fill in every value. The file explains each one.

### Step 5 — Verify the connection before touching data

```bash
npm run check
```

You should see two green ticks — one for Shopify, one for Medusa. Fix any errors here; a
misconfigured token is much easier to debug now than halfway through an import.

### Step 6 — Dry run

```bash
npm run sync -- --dry-run --limit 5
```

This reads from Shopify and prints exactly what it *would* do. **Nothing is written to Medusa.**
Always do this first against a real store.

### Step 7 — Sync for real

```bash
npm run sync -- --limit 5      # small batch first
npm run sync -- --full         # then the whole catalogue
```

Open your Medusa dashboard and confirm the products, images, prices and stock look right.

### Step 8 — Keep it in sync

**Option A — scheduled (simple, good enough for most stores).** Every run after the first only
fetches products changed since the previous run, so it stays fast.

```cron
# every 15 minutes
*/15 * * * * cd /path/to/shopify-medusa-sync && /usr/bin/npm run sync >> sync.log 2>&1
```

**Option B — webhooks (near real-time).**

```bash
npm run webhooks          # listens on :4000
npx ngrok http 4000       # gives you a public https URL for local testing
```

Then in Shopify → **Settings → Notifications → Webhooks**, subscribe `products/create`,
`products/update` and `products/delete` to `https://<your-url>/webhooks/shopify`, and put the app's
client secret in `SHOPIFY_WEBHOOK_SECRET`.

---

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Verifies credentials, sales channel and stock location |
| `npm run sync` | Incremental sync — only products changed since the last run |
| `npm run sync -- --full` | Walks the entire catalogue |
| `npm run sync -- --dry-run` | Prints the plan, writes nothing |
| `npm run sync -- --limit 5` | Stops after 5 products |
| `npm run sync -- --since 2026-08-01T00:00:00Z` | Custom cut-off |
| `npm run sync -- --force` | Rewrites products even if unchanged |
| `npm run webhooks` | Starts the webhook listener |
| `npm run demo` | Full end-to-end run against mock servers |
| `npm run typecheck` | TypeScript check, no output files |

---

## How it's organised

```
src/
  config.ts              env vars → one validated, typed object
  logger.ts              levelled logging
  http.ts                fetch + retry + exponential backoff
  utils.ts               slugify, HTML→text, unit and price conversion
  types.ts               the shape of Shopify and Medusa data
  mapper.ts              ← THE BUSINESS LOGIC: Shopify → Medusa translation
  sync.ts                orchestration: create vs update vs skip
  state.ts               last-run timestamp + Shopify↔Medusa id map
  index.ts               CLI
  webhook-server.ts      optional real-time listener
  shopify/
    client.ts            GraphQL client, cost-aware rate limiting
    products.ts          cursor-paginated product fetching
  medusa/
    client.ts            Admin API client, JWT/API-key auth
    products.ts          create, update, variant reconciliation
    categories.ts        find-or-create categories, cached
    inventory.ts         inventory item → location level updates
tools/
  mock-server.mjs        fake Shopify + fake Medusa for the demo
  demo.mjs               the three-run idempotence demo
```

`mapper.ts` is a pure function — no network calls — so every mapping rule can be read, reasoned
about and tested against a saved JSON fixture without touching either API.

---

## Design decisions worth knowing

**GraphQL, not REST, for Shopify.** Shopify made the REST Admin API legacy in October 2024, and
product/variant endpoints in particular are GraphQL-only for apps built since. GraphQL also lets us
fetch a product, its images, collections, options, variants and inventory in a single request.

**Rate limiting is handled properly.** Shopify's GraphQL limit is a bucket of *cost points*, not
requests per second. Every response reports the points remaining; the client pauses when the bucket
drops below 20% instead of waiting to be rejected. On top of that, `http.ts` retries 429 and 5xx
responses with exponential backoff and honours `Retry-After`.

**Idempotence comes from two keys, not one.** A product is matched by the state file
(Shopify id → Medusa id) first, and by `handle` as a fallback. The Shopify id is also written into
Medusa `metadata`, so the link survives even if the state file is lost.

**Incremental by default.** The run timestamp is captured *before* fetching, not after, so an edit
made while the sync is running is picked up next time instead of being silently lost.

**Deletes are soft.** A product deleted in Shopify is set to `draft` in Medusa, not deleted —
existing orders may reference it. Variants are only deleted if *we* created them (they carry a
`shopify_variant_id` in metadata), so anything a merchant added by hand in Medusa is left alone.

**One bad product doesn't stop the import.** Failures are collected per product and reported in the
summary; the process exits non-zero so cron or CI can alert.

---

## Known limitations (deliberate, not oversights)

| Limitation | Why / what to do instead |
|---|---|
| Products with **more than 100 variants** sync only the first 100 | Needs nested cursor pagination on `variants`. The code logs a warning naming the product. |
| **One currency** per run | Medusa supports multi-currency prices; extend `mapper.ts` to emit one entry per currency using Shopify's `presentmentPrices`. |
| **Single stock location** | Shopify's per-location quantities are summed into one Medusa location. Multi-warehouse needs a location mapping table. |
| `compareAtPrice` is stored in metadata but not applied | In Medusa v2 sale pricing belongs in a *price list*, which is a separate feature. |
| Images are referenced by **Shopify CDN URL** | Medusa stores the URL rather than re-hosting the file. If Shopify is decommissioned, run a one-off image migration to your own file provider first. |
| **One-way only** (Shopify → Medusa) | Orders and stock decrements flowing back would need a second, separate job. |
| State is a **JSON file** | Correct for a single instance. For multiple workers, move `state.ts` to Postgres or Redis — it's a one-file change behind a small interface. |

## Compatibility note

Written against **Medusa v2** and Shopify Admin API **2026-07**. Two version-sensitive spots:

- `MEDUSA_PRICE_FORMAT` — Medusa v2 expects decimals (`19.99`); v1 expected minor units (`1999`).
  Set it to `cents` if you're on v1.
- Medusa's admin payload field names occasionally shift between minor versions. If a request is
  rejected, compare `mapper.ts` against your backend's own API reference at
  `http://localhost:9000/docs` — the mapping lives in one file precisely so this is a small fix.
