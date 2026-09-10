import { platform } from "node:os";
import type { ChildProcess } from "node:child_process";
import type { AppConfig } from "../config.ts";
import { log } from "../logger.ts";
import { Analyzer } from "./analyzer.ts";
import { listDevices, matchDevice } from "./devices.ts";
import { deviceNameForFfmpeg, startFfmpegCapture } from "./backends/ffmpeg.ts";
import { startPulseCapture } from "./backends/pulse.ts";
import { startDemoCapture } from "./backends/demo.ts";
import { ensureWasapiHelper, startWasapiCapture } from "./backends/wasapi.ts";
import type { AudioDevice, FrameHandler, StatusHandler } from "./types.ts";

export class AudioEngine {
  private cfg: AppConfig;
  private analyzer: Analyzer;
  private child: ChildProcess | null = null;
  private demo: { stop(): void } | null = null;
  private stopping = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onFrame: FrameHandler | null = null;
  private onStatus: StatusHandler | null = null;
  private currentDevice: AudioDevice | null = null;
  private running = false;
  private lastError: string | null = null;
  private lastMissingDeviceWarning = "";
  private restartPromise: Promise<void> | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.analyzer = new Analyzer({
      sampleRate: cfg.audio.sampleRate,
      channels: cfg.audio.channels,
      fftSize: cfg.audio.fftSize,
      smoothing: cfg.audio.smoothing,
      sensitivity: cfg.audio.sensitivity,
      stereo: cfg.audio.stereo,
    });
  }

  setHandlers(onFrame: FrameHandler, onStatus: StatusHandler): void {
    this.onFrame = onFrame;
    this.onStatus = onStatus;
  }

  applyAudioConfig(cfg: AppConfig): void {
    this.cfg = cfg;
    this.analyzer.configure({
      smoothing: cfg.audio.smoothing,
      sensitivity: cfg.audio.sensitivity,
      stereo: cfg.audio.stereo,
      sampleRate: cfg.audio.sampleRate,
    });
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.stopping = false;
      await this.stopChild();
      this.backoff = 1000;
      await this.connect();
    })().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.stopChild();
    this.running = false;
    this.onStatus?.({ running: false });
  }

  getStatus(): { running: boolean; device: string | null; backend: string; error: string | null } {
    return {
      running: this.running,
      device: this.currentDevice?.name ?? null,
      backend: this.currentDevice?.backend ?? this.cfg.audio.backend,
      error: this.lastError,
    };
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    const os = platform();
    const devices = await listDevices();
    const wanted = this.cfg.audio.device;
    const backend = resolveBackend(this.cfg.audio.backend);
    const explicitDemo = backend === "demo" || wanted.toLowerCase() === "demo";

    let device = explicitDemo
      ? devices.find((d) => d.kind === "demo") ?? null
      : matchDevice(
          devices.filter((d) => d.kind !== "demo"),
          wanted,
        );

    if (!device && !explicitDemo) {
      this.lastError = wanted
        ? `No playback device matched "${wanted}". Refresh the device list and pick the exact WASAPI output VirtualDJ is using.`
        : "No WASAPI render / loopback device found.";
      if (this.lastMissingDeviceWarning === this.lastError) {
        log.debug("Audio device still unavailable", { error: this.lastError });
      } else {
        log.warn(this.lastError);
        this.lastMissingDeviceWarning = this.lastError;
      }
      this.currentDevice = null;
      this.running = false;
      this.onStatus?.({ running: false, error: this.lastError });
      this.scheduleReconnect();
      return;
    }

    if (!device) device = devices.find((d) => d.kind === "demo")!;
    this.currentDevice = device;
    this.lastMissingDeviceWarning = "";
    log.info("Audio device selected", { name: device.name, id: device.id, backend: device.backend, kind: device.kind });

    const onPcm = (chunk: { sampleRate: number; channels: number; samples: Float32Array }) => {
      this.analyzer.configure({ sampleRate: chunk.sampleRate });
      const frame = this.analyzer.push(chunk);
      if (frame) this.onFrame?.(frame);
    };

    const onExit = (code: number | null, err?: string) => {
      this.running = false;
      this.lastError = err || `capture exited code ${code}`;
      if (this.stopping) return;
      log.warn("Audio capture ended — will reconnect", { code, err: this.lastError.slice(0, 500) });
      this.onStatus?.({ running: false, device: device!.name, error: this.lastError });
      this.scheduleReconnect();
    };

    try {
      if (device.kind === "demo" || device.backend === "demo") {
        this.demo = startDemoCapture({
          sampleRate: this.cfg.audio.sampleRate,
          channels: this.cfg.audio.channels,
          onPcm,
        });
        this.running = true;
        this.lastError = "Using demo oscillator — select a real Windows output device for live audio.";
        this.backoff = 1000;
        this.onStatus?.({ running: true, device: device.name, error: this.lastError });
        return;
      }

      if (os === "win32" && (backend === "wasapi" || backend === "auto" || device.backend === "wasapi")) {
        await ensureWasapiHelper();
        this.child = startWasapiCapture({
          deviceId: device.raw || device.id,
          deviceName: device.name,
          sampleRateHint: this.cfg.audio.sampleRate,
          onPcm,
          onMeta: (meta) => this.analyzer.configure({ sampleRate: meta.sampleRate }),
          onExit,
        });
      } else if (device.backend === "pulse" && os === "linux") {
        this.child = startPulseCapture({
          deviceName: device.id,
          sampleRate: this.cfg.audio.sampleRate,
          channels: this.cfg.audio.channels,
          onPcm,
          onExit,
        });
      } else {
        this.child = startFfmpegCapture({
          sampleRate: this.cfg.audio.sampleRate,
          channels: this.cfg.audio.channels,
          deviceName: deviceNameForFfmpeg(device),
          onPcm,
          onExit,
        });
      }
      this.running = true;
      this.lastError = null;
      this.backoff = 1000;
      this.onStatus?.({ running: true, device: device.name });
    } catch (err) {
      this.lastError = String(err);
      log.error("Failed to start capture", err);
      this.onStatus?.({ running: false, error: this.lastError });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const wait = this.backoff;
    this.backoff = Math.min(10_000, Math.round(this.backoff * 1.7));
    log.debug(`Reconnecting audio in ${wait}ms`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, wait);
  }

  private async stopChild(): Promise<void> {
    this.demo?.stop();
    this.demo = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }, 800);
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

function resolveBackend(requested: string): string {
  if (requested !== "auto") return requested;
  const os = platform();
  if (os === "win32") return "wasapi";
  if (os === "linux") return "pulse";
  return "ffmpeg";
}
