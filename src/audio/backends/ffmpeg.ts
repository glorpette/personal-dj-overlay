import { spawn, type ChildProcessByStdio } from "node:child_process";
import { platform } from "node:os";
import type { Readable } from "node:stream";
import { log } from "../../logger.ts";
import type { AudioDevice, PcmChunk } from "../types.ts";
import { resolveFfmpeg } from "../../runtime/ffmpeg.ts";

export interface FfmpegOptions {
  sampleRate: number;
  channels: number;
  deviceName: string;
  onPcm: (chunk: PcmChunk) => void;
  onExit: (code: number | null, err?: string) => void;
}

export function startFfmpegCapture(opts: FfmpegOptions): ChildProcessByStdio<null, Readable, Readable> {
  const args = buildArgs(opts);
  log.info("Starting ffmpeg capture", { args: args.join(" ") });
  const child = spawn(resolveFfmpeg(), args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const bytesPerSample = 4;
  const frameBytes = opts.channels * bytesPerSample;
  let leftover = Buffer.alloc(0) as Buffer<ArrayBufferLike>;

  child.stdout.on("data", (buf: Buffer) => {
    const data = leftover.length ? Buffer.concat([leftover, buf]) : buf;
    const usable = data.length - (data.length % frameBytes);
    if (usable <= 0) {
      leftover = data;
      return;
    }
    const slice = data.subarray(0, usable);
    leftover = data.subarray(usable);
    const samples = new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4);
    opts.onPcm({ sampleRate: opts.sampleRate, channels: opts.channels, samples });
  });

  let errAcc = "";
  child.stderr.on("data", (buf: Buffer) => {
    errAcc += buf.toString("utf8");
    if (errAcc.length > 8000) errAcc = errAcc.slice(-4000);
  });

  child.on("error", (err) => opts.onExit(null, err.message));
  child.on("close", (code) => opts.onExit(code, errAcc.trim() || undefined));
  return child;
}

function buildArgs(opts: FfmpegOptions): string[] {
  const os = platform();
  const common = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
  ];
  const encode = [
    "-ac",
    String(opts.channels),
    "-ar",
    String(opts.sampleRate),
    "-f",
    "f32le",
    "-acodec",
    "pcm_f32le",
    "pipe:1",
  ];

  const name = opts.deviceName.replace(/^ffmpeg-(wasapi|dshow|pulse|avf):/i, "");

  if (os === "win32") {
    // Official ffmpeg wasapi indev has no -loopback flag. Opening a render
    // device name (or "default") captures that device's shared-mode mix.
    const input = !name || name === "default" || /wasapi default/i.test(name) ? "default" : name;
    return [...common, "-f", "wasapi", "-i", input, ...encode];
  }

  if (os === "linux") {
    const input = name || "default";
    return [...common, "-f", "pulse", "-i", input, ...encode];
  }

  // macOS — true output tap needs BlackHole / Loopback / Soundflower.
  const input = name.includes(":") ? name : `none:${name || "0"}`;
  return [...common, "-f", "avfoundation", "-i", input, ...encode];
}

export function deviceNameForFfmpeg(device: AudioDevice): string {
  if (device.id.startsWith("pulse:")) return device.id.slice("pulse:".length);
  const idx = device.id.indexOf(":");
  if (idx > 0) return device.id.slice(idx + 1);
  return device.name;
}
