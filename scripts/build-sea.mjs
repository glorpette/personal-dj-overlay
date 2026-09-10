import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SEA_DIR = join(DIST, ".sea");
const BUNDLE = join(SEA_DIR, "index.cjs");
const SEA_CONFIG = join(SEA_DIR, "sea-config.json");
const SEA_BLOB = join(SEA_DIR, "sea-prep.blob");
const OUTPUT = join(DIST, "VDJLiveOverlay.exe");
const SENTINEL = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const PUBLIC_FILES = [
  "admin.html",
  "display.html",
  "overlay.html",
  "css/admin.css",
  "css/overlay.css",
  "img/unc-logo.png",
  "img/unc-logo.svg",
  "js/admin.js",
  "js/overlay.js",
  "vendor/SVGLoader.js",
  "vendor/three.module.js",
];

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("The Windows SEA build must run with a Windows x64 Node executable.");
}
if (Number(process.versions.node.split(".")[0]) < 24) {
  throw new Error(`Node 24 or newer is required for the packaging build; received ${process.version}.`);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(SEA_DIR, { recursive: true });

const helperAssets = {
  "helpers/WasapiLoopback.exe": stageHelper(
    "WasapiLoopback.exe",
    join(ROOT, "helpers", "wasapi-loopback", "WasapiLoopback.cs"),
    ["/platform:x64"],
  ),
  "helpers/SpoutReceiver.exe": stageHelper(
    "SpoutReceiver.exe",
    join(ROOT, "helpers", "spout-receiver", "SpoutReceiver.cs"),
    ["/platform:x64", "/r:System.Drawing.dll"],
  ),
};

step("Bundling application");
await build({
  entryPoints: [join(ROOT, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: BUNDLE,
  logLevel: "silent",
});

const assets = {
  ...Object.fromEntries(PUBLIC_FILES.map((file) => [`public/${file}`, join(ROOT, "public", file)])),
  "licenses/THIRD_PARTY_NOTICES.txt": join(ROOT, "licenses", "THIRD_PARTY_NOTICES.txt"),
  ...helperAssets,
};
for (const [key, file] of Object.entries(assets)) {
  if (!existsSync(file)) throw new Error(`Missing packaging asset ${key}: ${file}`);
}

writeFileSync(SEA_CONFIG, JSON.stringify({
  main: BUNDLE,
  output: SEA_BLOB,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
  assets,
}, null, 2));

step("Preparing embedded application");
run(process.execPath, ["--experimental-sea-config", SEA_CONFIG]);
copyFileSync(process.execPath, OUTPUT);

const postjectCli = join(ROOT, "node_modules", "postject", "dist", "cli.js");
if (!existsSync(postjectCli)) throw new Error(`postject CLI not found: ${postjectCli}`);
step("Injecting single executable");
run(process.execPath, [postjectCli, OUTPUT, "NODE_SEA_BLOB", SEA_BLOB, "--sentinel-fuse", SENTINEL]);
rmSync(SEA_DIR, { recursive: true, force: true });

copyFileSync(join(ROOT, "config.example.json"), join(DIST, "config.example.json"));
mkdirSync(join(DIST, "licenses"), { recursive: true });
copyFileSync(join(ROOT, "licenses", "THIRD_PARTY_NOTICES.txt"), join(DIST, "licenses", "THIRD_PARTY_NOTICES.txt"));

const manifest = [
  "VDJ Live Overlay Windows x64 SEA build",
  `Node: ${process.version}`,
  `Executable SHA-256: ${sha256File(OUTPUT)}`,
  "",
  "The executable contains the application bundle, frontend assets, third-party notices, and native helper binaries.",
  "config.json and data/ are intentionally external and are created beside the executable at first launch.",
].join("\n");
writeFileSync(join(DIST, "BUILD-MANIFEST.txt"), `${manifest}\n`, "utf8");
console.log(`[build] Done: ${OUTPUT}`);

function stageHelper(name, source, cscFlags) {
  const target = join(SEA_DIR, "helpers", name);
  mkdirSync(dirname(target), { recursive: true });
  const csc = findCsc();
  if (csc && existsSync(source)) {
    step(`Compiling ${name}`);
    try {
      const output = execFileSync(csc, ["/nologo", "/optimize+", "/t:exe", ...cscFlags, `/out:${target}`, source], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (output.trim()) console.warn(output.trim());
    } catch (error) {
      throw new Error(`Failed to compile ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const fallback = prebuiltHelper(name);
    if (!fallback) {
      throw new Error(`${name} cannot be built: csc.exe was not found and no prebuilt helper was available.`);
    }
    console.warn(`[build] csc.exe not found; using prebuilt helper ${fallback}`);
    copyFileSync(fallback, target);
  }
  assertX64Pe(target, name);
  return target;
}

function findCsc() {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    process.env.CSC,
    join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) || null;
}

function prebuiltHelper(name) {
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const candidates = [
    process.env[name === "WasapiLoopback.exe" ? "WASAPI_HELPER" : "SPOUT_HELPER"],
    join(local, "vdj-live-overlay", name),
  ].filter(Boolean);
  return candidates.find((file) => existsSync(file)) || null;
}

function assertX64Pe(file, name) {
  const data = readFileSync(file);
  if (data.length < 0x40 || data.readUInt16LE(0) !== 0x5a4d) throw new Error(`${name} is not a Windows PE executable.`);
  const peOffset = data.readUInt32LE(0x3c);
  if (peOffset + 6 > data.length || data.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error(`${name} has an invalid PE header.`);
  }
  const machine = data.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) throw new Error(`${name} is not x64 (machine 0x${machine.toString(16)}).`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${command} exited with code ${result.status ?? "unknown"}.${output ? `\n${output}` : ""}`);
  }
}

function step(message) {
  console.log(`[build] ${message}`);
}
