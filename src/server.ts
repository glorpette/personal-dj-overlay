import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "./config.ts";
import { applyPartial, saveConfig } from "./config.ts";
import { log } from "./logger.ts";
import { listDevices } from "./audio/devices.ts";
import type { AudioEngine } from "./audio/capture.ts";
import type { VdjPoller } from "./vdj/poller.ts";
import { listSpoutSenders, type SpoutEngine, type SpoutStatus } from "./spout/receiver.ts";
import type { SpectrumFrame } from "./audio/types.ts";
import { coverFile, coverMime } from "./vdj/covers.ts";
import { readAsset, readAssetText, readPublicAsset } from "./runtime/assets.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function startServer(opts: {
  cfg: AppConfig;
  getConfig: () => AppConfig;
  setConfig: (cfg: AppConfig) => void;
  audio: AudioEngine;
  poller: VdjPoller;
  spout: SpoutEngine;
}): {
  server: ReturnType<typeof createServer>;
  broadcastFrame: (f: SpectrumFrame) => void;
  broadcastSpoutFrame: (jpeg: Buffer) => void;
  broadcastSpoutStatus: (status: SpoutStatus) => void;
  close: () => Promise<void>;
} {
  let cfg = opts.cfg;
  let configRevision = 1;
  const sockets = new Set<WebSocket>();
  const spoutSockets = new Set<WebSocket>();
  let spoutStatus = opts.spout.getStatus();
  let latestSpoutFrame: Buffer | null = null;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      log.error("HTTP error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("internal error");
      }
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({
      type: "hello",
      visual: cfg.visual,
      audio: statusAudio(),
      spout: cfg.spout,
      spoutStatus,
      nowPlaying: opts.poller.getState(),
    }));
    ws.on("close", () => sockets.delete(ws));
  });

  const spoutWss = new WebSocketServer({ noServer: true });
  spoutWss.on("connection", (ws) => {
    spoutSockets.add(ws);
    ws.send(JSON.stringify({ type: "status", status: spoutStatus }));
    if (latestSpoutFrame && ws.readyState === 1) ws.send(latestSpoutFrame);
    ws.on("close", () => spoutSockets.delete(ws));
  });

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`).pathname;
    const target = path === "/ws" ? wss : path === "/spout" ? spoutWss : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws, request));
  });

  opts.poller.onUpdate((state) => {
    const msg = JSON.stringify({ type: "nowplaying", state });
    for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
  });

  function statusAudio() {
    return { ...opts.audio.getStatus(), settings: opts.getConfig().audio };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname;

    if (path === "/" || path === "/overlay") return sendPublicFile(res, "overlay.html");
    if (path === "/admin") return sendPublicFile(res, "admin.html");
    if (path === "/display") return sendPublicFile(res, "display.html");
    if (path === "/licenses") return sendAssetFile(res, "licenses/THIRD_PARTY_NOTICES.txt");
    if (path === "/api/licenses") return json(res, { text: readAssetText("licenses/THIRD_PARTY_NOTICES.txt") || "" });

    if (path === "/api/health") {
      return json(res, { ok: true, audio: statusAudio(), vdj: opts.poller.getState(), spout: spoutStatus });
    }
    if (path === "/api/nowplaying") return json(res, opts.poller.getState());
    if (path === "/api/config" && req.method === "GET") {
      return json(res, opts.getConfig(), 200, { etag: `"${configRevision}"` });
    }
    if (path === "/api/devices") return json(res, { devices: await listDevices() });
    if (path === "/api/spout/status" && req.method === "GET") return json(res, spoutStatus);
    if (path === "/api/spout/senders" && req.method === "GET") return json(res, await listSpoutSenders());

    if (path === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      let patch: Partial<AppConfig>;
      try {
        patch = JSON.parse(body || "{}") as Partial<AppConfig>;
      } catch {
        return json(res, { error: "invalid JSON" }, 400);
      }
      if (!patch || Array.isArray(patch) || typeof patch !== "object") {
        return json(res, { error: "config patch must be an object" }, 400);
      }
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== `"${configRevision}"`) {
        return json(res, { error: "config changed elsewhere; reload and retry" }, 409, {
          etag: `"${configRevision}"`,
        });
      }
      const previous = opts.getConfig();
      const next = applyPartial(previous, patch);
      const validationError = validateConfig(next);
      if (validationError) return json(res, { error: validationError }, 400);
      const restartAudio = audioCaptureConfigChanged(previous, next);
      const restartSpout = spoutConfigChanged(previous, next);
      saveConfig(next);
      configRevision++;
      opts.setConfig(next);
      cfg = next;
      opts.audio.applyAudioConfig(next);
      opts.poller.configure(next);
      const msg = JSON.stringify({
        type: "config",
        visual: next.visual,
        audio: next.audio,
        spout: next.spout,
      });
      const broadcastConfig = () => {
        for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
      };
      if (restartAudio) void opts.audio.restart();
      if (restartSpout && next.spout.enabled) {
        // Let the receiver enter its starting state before the overlay arms the panel.
        void opts.spout.restart().then(broadcastConfig, broadcastConfig);
      } else {
        broadcastConfig();
        if (restartSpout) void opts.spout.restart();
      }
      return json(res, next, 200, { etag: `"${configRevision}"` });
    }

    if (path === "/api/audio/restart" && req.method === "POST") {
      await opts.audio.restart();
      return json(res, { ok: true });
    }

    if (path === "/api/spout/restart" && req.method === "POST") {
      await opts.spout.restart();
      return json(res, { ok: true });
    }

    const coverMatch = path.match(/^\/api\/cover\/(\d+)$/);
    if (coverMatch) {
      const file = coverFile(Number(coverMatch[1]));
      if (!existsSync(file)) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": coverMime(file),
        "cache-control": "no-store",
      });
      res.end(readFileSync(file));
      return;
    }

    const asset = readPublicAsset(path);
    if (asset) return sendAssetFile(res, `public/${path.replace(/^\/+/, "")}`, asset);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  function broadcastFrame(frame: SpectrumFrame): void {
    if (!sockets.size) return;
    const msg = JSON.stringify({ type: "frame", frame });
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function broadcastSpoutFrame(jpeg: Buffer): void {
    latestSpoutFrame = Buffer.from(jpeg);
    for (const ws of spoutSockets) {
      if (ws.readyState !== 1 || ws.bufferedAmount > 2_000_000) continue;
      ws.send(jpeg);
    }
  }

  function broadcastSpoutStatus(status: SpoutStatus): void {
    spoutStatus = status;
    if (status.state !== "connected") latestSpoutFrame = null;
    const msg = JSON.stringify({ type: "status", status });
    for (const ws of spoutSockets) if (ws.readyState === 1) ws.send(msg);
    for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
  }

  server.listen(cfg.server.port, cfg.server.host, () => {
    const base = `http://${cfg.server.host}:${cfg.server.port}`;
    log.info("HTTP server ready", {
      overlay: `${base}/overlay`,
      admin: `${base}/admin`,
      display: `${base}/display`,
    });
  });

  return {
    server,
    broadcastFrame,
    broadcastSpoutFrame,
    broadcastSpoutStatus,
    close: () =>
      new Promise((resolveClose) => {
        for (const ws of sockets) ws.close();
        for (const ws of spoutSockets) ws.close();
        wss.close();
        spoutWss.close();
        server.close(() => resolveClose());
      }),
  };
}

