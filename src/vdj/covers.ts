import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, parse } from "node:path";
import { spawn } from "node:child_process";
import { log } from "../logger.ts";
import { resolveAppPath } from "../runtime/paths.ts";
import { resolveFfmpeg } from "../runtime/ffmpeg.ts";

const CACHE_DIR = resolveAppPath("data/covers");
const busy = new Set<number>();
const lastPath = new Map<number, string>();

export function coverFile(deck: number): string {
  return join(CACHE_DIR, `deck${deck}.jpg`);
}

export function ensureCover(deck: number, filepath: string): void {
  if (!filepath || busy.has(deck)) return;
  if (lastPath.get(deck) === filepath && existsSync(coverFile(deck))) return;
  busy.add(deck);
  void extract(deck, filepath).finally(() => busy.delete(deck));
}

async function extract(deck: number, filepath: string): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const dest = coverFile(deck);
  const sidecar = findSidecar(filepath);
  if (sidecar) {
    try {
      copyFileSync(sidecar, dest);
      lastPath.set(deck, filepath);
      return;
    } catch { /* continue */ }
  }
  const ok = await ffmpegCover(filepath, dest);
  if (ok) {
    lastPath.set(deck, filepath);
    return;
  }
  const cached = findVdjCacheCover(filepath);
  if (cached) {
    try {
      copyFileSync(cached, dest);
      lastPath.set(deck, filepath);
    } catch { /* ignore */ }
  }
}

function findSidecar(filepath: string): string | null {
  const dir = dirname(filepath);
  const stem = parse(filepath).name;
  const names = [
    `${stem}.jpg`, `${stem}.jpeg`, `${stem}.png`,
    "cover.jpg", "cover.png", "folder.jpg", "folder.png",
    "AlbumArt.jpg", "AlbumArtSmall.jpg",
  ];
  for (const n of names) {
    const p = join(dir, n);
    if (existsSync(p)) return p;
  }
  return null;
}

function findVdjCacheCover(filepath: string): string | null {
  const roots = [
    join(homedir(), "Documents", "VirtualDJ", "Cache", "Covers"),
    join(homedir(), "Documents", "VirtualDJ", "Cache", "covers"),
  ];
  const stem = parse(filepath).name.toLowerCase().slice(0, 18);
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const files = readdirSync(root);
      const hit = files.find((f) => f.toLowerCase().includes(stem) && /\.(jpe?g|png)$/i.test(f));
      if (hit) return join(root, hit);
    } catch { /* ignore */ }
  }
  return null;
}

function ffmpegCover(src: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(src)) return resolve(false);
    const ff = resolveFfmpeg();
    const child = spawn(ff, ["-y", "-i", src, "-an", "-vcodec", "mjpeg", "-frames:v", "1", dest], {
      windowsHide: true,
      stdio: "ignore",
    });
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve(existsSync(dest) && safeSize(dest));
    }, 8000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve(code === 0 && existsSync(dest) && safeSize(dest));
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
}

function safeSize(p: string): boolean {
  try {
    return statSync(p).size > 80;
  } catch {
    return false;
  }
}

export function coverMime(file: string): string {
  const e = extname(file).toLowerCase();
  if (e === ".png") return "image/png";
  return "image/jpeg";
}
