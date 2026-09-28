import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, parse } from "node:path";
import { spawn } from "node:child_process";
import { log } from "../logger.ts";
import { resolveAppPath } from "../runtime/paths.ts";
import { resolveFfmpeg } from "../runtime/ffmpeg.ts";

const CACHE_DIR = resolveAppPath("data/covers");
const MAX_COVER_BYTES = 20 * 1024 * 1024;
const RETRY_MISSING_MS = 15_000;
const CACHE_INDEX_TTL_MS = 30_000;

export interface CoverMetadata {
  artist?: string;
  title?: string;
  hasCover?: boolean;
}

export interface CoverStatus {
  revision: number;
  ready: boolean;
}

export interface CoverAsset extends CoverStatus {
  file: string;
}

interface CoverEntry extends CoverStatus {
  filepath: string;
  fingerprint: string;
  pending: boolean;
  retryAt: number;
  file: string | null;
}

interface CachedCover {
  file: string;
  modifiedAt: number;
}

interface CoverDirectoryIndex {
  directoryModifiedAt: number;
  scannedAt: number;
  files: Array<{ file: string; normalizedName: string }>;
}

const entries = new Map<number, CoverEntry>();
const cacheIndexes = new Map<string, CoverDirectoryIndex>();
let nextRevision = Date.now();

export function coverFile(deck: number, revision?: number, extension = ".jpg"): string {
  if (revision == null) return join(CACHE_DIR, `deck${deck}.jpg`);
  const ext = normalizeImageExtension(extension);
  return join(CACHE_DIR, `deck${deck}-${revision}${ext}`);
}

/**
 * Check the source files every poll so a Tag Editor write to the same loaded
 * track invalidates the generated cover. The cover is only served once the
 * current source fingerprint has produced a complete image.
 */
export function ensureCover(deck: number, filepath: string, metadata: CoverMetadata = {}): CoverStatus {
  const trackPath = String(filepath || "").trim();
  const previous = entries.get(deck);
  if (!trackPath) {
    if (previous?.filepath) {
      removeEntryFile(previous);
      entries.set(deck, emptyEntry(++nextRevision));
    }
    return statusOf(entries.get(deck));
  }

  const cached = findVdjCacheCover(trackPath, metadata.artist, metadata.title);
  const sidecar = findSidecar(trackPath);
  const fingerprint = sourceFingerprint(trackPath, metadata, cached, sidecar);
  if (previous?.fingerprint === fingerprint) {
    if (!previous.pending && !previous.ready && Date.now() >= previous.retryAt) {
      startExtraction(deck, previous, cached, sidecar);
    }
    return statusOf(previous);
  }

  if (previous) removeEntryFile(previous);
  const entry: CoverEntry = {
    revision: ++nextRevision,
    filepath: trackPath,
    fingerprint,
    ready: false,
    pending: true,
    retryAt: 0,
    file: null,
  };
  entries.set(deck, entry);
  startExtraction(deck, entry, cached, sidecar);
  return statusOf(entry);
}

export function getCoverStatus(deck: number): CoverStatus {
  return statusOf(entries.get(deck));
}

export function getCoverAsset(deck: number): CoverAsset | null {
  const entry = entries.get(deck);
  if (!entry?.ready || !entry.file) return null;
  return { revision: entry.revision, ready: true, file: entry.file };
}

function emptyEntry(revision: number): CoverEntry {
  return {
    revision,
    filepath: "",
    fingerprint: "",
    ready: false,
    pending: false,
    retryAt: 0,
    file: null,
  };
}

function statusOf(entry: CoverEntry | undefined): CoverStatus {
  return { revision: entry?.revision ?? 0, ready: entry?.ready ?? false };
}

