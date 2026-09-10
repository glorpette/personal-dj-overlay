// WASAPI render-device enumerator + shared-mode loopback capture.
// Outputs interleaved IEEE float32 stereo on stdout. Errors on stderr.
// Compile: csc /nologo /optimize /out:WasapiLoopback.exe WasapiLoopback.cs
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.IO;

internal static class Native
{
    public const int S_OK = 0;
    public const uint CLSCTX_ALL = 23;
    public const uint STGM_READ = 0;
    public const uint DEVICE_STATE_ACTIVE = 0x1;
    public const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    public const uint AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    public const uint AUDCLNT_SHAREMODE_SHARED = 0;
    public const ushort WAVE_FORMAT_PCM = 1;
    public const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
    public const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
    public const int eRender = 0;
    public const int eCapture = 1;
    public const int eMultimedia = 1;
    public const uint INFINITE = 0xFFFFFFFF;

    public static readonly Guid CLSID_MMDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    public static readonly Guid IID_IMMDeviceEnumerator = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");
    public static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    public static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    public static readonly Guid IID_IPropertyStore = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    public static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");
    public static readonly Guid KSDATAFORMAT_SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");

    [DllImport("ole32.dll")] public static extern int CoInitializeEx(IntPtr pv, uint flags);
    [DllImport("ole32.dll")] public static extern int CoCreateInstance(ref Guid clsid, IntPtr unk, uint ctx, ref Guid iid, out IntPtr ppv);
    [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT pvar);
    [DllImport("kernel32.dll")] public static extern IntPtr CreateEvent(IntPtr sa, bool manual, bool initial, string name);
    [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate h, bool add);
    public delegate bool ConsoleCtrlDelegate(uint ctrl);
}

[StructLayout(LayoutKind.Sequential)]
internal struct WAVEFORMATEX
{
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
}

[StructLayout(LayoutKind.Sequential)]
internal struct PROPERTYKEY
{
    public Guid fmtid;
    public uint pid;
    public static PROPERTYKEY FriendlyName
    {
        get
        {
            return new PROPERTYKEY
            {
                fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
                pid = 14
            };
        }
    }
}

[StructLayout(LayoutKind.Sequential)]
internal struct PROPVARIANT
{
    public ushort vt;
    public ushort wReserved1;
    public ushort wReserved2;
    public ushort wReserved3;
    public IntPtr data;
    public IntPtr data2;
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387FC4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    int GetCount(out uint count);
    int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(uint stgmAccess, out IPropertyStore properties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    int Initialize(uint shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr session);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long hns);
    int GetCurrentPadding(out uint frames);
    int IsFormatSupported(uint shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long def, out long min);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr handle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object svc);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    int GetBuffer(out IntPtr data, out uint numFrames, out uint flags, out ulong pos, out ulong qpc);
    int ReleaseBuffer(uint numFrames);
    int GetNextPacketSize(out uint numFrames);
}

internal static class Program
{
    static volatile bool running = true;

    static bool OnCtrl(uint ctrl)
    {
        running = false;
        return true;
    }

    static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        Native.CoInitializeEx(IntPtr.Zero, 0);
        Native.SetConsoleCtrlHandler(OnCtrl, true);

