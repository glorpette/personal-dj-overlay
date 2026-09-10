import type { PcmChunk } from "../types.ts";

/** Musical demo signal so the overlay can be framed without a booth rig. */
export function startDemoCapture(opts: {
  sampleRate: number;
  channels: number;
  onPcm: (chunk: PcmChunk) => void;
}): { stop(): void } {
  const sr = opts.sampleRate;
  const ch = opts.channels;
  const framesPerTick = Math.floor(sr / 60);
  let t = 0;
  let beatPhase = 0;
  const bpm = 126;
  const interval = setInterval(() => {
    const samples = new Float32Array(framesPerTick * ch);
    const beatHz = bpm / 60;
    for (let i = 0; i < framesPerTick; i++) {
      const time = t / sr;
      beatPhase = (time * beatHz) % 1;
      const kick = Math.exp(-beatPhase * 18) * Math.sin(2 * Math.PI * 55 * time);
      const hat = beatPhase > 0.5 ? Math.exp(-(beatPhase - 0.5) * 40) * (Math.random() * 2 - 1) * 0.25 : 0;
      const bass = Math.sin(2 * Math.PI * 98 * time) * (0.25 + 0.2 * Math.sin(time * 0.7));
      const pad = Math.sin(2 * Math.PI * 392 * time) * 0.08 + Math.sin(2 * Math.PI * 523.25 * time) * 0.05;
      const l = clamp(kick * 0.85 + bass * 0.55 + hat * 0.5 + pad);
      const r = clamp(kick * 0.8 + bass * 0.5 + hat * 0.6 + pad * 1.1);
      samples[i * ch] = l;
      if (ch > 1) samples[i * ch + 1] = r;
      t++;
    }
    opts.onPcm({ sampleRate: sr, channels: ch, samples });
  }, 1000 / 60);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
