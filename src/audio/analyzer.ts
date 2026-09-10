import { fftRadix2, hann } from "./fft.ts";
import type { PcmChunk, SpectrumFrame } from "./types.ts";

export interface AnalyzerOptions {
  sampleRate: number;
  channels: number;
  fftSize: number;
  smoothing: number;
  sensitivity: number;
  stereo: boolean;
  binCount?: number;
  waveCount?: number;
  hopMs?: number;
}

export class Analyzer {
  private opts: Required<AnalyzerOptions>;
  private ringL: Float32Array;
  private ringR: Float32Array;
  private write = 0;
  private filled = 0;
  private lastEmit = 0;
  private window: Float64Array;
  private re: Float64Array;
  private im: Float64Array;
  private smoothBins: Float64Array;
  private smoothRms = 0;
  private smoothPeak = 0;
  private smoothBass = 0;
  private smoothMid = 0;
  private smoothHigh = 0;

  constructor(opts: AnalyzerOptions) {
    const fftSize = nextPow2(opts.fftSize || 2048);
    this.opts = {
      sampleRate: opts.sampleRate,
      channels: Math.max(1, opts.channels),
      fftSize,
      smoothing: clamp(opts.smoothing, 0, 0.95),
      sensitivity: Math.max(0.1, opts.sensitivity),
      stereo: opts.stereo,
      binCount: opts.binCount ?? 64,
      waveCount: opts.waveCount ?? 128,
      hopMs: opts.hopMs ?? 16,
    };
    this.ringL = new Float32Array(fftSize);
    this.ringR = new Float32Array(fftSize);
    this.window = hann(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.smoothBins = new Float64Array(this.opts.binCount);
  }

  configure(partial: Partial<AnalyzerOptions>): void {
    if (partial.smoothing != null) this.opts.smoothing = clamp(partial.smoothing, 0, 0.95);
    if (partial.sensitivity != null) this.opts.sensitivity = Math.max(0.1, partial.sensitivity);
    if (partial.stereo != null) this.opts.stereo = partial.stereo;
    if (partial.sampleRate != null) this.opts.sampleRate = partial.sampleRate;
  }

  push(chunk: PcmChunk): SpectrumFrame | null {
    const ch = chunk.channels || this.opts.channels;
    const data = chunk.samples;
    const frames = Math.floor(data.length / ch);
    for (let i = 0; i < frames; i++) {
      const l = data[i * ch] ?? 0;
      const r = ch > 1 ? data[i * ch + 1] ?? l : l;
      this.ringL[this.write] = l;
      this.ringR[this.write] = r;
      this.write = (this.write + 1) % this.opts.fftSize;
      if (this.filled < this.opts.fftSize) this.filled++;
    }
    const now = Date.now();
    if (this.filled < this.opts.fftSize) return null;
    if (now - this.lastEmit < this.opts.hopMs) return null;
    this.lastEmit = now;
    return this.compute(now);
  }

  private compute(t: number): SpectrumFrame {
    const n = this.opts.fftSize;
    const start = this.write; // oldest sample
    let peak = 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const l = this.ringL[idx];
      const r = this.ringR[idx];
      const mono = this.opts.stereo ? (l + r) * 0.5 : l;
      const w = this.window[i];
      this.re[i] = mono * w;
      this.im[i] = 0;
      const a = Math.abs(mono);
      if (a > peak) peak = a;
      acc += mono * mono;
    }
    const rms = Math.sqrt(acc / n);
    fftRadix2(this.re, this.im);

    const nyquist = n / 2;
    const sr = this.opts.sampleRate;
    const mag = new Float64Array(nyquist);
    for (let i = 0; i < nyquist; i++) {
      mag[i] = Math.hypot(this.re[i], this.im[i]) / n;
    }

    const bins = this.logBins(mag, sr);
    const s = this.opts.smoothing;
    for (let i = 0; i < bins.length; i++) {
      this.smoothBins[i] = this.smoothBins[i] * s + bins[i] * (1 - s);
    }

    const bass = bandEnergy(mag, sr, n, 20, 150);
    const mid = bandEnergy(mag, sr, n, 150, 2000);
    const high = bandEnergy(mag, sr, n, 2000, 12000);
    this.smoothRms = this.smoothRms * s + rms * (1 - s);
    this.smoothPeak = this.smoothPeak * (s * 0.6) + peak * (1 - s * 0.6);
    this.smoothBass = this.smoothBass * s + bass * (1 - s);
    this.smoothMid = this.smoothMid * s + mid * (1 - s);
    this.smoothHigh = this.smoothHigh * s + high * (1 - s);

    const gain = this.opts.sensitivity;
    const wave = this.opts.waveCount;
    const waveL = new Array<number>(wave);
    const waveR = new Array<number>(wave);
    const step = n / wave;
    for (let i = 0; i < wave; i++) {
      const idx = (start + Math.floor(i * step)) % n;
      waveL[i] = clamp(this.ringL[idx] * gain, -1, 1);
      waveR[i] = clamp(this.ringR[idx] * gain, -1, 1);
    }

    return {
      t,
      sampleRate: sr,
      rms: clamp(this.smoothRms * gain * 2.2, 0, 1),
      peak: clamp(this.smoothPeak * gain, 0, 1),
      bass: clamp(this.smoothBass * gain * 3.2, 0, 1),
      mid: clamp(this.smoothMid * gain * 3.8, 0, 1),
      high: clamp(this.smoothHigh * gain * 4.4, 0, 1),
      bins: Array.from(this.smoothBins, (v) => clamp(v * gain * 6, 0, 1)),
      waveL,
      waveR,
    };
  }

  private logBins(mag: Float64Array, sr: number): Float64Array {
    const count = this.opts.binCount;
    const out = new Float64Array(count);
    const n = this.opts.fftSize;
    const minHz = 30;
    const maxHz = Math.min(sr / 2, 16000);
    for (let b = 0; b < count; b++) {
      const t0 = b / count;
      const t1 = (b + 1) / count;
      const f0 = minHz * Math.pow(maxHz / minHz, t0);
      const f1 = minHz * Math.pow(maxHz / minHz, t1);
      const i0 = Math.max(1, Math.floor((f0 * n) / sr));
      const i1 = Math.min(mag.length - 1, Math.ceil((f1 * n) / sr));
      let sum = 0;
      let c = 0;
      for (let i = i0; i <= i1; i++) {
        sum += mag[i];
        c++;
      }
      const mean = c ? sum / c : 0;
      // mild perceptual lift for high bins
      const lift = 0.65 + t0 * 0.7;
      out[b] = Math.pow(mean * lift, 0.55);
    }
    return out;
  }
}

function bandEnergy(mag: Float64Array, sr: number, fftSize: number, f0: number, f1: number): number {
  const i0 = Math.max(1, Math.floor((f0 * fftSize) / sr));
  const i1 = Math.min(mag.length - 1, Math.ceil((f1 * fftSize) / sr));
  let sum = 0;
  let c = 0;
  for (let i = i0; i <= i1; i++) {
    sum += mag[i];
    c++;
  }
  return c ? Math.pow(sum / c, 0.5) : 0;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return Math.max(256, p);
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}
