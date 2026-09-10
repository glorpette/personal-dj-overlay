import { existsSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { listDevices, matchDevice } from "../audio/devices.ts";
import { defaultHistoryDir } from "../vdj/history.ts";
import { VdjClient } from "../vdj/client.ts";
import { label, paint, section, status } from "../terminal.ts";

if (process.argv.includes("--debug")) process.env.VDJ_OVERLAY_DEBUG = "1";

export async function runCheck(): Promise<void> {
  const cfg = loadConfig();
  const base = `http://${cfg.server.host}:${cfg.server.port}`;

  console.log(section("Configuration"));
  console.log(`  ${status(true)}  ${label("Overlay")} ${base}/overlay`);
  console.log(`  ${label("Admin")} ${base}/admin`);
  console.log(`  ${label("Now playing")} ${cfg.nowPlaying.txtPath}`);
  console.log(`  ${label("JSON output")} ${cfg.nowPlaying.jsonPath}`);

  const devices = await listDevices();
  console.log(`\n${section("Audio devices")} ${paint(`${devices.length} found`, "dim")}`);
  const match = matchDevice(devices, cfg.audio.device);
  for (const device of devices.slice(0, 20)) {
    const selected = Boolean(match && device.id === match.id);
    const marker = selected ? paint("*", "green") : " ";
    const details = paint(`${device.kind} / ${device.backend}`, "dim");
    console.log(`  ${marker} ${device.name}  ${details}${selected ? paint("  selected", "green") : ""}`);
    if (process.env.VDJ_OVERLAY_DEBUG) console.log(`      ${paint(`id=${device.id}`, "dim")}`);
  }

  const client = new VdjClient(cfg.vdj.host, cfg.vdj.port, cfg.vdj.bearer);
  const ok = await client.ping();
  console.log(`\n${section("VirtualDJ")} ${status(ok, "OK", "UNREACHABLE")}  ${paint(client.baseUrl, "dim")}`);
  if (!ok) {
    console.log(`  ${paint("!", "yellow")} Enable Network Control in VirtualDJ`);
    console.log(`    ${paint("Config -> Extensions -> Effects -> Other -> Network Control", "dim")}`);
    console.log(`    ${paint(`Auto-Start it from the Master panel (port ${cfg.vdj.port})`, "dim")}`);
  }

  const history = cfg.vdj.historyDir || defaultHistoryDir();
  const historyExists = existsSync(history);
  console.log(`\n${section("History fallback")} ${status(historyExists, "AVAILABLE", "MISSING")}  ${paint(history, "dim")}`);
}

export async function runDevices(): Promise<void> {
  const devices = await listDevices();
  if (!devices.length) {
    console.log(paint("No audio devices found.", "red"));
    process.exitCode = 1;
    return;
  }
  console.log(`${section("Audio devices")} ${paint(`${devices.length} found`, "dim")}`);
  for (const device of devices) {
    const mark = device.default ? paint("*", "green") : " ";
    const details = paint(`${device.kind} / ${device.backend}`, "dim");
    console.log(`  ${mark} ${device.name}  ${details}`);
    if (process.env.VDJ_OVERLAY_DEBUG) console.log(`      ${paint(`id=${device.id}`, "dim")}`);
  }
  console.log(`\n${paint("Tip", "cyan")} Copy a device name into ${paint("config.json -> audio.device", "bold")}`);
}
