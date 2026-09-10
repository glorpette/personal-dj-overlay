import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";
import { log } from "../logger.ts";
import type { AudioDevice } from "./types.ts";
import { listWasapiRenderDevices } from "./backends/wasapi.ts";

const execFileAsync = promisify(execFile);

export async function listDevices(): Promise<AudioDevice[]> {
  const os = platform();
  const devices: AudioDevice[] = [];

  if (os === "win32") {
    try {
      devices.push(...(await listWasapiRenderDevices()));
    } catch (err) {
      log.warn("Native WASAPI device list failed", err);
    }
    devices.push(...(await listFfmpegWasapi()));
    devices.push(...(await listFfmpegDshow()));
  } else if (os === "linux") {
    devices.push(...(await listPulse()));
    devices.push(...(await listFfmpegPulse()));
  } else if (os === "darwin") {
    devices.push(...(await listAvfoundation()));
  }

  devices.push({
    id: "demo",
    name: "Demo oscillator (test pattern — not live audio)",
    kind: "demo",
    backend: "demo",
  });
  return dedupe(devices);
}

async function listPulse(): Promise<AudioDevice[]> {
  const out: AudioDevice[] = [];
  try {
    const { stdout } = await execFileAsync("pactl", ["list", "short", "sources"], { timeout: 4000 });
    for (const line of stdout.split("\n")) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 2) continue;
      const name = cols[1];
      const monitor = name.includes(".monitor") || cols.join(" ").includes("monitor");
      out.push({
        id: `pulse:${name}`,
        name,
        kind: monitor ? "monitor" : "input",
        backend: "pulse",
        raw: line.trim(),
        default: name.includes(".monitor"),
      });
    }
  } catch {
    /* pactl missing */
  }
  return out;
}

async function listFfmpegPulse(): Promise<AudioDevice[]> {
  const text = await ffmpegList(["-f", "pulse", "-list_devices", "true", "-i", "dummy"]);
  return parseFfmpegList(text, "ffmpeg-pulse", "monitor");
}

async function listFfmpegWasapi(): Promise<AudioDevice[]> {
  const text = await ffmpegList(["-f", "wasapi", "-list_devices", "true", "-i", "dummy"]);
  return parseFfmpegList(text, "ffmpeg-wasapi", "output-loopback");
}

async function listFfmpegDshow(): Promise<AudioDevice[]> {
  const text = await ffmpegList(["-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
  return parseFfmpegList(text, "ffmpeg-dshow", "input");
}

async function listAvfoundation(): Promise<AudioDevice[]> {
  const text = await ffmpegList(["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  return parseFfmpegList(text, "ffmpeg-avf", "input");
}

async function ffmpegList(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync("ffmpeg", ["-hide_banner", ...args], { timeout: 5000 });
    return `${stderr}\n${stdout}`;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stderr ?? ""}\n${e.stdout ?? ""}`;
  }
}

function parseFfmpegList(text: string, backend: string, fallbackKind: AudioDevice["kind"]): AudioDevice[] {
  const out: AudioDevice[] = [];
  let section: "audio" | "video" | "other" = "other";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/audio devices/i.test(line)) section = "audio";
    if (/video devices/i.test(line)) section = "video";
    if (section !== "audio" && !/wasapi|pulse/i.test(backend)) continue;
    const quoted = line.match(/"([^"]+)"/);
    const alt = line.match(/\[(?:in|out)\]\s+(.+)$/i);
    const name = quoted?.[1] ?? alt?.[1];
    if (!name) continue;
    const monitor = /monitor|loopback|stereo mix|what you hear/i.test(name);
    out.push({
      id: `${backend}:${name}`,
      name,
      kind: monitor ? "monitor" : fallbackKind,
      backend: backend.startsWith("ffmpeg") ? "ffmpeg" : backend,
      raw: line,
    });
  }
  return out;
}

function dedupe(list: AudioDevice[]): AudioDevice[] {
  const seen = new Set<string>();
  const out: AudioDevice[] = [];
  for (const d of list) {
    const key = `${d.backend}|${d.name.toLowerCase()}|${d.raw ?? d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export function matchDevice(devices: AudioDevice[], wanted: string): AudioDevice | null {
  if (!wanted) {
    return (
      devices.find((d) => d.backend === "wasapi" && d.default) ||
      devices.find((d) => d.kind === "output-loopback" && d.default) ||
      devices.find((d) => d.backend === "wasapi") ||
      devices.find((d) => d.kind === "output-loopback") ||
      devices.find((d) => d.kind === "monitor") ||
      null
    );
  }
  const q = wanted.toLowerCase().trim();
  return (
    devices.find((d) => d.id.toLowerCase() === q) ||
    devices.find((d) => (d.raw || "").toLowerCase() === q) ||
    devices.find((d) => d.name.toLowerCase() === q) ||
    devices.find((d) => d.id.toLowerCase().endsWith(q)) ||
    devices.find((d) => d.name.toLowerCase().includes(q)) ||
    devices.find((d) => d.id.toLowerCase().includes(q)) ||
    null
  );
}
