import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { helperInstallPath, PACKAGED } from "./paths.ts";
import { readAsset } from "./assets.ts";

export async function ensureEmbeddedHelper(name: "WasapiLoopback.exe" | "SpoutReceiver.exe"): Promise<string> {
  if (!PACKAGED) throw new Error(`Embedded helper requested outside a packaged executable: ${name}`);
  const data = readAsset(`helpers/${name}`);
  if (!data) throw new Error(`Embedded helper asset is missing: ${name}`);

  const target = helperInstallPath(name);
  const expected = sha256(data);
  if (existsSync(target) && sha256(readFileSync(target)) === expected) return target;

  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, data, { mode: 0o755 });
    try {
      renameSync(temp, target);
    } catch {
      if (existsSync(target)) unlinkSync(target);
      renameSync(temp, target);
    }
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }

  if (!existsSync(target) || sha256(readFileSync(target)) !== expected) {
    throw new Error(`Extracted helper failed verification: ${name}`);
  }
  return target;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
