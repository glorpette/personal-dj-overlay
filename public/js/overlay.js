import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";

const canvas = document.getElementById("c");
const params = new URLSearchParams(location.search);
const cubeFrameOverride = params.has("cubeframe") ? params.get("cubeframe") !== "0" : null;

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
  logoSpin: num(params.get("logospin"), 0.35),
  snap: num(params.get("snap"), 0.35),
  snapAuto: params.get("snapauto") !== "0",
  cubeFrame: cubeFrameOverride ?? false,
};

const PALETTES = {
  "cyan-magenta": [0x19f3ff, 0xff2bd6, 0x7c5cff],
  "amber-ice": [0xffb347, 0x7ee0ff, 0xff6b4a],
  "lime-violet": [0xb8ff3c, 0x8a4dff, 0x36f1cd],
  "blood-gold": [0xff3355, 0xffd166, 0xff7a1a],
  "mono-ice": [0xe8f6ff, 0x7ec8ff, 0xffffff],
};

let audioSensitivity = 1.15;

const PRESETS = ["helix", "ribbon", "wings", "tunnel", "burst", "cube", "mirrored-bars"];

function emptyFrame() {
  return {
    rms: 0, peak: 0, bass: 0, mid: 0, high: 0,
    bins: new Array(64).fill(0),
    waveL: new Array(128).fill(0),
    waveR: new Array(128).fill(0),
  };
}
const target = emptyFrame();
const audio = emptyFrame();

function copyFrame(src, dest) {
  dest.rms = src.rms || 0;
  dest.peak = src.peak || 0;
  dest.bass = src.bass || 0;
  dest.mid = src.mid || 0;
  dest.high = src.high || 0;
  if (src.bins) {
    const n = Math.min(dest.bins.length, src.bins.length);
    for (let i = 0; i < n; i++) dest.bins[i] = src.bins[i] || 0;
  }
  if (src.waveL) {
    const n = Math.min(dest.waveL.length, src.waveL.length);
    for (let i = 0; i < n; i++) dest.waveL[i] = src.waveL[i] || 0;
  }
  if (src.waveR) {
    const n = Math.min(dest.waveR.length, src.waveR.length);
    for (let i = 0; i < n; i++) dest.waveR[i] = src.waveR[i] || 0;
  }
}

function follow(cur, nxt, up, down) {
  const k = nxt > cur ? up : down;
  return cur + (nxt - cur) * k;
}

function smoothAudio(dt) {
  const up = 1 - Math.exp(-dt / 0.038);
  const down = 1 - Math.exp(-dt / 0.078);
  audio.rms = follow(audio.rms, target.rms, up, down);
  audio.peak = follow(audio.peak, target.peak, up, down);
  audio.bass = follow(audio.bass, target.bass, up, down);
  audio.mid = follow(audio.mid, target.mid, up, down);
  audio.high = follow(audio.high, target.high, up, down);
  for (let i = 0; i < audio.bins.length; i++) {
    audio.bins[i] = follow(audio.bins[i], target.bins[i] || 0, up, down);
  }
  const wUp = 1 - Math.exp(-dt / 0.028);
  const wDown = 1 - Math.exp(-dt / 0.055);
  for (let i = 0; i < audio.waveL.length; i++) {
    audio.waveL[i] = follow(audio.waveL[i], target.waveL[i] || 0, wUp, wDown);
    audio.waveR[i] = follow(audio.waveR[i], target.waveR[i] || 0, wUp, wDown);
  }
}

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
// Keep the main overlay at native CSS resolution. The renderer still uses
// MSAA, while avoiding the quadratic fill-rate cost of high-DPI browser
// sources (especially when OBS scales the canvas again).
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.0));
renderer.setSize(innerWidth, innerHeight, false);
renderer.autoClear = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.sortObjects = true;

const scene = new THREE.Scene();
scene.background = null;
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 80);
const clock = new THREE.Clock();

const cameraPanel = document.getElementById("camera-panel");
const spoutCanvas = document.getElementById("spout-canvas");
const spoutStatusEl = document.getElementById("spout-status");
const SPOUT_STALE_MS = 1500;
const SPOUT_FIRST_FRAME_TIMEOUT_MS = 8000;
let spoutEnabled = false;
let spoutPanelVisible = false;
let spoutState = "disabled";
let spoutSocket = null;
let spoutReconnectTimer = null;
let spoutRevealTimer = null;
let spoutGeneration = 0;
let spoutDecodeBusy = false;
let spoutQueuedFrame = null;
let spoutPendingFrame = null;
let spoutDisplayedFrame = null;
let spoutLastFrameAt = 0;
let spoutStale = false;
let spoutWebglFailed = false;
let spoutRenderer = null;
let spoutScene = null;
let spoutCamera = null;
let spoutTexture = null;
let spoutMesh = null;
let spoutNeedsRender = false;

function setSpoutStatus(text) {
  if (spoutWebglFailed && text !== "DISABLED") text = "WEBGL ERROR";
  if (spoutStatusEl) spoutStatusEl.textContent = text;
}

function initSpoutView() {
  if (!spoutCanvas) return;
  try {
    spoutRenderer = new THREE.WebGLRenderer({
      canvas: spoutCanvas,
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
    spoutRenderer.setClearColor(0x0a080c, 1);
    spoutRenderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.0));

    spoutScene = new THREE.Scene();
    spoutCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    spoutCamera.position.z = 1;
    // ImageBitmap/HTMLImageElement sources require a regular Texture, not DataTexture.
    spoutTexture = new THREE.Texture();
    spoutTexture.colorSpace = THREE.SRGBColorSpace;
    spoutTexture.minFilter = THREE.LinearFilter;
    spoutTexture.magFilter = THREE.LinearFilter;
    spoutTexture.generateMipmaps = false;
    spoutMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        map: spoutTexture,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    spoutMesh.visible = false;
    spoutScene.add(spoutMesh);
    resizeSpoutView();
  } catch (err) {
    spoutWebglFailed = true;
    setSpoutStatus("WEBGL ERROR");
    console.error("Spout WebGL init failed", err);
  }
}

function resizeSpoutView() {
  if (!spoutRenderer || !spoutCanvas) return;
  const rect = spoutCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  spoutRenderer.setSize(width, height, false);
  spoutNeedsRender = true;
}

function clearSpoutFrames() {
  spoutQueuedFrame = null;
  releaseSpoutFrame(spoutPendingFrame);
  releaseSpoutFrame(spoutDisplayedFrame);
  spoutPendingFrame = null;
  spoutDisplayedFrame = null;
  spoutLastFrameAt = 0;
  spoutStale = false;
  if (spoutMesh) spoutMesh.visible = false;
  if (spoutTexture) {
    spoutTexture.image = null;
    spoutTexture.needsUpdate = true;
  }
  spoutNeedsRender = true;
}

function releaseSpoutFrame(frame) {
  frame?.cleanup?.();
}

function clearSpoutRevealTimer() {
  if (spoutRevealTimer) {
    clearTimeout(spoutRevealTimer);
    spoutRevealTimer = null;
  }
}

function revealSpoutPanel(generation) {
  if (!cameraPanel || !spoutEnabled || generation !== spoutGeneration || spoutPanelVisible) return;
  clearSpoutRevealTimer();
  spoutPanelVisible = true;
  cameraPanel.classList.remove("hidden", "out", "preparing");
  cameraPanel.classList.remove("in");
  void cameraPanel.offsetWidth;
  cameraPanel.classList.add("in");
  cameraPanel.setAttribute("aria-hidden", "false");
  resizeSpoutView();
}

function setSpoutEnabled(enabled) {
  const next = Boolean(enabled);
  if (spoutEnabled === next) return;
  spoutEnabled = next;
  spoutGeneration++;
  const generation = spoutGeneration;
  clearSpoutRevealTimer();
  if (!cameraPanel) return;

  if (spoutEnabled) {
    clearSpoutFrames();
    spoutPanelVisible = false;
    cameraPanel.classList.remove("hidden", "out", "in");
    cameraPanel.classList.add("preparing");
    cameraPanel.setAttribute("aria-hidden", "true");
    setSpoutStatus("SEARCHING");
    resizeSpoutView();
    spoutRevealTimer = setTimeout(() => {
      spoutRevealTimer = null;
      if (spoutEnabled && generation === spoutGeneration && !spoutPanelVisible) {
        setSpoutStatus("NO SIGNAL");
      }
    }, SPOUT_FIRST_FRAME_TIMEOUT_MS);
    return;
  }

  const wasVisible = spoutPanelVisible;
  spoutPanelVisible = false;
  setSpoutStatus("DISABLED");
  cameraPanel.setAttribute("aria-hidden", "true");
  if (!wasVisible) {
    clearSpoutFrames();
    cameraPanel.classList.remove("in", "out", "preparing");
    cameraPanel.classList.add("hidden");
    return;
  }
  cameraPanel.classList.remove("in", "preparing");
  cameraPanel.classList.remove("in");
  cameraPanel.classList.add("out");
  window.setTimeout(() => {
    if (!spoutEnabled && generation === spoutGeneration) {
      clearSpoutFrames();
      cameraPanel.classList.remove("out");
      cameraPanel.classList.add("hidden");
    }
  }, 420);
}