function startExtraction(
  deck: number,
  entry: CoverEntry,
  cached: CachedCover | null,
  sidecar: string | null,
): void {
  entry.pending = true;
  void extractCover(deck, entry, cached, sidecar).catch((err) => {
    if (entries.get(deck) !== entry) return;
    entry.pending = false;
    entry.retryAt = Date.now() + RETRY_MISSING_MS;
    log.debug("Cover extraction failed", err);
  });
}

async function extractCover(
  deck: number,
  entry: CoverEntry,
  cached: CachedCover | null,
  sidecar: string | null,
): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });

  // VirtualDJ's Tag Editor writes supported artwork into the track tags.
  // Extract those tags first so old neighboring images cannot mask an edit.
  let image = existsSync(entry.filepath) ? await ffmpegCover(entry.filepath) : null;
  let extension = ".jpg";

  // Covers selected from VirtualDJ's online sources may also be present in its
  // own Cache/Covers folder, even if the media format cannot store embedded art.
  if (!image && cached && entries.get(deck) === entry) {
    image = readImage(cached.file);
    extension = extname(cached.file);
  }

  if (!image && sidecar && entries.get(deck) === entry) {
    image = readImage(sidecar);
    extension = extname(sidecar);
  }

  if (!image || entries.get(deck) !== entry) {
    entry.pending = false;
    entry.retryAt = Date.now() + RETRY_MISSING_MS;
    return;
  }

  const output = coverFile(deck, entry.revision, extension);
  const staged = `${output}.tmp`;
  try {
    writeFileSync(staged, image);
    renameSync(staged, output);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  }

  // A new track or edit may have arrived while FFmpeg was working. Never
  // publish a late result over the current deck's cover.
  if (entries.get(deck) !== entry) {
    rmSync(output, { force: true });
    return;
  }

  entry.file = output;
  entry.ready = true;
  entry.pending = false;
  entry.retryAt = 0;
}

function readImage(file: string): Buffer | null {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size <= 80 || stat.size > MAX_COVER_BYTES) return null;
    return readFileSync(file);
  } catch {
    return null;
  }
}

function sourceFingerprint(
  filepath: string,
  metadata: CoverMetadata,
  cached: CachedCover | null,
  sidecar: string | null,
): string {
  return [
    normalizePath(filepath),
    metadata.artist || "",
    metadata.title || "",
    metadata.hasCover ? "has-cover" : "no-cover-hint",
    statFingerprint(filepath),
    cached ? `${normalizePath(cached.file)}:${cached.modifiedAt}` : "no-vdj-cache-cover",
    sidecar ? `${normalizePath(sidecar)}:${statFingerprint(sidecar)}` : "no-sidecar-cover",
  ].join("|");
}

function normalizePath(filepath: string): string {
  return process.platform === "win32" ? filepath.toLowerCase() : filepath;
}