function sendPublicFile(res: ServerResponse, path: string): void {
  const data = readPublicAsset(path);
  if (!data) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  sendAssetFile(res, `public/${path}`, data);
}

function sendAssetFile(res: ServerResponse, key: string, data = readAsset(key)): void {
  if (!data) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(key).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": (ext === ".html" || ext === ".js" || ext === ".css") ? "no-store" : "public, max-age=30",
  });
  res.end(data);
}

function json(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function audioCaptureConfigChanged(previous: AppConfig, next: AppConfig): boolean {
  return previous.audio.backend !== next.audio.backend
    || previous.audio.device !== next.audio.device
    || previous.audio.sampleRate !== next.audio.sampleRate
    || previous.audio.channels !== next.audio.channels
    || previous.audio.fftSize !== next.audio.fftSize;
}

function spoutConfigChanged(previous: AppConfig, next: AppConfig): boolean {
  return previous.spout.enabled !== next.spout.enabled
    || previous.spout.sender !== next.spout.sender
    || previous.spout.fps !== next.spout.fps
    || previous.spout.quality !== next.spout.quality
    || previous.spout.maxWidth !== next.spout.maxWidth;
}

function validateConfig(cfg: AppConfig): string | null {
  if (!cfg.server || typeof cfg.server.host !== "string" || !integerInRange(cfg.server.port, 1, 65535)) {
    return "server host/port is invalid";
  }
  if (!cfg.audio || !["auto", "wasapi", "ffmpeg", "pulse", "demo"].includes(cfg.audio.backend)) {
    return "audio backend is invalid";
  }
  if (typeof cfg.audio.device !== "string" || typeof cfg.audio.stereo !== "boolean") return "audio device/settings are invalid";
  if (!numberInRange(cfg.audio.sensitivity, 0.3, 3)) return "audio sensitivity is invalid";
  if (!numberInRange(cfg.audio.smoothing, 0, 0.9)) return "audio smoothing is invalid";
  if (!integerInRange(cfg.audio.sampleRate, 8000, 192000) || !integerInRange(cfg.audio.channels, 1, 8)) {
    return "audio format is invalid";
  }
  if (!integerInRange(cfg.audio.fftSize, 256, 32768)) return "audio FFT size is invalid";

  if (!cfg.vdj || typeof cfg.vdj.host !== "string" || !integerInRange(cfg.vdj.port, 1, 65535)) {
    return "VirtualDJ host/port is invalid";
  }
  if (!integerInRange(cfg.vdj.pollIntervalMs, 250, 5000) || typeof cfg.vdj.bearer !== "string"
    || !Array.isArray(cfg.vdj.decks) || typeof cfg.vdj.historyFallback !== "boolean") {
    return "VirtualDJ polling settings are invalid";
  }

  if (!cfg.spout || typeof cfg.spout.enabled !== "boolean" || typeof cfg.spout.sender !== "string") {
    return "Spout settings are invalid";
  }
  if (!integerInRange(cfg.spout.fps, 1, 60) || !integerInRange(cfg.spout.quality, 20, 95)
    || !integerInRange(cfg.spout.maxWidth, 160, 4096)) {
    return "Spout capture settings are invalid";
  }

  if (!cfg.visual || !numberInRange(cfg.visual.logoSafe, 0, 0.3)
    || !numberInRange(cfg.visual.rotationSpeed, 0, 1.2)
    || !numberInRange(cfg.visual.logoSpin, 0, 2.4)
    || !numberInRange(cfg.visual.scale, 0.4, 2)
    || !numberInRange(cfg.visual.snap, 0, 1)) {
    return "visual settings are invalid";
  }
  if (typeof cfg.visual.preset !== "string" || typeof cfg.visual.palette !== "string"
    || typeof cfg.visual.alignment !== "string" || typeof cfg.visual.bloom !== "boolean"
    || typeof cfg.visual.snapAuto !== "boolean" || typeof cfg.visual.cubeFrame !== "boolean") {
    return "visual settings are invalid";
  }
  if (typeof cfg.nowPlaying?.txtPath !== "string" || typeof cfg.nowPlaying?.jsonPath !== "string") {
    return "now-playing paths are invalid";
  }
  return null;
}

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function integerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