function applySpoutStatus(status) {
  if (!status) return;
  spoutState = status.state || spoutState;
  if (!spoutEnabled) {
    setSpoutStatus("DISABLED");
  } else if (status.error) {
    setSpoutStatus("ERROR");
  } else if (spoutLastFrameAt && performance.now() - spoutLastFrameAt <= SPOUT_STALE_MS) {
    setSpoutStatus("CLUB CAM");
  } else if (status.state === "connected") {
    setSpoutStatus("SEARCHING");
  } else if (status.state === "waiting" || status.state === "open-failed") {
    setSpoutStatus("SEARCHING");
  } else {
    setSpoutStatus(String(status.state || "SEARCHING").toUpperCase());
  }
}

function receiveSpoutFrame(data) {
  if (!spoutEnabled) return;
  spoutQueuedFrame = data;
  if (!spoutDecodeBusy) void decodeSpoutFrames();
}

async function decodeSpoutFrames() {
  spoutDecodeBusy = true;
  try {
    while (spoutQueuedFrame && spoutEnabled) {
      const payload = spoutQueuedFrame;
      spoutQueuedFrame = null;
      const generation = spoutGeneration;
      try {
         const blob = payload instanceof Blob && payload.type
           ? payload
           : new Blob([payload], { type: "image/jpeg" });
        const frame = await decodeSpoutFrame(blob);
        if (!spoutEnabled || generation !== spoutGeneration) {
          releaseSpoutFrame(frame);
          break;
        }
         releaseSpoutFrame(spoutPendingFrame);
          spoutPendingFrame = frame;
          spoutLastFrameAt = performance.now();
          spoutStale = false;
          spoutNeedsRender = true;
      } catch (err) {
        console.warn("Spout JPEG decode failed", err);
        setSpoutStatus("DECODE ERROR");
      }
    }
  } finally {
    spoutDecodeBusy = false;
    if (spoutQueuedFrame && spoutEnabled) void decodeSpoutFrames();
  }
}

async function decodeSpoutFrame(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, cleanup: () => bitmap.close() };
    } catch (err) {
      console.warn("createImageBitmap failed; trying image fallback", err);
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve({
      source: image,
      cleanup: () => {
        image.removeAttribute("src");
        URL.revokeObjectURL(url);
      },
    });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("JPEG image fallback failed"));
    };
    image.src = url;
  });
}

function renderSpout() {
  if (!spoutRenderer || !spoutEnabled || !spoutMesh) return;
  let submitted = false;
  if (spoutPendingFrame) {
    const old = spoutDisplayedFrame;
    spoutDisplayedFrame = spoutPendingFrame;
    spoutPendingFrame = null;
    spoutTexture.image = spoutDisplayedFrame.source;
    spoutTexture.needsUpdate = true;
    spoutMesh.visible = true;
    submitted = true;
    spoutNeedsRender = true;
    releaseSpoutFrame(old);
  }
  if (spoutLastFrameAt && performance.now() - spoutLastFrameAt > SPOUT_STALE_MS) {
    if (!spoutStale) {
      spoutStale = true;
      setSpoutStatus("STALE");
    }
  }
  if (!spoutNeedsRender) return;
  try {
    spoutRenderer.render(spoutScene, spoutCamera);
    spoutNeedsRender = false;
    if (submitted) {
      setSpoutStatus("CLUB CAM");
      revealSpoutPanel(spoutGeneration);
    }
  } catch (err) {
    if (!spoutPanelVisible) spoutMesh.visible = false;
    spoutWebglFailed = true;
    setSpoutStatus("WEBGL ERROR");
    console.error("Spout WebGL render failed", err);
  }
}

