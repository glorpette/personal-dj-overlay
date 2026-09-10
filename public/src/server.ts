import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppConfig } from "./config.ts";
import { applyPartial, saveConfig } from "./config.ts";
import { log } from "./logger.ts";
import { listDevices } from "./audio/devices.ts";
import type { AudioEngine } from "./audio/capture.ts";
import type { VdjPoller } from "./vdj/poller.ts";
import type { SpectrumFrame } from "./audio/types.ts";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));

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
}): { server: ReturnType<typeof createServer>; broadcastFrame: (f: SpectrumFrame) => void; close: () => Promise<void> } {
  let cfg = opts.cfg;
  const sockets = new Set<WebSocket>();

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

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "hello", visual: cfg.visual, audio: statusAudio(), nowPlaying: opts.poller.getState() }));
    ws.on("close", () => sockets.delete(ws));
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

    if (path === "/" || path === "/overlay") return sendFile(res, join(PUBLIC_DIR, "overlay.html"));
    if (path === "/admin") return sendFile(res, join(PUBLIC_DIR, "admin.html"));
    if (path === "/display") return sendFile(res, join(PUBLIC_DIR, "display.html"));

    if (path === "/api/health") return json(res, { ok: true, audio: statusAudio(), vdj: opts.poller.getState() });
    if (path === "/api/nowplaying") return json(res, opts.poller.getState());
    if (path === "/api/config" && req.method === "GET") return json(res, opts.getConfig());
    if (path === "/api/devices") return json(res, { devices: await listDevices() });

    if (path === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      const patch = JSON.parse(body || "{}");
      const next = applyPartial(opts.getConfig(), patch);
      saveConfig(next);
      opts.setConfig(next);
      cfg = next;
      opts.audio.applyAudioConfig(next);
      opts.poller.configure(next);
      const msg = JSON.stringify({ type: "config", visual: next.visual, audio: next.audio });
      for (const ws of sockets) if (ws.readyState === 1) ws.send(msg);
      if (patch.audio?.device != null || patch.audio?.backend != null) {
        void opts.audio.restart();
      }
      return json(res, next);
    }

    if (path === "/api/audio/restart" && req.method === "POST") {
      void opts.audio.restart();
      return json(res, { ok: true });
    }

    if (path.startsWith("/public/")) {
      return sendFile(res, join(PUBLIC_DIR, path.slice("/public/".length)));
    }
    // static assets referenced as /css /js
    const staticPath = join(PUBLIC_DIR, path.replace(/^\/+/, ""));
    if (existsSync(staticPath) && statSync(staticPath).isFile()) return sendFile(res, staticPath);

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

  server.listen(cfg.server.port, cfg.server.host, () => {
    log.info(`HTTP overlay on http://${cfg.server.host}:${cfg.server.port}/overlay`);
    log.info(`Admin UI        http://${cfg.server.host}:${cfg.server.port}/admin`);
    log.info(`Sample display  http://${cfg.server.host}:${cfg.server.port}/display`);
  });

  return {
    server,
    broadcastFrame,
    close: () =>
      new Promise((resolveClose) => {
        wss.close();
        server.close(() => resolveClose());
      }),
  };
}

function sendFile(res: ServerResponse, filePath: string): void {
  const resolved = resolve(filePath);
  if (!resolved.startsWith(PUBLIC_DIR) && !normalize(resolved).startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!existsSync(resolved)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const ext = extname(resolved).toLowerCase();
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=30",
  });
  res.end(readFileSync(resolved));
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
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
