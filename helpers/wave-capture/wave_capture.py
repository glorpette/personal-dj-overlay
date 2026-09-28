"""Capture VirtualDJ's waveform pop-out for the managed OBS browser source."""

from __future__ import annotations

import argparse
import ctypes
import json
import struct
import sys
import threading
import time
import traceback
from collections import deque
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


WIDTH = 1920
HEIGHT = 1080
WAVE_WIDTH = 120
LEFT_X = 48
RIGHT_X = 1752
PAGE = b"""<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b0d10}
img{display:block;width:100vw;height:100vh;object-fit:fill}
</style></head><body><img src="/stream" alt="VirtualDJ waveforms"></body></html>"""


def vdj_windows():
    if sys.platform != "win32":
        raise RuntimeError("Window discovery requires Windows")

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    windows = []
    processes = {}

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, unused):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in processes:
            process = kernel32.OpenProcess(0x1000, False, pid.value)
            path = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(path))
            processes[pid.value] = (
                path.value.lower() if process and kernel32.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(length)) else ""
            )
            if process:
                kernel32.CloseHandle(process)
        if not processes[pid.value].endswith("\\virtualdj.exe"):
            return True
        rect = wintypes.RECT()
        if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
            return True
        title_length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(hwnd, title, len(title))
        windows.append({
            "hwnd": int(hwnd), "pid": pid.value, "title": title.value,
            "width": rect.right - rect.left, "height": rect.bottom - rect.top,
            "owned": bool(user32.GetWindow(hwnd, 4)),  # GW_OWNER
        })
        return True

    user32.EnumWindows(visit, 0)
    return windows


def find_popout(windows):
    owned = [w for w in windows if w["owned"] and w["width"] > 900 and w["height"] > 500]
    if len(owned) == 1:
        return owned[0]
    candidates = [
        w for w in windows
        if abs(w["width"] - WIDTH) <= 24 and abs(w["height"] - HEIGHT) <= 24
    ]
    # A same-sized main VDJ window is never an acceptable fallback.
    candidates = [w for w in candidates if w["owned"]]
    if len(candidates) == 1:
        return candidates[0]
    named = [w for w in candidates if "wave" in w["title"].lower()]
    return named[0] if len(named) == 1 else None


class CapturableWindow:
    """Make the pop-out capturable and independent of the main VDJ window."""

    GWL_STYLE = -16
    GWL_EXSTYLE = -20
    GWLP_HWNDPARENT = -8  # For a top-level window this changes its owner.
    GW_OWNER = 4
    WS_BORDER = 0x00800000
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_APPWINDOW = 0x00040000
    SWP_FRAMECHANGED_NO_MOVE = 0x37  # FRAMECHANGED | NOMOVE | NOSIZE | NOZORDER | NOACTIVATE
    SWP_SEND_TO_BACK = 0x13  # NOMOVE | NOSIZE | NOACTIVATE
    HWND_BOTTOM = 1

    def __init__(self, hwnd, pid):
        self.hwnd = hwnd
        self.pid = pid
        self.original = None
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        u = self.user32
        u.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
        u.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        u.SetWindowLongPtrW.restype = ctypes.c_ssize_t
        u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        u.SetWindowPos.restype = wintypes.BOOL
        u.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
        u.GetWindow.restype = wintypes.HWND
        u.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]

    def belongs_to_vdj(self):
        if not self.user32.IsWindow(self.hwnd):
            return False
        actual = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(self.hwnd, ctypes.byref(actual))
        return actual.value == self.pid

    def set_style(self, which, value):
        ctypes.set_last_error(0)
        result = self.user32.SetWindowLongPtrW(self.hwnd, which, value)
        if result == 0 and ctypes.get_last_error():
            raise ctypes.WinError(ctypes.get_last_error())

    def refresh(self):
        if not self.user32.SetWindowPos(self.hwnd, 0, 0, 0, 0, 0, self.SWP_FRAMECHANGED_NO_MOVE):
            raise ctypes.WinError(ctypes.get_last_error())

    def apply(self):
        if not self.belongs_to_vdj():
            raise RuntimeError("VirtualDJ pop-out closed before capture started")
        style = self.user32.GetWindowLongPtrW(self.hwnd, self.GWL_STYLE)
        extended = self.user32.GetWindowLongPtrW(self.hwnd, self.GWL_EXSTYLE)
        owner = self.user32.GetWindow(self.hwnd, self.GW_OWNER)
        if not owner and not extended & self.WS_EX_TOOLWINDOW:
            return
        self.original = (style, extended, owner)
        try:
            if extended & self.WS_EX_TOOLWINDOW:
                self.set_style(self.GWL_EXSTYLE, (extended & ~self.WS_EX_TOOLWINDOW) | self.WS_EX_APPWINDOW)
                self.set_style(self.GWL_STYLE, style | self.WS_BORDER)
                self.refresh()
            if owner:
                self.set_style(self.GWLP_HWNDPARENT, 0)
                # Without an owner, activating VirtualDJ no longer raises this window.
                if not self.user32.SetWindowPos(self.hwnd, self.HWND_BOTTOM, 0, 0, 0, 0, self.SWP_SEND_TO_BACK):
                    raise ctypes.WinError(ctypes.get_last_error())
        except Exception:
            self.restore()
            raise

    def restore(self):
        original, self.original = self.original, None
        if original and self.belongs_to_vdj():
            style, extended, owner = original
            if owner and self.user32.IsWindow(owner):
                self.set_style(self.GWLP_HWNDPARENT, owner)
            self.set_style(self.GWL_STYLE, style)
            self.set_style(self.GWL_EXSTYLE, extended)
            self.refresh()


