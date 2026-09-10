export type Tone = "blue" | "cyan" | "dim" | "green" | "red" | "yellow" | "magenta" | "bold";

const ANSI: Record<Tone, string> = {
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
  bold: "\u001b[1m",
};
const RESET = "\u001b[0m";

export function supportsColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
}

export function paint(value: string, tone: Tone, stream: NodeJS.WriteStream = process.stdout): string {
  return supportsColor(stream) ? `${ANSI[tone]}${value}${RESET}` : value;
}

export function section(value: string): string {
  return paint(value, "bold");
}

export function label(value: string): string {
  return paint(value.padEnd(13), "dim");
}

export function status(ok: boolean, good = "OK", bad = "FAIL"): string {
  return paint(ok ? good : bad, ok ? "green" : "red");
}
