// Minimal levelled logger. Avoids pulling in pino/winston for a script this size.
import { config } from "./config.js";
import { publish } from "./log-bus.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level: Level, message: string, extra?: unknown) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString();
  const full = extra === undefined ? message : `${message} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${message}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, typeof extra === "string" ? extra : JSON.stringify(extra, null, 2));
  publish({ time, level, message: full });
}

export const log = {
  debug: (m: string, e?: unknown) => write("debug", m, e),
  info: (m: string, e?: unknown) => write("info", m, e),
  warn: (m: string, e?: unknown) => write("warn", m, e),
  error: (m: string, e?: unknown) => write("error", m, e),
};
