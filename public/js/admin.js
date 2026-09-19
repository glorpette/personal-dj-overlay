const $ = (id) => document.getElementById(id);
const SAVE_DEBOUNCE_MS = 500;

let pendingPatch = {};
let saveTimer = null;
let saveInFlight = false;
let savePromise = Promise.resolve(true);
let healthInFlight = false;
let spoutStatusInFlight = false;
let senderRefreshInFlight = false;
let deviceRefreshInFlight = false;
let configEtag = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function getConfigSnapshot() {
  const res = await fetch("/api/config", { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  configEtag = res.headers.get("etag") || configEtag;
  return res.json();
}

async function saveConfigPatch(patch) {
  const headers = { "content-type": "application/json" };
  if (configEtag) headers["if-match"] = configEtag;
  const res = await fetch("/api/config", {
    method: "POST",
    headers,
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    if (res.status === 409) {
      try { await getConfigSnapshot(); } catch { /* keep the local patch for retry */ }
      throw new Error("Config changed elsewhere; press Retry to merge this change");
    }
    throw new Error(`${res.status} ${await res.text()}`);
  }
  configEtag = res.headers.get("etag") || configEtag;
  return res.json();
}

function sendKeepalivePatch(patch) {
  if (!hasPatch(patch)) return;
  const headers = { "content-type": "application/json" };
  if (configEtag) headers["if-match"] = configEtag;
  void fetch("/api/config", {
    method: "POST",
    headers,
    body: JSON.stringify(patch),
    keepalive: true,
  }).catch(() => {});
}

function hasPatch(patch) {
  return patch && Object.keys(patch).length > 0;
}

function mergePatch(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (
      value && typeof value === "object" && !Array.isArray(value) &&
      out[key] && typeof out[key] === "object" && !Array.isArray(out[key])
    ) {
      out[key] = mergePatch(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function setSaveState(label, kind = "neutral", detail = "") {
  const state = $("saveState");
  const saved = $("saved");
  if (state) {
    state.textContent = label;
    state.className = `status-pill ${kind}`;
  }
  if (saved) {
    saved.textContent = detail || label;
    saved.className = `save-message${kind === "bad" ? " error" : ""}`;
  }
}

function queuePatch(patch, immediate = false) {
  pendingPatch = mergePatch(pendingPatch, patch);
  setSaveState("QUEUED", "saving", "Changes queued...");
  if (saveTimer) clearTimeout(saveTimer);
  if (immediate) return flushSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, SAVE_DEBOUNCE_MS);
  return Promise.resolve(true);
}

function flushSave() {
  if (saveInFlight) return savePromise;
  if (!hasPatch(pendingPatch)) return Promise.resolve(true);

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  const patch = pendingPatch;
  pendingPatch = {};
  saveInFlight = true;
  setSaveState("SAVING", "saving", "Saving changes...");
  $("retrySave").hidden = true;

  savePromise = (async () => {
    try {
      await saveConfigPatch(patch);
      if (hasPatch(pendingPatch)) {
        setSaveState("QUEUED", "saving", "More changes queued...");
        saveTimer = setTimeout(() => {
          saveTimer = null;
          void flushSave();
        }, 0);
      } else {
        setSaveState("SAVED", "good", `Saved ${new Date().toLocaleTimeString()}`);
      }
      return true;
    } catch (err) {
      // Keep failed changes ahead of edits made while the request was in flight.
      pendingPatch = mergePatch(patch, pendingPatch);
      setSaveState("RETRY", "bad", `Save failed - ${String(err)}`);
      $("retrySave").hidden = false;
      return false;
    } finally {
      saveInFlight = false;
    }
  })();
  return savePromise;
}

async function flushAllSaves() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  while (saveInFlight || hasPatch(pendingPatch)) {
    if (saveInFlight) {
      if (!(await savePromise)) return false;
    } else {
      if (!(await flushSave())) return false;
    }
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  }
  return true;
}

function setButtonBusy(button, busy, busyText = "Working...") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.defaultText) button.dataset.defaultText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
  } else {
    button.disabled = false;
    if (button.dataset.defaultText) button.textContent = button.dataset.defaultText;
  }
}

function setToggle(button, enabled) {
  if (!button) return;
  const on = Boolean(enabled);
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", String(on));
  const state = button.querySelector(".toggle-state");
  if (state) state.textContent = on ? "ON" : "OFF";
  if (button.id === "spoutToggle") setSpoutSettingsState(on);
}

function setSpoutSettingsState(enabled) {
  const settings = $("spoutSettings");
  if (!settings) return;
  const next = Boolean(enabled);
  const previous = settings.dataset.enabled;
  settings.classList.toggle("is-disabled", !next);
  const hint = $("spoutSettingsHint");
  if (hint) hint.textContent = next ? "Available" : "Enable to expand";
  if (previous === undefined || previous !== String(next)) settings.open = next;
  settings.dataset.enabled = String(next);
}

function setBadge(element, text, kind = "neutral") {
  if (!element) return;
  element.textContent = text;
  element.className = `${element.classList.contains("state-badge") ? "state-badge" : "status-pill"} ${kind}`;
}

function updateRangeValue(inputId, outputId) {
  const input = $(inputId);
  const output = $(outputId);
  if (input && output) output.textContent = input.value;
}

function fillDevices(devices, selected) {
  const sel = $("device");
  if (!sel) return;
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto - default Windows playback device, loopback";
  sel.appendChild(auto);
  for (const d of devices || []) {
    const option = document.createElement("option");
    option.value = d.id;
    const mark = d.default ? " [DEFAULT]" : "";
    option.textContent = `${d.name}${mark}  [${d.kind} / ${d.backend}]`;
    sel.appendChild(option);
  }
  if (selected != null) sel.value = selected;
}

function fillSpoutSenders(senders, selected, active) {
  const sel = $("spoutSender");
  if (!sel) return;
  const current = selected ?? sel.dataset.selected ?? sel.value ?? "";
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = active ? `(active: ${active})` : "(active Spout sender)";
  sel.appendChild(auto);
  for (const sender of senders || []) {
    const option = document.createElement("option");
    option.value = sender.name;
    option.textContent = `${sender.name} (${sender.width}x${sender.height})`;
    sel.appendChild(option);
  }
  if (current && !(senders || []).some((sender) => sender.name === current)) {
    const missing = document.createElement("option");
    missing.value = current;
    missing.textContent = `${current} (not currently available)`;
    sel.appendChild(missing);
  }
  sel.value = current;
  sel.dataset.selected = sel.value;
}

function applyConfig(cfg) {
  const audio = cfg.audio || {};
  const visual = cfg.visual || {};
  const vdj = cfg.vdj || {};
  const nowPlaying = cfg.nowPlaying || {};
  const spout = cfg.spout || {};

  $("backend").value = audio.backend ?? "auto";
  $("sensitivity").value = audio.sensitivity ?? 1.15;
  $("smoothing").value = audio.smoothing ?? 0.58;
  updateRangeValue("sensitivity", "sensitivityValue");
  updateRangeValue("smoothing", "smoothingValue");

  $("preset").value = visual.preset ?? "helix";
  $("palette").value = visual.palette ?? "cyan-magenta";
  $("alignment").value = visual.alignment ?? "center";
  $("logoSafe").value = visual.logoSafe ?? 0.12;
  $("rotationSpeed").value = visual.rotationSpeed ?? 0.18;
  $("logoSpin").value = visual.logoSpin ?? 0.35;
  $("scale").value = visual.scale ?? 1;
  $("snap").value = visual.snap ?? 0.35;
  for (const [input, output] of [
    ["logoSafe", "logoSafeValue"],
    ["rotationSpeed", "rotationSpeedValue"],
    ["logoSpin", "logoSpinValue"],
    ["scale", "scaleValue"],
    ["snap", "snapValue"],
  ]) updateRangeValue(input, output);
  setToggle($("bloomToggle"), visual.bloom);
  setToggle($("snapAutoToggle"), visual.snapAuto !== false);
  setToggle($("cubeFrameToggle"), visual.cubeFrame === true);

  $("vdjHost").value = vdj.host ?? "";
  $("vdjPort").value = vdj.port ?? 8080;
  $("vdjBearer").value = vdj.bearer ?? "";
  $("pollIntervalMs").value = vdj.pollIntervalMs ?? 750;
  $("txtPath").value = nowPlaying.txtPath ?? "";
  $("jsonPath").value = nowPlaying.jsonPath ?? "";

  setToggle($("spoutToggle"), spout.enabled);
  $("spoutSender").dataset.selected = spout.sender || "";
  $("spoutSender").value = spout.sender || "";
  $("spoutFps").value = spout.fps ?? 30;
  $("spoutQuality").value = spout.quality ?? 72;
  $("spoutMaxWidth").value = spout.maxWidth ?? 880;
  updateRangeValue("spoutQuality", "spoutQualityValue");
  for (const id of ["spoutFps", "spoutMaxWidth", "vdjPort", "pollIntervalMs"]) {
    const input = $(id);
    if (input) input.dataset.lastValid = input.value;
  }
  updateOverlayLink(visual.preset || "helix");
}

function updateOverlayLink(preset) {
  const link = $("overlayLink");
  if (link) link.href = `/overlay?preset=${encodeURIComponent(preset || "helix")}`;
}

function updateSpoutStatus(status) {
  if (!status) return;
  const enabled = Boolean(status.enabled);
  const connected = status.state === "connected" && Number(status.frameCount) > 0;
  const failed = Boolean(status.error) || status.state === "error";
  setSpoutSettingsState(enabled);
  const label = !enabled ? "DISABLED" : connected ? "CLUB CAM ACTIVE" : failed ? "ERROR" : String(status.state || "STARTING").toUpperCase();
  const kind = !enabled ? "neutral" : connected ? "good" : failed ? "bad" : "warn";
  setBadge($("spoutStateBadge"), label, kind);
  setBadge($("spoutBadge"), `CLUB CAM ${connected ? "OK" : enabled ? label : "OFF"}`, kind);
  const detail = status.error || (connected
    ? `${status.sender || "Sender"} - ${status.width || 0}x${status.height || 0} - ${status.frameCount || 0} frames`
    : `State: ${status.state || "unknown"}`);
  $("spoutStatusText").textContent = detail;
  $("spoutStatusText").className = `live-status ${kind}`;
  $("spoutStatus").textContent = JSON.stringify({
    state: status.state,
    running: status.running,
    enabled: status.enabled,
    sender: status.sender,
    size: status.width && status.height ? `${status.width}x${status.height}` : null,
    frameCount: status.frameCount ?? 0,
    lastFrame: status.lastFrameAt ? new Date(status.lastFrameAt).toLocaleTimeString() : null,
    error: status.error,
  }, null, 2);
}

function updateSystemSummary(health) {
  const summary = $("systemSummary");
  if (!summary) return;
  const audioOk = Boolean(health?.audio?.running);
  const vdjOk = Boolean(health?.vdj?.connected);
  const kind = audioOk && vdjOk ? "good" : audioOk || vdjOk ? "warn" : "bad";
  summary.textContent = `AUDIO ${audioOk ? "OK" : "OFFLINE"} / VDJ ${vdjOk ? "OK" : "OFFLINE"}`;
  summary.className = `glance-value ${kind}`;
}

function updateNowPlayingSummary(state) {
  const summary = $("nowPlayingSummary");
  if (!summary) return;
  const title = state?.masterTitle || state?.deck1?.artistTitle || state?.deck2?.artistTitle || "";
  summary.textContent = title || (state?.connected ? "No track loaded" : "VDJ offline");
  summary.title = title;
  summary.className = `glance-value ${state?.connected ? title ? "good" : "warn" : "bad"}`;
}

function updateHealth(health) {
  if (!health) return;
  updateSystemSummary(health);
  const audio = health.audio || {};
  const vdj = health.vdj || {};
  const audioOk = Boolean(audio.running);
  const vdjOk = Boolean(vdj.connected);
  setBadge($("audioBadge"), `AUDIO ${audioOk ? "OK" : "OFFLINE"}`, audioOk ? "good" : "bad");
  setBadge($("audioState"), audioOk ? "RUNNING" : "OFFLINE", audioOk ? "good" : "bad");
  setBadge($("vdjBadge"), `VDJ ${vdjOk ? "OK" : "OFFLINE"}`, vdjOk ? "good" : "warn");
  const audioDetail = audioOk
    ? `${audio.device || "Playback output"} - ${audio.backend || "audio"}`
    : audio.error || "Audio capture is offline";
  $("audioStatusText").textContent = audioDetail;
  $("audioStatusText").className = `live-status ${audioOk ? "good" : "bad"}`;
  $("status").textContent = JSON.stringify({
    audio: health.audio,
    spout: health.spout,
    vdjConnected: health.vdj.connected,
    vdjSource: health.vdj.source,
    onAir: health.vdj.onAirDeck,
    lastError: health.vdj.lastError || null,
  }, null, 2);
  $("nowplaying").textContent = JSON.stringify(health.vdj, null, 2);
  updateNowPlayingSummary(health.vdj);
  updateSpoutStatus(health.spout);
}

async function refreshHealth() {
  if (healthInFlight) return;
  healthInFlight = true;
  try {
    updateHealth(await api("/api/health"));
  } catch (err) {
    setBadge($("audioBadge"), "AUDIO ERROR", "bad");
    setBadge($("vdjBadge"), "VDJ UNKNOWN", "warn");
    updateSystemSummary(null);
    updateNowPlayingSummary(null);
    $("audioStatusText").textContent = String(err);
    $("audioStatusText").className = "live-status bad";
    $("status").textContent = String(err);
  } finally {
    healthInFlight = false;
  }
}

async function refreshSpoutStatus() {
  if (spoutStatusInFlight) return;
  spoutStatusInFlight = true;
  try {
    updateSpoutStatus(await api("/api/spout/status"));
  } catch (err) {
    $("spoutStatusText").textContent = String(err);
    $("spoutStatusText").className = "live-status bad";
  } finally {
    spoutStatusInFlight = false;
  }
}

async function refreshSpoutSenders() {
  if (senderRefreshInFlight) return;
  senderRefreshInFlight = true;
  const button = $("refreshSpoutSenders");
  setButtonBusy(button, true, "Finding senders...");
  try {
    const result = await api("/api/spout/senders");
    fillSpoutSenders(result.senders, $("spoutSender").dataset.selected, result.active);
  } catch (err) {
    $("spoutStatusText").textContent = String(err);
    $("spoutStatusText").className = "live-status bad";
  } finally {
    senderRefreshInFlight = false;
    setButtonBusy(button, false);
  }
}

async function refreshDevices() {
  if (deviceRefreshInFlight) return;
  deviceRefreshInFlight = true;
  const button = $("refreshDevices");
  setButtonBusy(button, true, "Finding devices...");
  try {
    const result = await api("/api/devices");
    fillDevices(result.devices, $("device").value);
  } catch (err) {
    setSaveState("DEVICE ERROR", "bad", String(err));
  } finally {
    deviceRefreshInFlight = false;
    setButtonBusy(button, false);
  }
}

async function refreshInitial() {
  const [healthResult, configResult, devicesResult] = await Promise.allSettled([
      api("/api/health"),
      getConfigSnapshot(),
      api("/api/devices"),
  ]);
  if (configResult.status === "rejected") {
    $("status").textContent = String(configResult.reason);
    setSaveState("OFFLINE", "bad", String(configResult.reason));
    return;
  }
  const cfg = configResult.value;
  applyConfig(cfg);
  if (devicesResult.status === "fulfilled") fillDevices(devicesResult.value.devices, cfg.audio.device);
  else setSaveState("DEVICE ERROR", "bad", String(devicesResult.reason));
  if (healthResult.status === "fulfilled") updateHealth(healthResult.value);
  else {
    updateSystemSummary(null);
    updateNowPlayingSummary(null);
    $("status").textContent = String(healthResult.reason);
  }
  void refreshSpoutSenders();
}

function numberPatch(input, makePatch) {
  if (!input.value.trim()) return null;
  const value = Number(input.value);
  const min = Number(input.min);
  const max = Number(input.max);
  if (!Number.isFinite(value) || (Number.isFinite(min) && value < min) || (Number.isFinite(max) && value > max)) {
    input.setCustomValidity(`Enter a value between ${input.min || "-infinity"} and ${input.max || "infinity"}.`);
    return null;
  }
  input.setCustomValidity("");
  input.dataset.lastValid = input.value;
  return makePatch(value);
}

function bindRange(inputId, outputId, makePatch) {
  const input = $(inputId);
  if (!input) return;
  const update = () => {
    updateRangeValue(inputId, outputId);
    queuePatch(makePatch(Number(input.value)));
  };
  input.addEventListener("input", update);
  input.addEventListener("change", () => void flushSave());
}

function bindNumber(inputId, makePatch) {
  const input = $(inputId);
  if (!input) return;
  const update = () => {
    const patch = numberPatch(input, makePatch);
    if (patch) queuePatch(patch);
  };
  input.addEventListener("input", update);
  input.addEventListener("change", () => {
    const patch = numberPatch(input, makePatch);
    if (patch) void queuePatch(patch, true);
    else {
      input.value = input.dataset.lastValid || input.value;
      input.setCustomValidity("");
    }
  });
}

function bindText(inputId, makePatch) {
  const input = $(inputId);
  if (!input) return;
  input.addEventListener("input", () => queuePatch(makePatch(input.value)));
  input.addEventListener("change", () => void flushSave());
  input.addEventListener("blur", () => void flushSave());
}

function bindImmediateSelect(inputId, makePatch) {
  const input = $(inputId);
  if (!input) return;
  input.addEventListener("change", () => void queuePatch(makePatch(input.value), true));
}

function bindToggle(buttonId, makePatch) {
  const button = $(buttonId);
  if (!button) return;
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-pressed") !== "true";
    setToggle(button, next);
    void queuePatch(makePatch(next), true);
  });
}

