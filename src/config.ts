import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./logger.ts";
import { resolveConfigPath } from "./runtime/paths.ts";

export type AudioBackend = "auto" | "wasapi" | "ffmpeg" | "pulse" | "demo";

export interface AppConfig {
  server: { host: string; port: number };
  audio: {
    backend: AudioBackend;
    device: string;
    sampleRate: number;
    channels: number;
    fftSize: number;
    smoothing: number;
    sensitivity: number;
    stereo: boolean;
  };
  vdj: {
    host: string;
    port: number;
    bearer: string;
    pollIntervalMs: number;
    decks: number[];
    historyFallback: boolean;
    historyDir: string;
  };
  nowPlaying: {
    txtPath: string;
    jsonPath: string;
    heartbeatMs: number;
  };
  spout: {
    enabled: boolean;
    sender: string;
    fps: number;
    quality: number;
    maxWidth: number;
  };
  visual: {
    preset: string;
    palette: string;
    bloom: boolean;
    alignment: string;
    logoSafe: number;
    rotationSpeed: number;
    scale: number;
    cameraYaw: number;
    cameraPitch: number;
    logoSpin: number;
    snap: number;
    snapAuto: boolean;
  };
}

const DEFAULTS: AppConfig = {
  server: { host: "127.0.0.1", port: 4780 },
  audio: {
    backend: "auto",
    device: "",
    sampleRate: 44100,
    channels: 2,
    fftSize: 2048,
    smoothing: 0.58,
    sensitivity: 1.15,
    stereo: true,
  },
  vdj: {
    host: "127.0.0.1",
    port: 8080,
    bearer: "",
    pollIntervalMs: 750,
    decks: [1, 2],
    historyFallback: true,
    historyDir: "",
  },
  nowPlaying: {
    txtPath: "./data/nowplaying.txt",
    jsonPath: "./data/nowplaying.json",
    heartbeatMs: 5000,
  },
  spout: {
    enabled: false,
    sender: "",
    fps: 30,
    quality: 72,
    maxWidth: 880,
  },
  visual: {
    preset: "helix",
    palette: "cyan-magenta",
    bloom: true,
    alignment: "center",
    logoSafe: 0.12,
    rotationSpeed: 0.18,
    scale: 1.0,
    cameraYaw: 0.15,
    cameraPitch: 0.22,
    logoSpin: 0.35,
    snap: 0.35,
    snapAuto: true,
  },
};

export const CONFIG_PATH = resolveConfigPath();

function deepMerge<T extends Record<string, unknown>>(base: T, over: Partial<T>): T {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (base as Record<string, unknown>)[k] === "object") {
      (out as Record<string, unknown>)[k] = deepMerge(
        (base as Record<string, unknown>)[k] as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export function loadConfig(): AppConfig {
  if (!existsSync(CONFIG_PATH)) {
    log.warn("Config missing; writing defaults", { path: CONFIG_PATH });
    saveConfig(DEFAULTS);
    return structuredClone(DEFAULTS);
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AppConfig>;
  return deepMerge(DEFAULTS as unknown as Record<string, unknown>, raw as Record<string, unknown>) as unknown as AppConfig;
}

export function saveConfig(cfg: AppConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tempPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  renameSync(tempPath, CONFIG_PATH);
}

export function applyPartial(cfg: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return deepMerge(cfg as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as AppConfig;
}
