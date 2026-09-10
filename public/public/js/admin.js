const $ = (id) => document.getElementById(id);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

function fillDevices(devices, selected) {
  const sel = $("device");
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "(auto — default Windows playback device, loopback)";
  sel.appendChild(auto);
  for (const d of devices) {
    const o = document.createElement("option");
    o.value = d.id;
    const mark = d.default ? " ★ default" : "";
    o.textContent = `${d.name}${mark}  [${d.kind} / ${d.backend}]`;
    sel.appendChild(o);
  }
  if (selected) {
    const exact = [...sel.options].find((o) => o.value === selected || o.textContent.startsWith(selected));
    if (exact) sel.value = exact.value;
    else {
      const byName = devices.find((d) => d.name === selected);
      if (byName) sel.value = byName.id;
    }
  }
}

function applyConfig(cfg) {
  $("backend").value = cfg.audio.backend;
  $("sensitivity").value = cfg.audio.sensitivity;
  $("smoothing").value = cfg.audio.smoothing;
  $("preset").value = cfg.visual.preset;
  $("palette").value = cfg.visual.palette;
  $("alignment").value = cfg.visual.alignment;
  $("logoSafe").value = cfg.visual.logoSafe;
  $("rotationSpeed").value = cfg.visual.rotationSpeed;
  $("scale").value = cfg.visual.scale;
  $("bloom").checked = cfg.visual.bloom;
  $("vdjHost").value = cfg.vdj.host;
  $("vdjPort").value = cfg.vdj.port;
  $("vdjBearer").value = cfg.vdj.bearer;
  $("pollIntervalMs").value = cfg.vdj.pollIntervalMs;
  $("txtPath").value = cfg.nowPlaying.txtPath;
  $("jsonPath").value = cfg.nowPlaying.jsonPath;
}

function readPatch() {
  return {
    audio: {
      device: $("device").value,
      backend: $("backend").value,
      sensitivity: Number($("sensitivity").value),
      smoothing: Number($("smoothing").value),
    },
    visual: {
      preset: $("preset").value,
      palette: $("palette").value,
      alignment: $("alignment").value,
      logoSafe: Number($("logoSafe").value),
      rotationSpeed: Number($("rotationSpeed").value),
      scale: Number($("scale").value),
      bloom: $("bloom").checked,
    },
    vdj: {
      host: $("vdjHost").value.trim(),
      port: Number($("vdjPort").value),
      bearer: $("vdjBearer").value,
      pollIntervalMs: Number($("pollIntervalMs").value),
    },
    nowPlaying: {
      txtPath: $("txtPath").value.trim(),
      jsonPath: $("jsonPath").value.trim(),
    },
  };
}

async function refresh() {
  const [health, cfg, devices] = await Promise.all([
    api("/api/health"),
    api("/api/config"),
    api("/api/devices"),
  ]);
  fillDevices(devices.devices, cfg.audio.device);
  applyConfig(cfg);
  $("status").textContent = JSON.stringify(
    {
      audio: health.audio,
      vdjConnected: health.vdj.connected,
      vdjSource: health.vdj.source,
      onAir: health.vdj.onAirDeck,
      lastError: health.vdj.lastError || null,
    },
    null,
    2,
  );
  $("nowplaying").textContent = JSON.stringify(health.vdj, null, 2);
  $("overlayLink").href = `/overlay?preset=${encodeURIComponent(cfg.visual.preset)}`;
}

$("save").onclick = async () => {
  await api("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(readPatch()),
  });
  $("saved").textContent = "Saved " + new Date().toLocaleTimeString();
  await refresh();
};
$("refreshDevices").onclick = refresh;
$("restartAudio").onclick = async () => {
  await api("/api/audio/restart", { method: "POST" });
  await refresh();
};

refresh().catch((err) => {
  $("status").textContent = String(err);
});
setInterval(() => {
  api("/api/nowplaying")
    .then((s) => {
      $("nowplaying").textContent = JSON.stringify(s, null, 2);
    })
    .catch(() => {});
}, 1500);
