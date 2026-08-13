// Persists sync state to a small JSON file: the last run timestamp (for
// incremental syncs) and a Shopify id -> Medusa id map (so a handle rename
// in Shopify updates the existing Medusa product instead of duplicating it).
// A JSON file is fine for a single instance; for multiple workers this
// interface is small enough to swap for Postgres/Redis without touching callers.
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import type { SyncState, SyncStateEntry } from "./types.js";

const EMPTY: SyncState = { lastRunAt: null, products: {} };

export async function loadState(): Promise<SyncState> {
  if (!existsSync(config.sync.stateFile)) {
    log.debug("No state file yet - treating this as a first run");
    return structuredClone(EMPTY);
  }
  try {
    const raw = await readFile(config.sync.stateFile, "utf8");
    const parsed = JSON.parse(raw) as SyncState;
    return { lastRunAt: parsed.lastRunAt ?? null, products: parsed.products ?? {} };
  } catch (error) {
    log.warn("State file is unreadable - starting fresh", String(error));
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
