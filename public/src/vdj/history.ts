import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { emptyDeck, type DeckInfo, type NowPlayingState } from "./types.ts";

export function defaultHistoryDir(): string {
  const home = homedir();
  if (platform() === "win32") return join(home, "Documents", "VirtualDJ", "History");
  if (platform() === "darwin") return join(home, "Documents", "VirtualDJ", "History");
  return join(home, "Documents", "VirtualDJ", "History");
}

export function readHistoryFallback(dir: string): NowPlayingState | null {
  const root = dir || defaultHistoryDir();
  if (!existsSync(root)) return null;

  const tracklist = join(root, "tracklist.txt");
  let line = "";
  if (existsSync(tracklist)) {
    const text = readFileSync(tracklist, "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    line = lines[lines.length - 1] ?? "";
  } else {
    const m3us = readdirSync(root)
      .filter((f) => f.toLowerCase().endsWith(".m3u"))
      .map((f) => join(root, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (!m3us.length) return null;
    const text = readFileSync(m3us[0], "utf8");
    const infos = text.split(/\r?\n/).filter((l) => l.startsWith("#EXTINF"));
    const last = infos[infos.length - 1] ?? "";
    line = last.replace(/^#EXTINF:[^,]*,/, "").trim();
  }
  if (!line) return null;

  const parsed = parseArtistTitle(line);
  const deck1: DeckInfo = {
    ...emptyDeck(1),
    artist: parsed.artist,
    title: parsed.title,
    artistTitle: parsed.artistTitle,
    playing: true,
    audible: true,
  };
  return {
    connected: false,
    source: "history",
    deck1,
    deck2: emptyDeck(2),
    onAirDeck: 1,
    masterTitle: parsed.artistTitle,
    updatedAt: new Date().toISOString(),
    lastError: "Network Control HTTP unavailable — history fallback (master only)",
  };
}

function parseArtistTitle(raw: string): { artist: string; title: string; artistTitle: string } {
  const cleaned = raw.replace(/^\d{1,2}:\d{2}(:\d{2})?\s+/, "").trim();
  const dash = cleaned.split(/\s+-\s+/);
  if (dash.length >= 2) {
    const artist = dash[0].trim();
    const title = dash.slice(1).join(" - ").trim();
    return { artist, title, artistTitle: `${artist} - ${title}` };
  }
  return { artist: "", title: cleaned, artistTitle: cleaned };
}
