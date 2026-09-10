import { existsSync } from "node:fs";
import { ffmpegInstallPath } from "./paths.ts";

export function resolveFfmpeg(): string {
  const configured = process.env.VDJ_OVERLAY_FFMPEG || process.env.FFMPEG_PATH || process.env.FFMPEG;
  if (configured && (existsSync(configured) || configured.toLowerCase().endsWith(".exe"))) return configured;

  const installed = ffmpegInstallPath();
  if (existsSync(installed)) return installed;
  return "ffmpeg";
}

export function installedFfmpegPath(): string | null {
  const path = ffmpegInstallPath();
  return existsSync(path) ? path : null;
}