bindToggle("spoutToggle", (enabled) => ({ spout: { enabled } }));
bindToggle("bloomToggle", (bloom) => ({ visual: { bloom } }));
bindToggle("snapAutoToggle", (snapAuto) => ({ visual: { snapAuto } }));
bindToggle("cubeFrameToggle", (cubeFrame) => ({ visual: { cubeFrame } }));

bindImmediateSelect("device", (device) => ({ audio: { device } }));
bindImmediateSelect("backend", (backend) => ({ audio: { backend } }));
bindImmediateSelect("preset", (preset) => {
  updateOverlayLink(preset);
  return { visual: { preset } };
});
bindImmediateSelect("palette", (palette) => ({ visual: { palette } }));
bindImmediateSelect("alignment", (alignment) => ({ visual: { alignment } }));
bindImmediateSelect("spoutSender", (sender) => {
  $("spoutSender").dataset.selected = sender;
  return { spout: { sender } };
});

bindRange("sensitivity", "sensitivityValue", (sensitivity) => ({ audio: { sensitivity } }));
bindRange("smoothing", "smoothingValue", (smoothing) => ({ audio: { smoothing } }));
bindRange("logoSafe", "logoSafeValue", (logoSafe) => ({ visual: { logoSafe } }));
bindRange("rotationSpeed", "rotationSpeedValue", (rotationSpeed) => ({ visual: { rotationSpeed } }));
bindRange("logoSpin", "logoSpinValue", (logoSpin) => ({ visual: { logoSpin } }));
bindRange("scale", "scaleValue", (scale) => ({ visual: { scale } }));
bindRange("snap", "snapValue", (snap) => ({ visual: { snap } }));
bindRange("spoutQuality", "spoutQualityValue", (quality) => ({ spout: { quality } }));

