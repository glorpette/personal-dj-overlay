import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { findCsc } from "../audio/backends/wasapi.ts";
import type { AppConfig } from "../config.ts";
import { log } from "../logger.ts";
import { ensureEmbeddedHelper } from "../runtime/helpers.ts";
import { helperInstallPath, PACKAGED, resolveAppPath } from "../runtime/paths.ts";

const execFileAsync = promisify(execFile);
const SRC = resolveAppPath("helpers/spout-receiver/SpoutReceiver.cs");
const MAGIC = Buffer.from("SPUT");
const MAX_FRAME_BYTES = 8_000_000;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + 8 + MAGIC.length;
let helperBuild: Promise<string> | null = null;

export interface SpoutSender {
  name: string;
  width: number;
  height: number;
  format: number;
  active: boolean;
}

export interface SpoutStatus {
  running: boolean;
  enabled: boolean;
  sender: string | null;
  width: number;
  height: number;
  state: string;
  error: string | null;
  platform: string;
  frameCount: number;
  lastFrameAt: number | null;
}

export type SpoutFrameHandler = (jpeg: Buffer, meta: { sender: string; width: number; height: number }) => void;
export type SpoutStatusHandler = (status: SpoutStatus) => void;

function exePath(): string {
  return helperInstallPath("SpoutReceiver.exe");
}

export function ensureSpoutHelper(): Promise<string> {
  if (!helperBuild) {
    helperBuild = buildSpoutHelper().finally(() => {
      helperBuild = null;
    });
  }
  return helperBuild;
}

async function buildSpoutHelper(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("Spout2 is Windows-only");
  }
  if (PACKAGED) return ensureEmbeddedHelper("SpoutReceiver.exe");
  const out = exePath();
  const csc = findCsc();
  if (!csc) {
    throw new Error("Cannot compile Spout helper — csc.exe not found (.NET Framework 4.x).");
  }
  const srcMtime = existsSync(SRC) ? statSync(SRC).mtimeMs : 0;
  const exeMtime = existsSync(out) ? statSync(out).mtimeMs : 0;
  if (existsSync(out) && exeMtime >= srcMtime && srcMtime > 0) return out;

  log.info("Compiling Spout2 receiver helper", { csc, out });
  try {
    await execFileAsync(
      csc,
      ["/nologo", "/optimize+", "/platform:x64", "/t:exe", "/r:System.Drawing.dll", `/out:${out}`, SRC],
      { timeout: 45000, windowsHide: true },
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(`csc failed: ${(e.stderr || e.stdout || e.message || "").slice(0, 1200)}`);
  }
  if (!existsSync(out)) throw new Error("csc produced no SpoutReceiver.exe");
  return out;
}

export async function listSpoutSenders(): Promise<{ active: string; senders: SpoutSender[] }> {
  if (process.platform !== "win32") return { active: "", senders: [] };
  const exe = await ensureSpoutHelper();
  const { stdout, stderr } = await execFileAsync(exe, ["--list"], {
    timeout: 8000,
    windowsHide: true,
  }).catch((err: { stdout?: string; stderr?: string }) => ({
    stdout: err.stdout || "",
    stderr: err.stderr || "",
  }));
  if (stderr) log.debug("Spout list", { stderr: stderr.trim().slice(0, 400) });
  const line = stdout.trim().split(/\r?\n/).find((l) => l.startsWith("{")) || stdout.trim();
  if (!line) return { active: "", senders: [] };
  try {
    const row = JSON.parse(line) as { active?: string; senders?: SpoutSender[] };
    return { active: row.active || "", senders: row.senders || [] };
  } catch {
    return { active: "", senders: [] };
  }
}

export class SpoutEngine {
  private cfg: AppConfig;
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private stopping = false;
  private backoff = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onFrame: SpoutFrameHandler | null = null;
  private onStatus: SpoutStatusHandler | null = null;
  private sender: string | null = null;
  private width = 0;
  private height = 0;
  private state = "idle";
  private running = false;
  private lastError: string | null = null;
  private frameCount = 0;
  private lastFrameAt: number | null = null;
  private restartPromise: Promise<void> | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  setHandlers(onFrame: SpoutFrameHandler, onStatus: SpoutStatusHandler): void {
    this.onFrame = onFrame;
    this.onStatus = onStatus;
  }

  applyConfig(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  getStatus(): SpoutStatus {
    return {
      running: this.running,
      enabled: this.cfg.spout.enabled,
      sender: this.sender,
      width: this.width,
      height: this.height,
      state: this.state,
      error: this.lastError,
      platform: process.platform,
      frameCount: this.frameCount,
      lastFrameAt: this.lastFrameAt,
    };
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    await this.connect();
  }

  async restart(): Promise<void> {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      this.state = "restarting";
      this.lastError = null;
      this.emitStatus();
      this.stopping = true;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      await this.stopChild();
      this.backoff = 1000;
      this.sender = null;
      this.width = 0;
      this.height = 0;
      this.frameCount = 0;
      this.lastFrameAt = null;
      this.stopping = false;
      await this.connect();
    })().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.stopChild();
    this.running = false;
    this.state = "stopped";
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatus?.(this.getStatus());
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    this.reconnectTimer = null;
    if (this.child) return;
    if (process.platform !== "win32") {
      this.state = "unsupported";
      this.lastError = "Spout2 is Windows-only";
      this.emitStatus();
      return;
    }
    if (!this.cfg.spout.enabled) {
      this.state = "disabled";
      this.running = false;
      this.lastError = null;
      this.frameCount = 0;
      this.lastFrameAt = null;
      this.emitStatus();
      return;
    }

