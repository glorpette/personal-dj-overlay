# WASAPI loopback helper (Windows)

`WasapiLoopback.cs` is compiled on first run by the Node service using

`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`

to `%LOCALAPPDATA%\vdj-live-overlay\WasapiLoopback.exe`.

```
WasapiLoopback.exe --list
WasapiLoopback.exe --default
WasapiLoopback.exe --id "{0.0.0.00000000}.{GUID}"
WasapiLoopback.exe --name "Speakers (Realtek(R) Audio)"
```

Stdout is raw interleaved stereo float32. Stderr prints `WASAPI_LOOPBACK device=... rate=...`.

This is listen-only. It does not open the device exclusive and does not change VirtualDJ routing.