bindNumber("spoutFps", (fps) => ({ spout: { fps } }));
bindNumber("spoutMaxWidth", (maxWidth) => ({ spout: { maxWidth } }));
bindNumber("vdjPort", (port) => ({ vdj: { port } }));
bindNumber("pollIntervalMs", (pollIntervalMs) => ({ vdj: { pollIntervalMs } }));

bindText("vdjHost", (host) => ({ vdj: { host: host.trim() } }));
bindText("vdjBearer", (bearer) => ({ vdj: { bearer } }));
bindText("txtPath", (txtPath) => ({ nowPlaying: { txtPath: txtPath.trim() } }));
bindText("jsonPath", (jsonPath) => ({ nowPlaying: { jsonPath: jsonPath.trim() } }));

$("retrySave").onclick = () => void flushAllSaves();
$("refreshDevices").onclick = () => void refreshDevices();
$("refreshSpoutSenders").onclick = () => void refreshSpoutSenders();

$("restartAudio").onclick = async () => {
  if (!(await flushAllSaves())) return;
  const button = $("restartAudio");
  setButtonBusy(button, true, "Restarting...");
  try {
    await api("/api/audio/restart", { method: "POST" });
    setSaveState("READY", "neutral", "Audio restart requested.");
    await refreshHealth();
  } catch (err) {
    setSaveState("RETRY", "bad", String(err));
  } finally {
    setButtonBusy(button, false);
  }
};

