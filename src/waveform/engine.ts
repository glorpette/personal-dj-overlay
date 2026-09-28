import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, execFile, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { Readable, Writable } from "node:stream";
import type { AppConfig } from "../config.ts";
import { log } from "../logger.ts";
import { ensureEmbeddedHelper } from "../runtime/helpers.ts";
import { helperInstallPath, PACKAGED, resolveAppPath } from "../runtime/paths.ts";

const execFileAsync = promisify(execFile);
const PORT = 8765;
const FPS = 60;
const MAX_FRAME_BYTES = 8_000_000;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAGE = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0d10}
img{display:block;width:100vw;height:100vh;object-fit:fill}
</style></head><body><img src="/stream" alt="VirtualDJ waveforms"></body></html>`);
const JPEG_BOUNDARY = Buffer.from("--waveframe\r\nContent-Type: image/jpeg\r\n");

export interface VdjWindow {
  hwnd: number;
  pid: number;
  title: string;
  width: number;
  height: number;
  owned: boolean;
}

export interface WaveformStatus {
  enabled: boolean;
  running: boolean;
  state: string;
  detail: string;
  error: string | null;
  port: number;
  url: string;
  configuredHwnd: string;
  activeHwnd: string | null;
  capturing: boolean;
  frames: number;
  captureFps: number;
  selectedTitle: string;
  streamClients: number;
  lastFrameAt: number | null;
}

interface HelperStatus {
  status?: string;
  active_hwnd?: string | null;
  active_title?: string;
  capturing?: boolean;
}

type WaveChild = ChildProcessByStdio<Writable, Readable, Readable>;

export class WaveformCaptureEngine {
  private cfg: AppConfig;
  private child: WaveChild | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private listenPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;
  private state = "stopped";
  private detail = "Capture is stopped";
  private lastError: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDelay = 1000;
  private latestFrame: Buffer | null = null;
  private stdoutBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private frameCount = 0;
  private frameTimes: number[] = [];
  private lastFrameAt: number | null = null;
  private streamClients = 0;
  private activeHwnd: string | null = null;
  private activeTitle = "";

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  applyConfig(cfg: AppConfig): void {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    this.stopping = false;
    if (process.platform !== "win32") {
      this.state = this.cfg.waveform.enabled ? "unsupported" : "disabled";
      this.detail = this.cfg.waveform.enabled ? "VirtualDJ waveform capture is Windows-only" : "Capture is disabled";
      return;
    }
    try {
      await this.ensureHttpServer();
    } catch (error) {
      this.setServerError(error);
      return;
    }
    if (!this.cfg.waveform.enabled) {
      this.state = "disabled";
      this.detail = "Capture is disabled";
      return;
    }
    await this.launch();
  }

  async restart(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    await this.stopChild();
    this.restartDelay = 1000;
    this.stopping = false;
    if (process.platform !== "win32") {
      this.state = this.cfg.waveform.enabled ? "unsupported" : "disabled";
      this.detail = this.cfg.waveform.enabled ? "VirtualDJ waveform capture is Windows-only" : "Capture is disabled";
      return;
    }
    try {
      await this.ensureHttpServer();
    } catch (error) {
      this.setServerError(error);
      return;
    }
    if (!this.cfg.waveform.enabled) {
      this.state = "disabled";
      this.detail = "Capture is disabled";
      return;
    }
    await this.launch();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    await this.stopChild();
    const server = this.httpServer;
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    this.httpServer = null;
    this.latestFrame = null;
    this.state = "stopped";
    this.detail = "Capture is stopped";
  }

  async listWindows(): Promise<VdjWindow[]> {
    if (process.platform !== "win32") return [];
    const exe = await this.helperPath();
    const { stdout } = await execFileAsync(exe, ["--list-windows"], {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2_000_000,
    });
    const parsed = JSON.parse(stdout.trim() || "[]") as unknown;
    if (!Array.isArray(parsed)) throw new Error("Waveform helper returned an invalid window list");
    return parsed.filter(isVdjWindow);
  }

  async getStatus(): Promise<WaveformStatus> {
    const now = Date.now();
    this.frameTimes = this.frameTimes.filter((stamp) => stamp > now - 2000);
    const running = Boolean(this.child && this.child.exitCode === null);
    return {
      enabled: this.cfg.waveform.enabled,
      running,
      state: this.cfg.waveform.enabled ? this.state : "disabled",
      detail: this.cfg.waveform.enabled ? this.detail : "Capture is disabled",
      error: this.lastError,
      port: PORT,
      url: `${BASE_URL}/`,
      configuredHwnd: this.cfg.waveform.hwnd,
      activeHwnd: this.activeHwnd,
      capturing: this.latestFrame !== null && running,
      frames: this.frameCount,
      captureFps: Math.round((this.frameTimes.length / 2) * 10) / 10,
      selectedTitle: this.activeTitle,
      streamClients: this.streamClients,
      lastFrameAt: this.lastFrameAt,
    };
  }

  private async ensureHttpServer(): Promise<void> {
    if (this.httpServer?.listening) return;
    if (this.listenPromise) return this.listenPromise;
    if (!this.httpServer) {
      this.httpServer = createServer((req, res) => {
        void this.handleHttp(req, res).catch((error) => {
          log.warn("Waveform HTTP request failed", { error });
          if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
          res.end("waveform service error");
        });
      });
      this.httpServer.on("error", (error) => {
        this.setServerError(error);
      });
    }
    const server = this.httpServer;
    this.listenPromise = new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.off("listening", onListen);
        rejectListen(error);
      };
      const onListen = () => {
        server.off("error", onError);
        this.lastError = null;
        this.detail = `OBS waveform source ready at ${BASE_URL}/`;
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListen);
      server.listen(PORT, "127.0.0.1");
    }).finally(() => {
      this.listenPromise = null;
    });
    return this.listenPromise;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", BASE_URL);
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "cache-control": "no-store" });
      res.end("method not allowed");
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-length": PAGE.length,
      });
      res.end(PAGE);
      return;
    }
    if (url.pathname === "/health") {
      const payload = Buffer.from(JSON.stringify(await this.getStatus()));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": payload.length,
      });
      res.end(payload);
      return;
    }
    if (url.pathname === "/windows") {
      const payload = Buffer.from(JSON.stringify(await this.listWindows()));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "content-length": payload.length,
      });
      res.end(payload);
      return;
    }
    if (url.pathname === "/snapshot.jpg") {
      if (!this.latestFrame) {
        res.writeHead(503, { "cache-control": "no-store" });
        res.end(this.detail);
        return;
      }
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "cache-control": "no-store",
        "content-length": this.latestFrame.length,
      });
      res.end(this.latestFrame);
      return;
    }
    if (url.pathname === "/stream") {
      await this.stream(req, res);
      return;
    }
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("not found");
  }

  private async stream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.writeHead(200, {
      "content-type": "multipart/x-mixed-replace; boundary=waveframe",
      "cache-control": "no-store",
      connection: "close",
    });
    this.streamClients++;
    const frameDelay = 1000 / FPS;
    try {
      while (!res.destroyed && !res.writableEnded && this.httpServer?.listening) {
        const frame = this.latestFrame;
        if (frame && res.writableLength < MAX_FRAME_BYTES * 2) {
          const header = Buffer.from(`Content-Length: ${frame.length}\r\n\r\n`);
          res.write(JPEG_BOUNDARY);
          res.write(header);
          res.write(frame);
          res.write("\r\n");
        }
        await delay(frameDelay);
      }
    } catch {
      /* OBS closed or reloaded its browser source. */
    } finally {
      this.streamClients = Math.max(0, this.streamClients - 1);
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    void req;
  }

  private async launch(): Promise<void> {
    if (this.child || this.stopping || !this.cfg.waveform.enabled) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        if (process.platform !== "win32") throw new Error("VirtualDJ waveform capture is Windows-only");
        await this.ensureHttpServer();
        const exe = await this.helperPath();
        if (this.stopping || !this.cfg.waveform.enabled) return;
        const args = ["--pipe", "--fps", String(FPS), "--quality", "80"];
        const hwnd = this.cfg.waveform.hwnd.trim();
        if (hwnd) args.push("--hwnd", hwnd);
        const child = spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        this.child = child;
        this.stdoutBuffer = Buffer.alloc(0);
        this.latestFrame = null;
        this.frameCount = 0;
        this.frameTimes = [];
        this.lastFrameAt = null;
        this.activeHwnd = null;
        this.activeTitle = "";
        this.state = "starting";
        this.detail = "Starting the VirtualDJ capture helper";
        this.lastError = null;
        child.stdout.on("data", (chunk: Buffer) => this.consumeFrames(child, chunk));
        child.stderr.setEncoding("utf8");
        let stderrBuffer = "";
        child.stderr.on("data", (text: string) => {
          stderrBuffer += text;
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop() || "";
          for (const line of lines) this.consumeMessage(child, line);
        });
        child.once("error", (error) => {
          if (this.child !== child) return;
          this.lastError = error.message;
          this.state = "error";
          this.detail = error.message;
        });
        child.once("close", (code, signal) => {
          if (this.child !== child) return;
          this.child = null;
          this.latestFrame = null;
          if (this.stopping || !this.cfg.waveform.enabled) {
            this.state = this.cfg.waveform.enabled ? "stopped" : "disabled";
            this.detail = this.cfg.waveform.enabled ? "Capture is stopped" : "Capture is disabled";
            return;
          }
          this.lastError ||= `capture helper exited (${signal || code || "unknown"})`;
          this.state = "restarting";
          this.detail = this.lastError;
          this.scheduleRestart();
        });
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.detail = this.lastError;
        this.state = "error";
        log.warn("Could not start VirtualDJ waveform capture", { error: this.lastError });
      }
    })().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private consumeFrames(child: WaveChild, chunk: Buffer): void {
    if (this.child !== child) return;
    this.stdoutBuffer = this.stdoutBuffer.length ? Buffer.concat([this.stdoutBuffer, chunk]) : chunk;
    if (this.stdoutBuffer.length > MAX_FRAME_BYTES * 2) {
      this.lastError = "capture helper sent an oversized frame packet";
      this.state = "error";
      this.detail = this.lastError;
      child.kill();
      return;
    }
    while (this.stdoutBuffer.length >= 4) {
      const length = this.stdoutBuffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) {
        this.lastError = `capture helper sent an invalid JPEG size (${length})`;
        this.state = "error";
        this.detail = this.lastError;
        child.kill();
        return;
      }
      if (this.stdoutBuffer.length < length + 4) return;
      this.latestFrame = Buffer.from(this.stdoutBuffer.subarray(4, length + 4));
      this.stdoutBuffer = this.stdoutBuffer.subarray(length + 4);
      this.frameCount++;
      this.lastFrameAt = Date.now();
      this.restartDelay = 1000;
      this.frameTimes.push(this.lastFrameAt);
      if (this.frameTimes.length > 300) this.frameTimes.shift();
      this.state = "capturing";
      this.detail = "Capturing VirtualDJ waveform window";
    }
  }

  private consumeMessage(child: WaveChild, line: string): void {
    if (this.child !== child || !line) return;
    if (!line.startsWith("VDJ_STATUS ")) {
      log.debug("Waveform helper", { message: line.slice(0, 500) });
      return;
    }
    try {
      const status = JSON.parse(line.slice("VDJ_STATUS ".length)) as HelperStatus;
      this.detail = status.status || "Waiting for the waveform pop-out";
      this.activeHwnd = status.active_hwnd || null;
      this.activeTitle = status.active_title || "";
      if (!status.capturing) this.latestFrame = null;
      const isError = /error|invalid argument|failed|could not/i.test(this.detail);
      this.state = status.capturing ? "capturing" : isError ? "error" : "waiting";
      this.lastError = isError ? this.detail : null;
    } catch (error) {
      log.debug("Invalid waveform status message", { error, line: line.slice(0, 500) });
    }
  }

  private async helperPath(): Promise<string> {
    if (PACKAGED) return ensureEmbeddedHelper("WaveCapture.exe");
    const configured = process.env.VDJ_WAVE_CAPTURE_HELPER;
    const candidates = [
      configured,
      resolveAppPath("helpers/wave-capture/build/WaveCapture.exe"),
      helperInstallPath("WaveCapture.exe"),
    ].filter((file): file is string => Boolean(file));
    const found = candidates.find((file) => existsSync(file));
    if (found) return found;
    throw new Error("WaveCapture.exe is not built; run npm run build:waveform-helper");
  }

  private scheduleRestart(): void {
    this.clearRestartTimer();
    if (this.stopping || !this.cfg.waveform.enabled) return;
    const delayMs = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.launch();
    }, delayMs);
  }

  private clearRestartTimer(): void {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async stopChild(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) return;
    this.stopPromise = new Promise<void>((resolveStop) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceTimer);
        if (this.child === child) this.child = null;
        resolveStop();
      };
      const forceTimer = setTimeout(() => {
        log.warn("Waveform helper did not stop gracefully; terminating it");
        try { child.kill(); } catch { /* already exited */ }
        finish();
      }, 8000);
      child.once("close", finish);
      try { child.stdin.end("stop\n"); }
      catch {
        try { child.kill(); } catch { /* already exited */ }
      }
    }).finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private setServerError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastError = message.includes("EADDRINUSE")
      ? `Port ${PORT} is already in use. Stop the old waveform helper and restart capture.`
      : message;
    this.detail = this.lastError;
    this.state = "error";
    log.warn("Waveform browser source could not listen", { error: this.lastError });
  }
}

function isVdjWindow(value: unknown): value is VdjWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Partial<VdjWindow>;
  return Number.isSafeInteger(window.hwnd) && Number.isInteger(window.pid)
    && typeof window.title === "string" && Number.isInteger(window.width)
    && Number.isInteger(window.height) && typeof window.owned === "boolean";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