class Feed:
    def __init__(self, fps, quality, hwnd=None, pipe_mode=False):
        self.fps = fps
        self.quality = quality
        self.hwnd = hwnd
        self.pipe_mode = pipe_mode
        self.output_lock = threading.Lock()
        self.stdin_buffer = bytearray()
        self.condition = threading.Condition()
        self.frame = None
        self.sequence = 0
        self.message = "Waiting for the VirtualDJ waveform pop-out"
        self.active_hwnd = None
        self.active_title = ""
        self.running = True
        self.control = None
        self.pending = None
        self.capture_count = 0
        self.capture_times = deque(maxlen=300)
        self.encode_times = deque(maxlen=300)
        self.stream_times = deque(maxlen=600)
        self.stream_clients = 0
        self.started_at = time.monotonic()
        self.stream_started_at = self.started_at

    def rate(self, events, now, started_at=None):
        recent = sum(stamp > now - 2 for stamp in events)
        return round(recent / min(2, max(0.5, now - (started_at or self.started_at))), 1)

    def diagnostics(self):
        with self.condition:
            now = time.monotonic()
            return {
                "capturing": self.frame is not None,
                "status": self.message,
                "selected_hwnd": f"0x{self.hwnd:x}" if self.hwnd else "",
                "active_hwnd": f"0x{self.active_hwnd:x}" if self.active_hwnd else None,
                "active_title": self.active_title,
                "frames": self.sequence,
                "target_fps": self.fps,
                "capture_fps": self.rate(self.capture_times, now),
                "encode_fps": self.rate(self.encode_times, now),
                "output_fps": round(self.rate(self.stream_times, now, self.stream_started_at) / max(1, self.stream_clients), 1),
                "stream_clients": self.stream_clients,
                "last_capture_age_ms": round((now - self.capture_times[-1]) * 1000) if self.capture_times else None,
            }

    def publish(self, frame):
        with self.condition:
            self.frame = frame
            self.sequence += 1
            self.encode_times.append(time.monotonic())
            self.condition.notify_all()
        if self.pipe_mode:
            try:
                with self.output_lock:
                    sys.stdout.buffer.write(struct.pack("<I", len(frame)))
                    sys.stdout.buffer.write(frame)
                    sys.stdout.buffer.flush()
            except (BrokenPipeError, OSError):
                self.stop()

    def status(self, message):
        with self.condition:
            changed = self.message != message
            self.message = message
            if message != "Capturing VirtualDJ waveform window":
                self.frame = None
                self.pending = None
            if message not in ("Waiting for first Windows Graphics Capture frame", "Capturing VirtualDJ waveform window"):
                self.active_hwnd = None
                self.active_title = ""
            self.condition.notify_all()
            status = {
                "status": self.message,
                "selected_hwnd": f"0x{self.hwnd:x}" if self.hwnd else "",
                "active_hwnd": f"0x{self.active_hwnd:x}" if self.active_hwnd else None,
                "active_title": self.active_title,
                "capturing": self.frame is not None,
            }
        if changed and self.pipe_mode:
            print("VDJ_STATUS " + json.dumps(status), file=sys.stderr, flush=True)

    def encode_frames(self, stop, cv2, numpy):
        processed = 0
        # The broad center never changes; scale and encode only the edge strips.
        background = numpy.full((HEIGHT, WIDTH, 3), (16, 13, 11), dtype=numpy.uint8)
        while self.running and not stop.is_set():
            with self.condition:
                self.condition.wait_for(
                    lambda: self.capture_count != processed or stop.is_set() or not self.running,
                    timeout=0.5,
                )
                if stop.is_set() or not self.running:
                    break
                processed = self.capture_count
                strips = self.pending
            if strips is None:
                continue
            started = time.monotonic()
            image = background.copy()
            image[:, LEFT_X:LEFT_X + WAVE_WIDTH] = cv2.resize(strips[0], (WAVE_WIDTH, HEIGHT))
            image[:, RIGHT_X:RIGHT_X + WAVE_WIDTH] = cv2.resize(strips[1], (WAVE_WIDTH, HEIGHT))
            encoded, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
            if encoded:
                self.publish(jpeg.tobytes())
                self.status("Capturing VirtualDJ waveform window")
            stop.wait(max(0, 1 / self.fps - (time.monotonic() - started)))

    def run(self):
        self.status("Starting capture worker")
        # Keep third-party packages local to this project if installed with --target .deps.
        deps = Path(__file__).with_name(".deps")
        if deps.is_dir():
            sys.path.insert(0, str(deps))
        try:
            self.status("Loading capture dependencies")
            import cv2
            self.status("OpenCV ready")
            import numpy
            self.status("NumPy ready")
            from windows_capture import WindowsCapture
            self.status("Windows Graphics Capture ready")
        except ImportError as error:
            self.status(f"Capture dependency is missing from the packaged helper ({error})")
            print(self.message, file=sys.stderr, flush=True)
            return

        while self.running:
            if self.stop_requested():
                self.stop()
                break
            style_patch = None
            encoder_stop = threading.Event()
            encoder = None
            try:
                self.status("Scanning VirtualDJ windows")
                windows = vdj_windows()
                target = next((w for w in windows if w["hwnd"] == self.hwnd), None) if self.hwnd else find_popout(windows)
                if not target:
                    self.status("Open the waveform pop-out in VirtualDJ" if not self.hwnd else "Selected VirtualDJ window is not visible")
                    time.sleep(1)
                    continue
                with self.condition:
                    self.active_hwnd = target["hwnd"]
                    self.active_title = target["title"]
                with self.condition:
                    self.pending = None
                    self.capture_count = 0
                style_patch = CapturableWindow(target["hwnd"], target["pid"])
                style_patch.apply()
                capture = WindowsCapture(
                    window_hwnd=target["hwnd"], cursor_capture=False, draw_border=False,
                    secondary_window=False, minimum_update_interval=None,
                )
                closed = threading.Event()
                encoder = threading.Thread(target=self.encode_frames, args=(encoder_stop, cv2, numpy), daemon=True)
                encoder.start()

                @capture.event
                def on_frame_arrived(frame, control):
                    if not self.running or closed.is_set():
                        control.stop()
                        return
                    pixels = frame.frame_buffer
                    factor = frame.width / WIDTH
                    def crop(x):
                        left = round(x * factor)
                        right = round((x + WAVE_WIDTH) * factor)
                        return pixels[:, left:right, :3].copy()
                    strips = crop(LEFT_X), crop(RIGHT_X)
                    with self.condition:
                        self.pending = strips  # Replace old unencoded frames instead of building a latency queue.
                        self.capture_count += 1
                        self.capture_times.append(time.monotonic())
                        self.condition.notify_all()

                @capture.event
                def on_closed():
                    closed.set()

                print(
                    f"Capturing {target['title']!r} (HWND 0x{target['hwnd']:x}) with Windows Graphics Capture",
                    file=sys.stderr if self.pipe_mode else sys.stdout,
                    flush=True,
                )
                self.status("Waiting for first Windows Graphics Capture frame")
                self.control = capture.start_free_threaded()
                while self.running and not closed.wait(0.5):
                    if self.stop_requested():
                        self.stop()
                        break
                    if not any(w["hwnd"] == target["hwnd"] for w in vdj_windows()):
                        break
                    if self.control.is_finished():
                        break
                self.status("Waveform pop-out closed")
            except Exception as error:
                self.status(str(error))
                traceback.print_exc(file=sys.stderr)
            finally:
                if self.control:
                    try:
                        self.control.stop()
                        self.control.wait()
                    except Exception as error:
                        self.status(str(error))
                        print(error, file=sys.stderr, flush=True)
                    self.control = None
                encoder_stop.set()
                with self.condition:
                    self.condition.notify_all()
                if encoder:
                    encoder.join(timeout=2)
                if style_patch:
                    try:
                        style_patch.restore()
                    except Exception as error:
                        self.status(f"Could not restore VirtualDJ window style: {error}")
                        print(self.message, file=sys.stderr, flush=True)
            time.sleep(1)

    def stop(self):
        self.running = False
        if self.control:
            self.control.stop()
        with self.condition:
            self.condition.notify_all()

    def stop_requested(self):
        if not self.pipe_mode:
            return False
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetStdHandle.argtypes = [wintypes.DWORD]
        kernel32.GetStdHandle.restype = wintypes.HANDLE
        kernel32.PeekNamedPipe.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.PeekNamedPipe.restype = wintypes.BOOL
        kernel32.ReadFile.argtypes = [
            wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p,
        ]
        kernel32.ReadFile.restype = wintypes.BOOL
        handle = kernel32.GetStdHandle(0xFFFFFFF6)  # STD_INPUT_HANDLE
        available = wintypes.DWORD()
        if not handle or not kernel32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(available), None):
            return True  # The supervising application closed its pipe.
        if available.value:
            size = min(available.value, 1024)
            data = ctypes.create_string_buffer(size)
            read = wintypes.DWORD()
            if not kernel32.ReadFile(handle, data, size, ctypes.byref(read), None):
                return True
            self.stdin_buffer.extend(data.raw[:read.value])
        return b"stop" in self.stdin_buffer.lower()


