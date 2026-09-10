import { inspect } from "node:util";
import { paint, supportsColor } from "./terminal.ts";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const LEVEL_TONE = {
  INFO: "cyan",
  WARN: "yellow",
  ERROR: "red",
  DEBUG: "dim",
} as const;

export const log = {
  info(msg: string, extra?: unknown) {
    write("INFO", msg, extra, process.stdout);
  },
  warn(msg: string, extra?: unknown) {
    write("WARN", msg, extra, process.stderr);
  },
  error(msg: string, extra?: unknown) {
    write("ERROR", msg, extra, process.stderr);
  },
  debug(msg: string, extra?: unknown) {
    if (!debugEnabled()) return;
    write("DEBUG", msg, extra, process.stdout);
  },
};

function write(level: LogLevel, msg: string, extra: unknown, stream: NodeJS.WriteStream): void {
  const details = formatExtra(extra);
  const stamp = paint(time(), "dim", stream);
  const name = paint(level.padEnd(5), LEVEL_TONE[level], stream);
  const suffix = details ? `  ${paint(details, "dim", stream)}` : "";
  stream.write(`${stamp} ${name} ${msg}${suffix}\n`);
}

function time(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function debugEnabled(): boolean {
  const value = process.env.VDJ_OVERLAY_DEBUG;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function formatExtra(extra?: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) {
    const message = `error=${quote(extra.message)}`;
    if (!debugEnabled() || !extra.stack) return message;
    return `${message}\n    ${extra.stack.split(/\r?\n/).join("\n    ")}`;
  }
  if (typeof extra === "string") return quote(extra);
  if (extra === null || typeof extra !== "object") return String(extra);
  try {
    return Object.entries(extra as Record<string, unknown>)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join("  ");
  } catch {
    return inspect(extra, { depth: 2, breakLength: Infinity, compact: true });
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return inspect(value, { depth: 2, breakLength: Infinity, compact: true, maxArrayLength: 16 })
    .replace(/\s+/g, " ");
}

function quote(value: string): string {
  const compact = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const clipped = compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
  return JSON.stringify(clipped);
}
