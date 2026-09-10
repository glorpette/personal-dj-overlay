export interface AudioDevice {
  id: string;
  name: string;
  kind: "output-loopback" | "input" | "monitor" | "virtual" | "demo";
  backend: string;
  raw?: string;
  default?: boolean;
}

export interface PcmChunk {
  sampleRate: number;
  channels: number;
  /** Interleaved Float32 PCM in -1..1 */
  samples: Float32Array;
}

export interface SpectrumFrame {
  t: number;
  sampleRate: number;
  rms: number;
  peak: number;
  bass: number;
  mid: number;
  high: number;
  bins: number[];
  waveL: number[];
  waveR: number[];
}

export interface CaptureHandle {
  backend: string;
  device: AudioDevice | null;
  stop(): Promise<void>;
}

export type FrameHandler = (frame: SpectrumFrame) => void;
export type StatusHandler = (status: { running: boolean; device?: string; error?: string }) => void;