def handler_for(feed):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            route = self.path.split("?", 1)[0]
            if route == "/":
                self.respond("text/html; charset=utf-8", PAGE)
            elif route == "/health":
                payload = json.dumps(feed.diagnostics()).encode()
                self.respond("application/json", payload)
            elif route == "/windows":
                payload = json.dumps(vdj_windows()).encode()
                self.respond("application/json", payload)
            elif route == "/snapshot.jpg":
                with feed.condition:
                    frame = feed.frame
                if frame:
                    self.respond("image/jpeg", frame)
                else:
                    self.send_error(503, feed.message)
            elif route == "/stream":
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=waveframe")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                period = 1 / feed.fps
                deadline = time.monotonic()
                with feed.condition:
                    if feed.stream_clients == 0:
                        feed.stream_started_at = time.monotonic()
                        feed.stream_times.clear()
                    feed.stream_clients += 1
                try:
                    while feed.running:
                        with feed.condition:
                            if feed.frame is None:
                                feed.condition.wait(timeout=0.1)
                            frame = feed.frame
                        if frame:
                            self.wfile.write(b"--waveframe\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                            self.wfile.flush()
                            with feed.condition:
                                feed.stream_times.append(time.monotonic())
                        deadline += period
                        now = time.monotonic()
                        if deadline < now:
                            deadline = now
                        time.sleep(max(0, deadline - now))
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    with feed.condition:
                        feed.stream_clients -= 1
            else:
                self.send_error(404)

        def respond(self, content_type, payload):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, _format, *_args):
            pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--quality", type=int, default=80, help="JPEG quality: 1..100")
    parser.add_argument("--hwnd", type=lambda x: int(x, 0), help="Choose a specific window from --list-windows")
    parser.add_argument("--list-windows", action="store_true")
    parser.add_argument("--pipe", action="store_true", help="Write length-prefixed JPEG frames to stdout")
    args = parser.parse_args()
    if args.list_windows:
        print(json.dumps(vdj_windows(), indent=2))
        return
    if not 1 <= args.fps <= 60 or not 1 <= args.quality <= 100 or not 1 <= args.port <= 65535:
        parser.error("Expected --fps 1..60, --quality 1..100 and --port 1..65535")
    feed = Feed(args.fps, args.quality, args.hwnd, pipe_mode=args.pipe)
    if args.pipe:
        feed.run()
        feed.stop()
        return

    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(feed))
    worker = threading.Thread(target=feed.run, daemon=True)
    worker.start()
    print(f"OBS Browser Source: http://127.0.0.1:{args.port}/", flush=True)

    def request_stop():
        if sys.stdin.readline().strip().lower() == "stop":
            server.shutdown()

    threading.Thread(target=request_stop, daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        feed.stop()
        worker.join(timeout=5)


if __name__ == "__main__":
    main()
