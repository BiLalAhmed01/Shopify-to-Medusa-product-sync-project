# Shopify → Medusa Product Sync

This is my submission for the Shopify → MedusaJS product sync task. Below is a rundown of how I
approached it, how the thing actually works, and the calls I made along the way. Setup instructions
are further down if you just want to run it.

## The brief, as I understood it

Move products from Shopify into MedusaJS: details, images, categories, prices, inventory. Talk to
both through their APIs, not a CSV or a manual export. And critically, it has to handle re-runs
sensibly - if I sync the same store twice, I shouldn't end up with duplicate products in Medusa.

That last part is really the crux of the whole exercise. "Push data from A to B" is the easy 80%.
The hard 20% is making that push safe to repeat on a schedule, which is what any real sync job
actually needs to do.

## How I approached it

First thing I did was figure out which APIs I was actually dealing with. Shopify deprecated the REST
Admin API for product/variant endpoints back in October 2024 - anything built now has to use their
GraphQL Admin API, so that settled that. Medusa v2 exposes an Admin REST API, so that side was more
straightforward, though I had to be careful about v1-vs-v2 differences (price format especially -
v2 wants decimals like `19.99`, v1 wanted integer minor units like `1999`).

Once I had the two APIs sketched out, I broke the problem into pieces I could reason about
separately:

1. **Pull products out of Shopify** - paginate through the catalogue, optionally filtered to "only
   what changed since last time."
2. **Translate a Shopify product into a Medusa product** - this is pure data mapping, no I/O, so I
   deliberately isolated it into one file (`mapper.ts`) so I could unit test it without touching
   either API.
3. **Decide create vs. update vs. skip** - this is the idempotence logic, and it's the part I spent
   the most time thinking about.
4. **Write to Medusa** - create/update the product, reconcile variants, push stock levels.
5. **Remember what happened** - so step 3 has something to compare against next time.

I built it in roughly that order, and wrote the mapper tests before I wired up the real sync loop,
because I wanted to be confident the translation logic was correct before layering retries and
pagination and rate limiting on top of it.

## How the idempotence actually works

This was the part I thought hardest about, so it's worth explaining properly rather than just saying
"it's idempotent" and moving on.

Every time the sync runs, it needs to answer one question per product: *have I already synced this
one, and if so, has it changed?*

I keep a small JSON file (`state.ts`) that maps Shopify product IDs to Medusa product IDs, plus the
Shopify `updatedAt` timestamp I saw last time I wrote that product. So on a re-run:

- If the state file has this Shopify ID, and the `updatedAt` I'm seeing now matches what I recorded
  last time - nothing changed, skip it. No API call to Medusa at all.
- If it's changed (or `--force` is passed), go ahead and write it.
- If I don't recognize the Shopify ID at all, I don't immediately assume it's new - I look it up in
  Medusa by `handle` first, because handles are unique in both systems. This matters if the state
  file ever gets lost or wiped: without the handle fallback, a lost state file would mean the *next*
  sync thinks every product is brand new and creates a full set of duplicates. With it, the sync
  self-heals - it finds the existing Medusa products by handle and just resumes updating them.
- Either way, I also write the Shopify ID into Medusa's `metadata` field on the product. That's a
  third, most-durable link: even if the state file *and* the handle both changed, the Shopify ID
  sitting in Medusa metadata is still traceable back.

Variants get the same treatment but one level deeper - `reconcileVariants()` matches existing Medusa
variants against the incoming ones (by the Shopify variant ID in metadata first, then SKU, then
title), updates what matches, creates what's new, and deletes what's gone *only if the sync created
it in the first place*. I didn't want a merchant manually adding a bundle variant in the Medusa admin
and having my sync silently delete it on the next run just because Shopify doesn't know about it.

I proved this behaviour rather than just asserting it - `npm run demo` runs the real sync three times
against a mock Shopify/Medusa (create, no-op, then forced update) and the product count in the mock
Medusa never goes above 2, which is the thing I actually care about.

## Walking through a single sync run

Roughly, `runSync()` does this:

1. Capture "now" as the run's start timestamp - *before* fetching anything. I do this on purpose: if
   someone edits a product in Shopify while my sync is mid-run, capturing the timestamp at the *end*
   would mean that edit falls before my recorded cutoff and gets silently missed on the next
   incremental run. Capturing it at the start means it just gets picked up next time instead.
