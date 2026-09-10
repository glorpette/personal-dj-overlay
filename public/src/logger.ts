const ts = () => new Date().toISOString();

export const log = {
  info(msg: string, extra?: unknown) {
    console.log(`[${ts()}] INFO  ${msg}${fmt(extra)}`);
  },
  warn(msg: string, extra?: unknown) {
    console.warn(`[${ts()}] WARN  ${msg}${fmt(extra)}`);
  },
  error(msg: string, extra?: unknown) {
    console.error(`[${ts()}] ERROR ${msg}${fmt(extra)}`);
  },
};

function fmt(extra?: unknown): string {
  if (extra === undefined) return "";
  if (extra instanceof Error) return ` — ${extra.message}`;
  try {
    return ` ${JSON.stringify(extra)}`;
  } catch {
    return ` ${String(extra)}`;
  }
}
