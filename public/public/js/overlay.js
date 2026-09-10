import * as THREE from "three";

const canvas = document.getElementById("c");
const params = new URLSearchParams(location.search);

const visual = {
  preset: params.get("preset") || "helix",
  palette: params.get("palette") || "cyan-magenta",
  bloom: params.get("bloom") !== "0",
  alignment: params.get("align") || "center",
  logoSafe: num(params.get("safe"), 0.12),
  rotationSpeed: num(params.get("spin"), 0.18),
  scale: num(params.get("scale"), 1),
  cameraYaw: num(params.get("yaw"), 0.15),
  cameraPitch: num(params.get("pitch"), 0.22),
};

const PALETTES = {
  "cyan-magenta": [0x19f3ff, 0xff2bd6, 0x7c5cff],
  "amber-ice": [0xffb347, 0x7ee0ff, 0xff6b4a],
  "lime-violet": [0xb8ff3c, 0x8a4dff, 0x36f1cd],
  "blood-gold": [0xff3355, 0xffd166, 0xff7a1a],
  "mono-ice": [0xe8f6ff, 0x7ec8ff, 0xffffff],
};

const PRESETS = ["helix", "ribbon", "wings", "tunnel", "burst"];

let latest = {
  rms: 0, peak: 0, bass: 0, mid: 0, high: 0,
  bins: new Array(64).fill(0),
  waveL: new Array(128).fill(0),
  waveR: new Array(128).fill(0),
};

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight, false);
renderer.autoClear = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 80);
const clock = new THREE.Clock();

const group = new THREE.Group();
scene.add(group);

const BAR = 64;
const WAVE = 128;
let meshes = [];
let presetName = "";

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function colors() {
  return PALETTES[visual.palette] || PALETTES["cyan-magenta"];
}
function col(i) {
  return new THREE.Color(colors()[i % colors().length]);
}

function glowMat(color, opacity = 0.85) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: visual.bloom ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function lineMat(color, opacity = 0.9) {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: visual.bloom ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
  });
}

function clearPreset() {
  for (const m of meshes) {
    group.remove(m);
    m.geometry?.dispose?.();
    if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose?.());
    else m.material?.dispose?.();
  }
  meshes = [];
}

function add(obj) {
  group.add(obj);
  meshes.push(obj);
  return obj;
}

function buildHelix() {
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.045, 0.045, 0.22),
    glowMat(col(0), 0.9),
    BAR * 2,
  );
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  add(inst);
  const dummy = new THREE.Object3D();
  inst.userData.dummy = dummy;
}

function buildRibbon() {
  const pts = [];
  for (let i = 0; i <= WAVE; i++) pts.push(new THREE.Vector3());
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  add(new THREE.Line(geo, lineMat(col(0))));
  const geo2 = new THREE.BufferGeometry().setFromPoints(pts.map(() => new THREE.Vector3()));
  add(new THREE.Line(geo2, lineMat(col(1))));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.012, 8, 96), glowMat(col(2), 0.35));
  add(ring);
}

function buildWings() {
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.07, 1, 0.07),
    glowMat(col(0)),
    BAR * 2,
  );
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.userData.dummy = new THREE.Object3D();
  add(inst);
}

function buildTunnel() {
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.08, 0.08, 0.55),
    glowMat(col(1)),
    BAR * 2,
  );
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.userData.dummy = new THREE.Object3D();
  add(inst);
}

function buildBurst() {
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.04, 1, 0.04),
    glowMat(col(0)),
    BAR,
  );
  inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  inst.userData.dummy = new THREE.Object3D();
  add(inst);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 16), glowMat(col(2), 0.7));
  add(core);
}

function rebuild() {
  clearPreset();
  presetName = visual.preset;
  if (!PRESETS.includes(presetName)) presetName = "helix";
  if (presetName === "helix") buildHelix();
  else if (presetName === "ribbon") buildRibbon();
  else if (presetName === "wings") buildWings();
  else if (presetName === "tunnel") buildTunnel();
  else buildBurst();
}