function statFingerprint(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function findSidecar(filepath: string): string | null {
  const dir = dirname(filepath);
  const stem = parse(filepath).name;
  const names = [
    `${stem}.jpg`, `${stem}.jpeg`, `${stem}.png`, `${stem}.webp`,
    "cover.jpg", "cover.jpeg", "cover.png", "cover.webp",
    "folder.jpg", "folder.jpeg", "folder.png", "folder.webp",
    "AlbumArt.jpg", "AlbumArtSmall.jpg",
  ];
  for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function virtualDjCoverRoots(): string[] {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const roaming = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const roots = [
    join(local, "VirtualDJ", "Cache", "Covers"),
    join(local, "VirtualDJ", "Cache", "covers"),
    join(roaming, "VirtualDJ", "Cache", "Covers"),
    join(homedir(), "Documents", "VirtualDJ", "Cache", "Covers"),
    join(homedir(), "Documents", "VirtualDJ", "Cache", "covers"),
    join(homedir(), "OneDrive", "Documents", "VirtualDJ", "Cache", "Covers"),
    join(homedir(), "Library", "Application Support", "VirtualDJ", "Cache", "Covers"),
  ];
  const unique = new Map<string, string>();
  for (const root of roots) {
    const key = process.platform === "win32" ? root.toLowerCase() : root;
    if (!unique.has(key)) unique.set(key, root);
  }
  return [...unique.values()];
}

function listVirtualDjCoverFiles(root: string): Array<{ file: string; normalizedName: string }> {
  try {
    const modifiedAt = statSync(root).mtimeMs;
    const cachedIndex = cacheIndexes.get(root);
    if (
      cachedIndex
      && cachedIndex.directoryModifiedAt === modifiedAt
      && Date.now() - cachedIndex.scannedAt < CACHE_INDEX_TTL_MS
    ) return cachedIndex.files;

    const files = readdirSync(root)
      .filter((name) => /\.(jpe?g|png|webp)$/i.test(name))
      .map((name) => ({
        file: join(root, name),
        normalizedName: normalizeCoverName(name),
      }));
    cacheIndexes.set(root, { directoryModifiedAt: modifiedAt, scannedAt: Date.now(), files });
    return files;
  } catch {
    return [];
  }
}

function findVdjCacheCover(filepath: string, artist = "", title = ""): CachedCover | null {
  const normalizedArtist = normalizeCoverName(artist);
  const normalizedTitle = normalizeCoverName(title);
  const normalizedStem = normalizeCoverName(parse(filepath).name);
  const candidates: Array<{ file: string; score: number; modifiedAt: number }> = [];

  for (const root of virtualDjCoverRoots()) {
    for (const indexed of listVirtualDjCoverFiles(root)) {
      const { file, normalizedName: name } = indexed;
      let score = 0;
      if (normalizedArtist && normalizedTitle) {
        if (!name.includes(normalizedArtist) || !name.includes(normalizedTitle)) continue;
        score = 20;
      } else if (normalizedTitle && normalizedTitle.length >= 5) {
        if (!name.includes(normalizedTitle)) continue;
        score = 10;
      } else if (normalizedStem && normalizedStem.length >= 8) {
        if (!name.includes(normalizedStem)) continue;
        score = 5;
      } else {
        continue;
      }

      // Prefer an exact media filename match when VDJ preserved it in the
      // cached image name, then use the newest of equally specific matches.
      if (normalizedStem.length >= 8 && name.includes(normalizedStem)) score += 4;
      try {
        const stat = statSync(file);
        if (stat.isFile() && stat.size > 80 && stat.size <= MAX_COVER_BYTES) {
          candidates.push({ file, score, modifiedAt: stat.mtimeMs });
        }
      } catch { /* file disappeared during a cache scan */ }
    }
  }

  candidates.sort((a, b) => b.score - a.score || b.modifiedAt - a.modifiedAt);
  const match = candidates[0];
  return match ? { file: match.file, modifiedAt: match.modifiedAt } : null;
}

function normalizeCoverName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeImageExtension(extension: string): string {
  const ext = extension.toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp"].includes(ext) ? ext : ".jpg";
}

function ffmpegCover(src: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn(resolveFfmpeg(), [
      "-hide_banner", "-loglevel", "error", "-y", "-i", src,
      "-map", "0:v:0?", "-an", "-sn", "-dn", "-frames:v", "1",
      "-c:v", "mjpeg", "-f", "image2pipe", "pipe:1",
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (image: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(image && image.length > 80 ? image : null);
    };
    const timeout = setTimeout(() => {
      try { child.kill(); } catch { /* process may have exited */ }
      finish(null);
    }, 8000);

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_COVER_BYTES) {
        try { child.kill(); } catch { /* process may have exited */ }
        finish(null);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? Buffer.concat(chunks, totalBytes) : null));
  });
}

function removeEntryFile(entry: CoverEntry): void {
  if (entry.file) rmSync(entry.file, { force: true });
  entry.file = null;
  entry.ready = false;
}

export function coverMime(file: string): string {
  const extension = extname(file).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "image/jpeg";
}