function connectSpout() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/spout`);
  spoutSocket = ws;
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "status") applySpoutStatus(msg.status);
      } catch {
        /* ignore malformed status messages */
      }
      return;
    }
    receiveSpoutFrame(ev.data);
  };
  ws.onclose = () => {
    if (spoutSocket !== ws) return;
    spoutSocket = null;
    if (spoutReconnectTimer) clearTimeout(spoutReconnectTimer);
    spoutReconnectTimer = setTimeout(() => {
      spoutReconnectTimer = null;
      connectSpout();
    }, 1000);
  };
  ws.onerror = () => ws.close();
}

const group = new THREE.Group();
const waveGroup = new THREE.Group();
const logoGroup = new THREE.Group();
const snapGroup = new THREE.Group();
scene.add(group);
group.add(waveGroup);
group.add(logoGroup);
group.add(snapGroup);
// Keep the visual layers deterministic: waveform bars first, optional cube
// frame next, logo above it, and beat-reactive snap particles above both.
// Atmosphere remains scene-level.
waveGroup.renderOrder = 1;
logoGroup.renderOrder = 3;
snapGroup.renderOrder = 4;

// These lights only affect the logo's physical side materials. The rest of the
// overlay intentionally stays unlit so its existing additive colors do not change.
const logoAmbient = new THREE.AmbientLight(0x4b0b06, 0.62);
const logoKey = new THREE.DirectionalLight(0xffc27f, 2.35);
const logoRim = new THREE.DirectionalLight(0xff4b1f, 1.35);
logoKey.position.set(-3.2, 4.2, 5.5);
logoRim.position.set(3.8, 1.1, -4.5);
logoKey.target = group;
logoRim.target = group;
scene.add(logoAmbient, logoKey, logoRim);

const BAR = 64;
const WAVE = 128;
const MIRROR_BAR_COUNT = 96;
const MIRROR_HALF_COUNT = MIRROR_BAR_COUNT / 2;
const CUBE_CORNERS = [
  [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
];
const mirrorBarHeights = new Float32Array(MIRROR_HALF_COUNT);
const mirrorBarTargets = new Float32Array(MIRROR_HALF_COUNT);
let mirroredBassPulse = 0;
let mirroredBassPrevious = 0;
let mirroredBarMeshes = [];
let activeCubeVisual = null;
let cubeFrameOverlay = null;
let meshes = [];
let presetName = "";

const SNAP_N = 720;
const snapHome = new Float32Array(SNAP_N * 3);
const snapPos = new Float32Array(SNAP_N * 3);
const snapVel = new Float32Array(SNAP_N * 3);
const snapCol = new Float32Array(SNAP_N * 3);
const snapLife = new Float32Array(SNAP_N);
let snapCount = 0;
let snapPreviousCount = 0;
let snapDrawCount = -1;
let snapColorDirty = true;
let snapBurst = 0;
let snapNext = 5;
let snapLastPeak = 0;
let snapPoints = null;

let circleTexture = null;

function makeCircleTexture() {
  if (circleTexture) return circleTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.6, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 1;
  circleTexture = tex;
  return tex;
}

function makeSnapSystem() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(snapPos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(snapCol, 3).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.PointsMaterial({
    size: 0.055,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    depthTest: true,
    blending: visual.bloom ? THREE.AdditiveBlending : THREE.NormalBlending,
    map: makeCircleTexture(),
    alphaTest: 0.05,
  });
  snapPoints = new THREE.Points(geo, mat);
  snapPoints.frustumCulled = false;
  snapPoints.renderOrder = 4;
  snapGroup.add(snapPoints);
}

function beginSamples() {
  snapPreviousCount = snapCount;
  snapCount = 0;
}

function pushSample(x, y, z, energy) {
  if (snapCount >= SNAP_N) return;
  const i = snapCount * 3;
  const wasLive = snapCount < snapPreviousCount;
  snapHome[i] = x;
  snapHome[i + 1] = y;
  snapHome[i + 2] = z;
  if (!wasLive) {
    // Newly activated points should start at their sample instead of waking
    // from a stale location left by a previous preset.
    snapPos[i] = x;
    snapPos[i + 1] = y;
    snapPos[i + 2] = z;
  }
  const c = col(snapCount);
  const k = 0.55 + Math.min(1, energy || 0) * 0.45;
  snapCol[i] = c.r * k;
  snapCol[i + 1] = c.g * k;
  snapCol[i + 2] = c.b * k;
  snapCount++;
  snapColorDirty = true;
}

function triggerSnapBurst() {
  snapBurst = 1;
  for (let i = 0; i < SNAP_N; i++) {
    const a = Math.random() * Math.PI * 2;
    const b = (Math.random() - 0.5) * Math.PI;
    const sp = 1.2 + Math.random() * 3.4;
    snapVel[i * 3] = Math.cos(a) * Math.cos(b) * sp;
    snapVel[i * 3 + 1] = Math.sin(b) * sp;
    snapVel[i * 3 + 2] = Math.sin(a) * Math.cos(b) * sp;
    snapLife[i] = 0.7 + Math.random() * 0.3;
  }
}

function updateSnap(dt, t) {
  if (!snapPoints) return;
  const amount = Math.max(0, Math.min(1, visual.snap || 0));
  const peakJump = audio.peak - snapLastPeak;
  snapLastPeak = audio.peak;
  if (visual.snapAuto && snapBurst < 0.08 && (t >= snapNext || (peakJump > 0.22 && audio.peak > 0.7))) {
    triggerSnapBurst();
    snapNext = t + 7 + Math.random() * 8;
  }
  snapBurst = Math.max(0, snapBurst - dt * 0.55);

  const wr = waveGroup.rotation.y;
  const cr = Math.cos(wr);
  const sr = Math.sin(wr);
  for (let i = 0; i < snapCount; i++) {
    const i3 = i * 3;
    const hx = snapHome[i3];
    const hy = snapHome[i3 + 1];
    const hz = snapHome[i3 + 2];
    const x = hx * cr + hz * sr;
    const z = -hx * sr + hz * cr;
    if (snapBurst > 0.02) {
      snapPos[i3] += snapVel[i3] * dt;
      snapPos[i3 + 1] += snapVel[i3 + 1] * dt;
      snapPos[i3 + 2] += snapVel[i3 + 2] * dt;
      snapVel[i3 + 1] -= dt * 0.8;
      const pull = 1 - snapBurst;
      snapPos[i3] += (x - snapPos[i3]) * pull * 3.2 * dt;
      snapPos[i3 + 1] += (hy - snapPos[i3 + 1]) * pull * 3.2 * dt;
      snapPos[i3 + 2] += (z - snapPos[i3 + 2]) * pull * 3.2 * dt;
    } else {
      snapPos[i3] += (x - snapPos[i3]) * Math.min(1, dt * 8);
      snapPos[i3 + 1] += (hy - snapPos[i3 + 1]) * Math.min(1, dt * 8);
      snapPos[i3 + 2] += (z - snapPos[i3 + 2]) * Math.min(1, dt * 8);
    }
  }
  if (snapDrawCount !== snapCount) {
    snapPoints.geometry.setDrawRange(0, snapCount);
    snapDrawCount = snapCount;
  }
  if (snapCount > 0) snapPoints.geometry.attributes.position.needsUpdate = true;
  if (snapColorDirty) {
    snapPoints.geometry.attributes.color.needsUpdate = true;
    snapColorDirty = false;
  }
  const fade = Math.max(amount, snapBurst * 0.85);
  snapPoints.material.opacity = 0.25 + fade * 0.75;
  snapPoints.material.size = 0.04 + audio.peak * 0.05 + snapBurst * 0.06;
  snapPoints.visible = fade > 0.03 || snapBurst > 0.02;
  const meshFade = 1 - Math.min(0.92, amount * 0.75 + snapBurst * 0.55);
  for (const m of meshes) {
    if (m.userData.keepFullOpacity) continue;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) {
      if (!mat) continue;
      if (mat.userData.baseOp == null) mat.userData.baseOp = mat.opacity ?? 0.85;
      mat.transparent = true;
      mat.opacity = mat.userData.baseOp * meshFade;
    }
  }
}

let logoMesh = null;
let logoReady = false;
const LOGO_VIEWBOX_WIDTH = 609;
const LOGO_VIEWBOX_HEIGHT = 410;

const logoSpin = {
  from: 0,
  to: 0,
  t: 1,
  dur: 1.3,
  nextAt: 4,
  lastPeak: 0,
};

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function colors() {
  return PALETTES[visual.palette] || PALETTES["cyan-magenta"];
}
const _col = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
let _palKey = "";
function col(i) {
  const pal = colors();
  if (_palKey !== visual.palette) {
    _palKey = visual.palette;
    for (let k = 0; k < 3; k++) _col[k].setHex(pal[k % pal.length]);
  }
  return _col[i % 3];
}

function glowMat(color, opacity = 0.85) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: visual.bloom ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
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
    depthTest: true,
  });
}

function logoUVPoint(vertices, index) {
  const x = vertices[index * 3];
  const y = vertices[index * 3 + 1];
  return new THREE.Vector2(
    THREE.MathUtils.clamp(x / LOGO_VIEWBOX_WIDTH, 0, 1),
    THREE.MathUtils.clamp(1 - y / LOGO_VIEWBOX_HEIGHT, 0, 1),
  );
}

const logoUVGenerator = {
  generateTopUV(_geometry, vertices, indexA, indexB, indexC) {
    return [
      logoUVPoint(vertices, indexA),
      logoUVPoint(vertices, indexB),
      logoUVPoint(vertices, indexC),
    ];
  },
  generateSideWallUV(_geometry, _vertices, _indexA, _indexB, _indexC, _indexD) {
    // Side materials are not textured, but ExtrudeGeometry still requires UVs.
    return [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(1, 0),
      new THREE.Vector2(1, 1),
      new THREE.Vector2(0, 1),
    ];
  },
};

function logoFaceMaterial(texture) {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: texture,
    transparent: true,
    alphaTest: 0.035,
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true,
    toneMapped: false,
  });
}

function logoSideMaterial(color, emissive) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 0.34,
    metalness: 0.78,
    roughness: 0.26,
    side: THREE.DoubleSide,
    // Keep the extruded logo in the same transparent render queue as the
    // bars. Opaque side materials would always render before transparent bars
    // when the logo rotates, regardless of renderOrder.
    transparent: true,
    opacity: 1,
    depthWrite: true,
    depthTest: true,
  });
}

function loadLogo() {
  const loader = new SVGLoader();
  const textureLoader = new THREE.TextureLoader();
  const logoTexture = textureLoader.load(
    "/img/unc-logo.png",
    () => { logoTexture.needsUpdate = true; },
    undefined,
    (err) => console.error("UNC logo texture failed", err),
  );
  logoTexture.colorSpace = THREE.SRGBColorSpace;
  logoTexture.wrapS = THREE.ClampToEdgeWrapping;
  logoTexture.wrapT = THREE.ClampToEdgeWrapping;
  logoTexture.minFilter = THREE.LinearFilter;
  logoTexture.magFilter = THREE.LinearFilter;
  logoTexture.generateMipmaps = false;
  logoTexture.flipY = true;

  loader.load("/img/unc-logo.svg", (data) => {
    const solid = new THREE.Group();
    // Every nested group must carry the logo layer order. Three.js replaces
    // the inherited group order when it visits a child Group.
    solid.renderOrder = 3;
    const face = logoFaceMaterial(logoTexture);
    const goldSide = logoSideMaterial(0x7e260b, 0x2c0800);
    const emberSide = logoSideMaterial(0x2d0705, 0x170000);
    const extrude = {
      depth: 24,
      bevelEnabled: true,
      bevelThickness: 2,
      bevelSize: 1.55,
      bevelOffset: 0,
      bevelSegments: 3,
      curveSegments: 12,
      UVGenerator: logoUVGenerator,
    };
    for (const svgPath of data.paths) {
      const hex = svgPath.color ? svgPath.color.getHex() : 0xdc924f;
      const isGold = hex === 0xdc924f || (svgPath.color && svgPath.color.g > 0.25);
      let shapes;
      try {
        shapes = SVGLoader.createShapes(svgPath);
      } catch (err) {
        continue;
      }
      for (const shape of shapes) {
        const geo = new THREE.ExtrudeGeometry(shape, extrude);
        const mesh = new THREE.Mesh(geo, [face, isGold ? goldSide : emberSide]);
        // The red inset is layered just ahead of the gold outline to avoid
        // coplanar cap z-fighting while preserving the SVG's two-color shape.
        if (!isGold) mesh.position.z = 0.12;
        mesh.renderOrder = 3;
        solid.add(mesh);
      }
    }
    // SVG Y grows downward. Flip first, then bake the visual
    // center into each child so a 180° Y clone sits on the SAME
    // pivot (not beside the logo).
    solid.scale.set(1, -1, 1);
    solid.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(solid);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const local = new THREE.Vector3(
      center.x / solid.scale.x,
      center.y / solid.scale.y,
      center.z / solid.scale.z,
    );
    for (const child of solid.children) child.position.sub(local);
    solid.position.set(0, 0, 0);

    const wrap = new THREE.Group();
    wrap.add(solid);
    const key = Math.max(size.x, 1);
    wrap.userData.baseScale = 2.05 / key;
    wrap.scale.setScalar(wrap.userData.baseScale);

    logoMesh = wrap;
    logoMesh.userData.face = face;
    logoMesh.userData.goldSide = goldSide;
    logoMesh.userData.emberSide = emberSide;
    logoMesh.renderOrder = 3;
    logoGroup.add(logoMesh);
    logoReady = true;
    layoutLogo();
  }, undefined, (err) => {
    console.error("UNC SVG failed", err);
  });
}

function layoutLogo() {
  if (!logoMesh) return;
  let s = 1;
  let z = 0;
  if (presetName === "ribbon") { s = 0.92; z = 0; }
  else if (presetName === "helix") { s = 0.78; z = 0; }
  else if (presetName === "wings") { s = 0.86; z = 0.12; }
  else if (presetName === "tunnel") { s = 0.74; z = 0; }
  else if (presetName === "burst") { s = 0.82; z = 0.1; }
  else if (presetName === "cube") { s = 0.72; z = 0; }
  else if (presetName === "mirrored-bars") { s = 0.72; z = 0.14; }
  const base = logoMesh.userData.baseScale || 1;
  logoMesh.scale.setScalar(base * s);
  logoMesh.position.set(0, 0, z);
  if (cubeFrameOverlay?.group) cubeFrameOverlay.group.position.set(0, 0, z);
}

function clearPreset() {
  if (cubeFrameOverlay) {
    waveGroup.remove(cubeFrameOverlay.group);
    disposeCubeVisual(cubeFrameOverlay);
    cubeFrameOverlay = null;
  }
  for (const m of meshes) {
    waveGroup.remove(m);
    m.geometry?.dispose?.();
    if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose?.());
    else m.material?.dispose?.();
  }
  meshes = [];
  mirroredBarMeshes = [];
  activeCubeVisual = null;
}

function add(obj) {
  obj.renderOrder = 1;
  waveGroup.add(obj);
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
  inst.userData.dummy = new THREE.Object3D();
}

function buildRibbon() {
  const pts = [];
  for (let i = 0; i <= WAVE; i++) pts.push(new THREE.Vector3());
  add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat(col(0))));
  add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map(() => new THREE.Vector3())), lineMat(col(1))));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.018, 10, 96), glowMat(col(2), 0.4));
  ring.rotation.x = Math.PI / 2;
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
}

function createCubeVisual(includeCorners) {
  const geo = new THREE.BoxGeometry(1.55, 1.55, 1.55, 8, 8, 8);
  geo.userData.base = Float32Array.from(geo.attributes.position.array);
  const cubeMat = glowMat(col(0), 0.32);
  cubeMat.depthWrite = false;
  cubeMat.depthTest = true;
  const mesh = new THREE.Mesh(geo, cubeMat);
  mesh.renderOrder = 1;

  const frameBox = new THREE.BoxGeometry(1.55, 1.55, 1.55);
  const frameMat = lineMat(col(1), 1);
  frameMat.depthTest = true;
  // The cube must contribute to the depth buffer before the logo is drawn.
  // This lets front edges occlude the logo while rear edges remain hidden by
  // the logo's own depth, producing a real 3D intersection instead of a
  // flat always-on-top overlay.
  frameMat.depthWrite = true;
  frameMat.opacity = 1;
  const frame = new THREE.LineSegments(
    new THREE.WireframeGeometry(frameBox),
    frameMat,
  );
  frameBox.dispose();
  frame.renderOrder = 2;

  let corners = null;
  if (includeCorners) {
    const cornerMat = glowMat(col(2), 1);
    cornerMat.depthTest = true;
    cornerMat.depthWrite = false;
    corners = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.13, 0.13, 0.13),
      cornerMat,
      8,
    );
    corners.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    corners.userData.dummy = new THREE.Object3D();
    corners.userData.corner = new THREE.Vector3();
    corners.renderOrder = 2;
  }

  return { mesh, frame, corners };
}

function disposeCubeVisual(cube) {
  cube.mesh.geometry.dispose();
  cube.mesh.material?.dispose?.();
  cube.frame.geometry.dispose();
  cube.frame.material?.dispose?.();
  cube.corners?.geometry?.dispose?.();
  cube.corners?.material?.dispose?.();
}

function buildCube() {
  activeCubeVisual = createCubeVisual(true);
  add(activeCubeVisual.mesh);
  add(activeCubeVisual.frame);
  activeCubeVisual.frame.renderOrder = 2;
  add(activeCubeVisual.corners);
  activeCubeVisual.corners.renderOrder = 2;
}

function buildCubeFrame() {
  // This is the same Bass Cube visual, deliberately without its eight corner
  // blocks. Keep the cube volume and wireframe materials identical to the
  // selectable cube preset so the standalone toggle cannot drift visually.
  cubeFrameOverlay = createCubeVisual(false);
  cubeFrameOverlay.group = new THREE.Group();
  cubeFrameOverlay.group.renderOrder = 2;
  cubeFrameOverlay.group.frustumCulled = false;
  cubeFrameOverlay.group.add(cubeFrameOverlay.mesh, cubeFrameOverlay.frame);
  waveGroup.add(cubeFrameOverlay.group);
}

const MIRRORED_BAR_VERTEX_SHADER = `
attribute float instanceBarExtension;
attribute float instanceBarEnergy;
attribute vec3 instanceBarColor;

