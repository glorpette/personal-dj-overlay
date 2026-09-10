import { loadConfig, saveConfig, type AppConfig } from "./config.ts";
import { log } from "./logger.ts";
import { AudioEngine } from "./audio/capture.ts";
import { VdjPoller } from "./vdj/poller.ts";
import { startServer } from "./server.ts";

async function main(): Promise<void> {
  let cfg = loadConfig();
  saveConfig(cfg);

  log.info("vdj-live-overlay starting", {
    config: process.env.VDJ_OVERLAY_CONFIG || "config.json",
    audioDevice: cfg.audio.device || "(auto)",
    vdj: `${cfg.vdj.host}:${cfg.vdj.port}`,
    nowPlaying: cfg.nowPlaying.txtPath,
  });

  const audio = new AudioEngine(cfg);
  const poller = new VdjPoller(cfg);

  const http = startServer({
    cfg,
    getConfig: () => cfg,
    setConfig: (next: AppConfig) => {
      cfg = next;
      audio.applyAudioConfig(next);
    },
    audio,
    poller,
  });

  audio.setHandlers(
    (frame) => http.broadcastFrame(frame),
    (status) => log.info("Audio status", status),
  );

  poller.start();
  await audio.start();

  const shutdown = async (signal: string) => {
    log.info(`Shutting down (${signal})`);
    poller.stop();
    await audio.stop();
    await http.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