    try {
      const exe = await ensureSpoutHelper();
      if (this.stopping) return;
      if (!this.cfg.spout.enabled) {
        this.running = false;
        this.state = "disabled";
        this.lastError = null;
        this.emitStatus();
        return;
      }
      const fps = boundedInt(this.cfg.spout.fps, 30, 1, 60);
      const quality = boundedInt(this.cfg.spout.quality, 72, 20, 95);
      const maxWidth = boundedInt(this.cfg.spout.maxWidth, 880, 160, 4096);
      const args: string[] = [
        "--fps",
        String(fps),
        "--quality",
        String(quality),
        "--max-width",
        String(maxWidth),
      ];
      const sender = String(this.cfg.spout.sender || "").trim();
      if (sender) args.push("--name", sender);
      else args.push("--active");

      log.info("Starting Spout2 receiver", { exe, args });
      const child = spawn(exe, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.running = true;
      this.state = "starting";
      this.lastError = null;
      this.emitStatus();

      let leftover = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
      child.stdout.on("data", (buf: Buffer) => {
        leftover = leftover.length ? Buffer.concat([leftover, buf]) : buf;
        leftover = this.drainFrames(leftover);
      });

      let errBuf = "";
      child.stderr.on("data", (buf: Buffer) => {
        errBuf += buf.toString("utf8");
        if (errBuf.length > 16000) errBuf = errBuf.slice(-8000);
        const lines = errBuf.split(/\r?\n/);
        errBuf = lines.pop() || "";
        for (const line of lines) this.handleStderr(line);
      });

      child.on("error", (err) => {
        this.lastError = err.message;
        this.state = "error";
        this.emitStatus();
        log.error("Spout helper process error", err);
      });

      child.on("exit", (code) => {
        if (this.child === child) this.child = null;
        this.running = false;
        if (this.stopping) return;
        this.lastError = code ? `helper exit ${code}` : "helper exited";
        this.state = "reconnect";
        this.emitStatus();
        this.scheduleReconnect();
      });
    } catch (err) {
      this.running = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.state = "error";
      this.emitStatus();
      log.error("Spout helper failed", err);
      if (!this.stopping) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    const wait = this.backoff;
    this.backoff = Math.min(10000, Math.round(this.backoff * 1.6));
    this.reconnectTimer = setTimeout(() => void this.connect(), wait);
  }

  private handleStderr(line: string): void {
    const t = line.trim();
    if (!t) return;
    if (t.startsWith("SPOUT_META ")) {
      try {
        const meta = JSON.parse(t.slice("SPOUT_META ".length)) as {
          sender?: string;
          width?: number;
          height?: number;
          state?: string;
        };
        this.sender = meta.sender || null;
        this.width = Number(meta.width) || 0;
        this.height = Number(meta.height) || 0;
        if (!(meta.state === "opened" && this.frameCount > 0)) this.state = meta.state || this.state;
        if (meta.state === "connected") this.backoff = 1000;
        this.emitStatus();
        return;
      } catch {
        /* fall through */
      }
    }
    if (t.startsWith("ERROR")) {
      this.lastError = t;
      log.warn("Spout helper", t);
      this.emitStatus();
      return;
    }
    log.debug("Spout helper", t.slice(0, 240));
  }

  private drainFrames(buf: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
    let offset = 0;
    while (buf.length - offset >= 8) {
      const mag = buf.subarray(offset, offset + 4);
      if (!mag.equals(MAGIC)) {
        const next = buf.indexOf(MAGIC, offset + 1);
        if (next < 0) {
          const keep = Math.min(MAGIC.length - 1, buf.length - offset);
          return Buffer.from(buf.subarray(buf.length - keep));
        }
        offset = next;
        continue;
      }
      const size = buf.readUInt32LE(offset + 4);
      if (size <= 0 || size > MAX_FRAME_BYTES) {
        offset += 1;
        continue;
      }
      if (buf.length - offset < 8 + size) break;
      const jpeg = Buffer.from(buf.subarray(offset + 8, offset + 8 + size));
      this.onFrame?.(jpeg, {
        sender: this.sender || "",
        width: this.width,
        height: this.height,
      });
      this.frameCount++;
      this.lastFrameAt = Date.now();
      this.lastError = null;
      if (this.state !== "connected") {
        this.state = "connected";
        this.backoff = 1000;
        this.emitStatus();
      }
      offset += 8 + size;
    }
    const remaining = offset > 0 ? buf.subarray(offset) : buf;
    if (remaining.length > MAX_BUFFER_BYTES) {
      return Buffer.from(remaining.subarray(remaining.length - (MAGIC.length - 1)));
    }
    return offset > 0 ? Buffer.from(remaining) : remaining;
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    await new Promise<void>((resolveStop) => {
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolveStop();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(t);
        resolveStop();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(t);
        resolveStop();
      }
    });
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