varying vec3 vBarColor;
varying float vBarEnergy;
varying float vBarY;

void main() {
  // CapsuleGeometry is two radii tall at rest. Only vertices on the rounded
  // cap arcs move, so the cap radius never changes as the center grows.
  vec3 transformed = position;
  float capVertex = step(0.499, abs(position.y));
  transformed.y += sign(position.y) * capVertex * instanceBarExtension * 0.5;

  vBarColor = instanceBarColor;
  vBarEnergy = instanceBarEnergy;
  vBarY = clamp(position.y * 0.5 + 0.5, 0.0, 1.0);

  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`;

const MIRRORED_BAR_FRAGMENT_SHADER = `
uniform float uOpacity;
uniform float uImpact;

varying vec3 vBarColor;
varying float vBarEnergy;
varying float vBarY;

void main() {
  float activity = clamp(vBarEnergy * 0.82 + uImpact * 0.72, 0.0, 1.0);
  float centerLight = 1.0 - abs(vBarY * 2.0 - 1.0);
  // Brighten the selected profile without mixing in white. This preserves
  // the hue stops at the edges, mids, and center during loud hits.
  float brightness = 0.66 + activity * 0.36 + centerLight * 0.06;
  vec3 litColor = min(vBarColor * brightness, vec3(0.98));
  float alpha = clamp(uOpacity * (0.58 + vBarEnergy * 0.20 + uImpact * 0.12), 0.16, 0.78);
  gl_FragColor = vec4(litColor, alpha);
  #include <colorspace_fragment>
}
`;

const MIRRORED_BAR_GLOW_FRAGMENT_SHADER = `
uniform float uOpacity;
uniform float uImpact;

varying vec3 vBarColor;
varying float vBarEnergy;
varying float vBarY;

void main() {
  float activity = clamp(vBarEnergy * 0.9 + uImpact, 0.0, 1.0);
  float centerLight = 1.0 - abs(vBarY * 2.0 - 1.0);
  vec3 glowColor = min(vBarColor * (0.62 + activity * 0.88 + centerLight * 0.08), vec3(0.98));
  float alpha = clamp(uOpacity * (0.20 + activity * 0.30), 0.0, 0.28);
  gl_FragColor = vec4(glowColor, alpha);
  #include <colorspace_fragment>
}
`;

const MIRRORED_BAR_SHADOW_FRAGMENT_SHADER = `
uniform float uOpacity;

varying vec3 vBarColor;
varying float vBarEnergy;
varying float vBarY;

void main() {
  float edgeWeight = 0.9 + (1.0 - abs(vBarY * 2.0 - 1.0)) * 0.1;
  float alpha = uOpacity * (0.62 + vBarEnergy * 0.2) * edgeWeight;
  gl_FragColor = vec4(0.008, 0.004, 0.018, alpha);
  #include <colorspace_fragment>
}
`;

function makeMirroredBarMaterial(glow = false) {
  return new THREE.ShaderMaterial({
    name: glow ? "MirroredBarGlowMaterial" : "MirroredBarMaterial",
    uniforms: {
      uOpacity: { value: glow ? 0.08 : 0.64 },
      uImpact: { value: 0 },
    },
    vertexShader: MIRRORED_BAR_VERTEX_SHADER,
    fragmentShader: glow ? MIRRORED_BAR_GLOW_FRAGMENT_SHADER : MIRRORED_BAR_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: glow && visual.bloom ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
  });
}

function makeMirroredBarShadowMaterial() {
  return new THREE.ShaderMaterial({
    name: "MirroredBarShadowMaterial",
    uniforms: {
      uOpacity: { value: 0.22 },
    },
    vertexShader: MIRRORED_BAR_VERTEX_SHADER,
    fragmentShader: MIRRORED_BAR_SHADOW_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
}

function makeMirroredBarAttribute(itemSize) {
  return new THREE.InstancedBufferAttribute(
    new Float32Array(MIRROR_BAR_COUNT * itemSize),
    itemSize,
  ).setUsage(THREE.DynamicDrawUsage);
}

function buildMirroredBars() {
  // Keep the capsule mesh shared between the solid and halo passes. The
  // instance attributes carry only the data that changes per bar per frame.
  const geometry = new THREE.CapsuleGeometry(0.5, 1, 6, 12);
  const glowGeometry = geometry.clone();
  const attributes = [
    [geometry, "instanceBarExtension", makeMirroredBarAttribute(1)],
    [geometry, "instanceBarEnergy", makeMirroredBarAttribute(1)],
    [geometry, "instanceBarColor", makeMirroredBarAttribute(3)],
    [glowGeometry, "instanceBarExtension", makeMirroredBarAttribute(1)],
    [glowGeometry, "instanceBarEnergy", makeMirroredBarAttribute(1)],
    [glowGeometry, "instanceBarColor", makeMirroredBarAttribute(3)],
  ];
  for (const [geo, name, attribute] of attributes) geo.setAttribute(name, attribute);
  const shadowGeometry = geometry.clone();
  for (const name of ["instanceBarExtension", "instanceBarEnergy", "instanceBarColor"]) {
    shadowGeometry.setAttribute(name, geometry.getAttribute(name));
  }

  const inst = new THREE.InstancedMesh(
    geometry,
    makeMirroredBarMaterial(false),
    MIRROR_BAR_COUNT,
  );
  const glow = new THREE.InstancedMesh(
    glowGeometry,
    makeMirroredBarMaterial(true),
    MIRROR_BAR_COUNT,
  );
  const shadow = new THREE.InstancedMesh(
    shadowGeometry,
    makeMirroredBarShadowMaterial(),
    MIRROR_BAR_COUNT,
  );
  // The shadow follows the exact same animated instance transforms as the
  // bars; only its object offset and material differ.
  shadow.instanceMatrix = inst.instanceMatrix;
  shadow.position.set(0.045, -0.055, -0.12);
  shadow.frustumCulled = false;
  shadow.userData.keepFullOpacity = true;
  for (const mesh of [inst, glow]) {
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.userData.dummy = new THREE.Object3D();
    mesh.userData.layoutKey = "";
    mesh.userData.paletteKey = "";
    mesh.userData.layout = { span: 0, cell: 0, width: 0, depth: 0 };
    mesh.userData.colorScratch = new THREE.Color();
    mesh.userData.keepFullOpacity = true;
    mesh.userData.extensionAttribute = mesh.geometry.getAttribute("instanceBarExtension");
    mesh.userData.energyAttribute = mesh.geometry.getAttribute("instanceBarEnergy");
    mesh.userData.colorAttribute = mesh.geometry.getAttribute("instanceBarColor");
  }
  inst.userData.barScale = 1;
  glow.userData.barScale = 1.30;
  add(inst);
  add(glow);
  add(shadow);
  inst.renderOrder = 1;
  glow.renderOrder = 1;
  shadow.renderOrder = 0;
  mirroredBarMeshes = [inst, glow];
  mirrorBarHeights.fill(0.06);
  mirrorBarTargets.fill(0.06);
  mirroredBassPulse = 0;
  mirroredBassPrevious = audio.bass;
}

function rebuild() {
  clearPreset();
  presetName = visual.preset;
  if (!PRESETS.includes(presetName)) presetName = "helix";
  if (presetName === "helix") buildHelix();
  else if (presetName === "ribbon") buildRibbon();
  else if (presetName === "wings") buildWings();
  else if (presetName === "tunnel") buildTunnel();
  else if (presetName === "burst") buildBurst();
  else if (presetName === "cube") buildCube();
  else buildMirroredBars();
  if (visual.cubeFrame && presetName !== "cube") buildCubeFrame();
  if (presetName === "mirrored-bars") waveGroup.rotation.set(0, 0, 0);
  layoutLogo();
}

function applyAlignment(w, h) {
  const safe = visual.logoSafe;
  group.scale.setScalar(visual.scale);
  group.position.set(0, 0, 0);
  camera.fov = 42;

  // The mirrored bars are a deliberately flat, screen-spanning preset. Keep
  // the camera square to the bar plane so the two halves stay symmetrical and
  // the center logo remains the visual anchor.
  if (presetName === "mirrored-bars") {
    camera.position.set(0, 0, 6);
    camera.lookAt(0, 0, 0);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    return;
  }

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
  beginSamples();
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  const bins = audio.bins;
  for (let strand = 0; strand < 2; strand++) {
    for (let i = 0; i < BAR; i++) {
      const a = (i / BAR) * Math.PI * 4 + t * (0.6 + visual.rotationSpeed) + strand * Math.PI;
      const y = (i / BAR - 0.5) * 3.2;
      const r = 1.05 + (bins[i] || 0) * (1.05 + audio.bass);
      dummy.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      dummy.scale.set(1, 1, 0.6 + (bins[i] || 0) * 4.5);
      dummy.lookAt(0, y, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(strand * BAR + i, dummy.matrix);
      pushSample(dummy.position.x, dummy.position.y, dummy.position.z, bins[i] || 0);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.material.color.lerpColors(col(0), col(1), audio.mid);
}

function updateRibbon(t) {
  beginSamples();
  const lineA = meshes[0];
  const lineB = meshes[1];
  const posA = lineA.geometry.attributes.position;
  const posB = lineB.geometry.attributes.position;
  const n = posA.count;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const a = u * Math.PI * 2 + t * visual.rotationSpeed;
    const wL = audio.waveL[i % audio.waveL.length] || 0;
    const wR = audio.waveR[i % audio.waveR.length] || 0;
    const r1 = 1.22 + wL * 0.75 + audio.bass * 0.22;
    const r2 = 1.62 + wR * 0.65 + audio.high * 0.18;
    posA.setXYZ(i, Math.cos(a) * r1, Math.sin(a * 2) * 0.18 + wL * 0.32, Math.sin(a) * r1);
    posB.setXYZ(i, Math.cos(a) * r2, Math.sin(a * 3) * 0.14 + wR * 0.28, Math.sin(a) * r2);
    if (i % 2 === 0) pushSample(Math.cos(a) * r1, Math.sin(a * 2) * 0.18 + wL * 0.32, Math.sin(a) * r1, Math.abs(wL));
    else pushSample(Math.cos(a) * r2, Math.sin(a * 3) * 0.14 + wR * 0.28, Math.sin(a) * r2, Math.abs(wR));
  }
  posA.needsUpdate = true;
  posB.needsUpdate = true;
  meshes[2].rotation.z = t * 0.22;
}

function updateWings() {
  beginSamples();
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;
    const wave = side === 0 ? audio.waveL : audio.waveR;
    for (let i = 0; i < BAR; i++) {
      const x = sign * (0.95 + i * 0.052);
      const amp = Math.abs(wave[Math.floor((i / BAR) * wave.length)] || 0);
      const h = 0.15 + amp * 2.6 + audio.bins[i] * 1.4;
      const z = Math.sin(i * 0.35) * 0.55;
      dummy.position.set(x, 0, z);
      dummy.scale.set(1, h, 1);
      dummy.rotation.set(0, 0, sign * 0.16);
      dummy.updateMatrix();
      inst.setMatrixAt(side * BAR + i, dummy.matrix);
      pushSample(x, ((i / BAR) - 0.5) * h, z, amp);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.material.color.lerpColors(col(0), col(1), audio.peak);
}

function updateTunnel(t) {
  beginSamples();
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < BAR; i++) {
      const a = (i / BAR) * Math.PI * 2 + t * 0.25 * (ring ? -1 : 1);
      const z = (ring === 0 ? -1.35 : 1.25) + Math.sin(t + i * 0.2) * 0.08;
      const r = 1.05 + (audio.bins[i] || 0) * 1.15 + audio.bass * 0.3;
      dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, z);
      dummy.lookAt(0, 0, 0);
      dummy.scale.set(1, 1, 0.4 + (audio.bins[i] || 0) * 3.2);
      dummy.updateMatrix();
      inst.setMatrixAt(ring * BAR + i, dummy.matrix);
      pushSample(dummy.position.x, dummy.position.y, dummy.position.z, audio.bins[i] || 0);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
}

function updateBurst(t) {
  beginSamples();
  const inst = meshes[0];
  const dummy = inst.userData.dummy;
  for (let i = 0; i < BAR; i++) {
    const a = (i / BAR) * Math.PI * 2 + t * visual.rotationSpeed * 0.4;
    const len = 0.55 + (audio.bins[i] || 0) * 2.4 + audio.peak * 0.35;
    const z = Math.sin(a * 2 + t) * 0.55;
    dummy.position.set(Math.cos(a) * 0.15, Math.sin(a) * 0.15, z);
    dummy.rotation.set(Math.sin(a) * 0.4, 0, a - Math.PI / 2);
    dummy.scale.set(1, len, 1);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    pushSample(Math.cos(a) * len * 0.55, Math.sin(a) * len * 0.55, z, audio.bins[i] || 0);
  }
  inst.instanceMatrix.needsUpdate = true;
}

function mirrorViewWidth() {
  const distance = Math.max(0.1, camera.position.z - group.position.z);
  const viewHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
  return viewHeight * Math.max(0.1, camera.aspect);
}

function sampleSpectrum(position) {
  const bins = audio.bins;
  if (!bins.length) return 0;
  const max = bins.length - 1;
  const p = THREE.MathUtils.clamp(position, 0, max);
  const i1 = Math.floor(p);
  const t = p - i1;
  const i0 = Math.max(0, i1 - 1);
  const i2 = Math.min(max, i1 + 1);
  const i3 = Math.min(max, i1 + 2);
  const p0 = bins[i0] || 0;
  const p1 = bins[i1] || 0;
  const p2 = bins[i2] || 0;
  const p3 = bins[i3] || 0;
  // Catmull-Rom interpolation removes the stair-step contour that appears
  // when 64 FFT bins are spread across a wider instanced bar field.
  const t2 = t * t;
  const t3 = t2 * t;
  const value = 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
  return THREE.MathUtils.clamp(value, 0, 1);
}

function updateMirroredBarLayout(inst) {
  const key = `${innerWidth}x${innerHeight}:${visual.scale}:${camera.aspect}:${camera.fov}`;
  if (inst.userData.layoutKey === key) return;
  const span = (mirrorViewWidth() * 1.04) / Math.max(0.1, visual.scale);
  const cell = span / MIRROR_BAR_COUNT;
  inst.userData.layout = {
    span,
    cell,
    width: Math.max(0.008, cell * 0.66),
    depth: 0.08,
  };
  inst.userData.layoutKey = key;
}

function updateMirroredBarColors() {
  if (!mirroredBarMeshes.length) return;
  if (mirroredBarMeshes.every((mesh) => mesh.userData.paletteKey === visual.palette)) return;
  const last = 2;
  col(0);
  col(1);
  col(2);
  for (const mesh of mirroredBarMeshes) {
    const scratch = mesh.userData.colorScratch;
    const colorAttribute = mesh.userData.colorAttribute;
    for (let i = 0; i < MIRROR_HALF_COUNT; i++) {
      const t = i / Math.max(1, MIRROR_HALF_COUNT - 1);
      const scaled = t * last;
      const segment = Math.min(last - 1, Math.floor(scaled));
      scratch.copy(col(segment)).lerp(col(segment + 1), scaled - segment);
      scratch.toArray(colorAttribute.array, i * 3);
      scratch.toArray(colorAttribute.array, (MIRROR_BAR_COUNT - 1 - i) * 3);
    }
    colorAttribute.needsUpdate = true;
    mesh.userData.paletteKey = visual.palette;
  }
}

function updateMirroredBars(dt) {
  beginSamples();
  const inst = mirroredBarMeshes[0];
  if (!inst) return;
  updateMirroredBarLayout(inst);
  updateMirroredBarColors();

  const layout = inst.userData.layout;
  const up = 1 - Math.exp(-dt / 0.045);
  const down = 1 - Math.exp(-dt / 0.12);
  const maxHeight = 1.28 + audio.bass * 0.42 + audio.peak * 0.14;
  const bassRise = Math.max(0, audio.bass - mirroredBassPrevious);
  mirroredBassPrevious = audio.bass;
  const pulseTarget = Math.min(1, audio.bass * 0.24 + bassRise * 4.8 + audio.peak * 0.08);
  mirroredBassPulse = Math.max(
    pulseTarget,
    mirroredBassPulse * Math.exp(-dt / 0.18),
  );
  const impact = THREE.MathUtils.clamp(
    audio.rms * 0.58 + audio.bass * 0.84 + audio.peak * 0.3 + mirroredBassPulse * 0.62,
    0,
    1,
  );

  for (let outer = 0; outer < MIRROR_HALF_COUNT; outer++) {
    const frequency = outer / Math.max(1, MIRROR_HALF_COUNT - 1);
    const energy = sampleSpectrum(frequency * (audio.bins.length - 1));
    const shaped = Math.pow(energy, 0.82);
    const nextHeight = 0.055 + shaped * maxHeight + audio.rms * 0.06;
    mirrorBarTargets[outer] = nextHeight;
    const rate = nextHeight > mirrorBarHeights[outer] ? up : down;
    const height = mirrorBarHeights[outer] = follow(mirrorBarHeights[outer], nextHeight, rate, rate);
    const actualHeight = Math.max(height, layout.width * 2);
    const leftIndex = outer;
    const rightIndex = MIRROR_BAR_COUNT - 1 - outer;
    const leftX = -layout.span * 0.5 + layout.cell * (leftIndex + 0.5);
    const rightX = -layout.span * 0.5 + layout.cell * (rightIndex + 0.5);

    for (const mesh of mirroredBarMeshes) {
      const dummy = mesh.userData.dummy;
      const barScale = mesh.userData.barScale;
      const width = layout.width * barScale;
      const extension = Math.max(0, actualHeight / width - 2);
      const extensionAttribute = mesh.userData.extensionAttribute;
      const energyAttribute = mesh.userData.energyAttribute;
      extensionAttribute.array[leftIndex] = extension;
      extensionAttribute.array[rightIndex] = extension;
      energyAttribute.array[leftIndex] = energy;
      energyAttribute.array[rightIndex] = energy;

      dummy.position.set(leftX, 0, -0.06);
      dummy.scale.set(width, width, layout.depth * barScale);
      dummy.updateMatrix();
      mesh.setMatrixAt(leftIndex, dummy.matrix);

      dummy.position.set(rightX, 0, -0.06);
      dummy.updateMatrix();
      mesh.setMatrixAt(rightIndex, dummy.matrix);
    }
  }
  for (const mesh of mirroredBarMeshes) mesh.instanceMatrix.needsUpdate = true;
  for (const mesh of mirroredBarMeshes) mesh.userData.extensionAttribute.needsUpdate = true;
  for (const mesh of mirroredBarMeshes) mesh.userData.energyAttribute.needsUpdate = true;
  const main = mirroredBarMeshes[0];
  const glow = mirroredBarMeshes[1];
  main.material.uniforms.uOpacity.value = 0.64 + impact * 0.16;
  main.material.uniforms.uImpact.value = impact;
  glow.material.uniforms.uOpacity.value = 0.08 + impact * 0.30;
  glow.material.uniforms.uImpact.value = impact;
  const glowBlending = visual.bloom ? THREE.AdditiveBlending : THREE.NormalBlending;
  if (glow.material.blending !== glowBlending) {
    glow.material.blending = glowBlending;
    glow.material.needsUpdate = true;
  }
}

function easeCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}


function animateCubeVisual(cube, t, emitSamples) {
  const mesh = cube.mesh;
  const pos = mesh.geometry.attributes.position;
  const base = mesh.geometry.userData.base;
  const s = 0.88 + audio.rms * 0.28 + audio.bass * 0.22;
  for (let i = 0; i < pos.count; i++) {
    const ix = i * 3;
    let x = base[ix];
    let y = base[ix + 1];
    let z = base[ix + 2];
    const bin = audio.bins[i % audio.bins.length] || 0;
    const warp = 1 + audio.bass * 0.14 + bin * 0.22 + Math.sin(t * 2.6 + i * 0.12) * audio.mid * 0.06;
    x *= warp;
    y *= warp * (1 + audio.high * 0.03);
    z *= warp;
    pos.array[ix] = x;
    pos.array[ix + 1] = y;
    pos.array[ix + 2] = z;
    if (emitSamples && i % 8 === 0) pushSample(x * s, y * s, z * s, bin);
  }
  pos.needsUpdate = true;
  mesh.scale.setScalar(s);
  mesh.rotation.x = t * 0.18;
  mesh.rotation.z = t * 0.11;
  mesh.material.color.lerpColors(col(0), col(1), audio.peak);

  cube.frame.scale.setScalar(s * 1.02);
  cube.frame.rotation.copy(mesh.rotation);
  cube.frame.material.color.copy(col(1));
  cube.frame.material.opacity = emitSamples ? 0.95 : 0.86;

  const inst = cube.corners;
  if (!inst) return;
  const dummy = inst.userData.dummy;
  const tmp = inst.userData.corner;
  const reach = 0.775 * s * 1.16;
  for (let i = 0; i < 8; i++) {
    const c = CUBE_CORNERS[i];
    tmp.set(c[0] * reach, c[1] * reach, c[2] * reach);
    tmp.applyEuler(mesh.rotation);
    tmp.x += Math.sin(t * 1.35 + i * 1.1) * 0.11 * s;
    tmp.y += Math.cos(t * 1.05 + i * 0.8) * 0.10 * s;
    tmp.z += Math.sin(t * 0.9 + i * 1.7) * 0.09 * s;
    dummy.position.copy(tmp);
    dummy.scale.setScalar(0.7 + (audio.bins[i * 7] || 0) * 1.4 + audio.peak * 0.25);
    dummy.rotation.set(t * 1.6 + i, t * 1.1 + i * 0.4, t * 0.7);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    if (emitSamples) {
      pushSample(dummy.position.x, dummy.position.y, dummy.position.z, audio.bins[i * 7] || 0);
    }
  }
  inst.instanceMatrix.needsUpdate = true;
}

function updateCube(t) {
  beginSamples();
  if (activeCubeVisual) animateCubeVisual(activeCubeVisual, t, true);
}

function updateCubeFrame(t) {
  if (cubeFrameOverlay) animateCubeVisual(cubeFrameOverlay, t, false);
}

const logoFlip = {
  t: 1,
  from: 0,
  to: 0,
  dur: 1.35,
  nextAt: 8 + Math.random() * 8,
};

function updateLogo(dt, t) {
  if (!logoReady || !logoMesh) return;
  const energy = audio.rms * 0.55 + audio.bass * 0.45 + audio.peak * 0.15;
  logoGroup.scale.setScalar(0.88 + energy * 0.72);
  const rate = (visual.logoSpin || 0) * (1.2 + energy * 0.85 * audioSensitivity);
  logoFlip.yaw = (logoFlip.yaw || 0) + dt * rate;
  logoFlip.pitch = (logoFlip.pitch || 0) + dt * rate * 0.62;
  logoGroup.rotation.y = Math.sin(logoFlip.yaw) * 0.62;
  logoMesh.rotation.y = 0;

  if (logoFlip.t >= 1 && t >= logoFlip.nextAt) {
    const facing = Math.abs(Math.cos(logoGroup.rotation.y)) > Math.cos(Math.PI * 50 / 180);
    if (!facing) {
      logoFlip.nextAt = t + 0.35;
    } else {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const turns = Math.random() < 0.25 ? 2 : 1;
      logoFlip.from = 0;
      logoFlip.to = dir * Math.PI * 2 * turns;
      logoFlip.t = 0;
      logoFlip.dur = 1.15 + Math.random() * 0.45;
      logoFlip.nextAt = t + 16 + Math.random() * 10;
    }
  }
  let flip = 0;
  if (logoFlip.t < 1) {
    logoFlip.t = Math.min(1, logoFlip.t + dt / logoFlip.dur);
    flip = logoFlip.from + (logoFlip.to - logoFlip.from) * easeCubic(logoFlip.t);
  }
  logoGroup.rotation.x = Math.sin(logoFlip.pitch) * 0.34 + flip;
  logoGroup.rotation.z = Math.sin(t * 0.19) * 0.04;
}

const ATMOS_N = 750;
const atmosPos = new Float32Array(ATMOS_N * 3);
const atmosVel = new Float32Array(ATMOS_N * 3);
const atmosCol = new Float32Array(ATMOS_N * 3);
let atmosPoints = null;

function makeAtmos() {
  for (let i = 0; i < ATMOS_N; i++) {
    atmosPos[i * 3] = (Math.random() - 0.5) * 14;
    atmosPos[i * 3 + 1] = (Math.random() - 0.5) * 8;
    atmosPos[i * 3 + 2] = (Math.random() - 0.5) * 10;
    atmosVel[i * 3] = (Math.random() - 0.5) * 0.15;
    atmosVel[i * 3 + 1] = 0.12 + Math.random() * 0.28;
    atmosVel[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
    const c = new THREE.Color(colors()[i % 3]);
    atmosCol[i * 3] = c.r;
    atmosCol[i * 3 + 1] = c.g;
    atmosCol[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(atmosPos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(atmosCol, 3));
  atmosPoints = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.08,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    map: makeCircleTexture(),
    alphaTest: 0.05,
  }));
  atmosPoints.frustumCulled = false;
  atmosPoints.renderOrder = 0;
  scene.add(atmosPoints);
}

const SQUIGGLE_N = 8;
const SQUIGGLE_PTS = 48;
const squiggles = [];
let squiggleCool = 0;

function makeSquiggles() {
  for (let i = 0; i < SQUIGGLE_N; i++) {
    const verts = new Float32Array(SQUIGGLE_PTS * 2 * 3);
    const geo = new THREE.BufferGeometry();
    const idx = [];
    for (let p = 0; p < SQUIGGLE_PTS - 1; p++) {
      const a = p * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xe8e8e8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
    }));
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    scene.add(mesh);
    squiggles.push({
      mesh,
      verts,
      points: new Float32Array(SQUIGGLE_PTS * 3),
      x: 0,
      z: 0,
      phase: 0,
      amp: 0.4,
      life: 0,
      speed: 1,
      width: 0.045,
    });
  }
}

function spawnSquiggle() {
  const slot = squiggles.find((s) => s.life <= 0);
  if (!slot) return;
  slot.x = (Math.random() - 0.5) * 7.5;
  slot.z = 1.6 + Math.random() * 1.4;
  slot.phase = Math.random() * Math.PI * 2;
  slot.amp = 0.16 + Math.random() * 0.14;
  slot.life = 1;
  slot.speed = 0.7 + Math.random() * 0.55;
  slot.width = 0.005;
  const grey = 0.72 + Math.random() * 0.22;
  slot.mesh.material.color.setRGB(grey, grey, grey);
}

function updateSquiggles(dt) {
  squiggleCool = Math.max(0, squiggleCool - dt);
  const bass = audio.bass;
  const kick = bass - (updateSquiggles.prevBass || 0);
  updateSquiggles.prevBass = bass;
  const hit = (bass > 0.32 && kick > 0.012) || (bass > 0.55 && kick > 0.002);
  if (hit && squiggleCool <= 0) {
    spawnSquiggle();
    if (bass > 0.6) spawnSquiggle();
    squiggleCool = 0.05;
  }
  for (const s of squiggles) {
    if (s.life <= 0) {
      s.mesh.material.opacity = 0;
      continue;
    }
    s.life -= dt * 0.48 * s.speed;
    const rise = 1 - Math.max(0, s.life);
    const y0 = -3.6 + rise * 8.4;
    const pts = s.points;
    for (let i = 0; i < SQUIGGLE_PTS; i++) {
      const u = i / (SQUIGGLE_PTS - 1);
      const y = y0 + u * 2.2;
      const wiggle = (Math.sin(u * 5.2 + s.phase) * 0.7 + Math.sin(u * 9.5 + s.phase * 1.7) * 0.3) * s.amp;
      const ix = i * 3;
      pts[ix] = s.x + wiggle;
      pts[ix + 1] = y;
      pts[ix + 2] = s.z;
    }
    for (let i = 0; i < SQUIGGLE_PTS; i++) {
      const ix = i * 3;
      let tx, ty, tz;
      if (i < SQUIGGLE_PTS - 1) {
        tx = pts[ix + 3] - pts[ix];
        ty = pts[ix + 4] - pts[ix + 1];
        tz = pts[ix + 5] - pts[ix + 2];
      } else {
        tx = pts[ix] - pts[ix - 3];
        ty = pts[ix + 1] - pts[ix - 2];
        tz = pts[ix + 2] - pts[ix - 1];
      }
      const len = Math.hypot(tx, ty) || 1;
      const px = -ty / len * s.width;
      const py = tx / len * s.width;
      const v = i * 6;
      s.verts[v] = pts[ix] - px;
      s.verts[v + 1] = pts[ix + 1] - py;
      s.verts[v + 2] = pts[ix + 2];
      s.verts[v + 3] = pts[ix] + px;
      s.verts[v + 4] = pts[ix + 1] + py;
      s.verts[v + 5] = pts[ix + 2];
    }
    s.mesh.geometry.attributes.position.needsUpdate = true;
    s.mesh.material.opacity = Math.max(0, s.life) * 0.55;
  }
}

function updateAtmos(dt) {
  if (!atmosPoints) return;
  const energy = audio.rms * 0.65 + audio.bass * 0.55 + audio.peak * 0.25;
  const speed = 0.35 + energy * 3.4;
  atmosPoints.material.size = 0.07 + energy * 0.09;
  atmosPoints.material.opacity = 0.55 + energy * 0.4;
  for (let i = 0; i < ATMOS_N; i++) {
    const i3 = i * 3;
    atmosPos[i3] += atmosVel[i3] * speed * dt * 4.2;
    atmosPos[i3 + 1] += atmosVel[i3 + 1] * speed * dt * 4.2;
    atmosPos[i3 + 2] += atmosVel[i3 + 2] * speed * dt * 3.4;
    const cx = atmosPos[i3];
    const cy = atmosPos[i3 + 1];
    const cz = atmosPos[i3 + 2];
    if (cx * cx + cy * cy + cz * cz < 3.24) {
      const ang = Math.random() * Math.PI * 2;
      const rad = 2.4 + Math.random() * 4.5;
      atmosPos[i3] = Math.cos(ang) * rad;
      atmosPos[i3 + 2] = Math.sin(ang) * rad;
    }
    if (atmosPos[i3 + 1] > 4.2) {
      atmosPos[i3 + 1] = -4.2;
      atmosPos[i3] = (Math.random() - 0.5) * 14;
      atmosPos[i3 + 2] = (Math.random() - 0.5) * 10;
    }
    if (atmosPos[i3] > 7) atmosPos[i3] = -7;
    if (atmosPos[i3] < -7) atmosPos[i3] = 7;
  }
  atmosPoints.geometry.attributes.position.needsUpdate = true;
  if (atmosPoints.userData.pal !== visual.palette) {
    atmosPoints.userData.pal = visual.palette;
    const c0 = col(0), c1 = col(1), c2 = col(2);
    const cs = [c0, c1, c2];
    for (let i = 0; i < ATMOS_N; i++) {
      const c = cs[i % 3];
      atmosCol[i * 3] = c.r;
      atmosCol[i * 3 + 1] = c.g;
      atmosCol[i * 3 + 2] = c.b;
    }
    atmosPoints.geometry.attributes.color.needsUpdate = true;
  }
}

function setFly(el, deck, side) {
  if (!el) return;
  const title = (deck && (deck.title || deck.artistTitle)) || "";
  const artist = (deck && deck.artist) || "";
  const loaded = true;
  const key = `${title}|${artist}`;
  if (el.dataset.key === key) {
    setDeckFooter(el, deck);
    el.classList.toggle("onair", Boolean(deck && deck.audible));
    const art = el.querySelector(".art");
    if (loaded && art && !art.classList.contains("has-art") && deck.coverUrl) {
      const now = Date.now();
      if (now - Number(el.dataset.tried || 0) > 4000) {
        el.dataset.tried = String(now);
        art.querySelector("img").src = `${deck.coverUrl}?r=${now}`;
      }
    }
    return;
  }
  if (el.dataset.key !== key) {
    el.classList.remove("in");
    el.classList.add("out");
    window.setTimeout(() => {
      const label = title || "No track";
      const t1 = el.querySelector(".title .t1");
      const t2 = el.querySelector(".title .t2");
      const titleEl = el.querySelector(".title");
      if (t1) t1.textContent = label;
      if (t2) t2.textContent = label;
      requestAnimationFrame(() => applyTitleMarquee(titleEl));
      el.querySelector(".artist").textContent = artist;
      setDeckFooter(el, deck, true);
      const art = el.querySelector(".art");
      const img = art.querySelector("img");
      if (deck && deck.coverUrl && (title || artist)) {
        img.src = `${deck.coverUrl}?t=${encodeURIComponent(key)}`;
        img.onload = () => art.classList.add("has-art");
        img.onerror = () => art.classList.remove("has-art");
      } else {
        img.removeAttribute("src");
        art.classList.remove("has-art");
      }
      el.dataset.key = key;
      if (loaded) {
        el.classList.remove("hidden", "out");
        el.classList.add("in");
      } else {
        el.classList.add("hidden");
        el.classList.remove("in");
      }
    }, el.classList.contains("hidden") ? 0 : 180);
  }
  el.classList.toggle("onair", Boolean(deck && deck.audible));
}

function deckFooter(deck) {
  let bpm = "";
  if (deck && deck.bpm != null && Number.isFinite(Number(deck.bpm))) {
    bpm = `${Number(deck.bpm).toFixed(1)} BPM`;
  }
  const remix = String(deck?.remix || "").trim();
  return { bpm, remix };
}

const MARQUEE_END_PAUSE_MS = 2000;
const FOOTER_PX_PER_SEC = 34;
const FOOTER_MARQUEE_PAUSE_MS = 1400;
const footerMarqueeRuns = new WeakMap();
const footerMarqueeTimers = new WeakMap();

function setDeckFooter(el, deck, restart = false) {
  const sub = el.querySelector(".sub");
  const bpmEl = sub?.querySelector(".sub-bpm");
  const divider = sub?.querySelector(".sub-divider");
  const clip = sub?.querySelector(".sub-clip");
  const track = sub?.querySelector(".sub-track");
  if (!sub || !bpmEl || !divider || !clip || !track) return;
  const { bpm, remix } = deckFooter(deck);
  const bpmChanged = bpmEl.textContent !== bpm;
  const remixChanged = track.textContent !== remix;
  const bpmVisibilityChanged = bpmEl.hidden !== !bpm;
  const remixVisibilityChanged = clip.hidden !== !remix;
  if (!restart && !bpmChanged && !remixChanged) return;
  bpmEl.textContent = bpm;
  bpmEl.hidden = !bpm;
  divider.hidden = !(bpm && remix);
  clip.hidden = !remix;
  track.textContent = remix;
  if (restart || remixChanged || bpmVisibilityChanged || remixVisibilityChanged) {
    requestAnimationFrame(() => applyFooterMarquee(sub));
  }
}

function applyFooterMarquee(sub) {
  if (!sub) return;
  const clip = sub.querySelector(".sub-clip");
  const track = sub.querySelector(".sub-track");
  if (!clip || !track) return;

  const oldTimer = footerMarqueeTimers.get(sub);
  if (oldTimer) clearTimeout(oldTimer);
  footerMarqueeTimers.delete(sub);
  const run = (footerMarqueeRuns.get(sub) || 0) + 1;
  footerMarqueeRuns.set(sub, run);
  sub.classList.remove("marquee", "reset");
  track.onanimationend = null;
  track.style.animation = "none";
  track.style.transform = "translateX(0)";
  void track.offsetWidth;

  const need = !clip.hidden && Boolean(track.textContent) && track.scrollWidth > clip.clientWidth + 4;
  if (!need || reducedMotionQuery?.matches) {
    sub.style.removeProperty("--footer-marquee-distance");
    sub.style.removeProperty("--footer-marquee-duration");
    track.style.animation = "";
    return;
  }

  const distance = track.scrollWidth - clip.clientWidth + 16;
  const duration = Math.max(3, distance / FOOTER_PX_PER_SEC);
  sub.style.setProperty("--footer-marquee-distance", `${distance}px`);
  sub.style.setProperty("--footer-marquee-duration", `${duration}s`);

  const restart = () => {
    if (footerMarqueeRuns.get(sub) !== run) return;
    footerMarqueeTimers.delete(sub);
    sub.classList.remove("reset");
    track.style.animation = "none";
    track.style.transform = "translateX(0)";
    void track.offsetWidth;
    sub.classList.add("marquee");
    track.style.animation = "";
  };

  sub.classList.add("marquee");
  track.style.animation = "";
  track.onanimationend = (ev) => {
    if (footerMarqueeRuns.get(sub) !== run) return;
    if (ev.animationName === "footerMarquee") {
      footerMarqueeTimers.set(sub, window.setTimeout(() => {
        if (footerMarqueeRuns.get(sub) !== run) return;
        footerMarqueeTimers.delete(sub);
        sub.classList.remove("marquee");
        sub.classList.add("reset");
      }, MARQUEE_END_PAUSE_MS));
    } else if (ev.animationName === "footerReset") {
      sub.classList.remove("reset");
      track.style.transform = "translateX(0)";
      footerMarqueeTimers.set(sub, window.setTimeout(restart, FOOTER_MARQUEE_PAUSE_MS));
    }
  };
}

const TITLE_PX_PER_SEC = 42;
const TITLE_MARQUEE_PAUSE_MS = 1400;
const titleMarqueeRuns = new WeakMap();
const titleMarqueeTimers = new WeakMap();
const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");

function applyTitleMarquee(titleEl) {
  if (!titleEl) return;
  const clip = titleEl.querySelector(".title-clip");
  const track = titleEl.querySelector(".title-track");
  const t1 = titleEl.querySelector(".t1");
  if (!clip || !track || !t1) return;

  const oldTimer = titleMarqueeTimers.get(titleEl);
  if (oldTimer) clearTimeout(oldTimer);
  titleMarqueeTimers.delete(titleEl);
  const run = (titleMarqueeRuns.get(titleEl) || 0) + 1;
  titleMarqueeRuns.set(titleEl, run);
  titleEl.classList.remove("marquee", "reset");
  track.onanimationend = null;
  track.style.animation = "none";
  track.style.transform = "translateX(0)";
  void track.offsetWidth;
  const need = t1.scrollWidth > clip.clientWidth + 4;
  if (!need || reducedMotionQuery?.matches) {
    titleEl.style.removeProperty("--marquee-distance");
    titleEl.style.removeProperty("--marquee-duration");
    track.style.animation = "";
    return;
  }
  const distance = t1.scrollWidth - clip.clientWidth + 16;
  const duration = Math.max(3, distance / TITLE_PX_PER_SEC);
  titleEl.style.setProperty("--marquee-distance", distance + "px");
  titleEl.style.setProperty("--marquee-duration", duration + "s");

  const restart = () => {
    if (titleMarqueeRuns.get(titleEl) !== run) return;
    titleMarqueeTimers.delete(titleEl);
    titleEl.classList.remove("reset");
    track.style.animation = "none";
    track.style.transform = "translateX(0)";
    void track.offsetWidth;
    titleEl.classList.add("marquee");
    track.style.animation = "";
  };

  titleEl.classList.add("marquee");
  track.style.animation = "";
  track.onanimationend = (ev) => {
    if (titleMarqueeRuns.get(titleEl) !== run) return;
    if (ev.animationName === "titleMarquee") {
      titleMarqueeTimers.set(titleEl, window.setTimeout(() => {
        if (titleMarqueeRuns.get(titleEl) !== run) return;
        titleMarqueeTimers.delete(titleEl);
        titleEl.classList.remove("marquee");
        titleEl.classList.add("reset");
      }, MARQUEE_END_PAUSE_MS));
    } else if (ev.animationName === "titleReset") {
      titleEl.classList.remove("reset");
      track.style.transform = "translateX(0)";
      titleMarqueeTimers.set(titleEl, window.setTimeout(restart, TITLE_MARQUEE_PAUSE_MS));
    }
  };
}

function refreshTitleMarquees() {
  for (const titleEl of document.querySelectorAll(".fly-card .title")) {
    applyTitleMarquee(titleEl);
  }
  for (const sub of document.querySelectorAll(".fly-card .sub")) {
    applyFooterMarquee(sub);
  }
}

function applyNowPlaying(state) {
  if (!state) return;
  setFly(document.getElementById("fly-left"), state.deck1 || {}, "left");
  setFly(document.getElementById("fly-right"), state.deck2 || {}, "right");
}

async function pullNowPlaying() {
  try {
    const res = await fetch("/api/nowplaying", { cache: "no-store" });
    if (!res.ok) return;
    applyNowPlaying(await res.json());
  } catch { /* overlay stays live even if VDJ is down */ }
}

function tick() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  smoothAudio(dt);
  if (presetName !== visual.preset) {
    rebuild();
    resize();
  }
  if (presetName === "mirrored-bars") {
    waveGroup.rotation.set(0, 0, 0);
  } else {
    waveGroup.rotation.y += dt * visual.rotationSpeed * (0.18 + audio.mid * 0.35);
  }
  if (presetName === "helix") updateHelix(t);
  else if (presetName === "ribbon") updateRibbon(t);
  else if (presetName === "wings") updateWings();
  else if (presetName === "tunnel") updateTunnel(t);
  else if (presetName === "burst") updateBurst(t);
  else if (presetName === "cube") updateCube(t);
  else updateMirroredBars(dt);
  updateCubeFrame(t);
  updateLogo(dt, t);
  updateSnap(dt, t);
  updateAtmos(dt);
  updateSquiggles(dt);
  renderer.render(scene, camera);
  renderSpout();
  requestAnimationFrame(tick);
}

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  applyAlignment(w, h);
  resizeSpoutView();
  refreshTitleMarquees();
}

addEventListener("resize", resize);
rebuild();
initSpoutView();
makeSnapSystem();
makeAtmos();
makeSquiggles();
loadLogo();
resize();
requestAnimationFrame(tick);

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "frame" && msg.frame) {
      copyFrame(msg.frame, target);
    } else if (msg.type === "nowplaying") {
      applyNowPlaying(msg.state);
    } else if (msg.type === "status" && msg.status) {
      applySpoutStatus(msg.status);
    } else if (msg.type === "hello" || msg.type === "config") {
      if (msg.visual) Object.assign(visual, msg.visual);
      if (cubeFrameOverride !== null) visual.cubeFrame = cubeFrameOverride;
      if (msg.audio?.settings?.sensitivity) audioSensitivity = Number(msg.audio.settings.sensitivity) || audioSensitivity;
      if (!params.get("preset") && msg.visual?.preset) visual.preset = msg.visual.preset;
      if (msg.spout) setSpoutEnabled(msg.spout.enabled);
      if (msg.spoutStatus) applySpoutStatus(msg.spoutStatus);
      if (msg.nowPlaying) applyNowPlaying(msg.nowPlaying);
      rebuild();
      resize();
    }
  };
  ws.onclose = () => setTimeout(connect, 800);
}
connect();
connectSpout();
pullNowPlaying();
setInterval(pullNowPlaying, 1500);
