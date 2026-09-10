// WASAPI render-device enumerator + shared-mode loopback capture.
// Outputs interleaved IEEE float32 stereo on stdout. Errors on stderr.
// Compile: csc /nologo /optimize /out:WasapiLoopback.exe WasapiLoopback.cs
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.IO;
using Microsoft.Win32;

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
    public static PROPERTYKEY DeviceDescription
    {
        get
        {
            return new PROPERTYKEY
            {
                fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
                pid = 2
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
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IntPtr endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IntPtr device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387FC4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IntPtr device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, out IntPtr iface);
    [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr properties);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPropertyStore
{
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    [PreserveSig] int Commit();
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioClient
{
    [PreserveSig] int Initialize(uint shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long hns);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(uint shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long def, out long min);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, out IntPtr svc);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint numFrames, out uint flags, out ulong pos, out ulong qpc);
    [PreserveSig] int ReleaseBuffer(uint numFrames);
    [PreserveSig] int GetNextPacketSize(out uint numFrames);
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

    static object ComObj(IntPtr p)
    {
        if (p == IntPtr.Zero) return null;
        object o = Marshal.GetObjectForIUnknown(p);
        Marshal.Release(p);
        return o;
    }

    static IMMDeviceEnumerator Enumerator()
    {
        Guid clsid = Native.CLSID_MMDeviceEnumerator;
        Guid iid = Native.IID_IMMDeviceEnumerator;
        IntPtr ptr;
        int hr = Native.CoCreateInstance(ref clsid, IntPtr.Zero, Native.CLSCTX_ALL, ref iid, out ptr);
        if (hr != 0 || ptr == IntPtr.Zero) throw new Exception("CoCreateInstance MMDeviceEnumerator failed hr=0x" + hr.ToString("X"));
        return (IMMDeviceEnumerator)ComObj(ptr);
    }

    static string DeviceName(IMMDevice dev)
    {
        try
        {
            IntPtr storePtr;
            if (dev.OpenPropertyStore(Native.STGM_READ, out storePtr) != 0 || storePtr == IntPtr.Zero) return "";
            IPropertyStore store = (IPropertyStore)ComObj(storePtr);
            PROPERTYKEY key = PROPERTYKEY.DeviceDescription;
            PROPVARIANT pv;
            if (store.GetValue(ref key, out pv) != 0) return "";
            string s = "";
            if (pv.vt == 31 || pv.vt == 8) s = Marshal.PtrToStringUni(pv.data);
            if (s == null) s = "";
            Native.PropVariantClear(ref pv);
            if (s.Length > 0) return s;

            key = PROPERTYKEY.FriendlyName;
            if (store.GetValue(ref key, out pv) != 0) return "";
            s = "";
            if (pv.vt == 31 || pv.vt == 8) s = Marshal.PtrToStringUni(pv.data);
            if (s == null) s = "";
            Native.PropVariantClear(ref pv);
            return s;
        }
        catch { return ""; }
    }

    static string RegStr(object v)
    {
        if (v == null) return "";
        string s = v as string;
        if (s != null) return s;
        byte[] b = v as byte[];
        if (b != null) return Encoding.Unicode.GetString(b).Trim().Trim('\0');
        return v.ToString();
    }

    static void Emit(string did, string nm, bool isDef)
    {
        string json = "{\"id\":\"" + Esc(did) + "\",\"name\":\"" + Esc(nm) + "\",\"kind\":\"output-loopback\",\"default\":" + (isDef ? "true" : "false") + "}";
        Console.Out.WriteLine(json);
    }

    static void ListDevices()
    {
        int n = ListFromRegistry();
        if (n == 0) n = ListFromCom();
        if (n == 0) throw new Exception("No active WASAPI render devices found");
        Console.Out.Flush();
    }

    static string DefaultRenderId()
    {
        try
        {
            IMMDeviceEnumerator en = Enumerator();
            IntPtr defPtr;
            if (en.GetDefaultAudioEndpoint(Native.eRender, Native.eMultimedia, out defPtr) == 0 && defPtr != IntPtr.Zero)
            {
                IMMDevice def = (IMMDevice)ComObj(defPtr);
                string id;
                def.GetId(out id);
                return id != null ? id : "";
            }
        }
        catch { }
        return "";
    }

    static int ListFromRegistry()
    {
        string defId = DefaultRenderId();
        RegistryKey root = Registry.LocalMachine.OpenSubKey("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render");
        if (root == null) return 0;
        string[] names = root.GetSubKeyNames();
        int n = 0;
        int i;
        for (i = 0; i < names.Length; i++)
        {
            string guid = names[i];
            RegistryKey dev = root.OpenSubKey(guid);
            if (dev == null) continue;
            object stateObj = dev.GetValue("DeviceState");
            int state = 0;
            try { if (stateObj != null) state = Convert.ToInt32(stateObj); } catch { }
            if ((state & 1) == 0) continue;
            string nm = guid;
            RegistryKey props = dev.OpenSubKey("Properties");
            if (props != null)
            {
                string route = RegStr(props.GetValue("{a45c254e-df1c-4efd-8020-67d146a850e0},2"));
                string friendly = RegStr(props.GetValue("{a45c254e-df1c-4efd-8020-67d146a850e0},14"));
                string endpoint = RegStr(props.GetValue("{b3f8fa53-0004-438e-9003-51a46e139bfc},6"));
                if (route.Length > 0 && endpoint.Length > 0 && !string.Equals(route, endpoint, StringComparison.OrdinalIgnoreCase))
                    nm = route + " (" + endpoint + ")";
                else if (route.Length > 0) nm = route;
                else if (friendly.Length > 0) nm = friendly;
                else if (endpoint.Length > 0) nm = endpoint;
            }
            string did = guid.StartsWith("{") ? ("{0.0.0.00000000}." + guid) : ("{0.0.0.00000000}.{" + guid + "}");
            bool isDef = defId.Length > 0 && defId.ToLowerInvariant().IndexOf(guid.ToLowerInvariant()) >= 0;
            Emit(did, nm, isDef);
            n++;
        }
        if (n > 0) Console.Error.WriteLine("WASAPI render endpoints (registry): " + n);
        return n;
    }

    static int ListFromCom()
    {
        IMMDeviceEnumerator en = Enumerator();
        string defId = "";
        IntPtr defPtr;
        if (en.GetDefaultAudioEndpoint(Native.eRender, Native.eMultimedia, out defPtr) == 0 && defPtr != IntPtr.Zero)
        {
            IMMDevice def = (IMMDevice)ComObj(defPtr);
            def.GetId(out defId);
        }
        IntPtr colPtr;
        int hr = en.EnumAudioEndpoints(Native.eRender, Native.DEVICE_STATE_ACTIVE, out colPtr);
        if (hr != 0 || colPtr == IntPtr.Zero)
        {
            Console.Error.WriteLine("EnumAudioEndpoints hr=0x" + hr.ToString("X"));
            if (defId.Length > 0)
            {
                Emit(defId, "Default playback device", true);
                return 1;
            }
            return 0;
        }
        IMMDeviceCollection col = (IMMDeviceCollection)ComObj(colPtr);
        uint count;
        col.GetCount(out count);
        Console.Error.WriteLine("WASAPI render endpoints (COM): " + count);
        uint i;
        int n = 0;
        for (i = 0; i < count; i++)
        {
            IntPtr devPtr;
            col.Item(i, out devPtr);
            if (devPtr == IntPtr.Zero) continue;
            IMMDevice dev = (IMMDevice)ComObj(devPtr);
            string did;
            dev.GetId(out did);
            string nm = DeviceName(dev);
            bool isDef = defId.Length > 0 && string.Equals(did, defId, StringComparison.OrdinalIgnoreCase);
            Emit(did, nm, isDef);
            n++;
        }
        return n;
    }

    static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static IMMDevice Resolve(IMMDeviceEnumerator en, string id, string name)
    {
        IntPtr p;
        int hr;
        if (string.IsNullOrEmpty(id) || id == "default")
        {
            hr = en.GetDefaultAudioEndpoint(Native.eRender, Native.eMultimedia, out p);
            if (hr != 0 || p == IntPtr.Zero) throw new Exception("GetDefaultAudioEndpoint failed hr=0x" + hr.ToString("X"));
            return (IMMDevice)ComObj(p);
        }
        hr = en.GetDevice(id, out p);
        if (hr == 0 && p != IntPtr.Zero) return (IMMDevice)ComObj(p);
        if (id.StartsWith("{") && id.IndexOf("{0.0.0.00000000}") < 0)
        {
            string alt = "{0.0.0.00000000}." + id;
            hr = en.GetDevice(alt, out p);
            if (hr == 0 && p != IntPtr.Zero) return (IMMDevice)ComObj(p);
        }
        throw new Exception("Render device not found: " + (id != null ? id : name));
    }

    static void Capture(string id, string name)
    {
        IMMDeviceEnumerator en = Enumerator();
        IMMDevice dev = Resolve(en, id, name);
        string did;
        dev.GetId(out did);
        string nm = DeviceName(dev);
        Guid iidClient = Native.IID_IAudioClient;
        IntPtr rawPtr;
        int hr = dev.Activate(ref iidClient, Native.CLSCTX_ALL, IntPtr.Zero, out rawPtr);
        if (hr != 0 || rawPtr == IntPtr.Zero) throw new Exception("Activate IAudioClient failed hr=0x" + hr.ToString("X"));
        IAudioClient client = (IAudioClient)ComObj(rawPtr);

        IntPtr fmtPtr;
        hr = client.GetMixFormat(out fmtPtr);
        if (hr != 0) throw new Exception("GetMixFormat failed hr=0x" + hr.ToString("X"));
        WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(fmtPtr, typeof(WAVEFORMATEX));
        int srcCh = fmt.nChannels;
        int srcRate = (int)fmt.nSamplesPerSec;
        int bits = fmt.wBitsPerSample;
        bool isFloat = IsFloat(fmtPtr, fmt);

        hr = client.Initialize(
            Native.AUDCLNT_SHAREMODE_SHARED,
            Native.AUDCLNT_STREAMFLAGS_LOOPBACK | Native.AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            250000, 0, fmtPtr, IntPtr.Zero);
        if (hr != 0)
        {
            hr = client.Initialize(
                Native.AUDCLNT_SHAREMODE_SHARED,
                Native.AUDCLNT_STREAMFLAGS_LOOPBACK,
                250000, 0, fmtPtr, IntPtr.Zero);
        }
        if (hr != 0) throw new Exception("IAudioClient.Initialize loopback failed hr=0x" + hr.ToString("X") + " - is the device exclusive-mode?");

        IntPtr ev = Native.CreateEvent(IntPtr.Zero, false, false, null);
        bool useEvent = ev != IntPtr.Zero && client.SetEventHandle(ev) == 0;

        Guid iidCap = Native.IID_IAudioCaptureClient;
        IntPtr capPtr;
        hr = client.GetService(ref iidCap, out capPtr);
        if (hr != 0 || capPtr == IntPtr.Zero) throw new Exception("GetService IAudioCaptureClient failed hr=0x" + hr.ToString("X"));
        IAudioCaptureClient cap = (IAudioCaptureClient)ComObj(capPtr);

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
                    Native.WaitForSingleObject(ev, 500);
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
                    if (frames > 0 && data != IntPtr.Zero && (flags & 0x2) == 0)
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
