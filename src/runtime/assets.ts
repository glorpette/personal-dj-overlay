import { existsSync, readFileSync } from "node:fs";
import { join, normalize, relative, resolve } from "node:path";
import { getAsset, isSea } from "node:sea";
import { APP_ROOT } from "./paths.ts";

const PUBLIC_ROOT = resolve(APP_ROOT, "public");
const LICENSE_ROOT = resolve(APP_ROOT, "licenses");

export const PUBLIC_ASSETS = new Set([
  "admin.html",
  "display.html",
  "overlay.html",
  "css/admin.css",
  "css/overlay.css",
  "img/unc-logo.png",
  "img/unc-logo.svg",
  "js/admin.js",
  "js/overlay.js",
  "vendor/SVGLoader.js",
  "vendor/three.module.js",
]);

export function readAsset(key: string): Buffer | null {
  if (isSea()) {
    try {
      return Buffer.from(getAsset(key));
    } catch {
      return null;
    }
  }

  const diskPath = diskPathForAsset(key);
  if (!diskPath || !existsSync(diskPath)) return null;
  try {
    return readFileSync(diskPath);
  } catch {
    return null;
  }
}

export function readAssetText(key: string): string | null {
  const data = readAsset(key);
  return data ? data.toString("utf8") : null;
}

export function readPublicAsset(path: string): Buffer | null {
  const key = path.replace(/^\/+/, "").replaceAll("\\", "/");
  if (!PUBLIC_ASSETS.has(key)) return null;
  return readAsset(`public/${key}`);
}

function diskPathForAsset(key: string): string | null {
  const root = key.startsWith("public/") ? PUBLIC_ROOT : key.startsWith("licenses/") ? LICENSE_ROOT : null;
  if (!root) return null;
  const child = key.slice(key.indexOf("/") + 1);
  const full = resolve(root, child);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || normalize(rel) !== rel) return null;
  return join(root, rel);
}