$("restartSpout").onclick = async () => {
  if (!(await flushAllSaves())) return;
  const button = $("restartSpout");
  setButtonBusy(button, true, "Restarting...");
  try {
    await api("/api/spout/restart", { method: "POST" });
    setSaveState("READY", "neutral", "Club Cam restart requested.");
    await refreshSpoutStatus();
  } catch (err) {
    setSaveState("RETRY", "bad", String(err));
  } finally {
    setButtonBusy(button, false);
  }
};

for (const drawer of document.querySelectorAll("details.drawer")) {
  const key = `vdj-overlay.drawer.${drawer.querySelector("summary")?.textContent?.trim() || drawer.id}`;
  try {
    if (sessionStorage.getItem(key) === "open") drawer.open = true;
  } catch { /* storage can be unavailable in restricted browsers */ }
  drawer.addEventListener("toggle", () => {
    try { sessionStorage.setItem(key, drawer.open ? "open" : "closed"); } catch { /* ignore */ }
  });
}

addEventListener("pagehide", () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!saveInFlight && hasPatch(pendingPatch)) {
    const patch = pendingPatch;
    pendingPatch = {};
    sendKeepalivePatch(patch);
  }
});

void refreshInitial();
setInterval(() => void refreshHealth(), 1500);
setInterval(() => {
  api("/api/nowplaying")
    .then((state) => {
      $("nowplaying").textContent = JSON.stringify(state, null, 2);
      updateNowPlayingSummary(state);
    })
    .catch(() => {});
}, 1500);