function applyAlignment(w, h) {
  const safe = visual.logoSafe;
  group.scale.setScalar(visual.scale);
  group.position.set(0, 0, 0);
  camera.fov = 42;
  const yaw = visual.cameraYaw;
  const pitch = visual.cameraPitch;
  if (visual.alignment === "bottom") {
    group.position.y = -1.15 + safe;
    camera.position.set(Math.sin(yaw) * 4.2, 1.6 + pitch, Math.cos(yaw) * 4.2);
  } else if (visual.alignment === "side") {
    group.position.x = 1.55;
    camera.position.set(Math.sin(yaw) * 3.6, 0.4 + pitch, Math.cos(yaw) * 4.6);
  } else if (visual.alignment === "frame") {
    group.position.y = 0.1;
    camera.position.set(0, 0.2, 5.1);
    camera.fov = 38;
  } else {
    camera.position.set(Math.sin(yaw) * 3.8, 0.85 + pitch * 2, Math.cos(yaw) * 4.4);
  }
  camera.lookAt(0, group.position.y * 0.35, 0);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function updateHelix(t) {
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  const bins = latest.bins;
  for (let strand = 0; strand < 2; strand++) {
    for (let i = 0; i < BAR; i++) {
      const a = (i / BAR) * Math.PI * 4 + t * (0.6 + visual.rotationSpeed) + strand * Math.PI;
      const y = (i / BAR - 0.5) * 3.4;
      const r = 0.85 + (bins[i] || 0) * (1.1 + latest.bass);
      dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      dummy.scale.set(1, 1, 0.6 + (bins[i] || 0) * 4.5);
      dummy.lookAt(0, y, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(strand * BAR + i, dummy.matrix);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.material.color.lerpColors(col(0), col(1), latest.mid);
}

function updateRibbon(t) {
  const lineA = meshes[0];
  const lineB = meshes[1];
  const posA = lineA.geometry.attributes.position;
  const posB = lineB.geometry.attributes.position;
  const n = posA.count;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = u * Math.PI * 2 + t * visual.rotationSpeed;
    const wL = latest.waveL[i % latest.waveL.length] || 0;
    const wR = latest.waveR[i % latest.waveR.length] || 0;
    const r1 = 1.35 + wL * 0.85 + latest.bass * 0.25;
    const r2 = 1.75 + wR * 0.7 + latest.high * 0.2;
    posA.setXYZ(i, Math.cos(a) * r1, Math.sin(a * 2) * 0.22 + wL * 0.4, Math.sin(a) * r1);
    posB.setXYZ(i, Math.cos(a) * r2, Math.sin(a * 3) * 0.16 + wR * 0.35, Math.sin(a) * r2);
  }
  posA.needsUpdate = true;
  posB.needsUpdate = true;
  meshes[2].rotation.x = t * 0.15;
  meshes[2].rotation.y = t * 0.22;
}

function updateWings() {
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    const wave = side === 0 ? latest.waveL : latest.waveR;
    for (let i = 0; i < BAR; i++) {
      const x = sign * (0.35 + i * 0.055);
      const amp = Math.abs(wave[Math.floor((i / BAR) * wave.length)] || 0);
      const h = 0.15 + amp * 2.6 + latest.bins[i] * 1.4;
      dummy.position.set(x, 0, 0);
      dummy.scale.set(1, h, 1);
      dummy.rotation.set(0, 0, sign * 0.18);
      dummy.updateMatrix();
      inst.setMatrixAt(side * BAR + i, dummy.matrix);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.material.color.lerpColors(col(0), col(1), latest.peak);
}

function updateTunnel(t) {
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < BAR; i++) {
      const a = (i / BAR) * Math.PI * 2 + t * 0.25 * (ring ? -1 : 1);
      const z = (ring === 0 ? -1.2 : 1.1) + Math.sin(t + i * 0.2) * 0.1;
      const r = 1.15 + (latest.bins[i] || 0) * 1.3 + latest.bass * 0.35;
      dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, z);
      dummy.lookAt(0, 0, z + 2);
      dummy.scale.set(1, 1, 0.4 + (latest.bins[i] || 0) * 3.2);
      dummy.updateMatrix();
      inst.setMatrixAt(ring * BAR + i, dummy.matrix);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
}

function updateBurst(t) {
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  for (let i = 0; i < BAR; i++) {
    const a = (i / BAR) * Math.PI * 2 + t * visual.rotationSpeed * 0.4;
    const len = 0.4 + (latest.bins[i] || 0) * 2.6 + latest.peak * 0.4;
    dummy.position.set(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0);
    dummy.rotation.z = a - Math.PI / 2;
    dummy.scale.set(1, len, 1);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  }
  inst.instanceMatrix.needsUpdate = true;
  meshes[1].scale.setScalar(0.7 + latest.bass * 1.8);
}

function tick() {
  const dt = clock.getDelta();
  const t = clock.elapsedTime;
  if (presetName !== visual.preset) rebuild();
  group.rotation.y += dt * visual.rotationSpeed * (0.25 + latest.mid);
  if (presetName === "helix") updateHelix(t);
  else if (presetName === "ribbon") updateRibbon(t);
  else if (presetName === "wings") updateWings();
  else if (presetName === "tunnel") updateTunnel(t);
  else updateBurst(t);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  applyAlignment(w, h);
}

addEventListener("resize", resize);
rebuild();
resize();
requestAnimationFrame(tick);

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "frame" && msg.frame) {
      latest = msg.frame;
    } else if (msg.type === "hello" || msg.type === "config") {
      if (msg.visual) Object.assign(visual, msg.visual);
      if (!params.get("preset") && msg.visual?.preset) visual.preset = msg.visual.preset;
      rebuild();
      resize();
    }
  };
  ws.onclose = () => setTimeout(connect, 800);
}
connect();
