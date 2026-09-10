import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ffmpegInstallPath } from "./paths.ts";
import { installedFfmpegPath } from "./ffmpeg.ts";

export const FFMPEG_PACKAGE = {
  version: "n9.0-lgpl-win64",
  url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip",
  sha256: "7a815bbdc5a8dcc1080344263fe0bdc7ee2b339edbbe4294d9a02af6c744ea95",
};

const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const MAX_ENTRY_BYTES = 240 * 1024 * 1024;

export async function installFfmpeg(): Promise<string> {
  if (process.platform !== "win32") throw new Error("The bundled FFmpeg installer is Windows-only.");
  const existing = installedFfmpegPath();
  if (existing) return existing;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let zip: Buffer;
  try {
    const response = await fetch(FFMPEG_PACKAGE.url, {
      headers: { "user-agent": "vdj-live-overlay/1.0", accept: "application/octet-stream" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`FFmpeg download failed with HTTP ${response.status}.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("FFmpeg download is larger than the safety limit.");
    zip = data;
  } finally {
    clearTimeout(timeout);
  }

  const actualHash = sha256(zip);
  if (actualHash !== FFMPEG_PACKAGE.sha256) {
    throw new Error(`FFmpeg checksum mismatch: expected ${FFMPEG_PACKAGE.sha256}, received ${actualHash}.`);
  }

  const targetRoot = dirname(ffmpegInstallPath());
  const stagingRoot = `${targetRoot}.install-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(targetRoot), { recursive: true });
  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });
  try {
    extractFfmpegZip(zip, stagingRoot);
    const target = join(stagingRoot, "ffmpeg.exe");
    if (!existsSync(target)) throw new Error("FFmpeg archive did not contain bin/ffmpeg.exe.");
    writeFileSync(join(stagingRoot, "FFMPEG_NOTICE.txt"), noticeText(), "utf8");
    rmSync(targetRoot, { recursive: true, force: true });
    renameSync(stagingRoot, targetRoot);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  return ffmpegInstallPath();
}

function extractFfmpegZip(zip: Buffer, targetRoot: string): void {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > zip.length) throw new Error("Invalid FFmpeg ZIP: end record missing.");
  const entries = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > zip.length) throw new Error("Invalid FFmpeg ZIP: central directory is outside the archive.");

  let offset = centralOffset;
  let foundBinary = false;
  let noticeIndex = 0;
  for (let i = 0; i < entries; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid FFmpeg ZIP: central entry is malformed.");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength).replaceAll("\\", "/");
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 1) throw new Error(`Encrypted FFmpeg ZIP entry is not supported: ${name}`);
    if (isSymlink(externalAttributes)) throw new Error(`Symlink in FFmpeg ZIP is not allowed: ${name}`);
    const normalized = safeArchivePath(name);
    if (!normalized || uncompressedSize > MAX_ENTRY_BYTES) continue;

    const lower = normalized.toLowerCase();
    const isBinary = !foundBinary && basename(lower) === "ffmpeg.exe" && lower.includes("/bin/");
    const isNotice = /(^|\/)(license|copying|readme)([^/]*)$/i.test(normalized);
    if (!isBinary && !isNotice) continue;

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid FFmpeg ZIP local entry: ${name}`);
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const end = start + compressedSize;
    if (end > zip.length) throw new Error(`Invalid FFmpeg ZIP data entry: ${name}`);
    const compressed = zip.subarray(start, end);
    const contents = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null;
    if (!contents || contents.length !== uncompressedSize) throw new Error(`Unsupported FFmpeg ZIP compression: ${name}`);

    if (isBinary) {
      writeFileSync(join(targetRoot, "ffmpeg.exe"), contents);
      foundBinary = true;
    } else {
      const safeName = `${String(noticeIndex++).padStart(2, "0")}-${basename(normalized).replace(/[^A-Za-z0-9._-]/g, "_")}`;
      mkdirSync(join(targetRoot, "licenses"), { recursive: true });
      writeFileSync(join(targetRoot, "licenses", safeName), contents);
    }
  }
  if (!foundBinary) throw new Error("FFmpeg archive did not contain a safe executable entry.");
}

function safeArchivePath(value: string): string | null {
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function isSymlink(attributes: number): boolean {
  return ((attributes >>> 16) & 0xf000) === 0xa000;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function noticeText(): string {
  return [
    "VDJ Live Overlay optional FFmpeg component",
    "",
    `Package: ${FFMPEG_PACKAGE.version}`,
    `Source archive: ${FFMPEG_PACKAGE.url}`,
    `SHA-256: ${FFMPEG_PACKAGE.sha256}`,
    "",
    "This build uses the LGPL variant of FFmpeg. The downloaded archive's license and copying files are retained in the licenses directory.",
    "FFmpeg legal information: https://ffmpeg.org/legal.html",
    "BtbN build project: https://github.com/BtbN/FFmpeg-Builds",
    "",
  ].join("\n");
}
