import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { log } from "../../logger.ts";
import type { AudioDevice, PcmChunk } from "../types.ts";

const execFileAsync = promisify(execFile);
const SRC = resolve(fileURLToPath(new URL("../../../helpers/wasapi-loopback/WasapiLoopback.cs", import.meta.url)));

export function findCsc(): string | null {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function exePath(): string {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const dir = join(local, "vdj-live-overlay");
  mkdirSync(dir, { recursive: true });
  return join(dir, "WasapiLoopback.exe");
}

export async function ensureWasapiHelper(): Promise<string> {
  const out = exePath();
  const csc = findCsc();
  if (!csc) {
    throw new Error(
      "Cannot compile WASAPI helper — csc.exe not found. Install .NET Framework 4.x (included with Windows) or add FFmpeg with WASAPI.",
    );
  }
  const srcMtime = existsSync(SRC) ? statSync(SRC).mtimeMs : 0;
  const exeMtime = existsSync(out) ? statSync(out).mtimeMs : 0;
  if (existsSync(out) && exeMtime >= srcMtime && srcMtime > 0) return out;

  log.info("Compiling WASAPI loopback helper", { csc, out });
  try {
    await execFileAsync(csc, ["/nologo", "/optimize+", "/t:exe", `/out:${out}`, SRC], {
      timeout: 30000,
      windowsHide: true,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`csc failed: ${(e.stderr || e.stdout || e.message || "").slice(0, 800)}`);
  }
  if (!existsSync(out)) throw new Error("csc produced no exe");
  return out;
}

export async function listWasapiRenderDevices(): Promise<AudioDevice[]> {
  const exe = await ensureWasapiHelper();
  const { stdout, stderr } = await execFileAsync(exe, ["--list"], {
    timeout: 8000,
    windowsHide: true,
  }).catch((err: { stdout?: string; stderr?: string }) => ({
    stdout: err.stdout || "",
    stderr: err.stderr || "",
  }));
  if (stderr) log.info("WASAPI list", { stderr: stderr.trim().slice(0, 400) });
  const devices: AudioDevice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const row = JSON.parse(t) as { id: string; name: string; default?: boolean };
      devices.push({
        id: `wasapi:${row.id}`,
        name: row.name || row.id,
        kind: "output-loopback",
        backend: "wasapi",
        raw: row.id,
        default: Boolean(row.default),
      });
    } catch {
      /* skip */
    }
  }
  return devices;
}

export function startWasapiCapture(opts: {
  deviceId?: string;
  deviceName?: string;
  sampleRateHint: number;
  onPcm: (chunk: PcmChunk) => void;
  onMeta?: (meta: { sampleRate: number; device: string }) => void;
  onExit: (code: number | null, err?: string) => void;
}): ChildProcessWithoutNullStreams {
  const exe = exePath();
  const args: string[] = [];
  const rawId = stripPrefix(opts.deviceId || "");
  if (!rawId || rawId === "default") args.push("--default");
  else args.push("--id", rawId);
  if (opts.deviceName) args.push("--name", opts.deviceName);

  log.info("Starting WASAPI loopback helper", { exe: dirname(exe), args });
  const child = spawn(exe, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let sampleRate = opts.sampleRateHint || 48000;
  const channels = 2;
  const frameBytes = channels * 4;
  let leftover = Buffer.alloc(0);

  child.stdout.on("data", (buf: Buffer) => {
    const data = leftover.length ? Buffer.concat([leftover, buf]) : buf;
    const usable = data.length - (data.length % frameBytes);
    leftover = usable < data.length ? Buffer.from(data.subarray(usable)) : Buffer.alloc(0);
    if (usable <= 0) return;
    // Copy so Node's reused pool buffers cannot corrupt the analyzer.
    const copy = Buffer.from(data.subarray(0, usable));
    const samples = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    opts.onPcm({ sampleRate, channels, samples });
  });

  let errAcc = "";
  child.stderr.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    errAcc += text;
    if (errAcc.length > 8000) errAcc = errAcc.slice(-4000);
    const meta = text.match(/WASAPI_LOOPBACK.*?rate=(\d+)/);
    if (meta) {
      sampleRate = Number(meta[1]) || sampleRate;
      const dev = /device="([^"]*)"/.exec(text)?.[1] || "";
      opts.onMeta?.({ sampleRate, device: dev });
      log.info("WASAPI capture format", { sampleRate, device: dev });
    }
  });

  child.on("error", (err) => opts.onExit(null, err.message));
  child.on("close", (code) => opts.onExit(code, errAcc.trim() || undefined));
  return child;
}

function stripPrefix(id: string): string {
  return id.replace(/^wasapi:/i, "").replace(/^ffmpeg-wasapi:/i, "").replace(/^win:/i, "");
}
