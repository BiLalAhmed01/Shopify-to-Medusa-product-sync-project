/**
 * log-bus.ts
 * -----------------------------------------------------------------------------
 * Lets the dashboard's SSE endpoint show live log lines without changing how
 * logger.ts behaves for the CLI. logger.ts pushes every line here in addition
 * to printing it; nothing subscribes in normal CLI usage, so this is a no-op
 * cost (one array push) outside of the dashboard.
 */
import { EventEmitter } from "node:events";
import type { Level } from "./logger.js";

export interface LogLine {
  time: string;
  level: Level;
  message: string;
}

const MAX_BUFFER = 500;
const buffer: LogLine[] = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export function publish(line: LogLine): void {
  buffer.push(line);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  emitter.emit("line", line);
}

export function recentLines(): LogLine[] {
  return buffer.slice();
}

export function onLine(handler: (line: LogLine) => void): () => void {
  emitter.on("line", handler);
  return () => emitter.off("line", handler);
}
