/**
 * state.ts
 * -----------------------------------------------------------------------------
 * Remembers what happened last time, in a small JSON file.
 *
 * Two jobs:
 *   1. `lastRunAt` powers the incremental sync (only fetch what changed).
 *   2. `products` maps Shopify product id -> Medusa product id, so a rename in
 *      Shopify (which changes the handle) updates the existing Medusa product
 *      instead of creating a duplicate.
 *
 * A JSON file is the right call for a single-instance job. If this ever runs on
 * multiple workers at once, move this table into Postgres or Redis — the
 * interface below is deliberately small enough that swapping it is a one-file
 * change.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { SyncState, SyncStateEntry } from "./types.js";

const EMPTY: SyncState = { lastRunAt: null, products: {} };

export async function loadState(): Promise<SyncState> {
  if (!existsSync(config.sync.stateFile)) {
    log.debug("No state file yet — treating this as a first run");
    return structuredClone(EMPTY);
  }
  try {
    const raw = await readFile(config.sync.stateFile, "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    return { lastRunAt: parsed.lastRunAt ?? null, products: parsed.products ?? {} };
  } catch (error) {
    log.warn("State file is unreadable — starting fresh", String(error));
    return structuredClone(EMPTY);
  }
}

/** Write to a temp file then rename: an interrupted run cannot corrupt state. */
export async function saveState(state: SyncState): Promise<void> {
  const tmp = `${config.sync.stateFile}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, config.sync.stateFile);
}

export function recordProduct(
  state: SyncState,
  shopifyProductId: string,
  entry: SyncStateEntry
): void {
  state.products[shopifyProductId] = entry;
}
