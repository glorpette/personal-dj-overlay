import { loadConfig } from "./config.ts";
import { listDevices, matchDevice } from "./audio/devices.ts";
import { VdjClient } from "./vdj/client.ts";
import { defaultHistoryDir } from "./vdj/history.ts";
import { existsSync } from "node:fs";

const cfg = loadConfig();
console.log("Config OK");
console.log(`  overlay  http://${cfg.server.host}:${cfg.server.port}/overlay`);
console.log(`  admin    http://${cfg.server.host}:${cfg.server.port}/admin`);
console.log(`  nowplaying txt  ${cfg.nowPlaying.txtPath}`);
console.log(`  nowplaying json ${cfg.nowPlaying.jsonPath}`);

const devices = await listDevices();
console.log(`\nAudio devices (${devices.length}):`);
const match = matchDevice(devices, cfg.audio.device);
for (const d of devices.slice(0, 20)) {
  const sel = match && d.id === match.id ? " <-- selected" : "";
  console.log(`  - ${d.name} [${d.kind}/${d.backend}]${sel}`);
}

const client = new VdjClient(cfg.vdj.host, cfg.vdj.port, cfg.vdj.bearer);
const ok = await client.ping();
console.log(`\nVirtualDJ Network Control @ ${client.baseUrl}: ${ok ? "OK" : "UNREACHABLE"}`);
if (!ok) {
  console.log("  Enable Config → Extensions → Effects → Other → Network Control");
  console.log("  Then Master panel → Auto-Start → Network Control, set port", cfg.vdj.port);
}

const hist = cfg.vdj.historyDir || defaultHistoryDir();
console.log(`History dir: ${hist} (${existsSync(hist) ? "exists" : "missing"})`);
