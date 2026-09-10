# Native Spout2 receiver

During development, `SpoutReceiver.cs` is compiled on first run by the Node
service using

`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`

to `%LOCALAPPDATA%\vdj-live-overlay\SpoutReceiver.exe`.

This is a **native Spout2 client**: it reads the Spout sender-name map, opens the sender’s shared Direct3D 11 texture, copies it through a staging resource, JPEG-encodes, and writes frames to stdout. It does **not** use OBS, SpoutCam, or a window capture.

```
SpoutReceiver.exe --list
SpoutReceiver.exe --name "SenderName" --fps 30 --quality 72 --max-width 880
SpoutReceiver.exe --active
SpoutReceiver.exe --send-test --name "VDJ Overlay Test"
```

Stdout (receive mode) is binary:

```
"SPUT" + uint32 LE length + JPEG bytes
```

Stderr prints `SPOUT_META {…}` JSON lines (`waiting`, `connected`, `open-failed`, …).

`--list` prints a JSON object of live senders on stdout.

The packaged Windows executable embeds a precompiled x64 helper and extracts
it to the same `%LOCALAPPDATA%\vdj-live-overlay` location after verifying its
SHA-256 hash. It does not require a compiler on the target PC.
