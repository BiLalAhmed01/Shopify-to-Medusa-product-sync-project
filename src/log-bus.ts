// In-memory pub/sub so the dashboard's SSE endpoint can show live log lines.
// logger.ts pushes every line here; nothing subscribes outside the dashboard,
// so plain CLI usage pays only the cost of one array push per line.
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
