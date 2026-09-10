import { log } from "../logger.ts";

export class VdjClient {
  private host;
  private port;
  private bearer;
  private timeoutMs;
  constructor(host, port, bearer, timeoutMs = 2500) {
    this.host = host;
    this.port = port;
    this.bearer = bearer;
    this.timeoutMs = timeoutMs;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  configure(host: string, port: number, bearer: string): void {
    this.host = host;
    this.port = port;
    this.bearer = bearer;
  }

  async query(script: string): Promise<string> {
    const url = `${this.baseUrl}/query?script=${encodeURIComponent(script)}`;
    const headers: Record<string, string> = {};
    if (this.bearer) headers.Authorization = `Bearer ${this.bearer}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      const text = (await res.text()).trim();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
      }
      return sanitize(text);
    } finally {
      clearTimeout(t);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const v = await this.query("get_version");
      return Boolean(v) && !v.startsWith("error:");
    } catch {
      return false;
    }
  }
}

function sanitize(text: string): string {
  if (!text) return "";
  if (/^error:/i.test(text)) return "";
  if (text === "false") return "false";
  if (text === "true") return "true";
  return text.replace(/\u0000/g, "").trim();
}

export function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "on" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "off" || s === "no" || s === "") return false;
  const n = Number(s);
  return Number.isFinite(n) ? n !== 0 : false;
}

export function parseNum(v: string): number | null {
  if (!v) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function queryDeck(client: VdjClient, deck: number) {
  const q = (verb: string) => client.query(`deck ${deck} ${verb}`);
  // Sequential on purpose: some Network Control builds drop parallel GETs,
  // and a single-threaded mock/plugin should not be stampeded every poll.
  const artist = await q("get_artist");
  const title = await q("get_title");
  const artistTitle = await q("get_artist_title");
  const album = await q("get_album");
  const bpm = await q("get_bpm");
  const key = await q("get_key");
  const playing = await q("play");
  const audible = await q("is_audible");
  const elapsed = await client.query(`deck ${deck} get_time "elapsed"`);
  const length = await q("get_songlength");

  return {
    deck,
    artist,
    title,
    artistTitle: artistTitle || [artist, title].filter(Boolean).join(" - "),
    album,
    bpm: parseNum(bpm),
    key,
    playing: parseBool(playing),
    audible: parseBool(audible),
    elapsedMs: parseNum(elapsed),
    lengthSec: parseNum(length),
  };
}

export async function queryMaster(client: VdjClient): Promise<string> {
  try {
    return await client.query("deck master get_artist_title");
  } catch (err) {
    log.warn("master query failed", err);
    return "";
  }
}
