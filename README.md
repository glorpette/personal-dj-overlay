# vdj-live-overlay

Local booth service for live VirtualDJ events:

1. Captures the **playback / loopback** of a chosen output device (not a microphone, not a file).
2. Serves a **transparent 3D waveform overlay** at `http://127.0.0.1:4780/overlay`.
3. Polls VirtualDJ **Network Control** HTTP and atomically writes **Deck 1 + Deck 2** metadata to disk.
4. Optionally receives a **Spout2 DX11 sender** through a native helper and displays it in a fixed WebGL camera panel.

Built for unattended use on the same PC as VirtualDJ. Runtime: Node.js 24 LTS for source development, or the Windows x64 single executable described below. FFmpeg is optional on Windows and can be installed from the app's pinned LGPL build.

```
[VirtualDJ] --HTTP poll--> [this service] --atomic write--> data/nowplaying.txt
[Output device loopback] -> ffmpeg/parec -> FFT -> WebSocket -> /overlay (WebGL, alpha)
[Spout2 sender] -> native DX11 receiver -> JPEG WebSocket -> fixed WebGL camera panel
[OBS / static page] embeds overlay URL and reads the text file
```

## Quick start

```bash
cd vdj-live-overlay
npm install
cp config.example.json config.json   # already auto-written on first start
npm start
```

Then open:

| URL | Purpose |
| --- | --- |
| http://127.0.0.1:4780/admin | Operator UI (device, preset, VDJ port) |
| http://127.0.0.1:4780/overlay | Transparent waveform (OBS browser source) |
| http://127.0.0.1:4780/display | Sample event page that composites both |
| http://127.0.0.1:4780/api/nowplaying | Same payload as the JSON file |

```bash
npm run devices    # list loopback / monitor devices
npm run check      # config + VDJ ping + device match
```

First-frame path: HTTP server binds immediately; audio capture starts in parallel. Demo oscillator is used if no device matches so the overlay is never blank during setup.

## Windows single executable

Build on a Windows x64 machine with Node 24 LTS and the .NET Framework 4.x
compiler available:

```powershell
npm install
npm run build:win
```

The output is `dist\VDJLiveOverlay.exe`. The executable embeds the Node
bundle, frontend assets, third-party notices, and x64 WASAPI/Spout helpers.
On first launch it creates `config.json` and `data\` beside the executable,
opens `/admin`, and extracts verified helpers to
`%LOCALAPPDATA%\vdj-live-overlay`. Use `--no-open` for unattended startup.

Useful packaged commands:

```text
VDJLiveOverlay.exe --check
VDJLiveOverlay.exe --devices
VDJLiveOverlay.exe --licenses
VDJLiveOverlay.exe --install-ffmpeg
```

The FFmpeg command downloads the pinned SHA-256-verified win64 LGPL archive;
it is never downloaded automatically. The build is unsigned unless a local
Windows signing step is added after `postject`.

## VirtualDJ Network Control

Requires **VirtualDJ 2023+** and a **Pro** license.

1. Config → **Extensions** → Effects → Other → install **Network Control**.
2. Master panel → Master Effect drop-down → **Auto-Start** category → enable **Network Control**.
3. Cog wheel: set **port** (this repo defaults to `8080`; the official examples sometimes show `80`) and optional password.
4. Put the same port / bearer in `config.json` → `vdj`.

Queries used (all localhost GET `/query?script=`):

- `deck N get_artist`, `get_title`, `get_artist_title`, `get_album`, `get_bpm`, `get_key`
- `deck N play`, `deck N is_audible`, `deck N get_time "elapsed"`, `deck N get_songlength`
- `deck master get_artist_title`
- `get_version` (connectivity)

Auth: `Authorization: Bearer <password>` or empty if the plugin has no password.

If HTTP is down, last known deck values are kept (`connected: false`). Optional fallback reads `Documents/VirtualDJ/History/tracklist.txt` or the newest History `*.m3u` — that path only knows the logged master track, not both live decks.

## Audio device (loopback)

Visualization is **listen-only**. It must not be inserted into the VirtualDJ output graph.

### Windows (this app is designed for booth PCs)

Capture is a **native WASAPI loopback helper** (`helpers/wasapi-loopback/WasapiLoopback.cs`), compiled once with the .NET Framework `csc.exe` that ships with Windows. It lists real **playback** endpoints and records the shared-mode mix of the device you pick. Nothing is inserted into the DJ output path.

1. In `/admin` click **Refresh devices**.
2. Choose the same **playback** device VirtualDJ is using (e.g. `Speakers (Realtek(R) Audio)`, your booth interface, or a virtual cable). The default device is marked ★.
3. Save, play a track in VirtualDJ, confirm the overlay moves with the music — not a looping demo beat.

**If the waveform is a fake kick/hat pattern:** you were on the demo oscillator. That is no longer selected automatically.

**If the waveform is flat while music plays:**
- VirtualDJ is likely in **ASIO or exclusive WASAPI** on that output. Windows loopback can only hear the shared engine mix. Switch that output to **WASAPI shared**, or send a copy of master to a second device (VB-Audio Cable / Voicemeeter) and loopback *that* device.
- You selected a different interface than master.

FFmpeg is only a fallback (`backend: ffmpeg`). Do not use `-loopback` as an FFmpeg flag — it is not a valid wasapi option.

### Linux

- PipeWire / Pulse **monitor** sources (`something.monitor`).
- `parec` is preferred when present; FFmpeg `-f pulse` otherwise.
- Pick the monitor of the sink VirtualDJ uses.

### macOS

- Core Audio does **not** expose a native “tap this render device” API the way WASAPI loopback does.
- Create a multi-output device + **BlackHole** / Loopback / Soundflower, play VDJ into it, capture the virtual input.
- ScreenCaptureKit system-audio exists at the OS level but is not wired here (permission + helper required). Honest gap: without a virtual device you only get a microphone.

Device unplug / sample-rate change / process exit: capture restarts with exponential backoff (1s → 10s). The overlay keeps running.

## Overlay as a transparent browser source

OBS / vMix / similar:

1. Source → Browser → URL `http://127.0.0.1:4780/overlay`
2. Width / height = output canvas
3. Enable **Transparent** / custom CSS empty
4. Shutdown-when-not-visible: **off**
5. Do **not** let the browser source capture desktop audio (we already visualize the chosen device)

