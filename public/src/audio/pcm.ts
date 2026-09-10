import type { PcmChunk } from "./types.ts";

/** Copy interleaved f32le bytes into a detached Float32Array. */
export function f32leChunk(buf: Buffer, sampleRate: number, channels: number): PcmChunk | null {
  const frameBytes = Math.max(1, channels) * 4;
  const usable = buf.length - (buf.length % frameBytes);
  if (usable <= 0) return null;
  const copy = Buffer.from(buf.subarray(0, usable));
  return {
    sampleRate,
    channels,
    samples: new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4),
  };
}
