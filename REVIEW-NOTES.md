# Reviewer Notes

**Task:** sync products from Shopify to MedusaJS — details, images, categories, prices, inventory —
via APIs, handling updates to existing products.

## Fastest way to evaluate this (about 2 minutes, no credentials)

```bash
npm install
npm test      # 9 unit tests on the mapping logic
npm run demo  # full end-to-end run against mock Shopify + mock Medusa
```

`npm run demo` executes the real sync code three times:

```
RUN 1  created: 2   updated: 0   skipped: 0   failed: 0
RUN 2  created: 0   updated: 0   skipped: 2   failed: 0    (nothing changed in Shopify)
RUN 3  created: 0   updated: 2   skipped: 0   failed: 0    (--force; no duplicates)
```

Run 2 and run 3 are the requirement "handle updates to existing products," demonstrated rather than
asserted.

## Where to look

| Question | File |
|---|---|
| How is Shopify data translated to Medusa? | `src/mapper.ts` (pure function, no I/O) |
| Create vs update vs skip decision | `src/sync.ts` → `syncOneProduct` |
| Duplicate prevention | `src/sync.ts` + `src/state.ts` + `metadata.shopify_id` |
| Variant add / change / remove | `src/medusa/products.ts` → `reconcileVariants` |
| Rate limiting and retries | `src/shopify/client.ts`, `src/http.ts` |
| Inventory model | `src/medusa/inventory.ts` (header comment explains the chain) |

## Requirement coverage

| Required | Where |
|---|---|
| Product details | `mapper.ts` — title, handle, description, status, tags, vendor, type |
| Images | `mapper.ts` — `thumbnail` + `images[]` |
| Categories | `medusa/categories.ts` — find-or-create from Shopify collections, product type as fallback, cached |
| Prices | `mapper.ts` + `utils.toMedusaAmount` — decimal/minor-unit aware |
| Inventory | `medusa/inventory.ts` — inventory item → location level, update-then-create |
| Works through APIs | Shopify GraphQL Admin API; Medusa Admin REST API |
| Handles updates | State map + handle fallback; variant reconciliation; incremental `updated_at` filter; optional webhooks |

## Engineering decisions I'd want to discuss

1. **GraphQL over REST for Shopify.** REST Admin became legacy in Oct 2024 and product/variant
   endpoints are GraphQL-only for new apps. Also one round trip per product instead of four.
2. **Cost-based rate limiting.** Shopify GraphQL meters query *cost points*, not request count. The
   client reads `extensions.cost.throttleStatus` and backs off at 20% remaining, in addition to
   generic 429/5xx exponential backoff with `Retry-After` support.
3. **Two-key identity.** State file (Shopify id → Medusa id) first, `handle` second, plus the
   Shopify id written into Medusa `metadata` so the link survives loss of the state file.
4. **Run timestamp captured before fetching, not after** — otherwise edits made during a long sync
   are silently lost on the next incremental run.
5. **Soft deletes and conservative variant removal.** Deleted-in-Shopify → `draft` in Medusa
   (orders may reference it). Variants are only deleted if they carry a `shopify_variant_id`, so
   merchant-created variants in Medusa are never destroyed by the sync.
6. **Per-product error isolation** with a non-zero exit code, so one malformed product cannot abort
   a 5,000-product import but cron/CI still alerts.

## Known limitations

Documented with rationale and remediation in `README.md` ("Known limitations"). Summary: >100
variants per product, single currency, single stock location, `compareAtPrice` not yet mapped to a
Medusa price list, images referenced by Shopify CDN URL, one-way only, JSON state file (single
instance).

## Version sensitivity

Built against Medusa **v2** and Shopify Admin API **2026-07**. Medusa v2 expects decimal prices
(`19.99`) where v1 expected minor units (`1999`); this is the `MEDUSA_PRICE_FORMAT` flag. Medusa
admin payload field names shift occasionally between minor versions — the mapping is isolated in
`mapper.ts` so any such fix is one file.