The page sets `background: transparent`, WebGL `alpha: true`, clear color alpha `0`. There is no chrome on `/overlay`.

### Spout2 camera feed

Enable **Spout2 camera** from `/admin`, choose a named sender or leave the sender empty to use the active sender, then save the configuration. In source development the native helper is compiled on first use with the .NET Framework `csc.exe`; the packaged executable extracts its verified helper to `%LOCALAPPDATA%\vdj-live-overlay\SpoutReceiver.exe`.

The helper follows the same shared-DX11-texture approach used by the OBS Spout2 source: it finds the sender, opens its shared texture on a compatible adapter, copies it to a CPU-readable staging texture, and JPEG-encodes frames. The Node service forwards only the latest frames on a separate `/spout` WebSocket. The browser decodes them with `createImageBitmap()` and uploads them to a dedicated THREE.js WebGL canvas.

The camera is a fixed panel in the upper-right of the overlay. Enabling it reveals the panel with the same `flyIn` animation used by the DECK 1 card. The panel uses an ordinary opaque JPEG feed; transparency remains around the panel, not inside the video. This bridge intentionally favors a basic reliable implementation over zero-copy GPU transport.

Useful endpoints:

- `/api/spout/status` — native receiver state and current dimensions.
- `/api/spout/senders` — live Spout sender list.
- `/api/spout/restart` — restart the native receiver with the saved settings.

The native helper also supports direct diagnostics:

```text
%LOCALAPPDATA%\vdj-live-overlay\SpoutReceiver.exe --list
%LOCALAPPDATA%\vdj-live-overlay\SpoutReceiver.exe --name "SenderName" --fps 30 --quality 72 --max-width 880
```

Query overrides (optional):

```
/overlay?preset=wings&palette=amber-ice&align=bottom&safe=0.16&spin=0.2&scale=1
```

Presets: `helix`, `ribbon`, `wings`, `tunnel`, `burst`  
Alignments: `center`, `bottom`, `side`, `frame`

## Now-playing files

Atomic write = temp file + `rename`. Readers never see a torn file.

`data/nowplaying.txt`

```text
DECK1=Artist - Title
DECK2=Artist - Title
ONAIR=1
MASTER=Artist - Title
CONNECTED=1
SOURCE=http
UPDATED=2026-09-07T14:50:00.000Z
```

`data/nowplaying.json` mirrors `/api/nowplaying`:

```json
{
  "connected": true,
  "source": "http",
  "deck1": { "artist": "", "title": "", "bpm": 128, "playing": true, "audible": true },
  "deck2": { "artist": "", "title": "", "bpm": 126, "playing": true, "audible": false },
  "onAirDeck": 1,
  "masterTitle": "Artist - Title",
  "updatedAt": "2026-09-07T14:50:00.000Z"
}
```

A static page on the same machine can:

- poll `/api/nowplaying`, or
- read the JSON/TXT from disk (OBS text source, custom HTML `file://` will not read arbitrary paths — prefer the HTTP endpoint or a local watcher).

Writes happen on change and on a 5s heartbeat (`nowPlaying.heartbeatMs`).

## Config

`config.json` (auto-created from defaults):

- `server.host` / `server.port` — bind address (keep `127.0.0.1` on a booth PC)
- `audio.device` — exact or substring match of a listed device; empty = first monitor/loopback
- `audio.backend` — `auto` | `ffmpeg` | `pulse` | `demo`
- `vdj.host` / `port` / `bearer` / `pollIntervalMs` / `decks`
- `nowPlaying.txtPath` / `jsonPath`
- `spout.enabled` / `sender` / `fps` / `quality` / `maxWidth`
- `visual.*` — also editable live from `/admin`

## Performance

- Capture hop ~33 ms, WebSocket JSON frames (~64 bins + 128-sample stereo wave).
- Overlay: instanced boxes / lines, additive materials, no post-process composer (bloom is faked with additive blending so transparency stays intact).
- Pixel ratio capped at 1.75. Expect well under a core and modest GPU on a typical booth laptop while VirtualDJ is running.
- Latency target: device buffer + 1 hop + 1 frame ≈ 50–90 ms when FFmpeg/Pulse is healthy.
- Spout latency includes DX11 staging readback, JPEG encoding, browser decode, and WebGL texture upload. Start with `maxWidth: 880` and `fps: 30` before increasing capture size.

## Adding a waveform preset

1. Add a name to `PRESETS` in `public/js/overlay.js`.
2. Write `buildX()` (create meshes, push onto `meshes`) and `updateX(t)` (drive from `latest.bins` / `waveL` / `waveR` / `bass|mid|high`).
3. Add an `<option>` in `public/admin.html`.
4. Keep materials `transparent` + `depthWrite: false`. Never set `scene.background` to an opaque color.

The analyzer lives in `src/audio/analyzer.ts` (Hann + radix-2 FFT, log-spaced bins).

## Operator checklist

See [OPERATOR.md](OPERATOR.md).