2. Ask Shopify for products, optionally filtered to `updated_at:>...` for an incremental run.
   Shopify's GraphQL doesn't give you "page 3" - it gives you a cursor, so I loop, fetching a page at
   a time, until there's no next page.
3. For each product: resolve its categories first (a product can't reference a category that doesn't
   exist yet), then decide create/update/skip as above, then reconcile variants, then push inventory
   levels, using the product/variant IDs that only exist after the write.
4. One product failing doesn't kill the run - I catch per-product, log it, keep going, and report a
   non-zero exit code at the end so cron or CI notices something needs attention. A 5,000-product
   import shouldn't die because product #12 has a malformed price.
5. Save the state file at the end (skipped entirely on `--dry-run`).

## A couple of things that weren't obvious until I hit them

**Shopify's rate limiting isn't "requests per second," it's a cost bucket.** Every GraphQL response
tells you how many "cost points" you have left. I read that and pause proactively once the bucket
drops below 20%, rather than firing requests until I get rejected and then backing off. Combined with
generic 429/5xx retry-with-backoff in `http.ts`, this is what lets a full catalogue sync run
unattended without falling over.

**Medusa v2's inventory model isn't what I expected going in.** A quantity isn't stored on the
variant - it's on an `InventoryLevel`, which belongs to an `InventoryItem`, at a specific stock
location. So syncing inventory actually means: create/find the inventory item, then set its level at
your configured `MEDUSA_STOCK_LOCATION_ID`. I only worked this out by reading the Medusa admin API
docs directly rather than assuming it'd mirror Shopify's model.

**Deletes needed a judgment call.** When a product is deleted in Shopify, I don't delete it in
Medusa - existing orders might reference it, so I set it to `draft` instead. That felt like the
safer default for anyone actually running this against a live store.

## What I tested and why

`mapper.ts` has no network calls, which is exactly why I put the bulk of my unit tests there - it's
the part of the codebase where a bug would be a silent, wrong translation rather than a loud
exception, so it's the part most worth locking down with tests. `npm test` covers status mapping,
variant/option mapping, price rounding, weight unit conversion, and the category
collection-vs-product-type fallback.

For everything that *does* touch the network, I wrote `tools/mock-server.mjs` - a small Node HTTP
server that fakes just enough of both APIs to run the real sync code against. That's what
`npm run demo` uses, and it's also how I sanity-checked the webhook listener and the dashboard
without needing a real Shopify store or a Postgres-backed Medusa instance sitting around.

I also built a small local dashboard (`npm run dashboard`, `http://localhost:5050`) mostly so I could
click through a sync and watch it happen rather than only reading log lines - it hits the same
`runSync()` the CLI does, so it's a UI on top of the existing engine, not a second code path to keep
in sync (no pun intended).

## What I'd do differently with more time

- **Multi-currency.** Right now I sync one currency per run. Shopify exposes `presentmentPrices` for
  multiple currencies; extending `mapper.ts` to emit one Medusa price entry per currency is
  contained to that one file.
- **Multi-location inventory.** I currently sum Shopify's per-location quantities into a single
  Medusa stock location. A real multi-warehouse store would need an explicit location mapping table.
- **State in a database, not a JSON file.** Fine for one instance; if this ever ran on multiple
  workers concurrently I'd move `state.ts` behind Postgres or Redis. I kept the interface small
  specifically so that's a contained change.
- **Sale pricing.** Shopify's `compareAtPrice` is captured into metadata today but not applied -
  Medusa v2 models sale pricing as a separate price list feature, which felt out of scope to bolt on
  without understanding how the store actually wants promotions to work.
- **>100 variants per product.** I paginate products, but not variants within a product - Shopify
  caps me at the first 100 and I log a warning. Nested cursor pagination on variants would fix it,
  I just didn't hit a real case that needed it.

## What gets synced, concretely

