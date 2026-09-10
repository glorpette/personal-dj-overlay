# vdj-live-overlay

Local booth service for live VirtualDJ events:

1. Captures the **playback / loopback** of a chosen output device (not a microphone, not a file).
2. Serves a **transparent 3D waveform overlay** at `http://127.0.0.1:4780/overlay`.
3. Polls VirtualDJ **Network Control** HTTP and atomically writes **Deck 1 + Deck 2** metadata to disk.

Built for unattended use on the same PC as VirtualDJ. Runtime: Node.js 22.6+ (runs the TypeScript sources directly) or Node 20 with `npm run start:tsx`, plus FFmpeg on PATH for loopback capture.

```
[VirtualDJ] --HTTP poll--> [this service] --atomic write--> data/nowplaying.txt
[Output device loopback] -> ffmpeg/parec -> FFT -> WebSocket -> /overlay (WebGL, alpha)
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
- `visual.*` — also editable live from `/admin`

## Performance

- Capture hop ~33 ms, WebSocket JSON frames (~64 bins + 128-sample stereo wave).
- Overlay: instanced boxes / lines, additive materials, no post-process composer (bloom is faked with additive blending so transparency stays intact).
- Pixel ratio capped at 1.75. Expect well under a core and modest GPU on a typical booth laptop while VirtualDJ is running.
- Latency target: device buffer + 1 hop + 1 frame ≈ 50–90 ms when FFmpeg/Pulse is healthy.

## Adding a waveform preset

1. Add a name to `PRESETS` in `public/js/overlay.js`.
2. Write `buildX()` (create meshes, push onto `meshes`) and `updateX(t)` (drive from `latest.bins` / `waveL` / `waveR` / `bass|mid|high`).
3. Add an `<option>` in `public/admin.html`.
4. Keep materials `transparent` + `depthWrite: false`. Never set `scene.background` to an opaque color.

The analyzer lives in `src/audio/analyzer.ts` (Hann + radix-2 FFT, log-spaced bins).

## Operator checklist

See [OPERATOR.md](OPERATOR.md).
