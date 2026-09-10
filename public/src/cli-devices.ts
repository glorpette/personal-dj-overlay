import { listDevices } from "./audio/devices.ts";

const devices = await listDevices();
if (!devices.length) {
  console.log("No devices found.");
  process.exit(1);
}
for (const d of devices) {
  const mark = d.default ? " *" : "  ";
  console.log(`${mark}[${d.kind.padEnd(16)}] ${d.backend.padEnd(10)}  ${d.name}`);
}
console.log("\nCopy a name into config.json → audio.device");
