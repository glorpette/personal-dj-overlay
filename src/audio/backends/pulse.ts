import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { log } from "../../logger.ts";
import type { PcmChunk } from "../types.ts";

export function startPulseCapture(opts: {
  deviceName: string;
  sampleRate: number;
  channels: number;
  onPcm: (chunk: PcmChunk) => void;
  onExit: (code: number | null, err?: string) => void;
}): ChildProcessByStdio<null, Readable, Readable> {
  const source = opts.deviceName.replace(/^pulse:/, "");
  const args = [
    "-d",
    source,
    `--format=float32le`,
    `--rate=${opts.sampleRate}`,
    `--channels=${opts.channels}`,
    "--latency-msec=30",
    "--raw",
  ];
  log.info("Starting parec capture", { source });
  const child = spawn("parec", args, { stdio: ["ignore", "pipe", "pipe"] });
  const frameBytes = opts.channels * 4;
  let leftover = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  child.stdout.on("data", (buf: Buffer) => {
    const data = leftover.length ? Buffer.concat([leftover, buf]) : buf;
    const usable = data.length - (data.length % frameBytes);
    leftover = data.subarray(usable);
    if (usable <= 0) return;
    const slice = data.subarray(0, usable);
    const samples = new Float32Array(slice.buffer, slice.byteOffset, slice.byteLength / 4);
    opts.onPcm({ sampleRate: opts.sampleRate, channels: opts.channels, samples });
  });
  let errAcc = "";
  child.stderr.on("data", (b: Buffer) => {
    errAcc += b.toString("utf8");
  });
  child.on("error", (err) => opts.onExit(null, err.message));
  child.on("close", (code) => opts.onExit(code, errAcc.trim() || undefined));
  return child;
}
