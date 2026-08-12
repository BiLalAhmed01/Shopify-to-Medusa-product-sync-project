/**
 * logger.ts
 * -----------------------------------------------------------------------------
 * A tiny logger. In a bigger project you would use pino or winston, but for a
 * sync script this keeps the dependency list short and the output readable.
 */
import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level: Level, message: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
}

export const log = {
  debug: (m: string, e?: unknown) => write("debug", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  error: (m: string, e?: unknown) => write("error", m, e),
};