        bool list = false;
        string id = null;
        string name = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--list") list = true;
            else if (args[i] == "--id" && i + 1 < args.Length) id = args[++i];
            else if (args[i] == "--name" && i + 1 < args.Length) name = args[++i];
            else if (args[i] == "--default") id = "default";
        }

        try
        {
            if (list)
            {
                ListDevices();
                return 0;
            }
            Capture(id, name);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR " + ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
    }

    static IMMDeviceEnumerator Enumerator()
    {
        Guid clsid = Native.CLSID_MMDeviceEnumerator;
        Guid iid = Native.IID_IMMDeviceEnumerator;
        IntPtr ptr;
        int hr = Native.CoCreateInstance(ref clsid, IntPtr.Zero, Native.CLSCTX_ALL, ref iid, out ptr);
        if (hr != 0 || ptr == IntPtr.Zero) throw new Exception("CoCreateInstance MMDeviceEnumerator failed hr=0x" + hr.ToString("X"));
        return (IMMDeviceEnumerator)Marshal.GetObjectForIUnknown(ptr);
    }

    static string DeviceName(IMMDevice dev)
    {
        try
        {
            IPropertyStore store;
            if (dev.OpenPropertyStore(Native.STGM_READ, out store) != 0) return "";
            PROPERTYKEY key = PROPERTYKEY.FriendlyName;
            PROPVARIANT pv;
            if (store.GetValue(ref key, out pv) != 0) return "";
            string s = "";
            if (pv.vt == 31 || pv.vt == 8) s = Marshal.PtrToStringUni(pv.data) ?? "";
            Native.PropVariantClear(ref pv);
            return s;
        }
        catch { return ""; }
    }

    static void ListDevices()
    {
        var en = Enumerator();
        IMMDevice def = null;
        string defId = "";
        try
        {
            if (en.GetDefaultAudioEndpoint(Native.eRender, Native.eMultimedia, out def) == 0 && def != null)
                def.GetId(out defId);
        }
        catch { }

        IMMDeviceCollection col;
        int hr = en.EnumAudioEndpoints(Native.eRender, Native.DEVICE_STATE_ACTIVE, out col);
        if (hr != 0) throw new Exception("EnumAudioEndpoints failed hr=0x" + hr.ToString("X"));
        uint count;
        col.GetCount(out count);
        Console.Error.WriteLine("WASAPI render endpoints: " + count);
        for (uint i = 0; i < count; i++)
        {
            IMMDevice dev;
            col.Item(i, out dev);
            string did;
            dev.GetId(out did);
            string nm = DeviceName(dev);
            bool isDef = !string.IsNullOrEmpty(defId) && string.Equals(did, defId, StringComparison.OrdinalIgnoreCase);
            string json = "{\"id\":\"" + Esc(did) + "\",\"name\":\"" + Esc(nm) + "\",\"kind\":\"output-loopback\",\"default\":" + (isDef ? "true" : "false") + "}";
            Console.Out.WriteLine(json);
        }
        Console.Out.Flush();
    }

    static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static IMMDevice Resolve(IMMDeviceEnumerator en, string id, string name)
    {
        IMMDevice dev;
        if (string.IsNullOrEmpty(id) || id == "default")
        {
            int hr = en.GetDefaultAudioEndpoint(Native.eRender, Native.eMultimedia, out dev);
            if (hr != 0) throw new Exception("GetDefaultAudioEndpoint failed hr=0x" + hr.ToString("X"));
            return dev;
        }
        if (en.GetDevice(id, out dev) == 0 && dev != null) return dev;

        IMMDeviceCollection col;
        en.EnumAudioEndpoints(Native.eRender, Native.DEVICE_STATE_ACTIVE, out col);
        uint count;
        col.GetCount(out count);
        string want = (name ?? id).ToLowerInvariant();
        IMMDevice fallback = null;
        for (uint i = 0; i < count; i++)
        {
            IMMDevice d;
            col.Item(i, out d);
            string did; d.GetId(out did);
            string nm = DeviceName(d);
            if (string.Equals(did, id, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(nm, name, StringComparison.OrdinalIgnoreCase))
                return d;
            if (!string.IsNullOrEmpty(want) &&
                ((nm != null && nm.ToLowerInvariant().Contains(want)) ||
                 (did != null && did.ToLowerInvariant().Contains(want))))
                fallback = d;
        }
        if (fallback != null) return fallback;
        throw new Exception("Render device not found: " + (id ?? name));
    }

    static void Capture(string id, string name)
    {
        var en = Enumerator();
        var dev = Resolve(en, id, name);
        string did; dev.GetId(out did);
        string nm = DeviceName(dev);
        Guid iidClient = Native.IID_IAudioClient;
        object raw;
        int hr = dev.Activate(ref iidClient, Native.CLSCTX_ALL, IntPtr.Zero, out raw);
        if (hr != 0) throw new Exception("Activate IAudioClient failed hr=0x" + hr.ToString("X"));
        var client = (IAudioClient)raw;

        IntPtr fmtPtr;
        hr = client.GetMixFormat(out fmtPtr);
        if (hr != 0) throw new Exception("GetMixFormat failed hr=0x" + hr.ToString("X"));
        WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
        int srcCh = fmt.nChannels;
        int srcRate = (int)fmt.nSamplesPerSec;
        int bits = fmt.wBitsPerSample;
        bool isFloat = IsFloat(fmtPtr, fmt);

        // 100 ms buffer. Event-driven + loopback on the RENDER endpoint.
        hr = client.Initialize(
            Native.AUDCLNT_SHAREMODE_SHARED,
            Native.AUDCLNT_STREAMFLAGS_LOOPBACK | Native.AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            1000000, 0, fmtPtr, IntPtr.Zero);
        if (hr != 0)
        {
            // Retry without event callback (some drivers dislike the combo).
            hr = client.Initialize(
                Native.AUDCLNT_SHAREMODE_SHARED,
                Native.AUDCLNT_STREAMFLAGS_LOOPBACK,
                1000000, 0, fmtPtr, IntPtr.Zero);
        }
        if (hr != 0) throw new Exception("IAudioClient.Initialize loopback failed hr=0x" + hr.ToString("X") + " — is the device exclusive-mode?");

        IntPtr ev = Native.CreateEvent(IntPtr.Zero, false, false, null);
        bool useEvent = ev != IntPtr.Zero && client.SetEventHandle(ev) == 0;

        Guid iidCap = Native.IID_IAudioCaptureClient;
        object capObj;
        hr = client.GetService(ref iidCap, out capObj);
        if (hr != 0) throw new Exception("GetService IAudioCaptureClient failed hr=0x" + hr.ToString("X"));
        var cap = (IAudioCaptureClient)capObj;

        hr = client.Start();
        if (hr != 0) throw new Exception("IAudioClient.Start failed hr=0x" + hr.ToString("X"));

        Console.Error.WriteLine("WASAPI_LOOPBACK device=\"" + nm + "\" id=\"" + did + "\" rate=" + srcRate + " srcCh=" + srcCh + " bits=" + bits + " float=" + isFloat);
        Stream stdout = Console.OpenStandardOutput();
        byte[] stereoBytes = new byte[8192 * 8];

        try
        {
            while (running)
            {
                if (useEvent)
                {
                    uint w = Native.WaitForSingleObject(ev, 500);
                    if (w != 0 && w != 0x00000080) { /* timeout — still poll */ }
                }
                else Thread.Sleep(10);

                uint packet;
                while (cap.GetNextPacketSize(out packet) == 0 && packet > 0)
                {
                    IntPtr data;
                    uint frames, flags;
                    ulong pos, qpc;
                    hr = cap.GetBuffer(out data, out frames, out flags, out pos, out qpc);
                    if (hr != 0) break;
                    if (frames > 0 && data != IntPtr.Zero && (flags & 0x2) == 0) // not silent-only empty
                    {
                        int needed = (int)frames * 2 * 4;
                        if (stereoBytes.Length < needed) stereoBytes = new byte[needed];
                        ConvertToStereoF32(data, (int)frames, srcCh, bits, isFloat, flags, stereoBytes);
                        stdout.Write(stereoBytes, 0, needed);
                    }
                    cap.ReleaseBuffer(frames);
                }
            }
        }
        finally
        {
            try { client.Stop(); } catch { }
            if (ev != IntPtr.Zero) Native.CloseHandle(ev);
            Marshal.FreeCoTaskMem(fmtPtr);
        }
    }

    static bool IsFloat(IntPtr fmtPtr, WAVEFORMATEX fmt)
    {
        if (fmt.wFormatTag == Native.WAVE_FORMAT_IEEE_FLOAT) return true;
        if (fmt.wFormatTag != Native.WAVE_FORMAT_EXTENSIBLE) return false;
        // SubFormat starts at offset 24 in WAVEFORMATEXTENSIBLE (after 18-byte WAVEFORMATEX + 2 + 4)
        // WAVEFORMATEX is 18 bytes. Then Samples (2) + dwChannelMask (4) + SubFormat (16)
        IntPtr sub = new IntPtr(fmtPtr.ToInt64() + 24);
        byte[] g = new byte[16];
        Marshal.Copy(sub, g, 0, 16);
        Guid subFmt = new Guid(g);
        return subFmt == Native.KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    }

    static void ConvertToStereoF32(IntPtr src, int frames, int ch, int bits, bool isFloat, uint flags, byte[] dest)
    {
        bool silent = (flags & 0x2) != 0;
        for (int i = 0; i < frames; i++)
        {
            float l = 0, r = 0;
            if (!silent)
            {
                if (isFloat && bits == 32)
                {
                    l = ReadF32(src, (i * ch + 0) * 4);
                    r = ch > 1 ? ReadF32(src, (i * ch + 1) * 4) : l;
                    if (ch > 2)
                    {
                        // fold extra channels down so a 5.1 mix still moves the waveform
                        for (int c = 2; c < ch; c++)
                        {
                            float s = ReadF32(src, (i * ch + c) * 4);
                            if ((c & 1) == 0) l += s * 0.4f; else r += s * 0.4f;
                        }
                    }
                }
                else if (bits == 16)
                {
                    l = ReadI16(src, (i * ch + 0) * 2) / 32768f;
                    r = ch > 1 ? ReadI16(src, (i * ch + 1) * 2) / 32768f : l;
                }
                else if (bits == 32 && !isFloat)
                {
                    l = ReadI32(src, (i * ch + 0) * 4) / 2147483648f;
                    r = ch > 1 ? ReadI32(src, (i * ch + 1) * 4) / 2147483648f : l;
                }
                else if (bits == 24)
                {
                    int bps = 3;
                    l = ReadI24(src, (i * ch + 0) * bps) / 8388608f;
                    r = ch > 1 ? ReadI24(src, (i * ch + 1) * bps) / 8388608f : l;
                }
            }
            if (l > 1) l = 1; if (l < -1) l = -1;
            if (r > 1) r = 1; if (r < -1) r = -1;
            WriteF32(dest, i * 8, l);
            WriteF32(dest, i * 8 + 4, r);
        }
    }

    static float ReadF32(IntPtr p, int off)
    {
        byte[] b = new byte[4];
        Marshal.Copy(new IntPtr(p.ToInt64() + off), b, 0, 4);
        return BitConverter.ToSingle(b, 0);
    }
    static short ReadI16(IntPtr p, int off)
    {
        byte[] b = new byte[2];
        Marshal.Copy(new IntPtr(p.ToInt64() + off), b, 0, 2);
        return BitConverter.ToInt16(b, 0);
    }
    static int ReadI32(IntPtr p, int off)
    {
        byte[] b = new byte[4];
        Marshal.Copy(new IntPtr(p.ToInt64() + off), b, 0, 4);
        return BitConverter.ToInt32(b, 0);
    }
    static int ReadI24(IntPtr p, int off)
    {
        byte[] b = new byte[3];
        Marshal.Copy(new IntPtr(p.ToInt64() + off), b, 0, 3);
        int v = b[0] | (b[1] << 8) | (b[2] << 16);
        if ((v & 0x800000) != 0) v |= unchecked((int)0xFF000000);
        return v;
    }
    static void WriteF32(byte[] dest, int off, float v)
    {
        byte[] b = BitConverter.GetBytes(v);
        Buffer.BlockCopy(b, 0, dest, off, 4);
    }
}
