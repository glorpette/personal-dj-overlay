# Live-event operator checklist

Do this once per booth PC, then only confirm before doors.

## One-time setup

1. Install **Node.js 20+** and **FFmpeg**, both on PATH.
2. Copy this folder onto the booth PC. Run `npm install` then `npm start` once so `config.json` is created.
3. In VirtualDJ: install and **enable** Network Control (Master → Auto-Start). Note the port and password.
4. Point VirtualDJ master (or the bus you want visualized) at a **shared-mode** output device.
5. Open http://127.0.0.1:4780/admin
   - Select that output / its monitor / loopback (not the microphone).
   - Enter VDJ host `127.0.0.1`, port, bearer.
   - Pick a waveform preset and alignment that clears title text (`bottom` + logo-safe if titles sit mid-frame).
6. In OBS (or the venue player) add a **Browser source**:
   - URL `http://127.0.0.1:4780/overlay`
   - Transparent background ON
7. Point the existing static page at `data/nowplaying.txt` / `data/nowplaying.json`, or at `http://127.0.0.1:4780/api/nowplaying`.

## Before the set (~3 minutes)

- [ ] VirtualDJ open, Network Control effect **on**
- [ ] `npm start` in this folder (or the Windows shortcut / scheduled task you created)
- [ ] http://127.0.0.1:4780/admin → audio **running**, VDJ **connected**
- [ ] Play a track on deck 1 and another on deck 2 — both lines appear in Now playing
- [ ] Overlay reacts to the **master speakers**, not the mic, and is not the demo kick/hat loop
- [ ] VirtualDJ output on that device is **WASAPI shared** (not ASIO exclusive)
- [ ] OBS overlay has no black box
- [ ] Walk away. Do not touch `/overlay` during the set; use `/admin` on a utility monitor if needed.

## If something dies mid-set

| Symptom | Action |
| --- | --- |
| Waveform frozen | `/admin` → Restart capture. Confirm device still exists. |
| Black box in OBS | Refresh browser source. Confirm URL is `/overlay` not `/admin`. |
| Now playing stale | Network Control still enabled? Port match? Service keeps last titles and retries by itself. |
| Service crash | `npm start` again. Overlay and file writer come back independently of VDJ. |
| Wrong song visualized | You captured headphones / a different interface. Reselect the master output. |

## Shutdown

Ctrl+C in the service window, or close the terminal. Safe to kill; files are renamed atomically so they will not stay half-written.
