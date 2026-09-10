import { spawn } from "node:child_process";
import { loadConfig, saveConfig, type AppConfig } from "./config.ts";
import { log } from "./logger.ts";
import { AudioEngine } from "./audio/capture.ts";
import { VdjPoller } from "./vdj/poller.ts";
import { SpoutEngine } from "./spout/receiver.ts";
import { startServer } from "./server.ts";
import { readAssetText } from "./runtime/assets.ts";
import { installFfmpeg } from "./runtime/ffmpeg-installer.ts";
import { runCheck, runDevices } from "./runtime/commands.ts";
import { paint, section } from "./terminal.ts";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--debug")) process.env.VDJ_OVERLAY_DEBUG = "1";
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }
  if (args.has("--licenses")) {
    const notices = readAssetText("licenses/THIRD_PARTY_NOTICES.txt");
    if (!notices) throw new Error("Third-party notices are not available.");
    process.stdout.write(notices);
    return;
  }
  if (args.has("--install-ffmpeg")) {
    const path = await installFfmpeg();
    console.log(`${paint("FFmpeg ready", "green")}  ${paint(path, "dim")}`);
    return;
  }
  if (args.has("--check")) {
    await runCheck();
    return;
  }
  if (args.has("--devices")) {
    await runDevices();
    return;
  }

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
  const spout = new SpoutEngine(cfg);

  const http = startServer({
    cfg,
    getConfig: () => cfg,
    setConfig: (next: AppConfig) => {
      cfg = next;
      audio.applyAudioConfig(next);
      spout.applyConfig(next);
    },
    audio,
    poller,
    spout,
  });
  if (process.platform === "win32" && !args.has("--no-open")) {
    const url = adminUrl(cfg);
    const open = () => {
      const child = spawn("explorer.exe", [url], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
    };
    if (http.server.listening) setTimeout(open, 350);
    else http.server.once("listening", () => setTimeout(open, 350));
  }

  let lastAudioStatus = "";
  audio.setHandlers(
    (frame) => http.broadcastFrame(frame),
    (status) => {
      const key = JSON.stringify(status);
      if (key === lastAudioStatus) return;
      lastAudioStatus = key;
      log.info("Audio status", status);
    },
  );
  spout.setHandlers(
    (jpeg) => http.broadcastSpoutFrame(jpeg),
    (status) => http.broadcastSpoutStatus(status),
  );

  poller.start();
  await audio.start();
  await spout.start();

  const shutdown = async (signal: string) => {
    log.info(`Shutting down (${signal})`);
    poller.stop();
    await spout.stop();
    await audio.stop();
    await http.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function adminUrl(cfg: AppConfig): string {
  const host = cfg.server.host === "0.0.0.0" || cfg.server.host === "::" ? "127.0.0.1" : cfg.server.host;
  return `http://${host}:${cfg.server.port}/admin`;
}

function printHelp(): void {
  console.log([
    section("VDJ Live Overlay"),
    "",
    "  (default)          Start the overlay and open the admin dashboard",
    "  --no-open          Start without opening a browser",
    "  --debug            Show low-level capture and helper diagnostics",
    "  --check            Validate config, devices, VirtualDJ, and history",
    "  --devices          List detected audio devices",
    "  --install-ffmpeg   Download and verify the optional LGPL FFmpeg build",
    "  --licenses         Print bundled third-party notices",
    "  --help             Show this help",
  ].join("\n"));
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