| Shopify | Medusa |
|---|---|
| `title`, `handle`, `descriptionHtml` | `title`, `handle`, `description` (HTML stripped) |
| `status: ACTIVE` | `status: published`, anything else `draft` |
| `featuredImage`, `images` | `thumbnail`, `images[]` |
| Collections (or `productType` as fallback) | Product categories, created on demand |
| `tags` | `tags[]` |
| Product options + values | Product options + values |
| Variant `price` | Variant price in the configured currency |
| Variant `sku`, `barcode`, weight | Same fields (weight normalised to grams) |
| `inventoryQuantity` | Inventory level `stocked_quantity` at your stock location |
| `inventoryPolicy: CONTINUE` | `allow_backorder: true` |
| Shopify ids | `metadata.shopify_id` / `metadata.shopify_variant_id` |

## Running it

**No credentials, 60 seconds:**

```bash
npm install
npm run demo
```

Starts a mock Shopify and mock Medusa on localhost and runs the real sync against them three times -
create, no-op, forced update - which is the idempotence proof described above.

**With a real store:**

1. Node 20+, then `npm install`.
2. Shopify: admin → Settings → Apps and sales channels → Develop apps → create an app → enable
   `read_products`, `read_inventory`, `read_locations` → install → copy the Admin API access token
   (`shpat_...`, you only see it once).
3. Medusa: need a running v2 backend (`npx create-medusa-app@latest` if you don't have one). From the
   dashboard, grab the sales channel id, stock location id, and optionally a secret API key.
4. `cp .env.example .env` and fill it in - every variable has a comment explaining it.
5. `npm run check` - should print a green line for Shopify and one for Medusa. Sort out anything that
   fails here before touching real data.
6. `npm run sync -- --dry-run --limit 5` - prints the plan, writes nothing. Always do this first.
7. `npm run sync -- --limit 5`, then `npm run sync -- --full` once that looks right.
8. Keep it current either with a cron entry running `npm run sync` every 15 minutes (incremental
   after the first run), or `npm run webhooks` for near-real-time updates via Shopify's product
   webhooks.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Verifies credentials, sales channel, stock location |
| `npm run sync` | Incremental sync - only products changed since the last run |
| `npm run sync -- --full` | Walks the entire catalogue |
| `npm run sync -- --dry-run` | Prints the plan, writes nothing |
| `npm run sync -- --limit 5` | Stops after 5 products |
| `npm run sync -- --since 2026-08-01T00:00:00Z` | Custom cut-off |
| `npm run sync -- --force` | Rewrites products even if unchanged |
| `npm run webhooks` | Starts the webhook listener on :4000 |
| `npm run dashboard` | Local web UI on :5050 |
| `npm run demo` | End-to-end run against mock servers |
| `npm test` | Unit tests on the mapping logic |
| `npm run typecheck` | TypeScript check, no output files |

## Where things live

```
src/
  config.ts              env vars -> one validated, typed object
  logger.ts              levelled logging
  http.ts                fetch + retry + exponential backoff
  utils.ts               slugify, HTML->text, unit and price conversion
  types.ts               shape of Shopify and Medusa data
  mapper.ts              Shopify -> Medusa field mapping (pure function)
  sync.ts                orchestration: create vs update vs skip
  state.ts               last-run timestamp + Shopify<->Medusa id map
  index.ts               CLI
  webhook-server.ts      optional real-time listener
  dashboard-server.ts    optional local web UI
  shopify/
    client.ts            GraphQL client, cost-aware rate limiting
    products.ts          cursor-paginated product fetching
  medusa/
    client.ts            Admin API client, JWT/API-key auth
    products.ts          create, update, variant reconciliation
    categories.ts        find-or-create categories, cached
    inventory.ts         inventory item -> location level updates
tools/
  mock-server.mjs        fake Shopify + fake Medusa for the demo
  demo.mjs               the three-run idempotence demo
public/
  index.html/app.js/style.css   dashboard frontend
```

## Version notes

Built and tested against Medusa v2 and Shopify Admin API 2026-07. If you're on Medusa v1, set
`MEDUSA_PRICE_FORMAT=cents` in `.env`. Medusa's admin payload field names have shifted a bit between
minor versions in the past - if a write gets rejected, `mapper.ts` is where I'd go check first against
your backend's own docs at `http://localhost:9000/docs`, since that's the one place the Shopify→Medusa
field mapping actually lives.
