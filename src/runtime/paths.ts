import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSea } from "node:sea";

export const PACKAGED = isSea();
export const APP_ROOT = PACKAGED ? dirname(process.execPath) : process.cwd();
export const LOCAL_DATA_ROOT = join(
  process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
  "vdj-live-overlay",
);

export function resolveAppPath(value: string): string {
  return isAbsolute(value) ? value : resolve(APP_ROOT, value);
}

export function resolveConfigPath(): string {
  const configured = process.env.VDJ_OVERLAY_CONFIG || "config.json";
  return resolveAppPath(configured);
}

export function helperInstallPath(name: string): string {
  return join(LOCAL_DATA_ROOT, name);
}

export function ffmpegInstallPath(): string {
  return join(LOCAL_DATA_ROOT, "tools", "ffmpeg", "ffmpeg.exe");
}
