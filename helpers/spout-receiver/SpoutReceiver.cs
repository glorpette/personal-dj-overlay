// Native Spout2 receiver (and optional test sender) for vdj-live-overlay.
// Opens the sender's shared DX11 texture, copies it to a staging resource,
// JPEG-encodes, and writes length-prefixed frames to stdout.
// Compile: csc /nologo /optimize /platform:x64 /r:System.Drawing.dll /out:SpoutReceiver.exe SpoutReceiver.cs
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

internal static class Native
{
    public const uint FILE_MAP_ALL_ACCESS = 0x000F001F;
    public const uint PAGE_READWRITE = 0x04;
    public const uint INFINITE = 0xFFFFFFFF;
    public const uint WAIT_OBJECT_0 = 0;
    public const uint WAIT_TIMEOUT = 0x102;
    public const uint ERROR_ALREADY_EXISTS = 183;
    public const int D3D_DRIVER_TYPE_UNKNOWN = 0;
    public const int D3D_DRIVER_TYPE_HARDWARE = 1;
    public const uint D3D11_SDK_VERSION = 7;
    public const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
    public const uint D3D11_USAGE_DEFAULT = 0;
    public const uint D3D11_USAGE_STAGING = 3;
    public const uint D3D11_CPU_ACCESS_READ = 0x20000;
    public const uint D3D11_BIND_SHADER_RESOURCE = 0x8;
    public const uint D3D11_BIND_RENDER_TARGET = 0x20;
    public const uint D3D11_RESOURCE_MISC_SHARED = 0x2;
    public const uint D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX = 0x10;
    public const uint D3D11_MAP_READ = 1;
    public const uint DXGI_FORMAT_R8G8B8A8_UNORM = 28;
    public const uint DXGI_FORMAT_R8G8B8A8_UNORM_SRGB = 29;
    public const uint DXGI_FORMAT_B8G8R8A8_UNORM = 87;
    public const uint DXGI_FORMAT_B8G8R8A8_UNORM_SRGB = 91;
    public const int MaxJpegBytes = 8000000;
    public const int SpoutMaxSenderNameLen = 256;
    public const int SharedTextureInfoSize = 280;
    public const uint FrameMagic = 0x54555053; // "SPUT"

    public static readonly Guid IID_ID3D11Texture2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    public static readonly Guid IID_ID3D11Device1 = new Guid("a04bfb29-08ef-43d6-a49c-a9bdbdcbe686");
    public static readonly Guid IID_IDXGIFactory = new Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369");
    public static readonly Guid IID_IDXGIResource = new Guid("035f3ab4-482e-4e50-b41f-8a7f8bd8960b");
    public static readonly Guid IID_IDXGIKeyedMutex = new Guid("9d8e1289-d7b3-465f-8126-250e349af85d");

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr CreateFileMappingA(IntPtr hFile, IntPtr sa, uint protect, uint hi, uint lo, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr OpenFileMappingA(uint access, bool inherit, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr MapViewOfFile(IntPtr hMap, uint access, uint hi, uint lo, UIntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UnmapViewOfFile(IntPtr view);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    public static extern IntPtr CreateMutexA(IntPtr sa, bool initial, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr h, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReleaseMutex(IntPtr h);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll")]
    public static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate h, bool add);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern uint GetModuleFileNameW(IntPtr mod, StringBuilder buf, int size);

    [DllImport("d3d11.dll")]
    public static extern int D3D11CreateDevice(
        IntPtr adapter, int driverType, IntPtr software, uint flags,
        [In] int[] featureLevels, uint nLevels, uint sdkVersion,
        out IntPtr device, out int featureLevel, out IntPtr context);

    [DllImport("dxgi.dll")]
    public static extern int CreateDXGIFactory(ref Guid riid, out IntPtr factory);

    public delegate bool ConsoleCtrlDelegate(uint ctrl);
}

[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_TEXTURE2D_DESC
{
    public uint Width, Height, MipLevels, ArraySize, Format;
    public uint SampleCount, SampleQuality;
    public uint Usage, BindFlags, CPUAccessFlags, MiscFlags;
}

[StructLayout(LayoutKind.Sequential)]
internal struct D3D11_MAPPED_SUBRESOURCE
{
    public IntPtr pData;
    public uint RowPitch;
    public uint DepthPitch;
}

internal struct SenderInfo
{
    public string Name;
    public uint Width, Height, Format, ShareHandle, PartnerId;
}

internal static class Com
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int QiDel(IntPtr self, ref Guid iid, out IntPtr ppv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate uint RefDel(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int CreateTexDel(IntPtr self, ref D3D11_TEXTURE2D_DESC desc, IntPtr init, out IntPtr tex);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int OpenSharedDel(IntPtr self, IntPtr handle, ref Guid iid, out IntPtr res);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void GetCtxDel(IntPtr self, out IntPtr ctx);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int OpenShared1Del(IntPtr self, IntPtr handle, ref Guid iid, out IntPtr res);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int MapDel(IntPtr self, IntPtr res, uint sub, uint map, uint flags, out D3D11_MAPPED_SUBRESOURCE mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void UnmapDel(IntPtr self, IntPtr res, uint sub);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void CopyDel(IntPtr self, IntPtr dst, IntPtr src);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void UpdateDel(IntPtr self, IntPtr dst, uint sub, IntPtr box, IntPtr data, uint pitch, uint depth);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void GetDescDel(IntPtr self, out D3D11_TEXTURE2D_DESC desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int EnumAdapterDel(IntPtr self, uint index, out IntPtr adapter);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int GetSharedDel(IntPtr self, out IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int AcquireDel(IntPtr self, ulong key, uint ms);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int ReleaseSyncDel(IntPtr self, ulong key);

    // Delegates bound per-call from vtable — cached by function pointer to survive GC.

    static IntPtr Fn(IntPtr obj, int slot)
    {
        return Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size);
    }

    static T Del<T>(IntPtr obj, int slot) where T : class
    {
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Fn(obj, slot), typeof(T));
    }

    public static int QueryInterface(IntPtr obj, Guid iid, out IntPtr ppv)
    {
        return Del<QiDel>(obj, 0)(obj, ref iid, out ppv);
    }

    public static uint Release(IntPtr obj)
    {
        if (obj == IntPtr.Zero) return 0;
        return Del<RefDel>(obj, 2)(obj);
    }

    public static int CreateTexture2D(IntPtr device, ref D3D11_TEXTURE2D_DESC desc, out IntPtr tex)
    {
        return Del<CreateTexDel>(device, 5)(device, ref desc, IntPtr.Zero, out tex);
    }

    public static int OpenSharedResource(IntPtr device, IntPtr handle, Guid iid, out IntPtr res)
    {
        return Del<OpenSharedDel>(device, 28)(device, handle, ref iid, out res);
    }

    public static void GetImmediateContext(IntPtr device, out IntPtr ctx)
    {
        Del<GetCtxDel>(device, 40)(device, out ctx);
    }

    public static int OpenSharedResource1(IntPtr device1, IntPtr handle, Guid iid, out IntPtr res)
    {
        return Del<OpenShared1Del>(device1, 48)(device1, handle, ref iid, out res);
    }

    public static int Map(IntPtr ctx, IntPtr res, out D3D11_MAPPED_SUBRESOURCE mapped)
    {
        return Del<MapDel>(ctx, 14)(ctx, res, 0, Native.D3D11_MAP_READ, 0, out mapped);
    }

    public static void Unmap(IntPtr ctx, IntPtr res)
    {
        Del<UnmapDel>(ctx, 15)(ctx, res, 0);
    }

    public static void CopyResource(IntPtr ctx, IntPtr dst, IntPtr src)
    {
        Del<CopyDel>(ctx, 47)(ctx, dst, src);
    }

    public static void UpdateSubresource(IntPtr ctx, IntPtr dst, IntPtr data, uint pitch)
    {
        Del<UpdateDel>(ctx, 48)(ctx, dst, 0, IntPtr.Zero, data, pitch, 0);
    }

    public static void GetDesc(IntPtr tex, out D3D11_TEXTURE2D_DESC desc)
    {
        Del<GetDescDel>(tex, 10)(tex, out desc);
    }

    public static int EnumAdapters(IntPtr factory, uint index, out IntPtr adapter)
    {
        return Del<EnumAdapterDel>(factory, 7)(factory, index, out adapter);
    }

    public static int GetSharedHandle(IntPtr resource, out IntPtr handle)
    {
        return Del<GetSharedDel>(resource, 8)(resource, out handle);
    }

    public static int AcquireSync(IntPtr keyed, uint ms)
    {
        return Del<AcquireDel>(keyed, 8)(keyed, 0, ms);
    }

    public static int ReleaseSync(IntPtr keyed)
    {
        return Del<ReleaseSyncDel>(keyed, 9)(keyed, 0);
    }
}

internal sealed class SharedMap : IDisposable
{
    IntPtr map, view, mutex;
    public IntPtr View { get { return view; } }

    public static SharedMap Open(string name)
    {
        IntPtr h = Native.OpenFileMappingA(Native.FILE_MAP_ALL_ACCESS, false, name);
        if (h == IntPtr.Zero) return null;
        return Attach(h, name);
    }

    public static SharedMap Create(string name, int size)
    {
        IntPtr h = Native.CreateFileMappingA(new IntPtr(-1), IntPtr.Zero, Native.PAGE_READWRITE, 0, (uint)size, name);
        if (h == IntPtr.Zero) return null;
        return Attach(h, name);
    }

    static SharedMap Attach(IntPtr h, string name)
    {
        IntPtr v = Native.MapViewOfFile(h, Native.FILE_MAP_ALL_ACCESS, 0, 0, UIntPtr.Zero);
        if (v == IntPtr.Zero)
        {
            Native.CloseHandle(h);
            return null;
        }
        IntPtr mx = Native.CreateMutexA(IntPtr.Zero, false, name + "_mutex");
        return new SharedMap { map = h, view = v, mutex = mx };
    }

    public bool Lock(int ms)
    {
        if (mutex == IntPtr.Zero) return view != IntPtr.Zero;
        return Native.WaitForSingleObject(mutex, (uint)ms) == Native.WAIT_OBJECT_0;
    }

    public void Unlock()
    {
        if (mutex != IntPtr.Zero) Native.ReleaseMutex(mutex);
    }

    public void Dispose()
    {
        if (view != IntPtr.Zero) { Native.UnmapViewOfFile(view); view = IntPtr.Zero; }
        if (map != IntPtr.Zero) { Native.CloseHandle(map); map = IntPtr.Zero; }
        if (mutex != IntPtr.Zero) { Native.CloseHandle(mutex); mutex = IntPtr.Zero; }
    }
}

internal static class SpoutNames
{
    public static int MaxSenders()
    {
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(@"Software\Leading Edge\Spout"))
            {
                if (k != null)
                {
                    object v = k.GetValue("MaxSenders");
                    if (v is int) return Math.Max(1, (int)v);
                    if (v is uint) return Math.Max(1, (int)(uint)v);
                }
            }
        }
        catch { }
        return 64;
    }

    public static List<SenderInfo> ListSenders()
    {
        List<SenderInfo> list = new List<SenderInfo>();
        int max = MaxSenders();
        using (SharedMap map = SharedMap.Open("SpoutSenderNames") ?? SharedMap.Create("SpoutSenderNames", max * Native.SpoutMaxSenderNameLen))
        {
            if (map == null || !map.Lock(67)) return list;
            try
            {
                string active = GetActiveSenderName();
                for (int i = 0; i < max; i++)
                {
                    string name = ReadAnsi(map.View, i * Native.SpoutMaxSenderNameLen, Native.SpoutMaxSenderNameLen);
                    if (string.IsNullOrEmpty(name)) break;
                    SenderInfo info;
                    if (!TryGetInfo(name, out info)) continue;
                    list.Add(info);
                }
                if (!string.IsNullOrEmpty(active))
                {
                    for (int i = 0; i < list.Count; i++)
                    {
                        if (list[i].Name == active)
                        {
                            SenderInfo tmp = list[0];
                            list[0] = list[i];
                            list[i] = tmp;
                            break;
                        }
                    }
                }
            }
            finally { map.Unlock(); }
        }
        return list;
    }

    public static string GetActiveSenderName()
    {
        using (SharedMap map = SharedMap.Open("ActiveSenderName"))
        {
            if (map == null || !map.Lock(67)) return "";
            try { return ReadAnsi(map.View, 0, Native.SpoutMaxSenderNameLen); }
            finally { map.Unlock(); }
        }
    }

    public static bool TryGetInfo(string name, out SenderInfo info)
    {
        info = new SenderInfo { Name = name };
        using (SharedMap map = SharedMap.Open(name))
        {
            if (map == null || !map.Lock(67)) return false;
            try
            {
                IntPtr p = map.View;
                info.ShareHandle = (uint)Marshal.ReadInt32(p, 0);
                info.Width = (uint)Marshal.ReadInt32(p, 4);
                info.Height = (uint)Marshal.ReadInt32(p, 8);
                info.Format = (uint)Marshal.ReadInt32(p, 12);
                info.PartnerId = (uint)Marshal.ReadInt32(p, 276);
                return info.Width > 0 && info.Height > 0 && info.ShareHandle != 0;
            }
            finally { map.Unlock(); }
        }
    }

    public static bool RegisterSender(string name, uint width, uint height, uint shareHandle, uint format)
    {
        int max = MaxSenders();
        using (SharedMap names = SharedMap.Create("SpoutSenderNames", max * Native.SpoutMaxSenderNameLen))
        {
            if (names == null || !names.Lock(200)) return false;
            try
            {
                List<string> existing = new List<string>();
                for (int i = 0; i < max; i++)
                {
                    string n = ReadAnsi(names.View, i * Native.SpoutMaxSenderNameLen, Native.SpoutMaxSenderNameLen);
                    if (string.IsNullOrEmpty(n)) break;
                    existing.Add(n);
                }
                if (!existing.Contains(name))
                {
                    if (existing.Count >= max) return false;
                    existing.Add(name);
                    for (int i = 0; i < existing.Count; i++)
                    {
                        WriteAnsi(names.View, i * Native.SpoutMaxSenderNameLen, Native.SpoutMaxSenderNameLen, existing[i]);
                    }
                    if (existing.Count < max)
                        Marshal.WriteByte(names.View, existing.Count * Native.SpoutMaxSenderNameLen, 0);
                }
            }
            finally { names.Unlock(); }
        }

        using (SharedMap info = SharedMap.Create(name, Native.SharedTextureInfoSize))
        {
            if (info == null || !info.Lock(200)) return false;
            try
            {
                byte[] zeros = new byte[Native.SharedTextureInfoSize];
                Marshal.Copy(zeros, 0, info.View, zeros.Length);
                Marshal.WriteInt32(info.View, 0, unchecked((int)shareHandle));
                Marshal.WriteInt32(info.View, 4, unchecked((int)width));
                Marshal.WriteInt32(info.View, 8, unchecked((int)height));
                Marshal.WriteInt32(info.View, 12, unchecked((int)format));
                StringBuilder path = new StringBuilder(260);
                Native.GetModuleFileNameW(IntPtr.Zero, path, path.Capacity);
                byte[] desc = Encoding.ASCII.GetBytes(path.ToString());
                int n = Math.Min(desc.Length, 255);
                for (int i = 0; i < n; i++) Marshal.WriteByte(info.View, 20 + i, desc[i]);
            }
            finally { info.Unlock(); }
        }

        using (SharedMap active = SharedMap.Create("ActiveSenderName", Native.SpoutMaxSenderNameLen))
        {
            if (active != null && active.Lock(67))
            {
                try { WriteAnsi(active.View, 0, Native.SpoutMaxSenderNameLen, name); }
                finally { active.Unlock(); }
            }
        }
        return true;
    }

    static string ReadAnsi(IntPtr p, int offset, int max)
    {
        List<byte> bytes = new List<byte>(64);
        for (int i = 0; i < max; i++)
        {
            byte b = Marshal.ReadByte(p, offset + i);
            if (b == 0) break;
            bytes.Add(b);
        }
        if (bytes.Count == 0) return "";
        return Encoding.ASCII.GetString(bytes.ToArray());
    }

    static void WriteAnsi(IntPtr p, int offset, int max, string s)
    {
        byte[] bytes = Encoding.ASCII.GetBytes(s ?? "");
        int n = Math.Min(bytes.Length, max - 1);
        for (int i = 0; i < n; i++) Marshal.WriteByte(p, offset + i, bytes[i]);
        Marshal.WriteByte(p, offset + n, 0);
    }
}

internal sealed class DxDevice : IDisposable
{
    public IntPtr Device, Context;
    IntPtr adapterUsed;

    public static DxDevice Create(IntPtr adapter)
    {
        int[] levels = { 0xb000, 0xa100, 0xa000 }; // 11.0, 10.1, 10.0
        IntPtr dev, ctx;
        int fl;
        int driver = adapter == IntPtr.Zero ? Native.D3D_DRIVER_TYPE_HARDWARE : Native.D3D_DRIVER_TYPE_UNKNOWN;
        int hr = Native.D3D11CreateDevice(adapter, driver, IntPtr.Zero, Native.D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            levels, (uint)levels.Length, Native.D3D11_SDK_VERSION, out dev, out fl, out ctx);
        if (hr < 0 || dev == IntPtr.Zero) return null;
        return new DxDevice { Device = dev, Context = ctx, adapterUsed = adapter };
    }

    public IntPtr OpenShared(IntPtr shareHandle)
    {
        IntPtr tex;
        Guid iid = Native.IID_ID3D11Texture2D;
        int hr = Com.OpenSharedResource(Device, shareHandle, iid, out tex);
        if (hr >= 0 && tex != IntPtr.Zero) return tex;
        IntPtr dev1;
        if (Com.QueryInterface(Device, Native.IID_ID3D11Device1, out dev1) >= 0 && dev1 != IntPtr.Zero)
        {
            hr = Com.OpenSharedResource1(dev1, shareHandle, iid, out tex);
            Com.Release(dev1);
            if (hr >= 0 && tex != IntPtr.Zero) return tex;
        }
        return IntPtr.Zero;
    }

    public IntPtr CreateStaging(uint w, uint h, uint format)
    {
        D3D11_TEXTURE2D_DESC d = new D3D11_TEXTURE2D_DESC();
        d.Width = w; d.Height = h; d.MipLevels = 1; d.ArraySize = 1;
        d.Format = format == 0 ? Native.DXGI_FORMAT_B8G8R8A8_UNORM : format;
        d.SampleCount = 1; d.SampleQuality = 0;
        d.Usage = Native.D3D11_USAGE_STAGING;
        d.CPUAccessFlags = Native.D3D11_CPU_ACCESS_READ;
        IntPtr tex;
        int hr = Com.CreateTexture2D(Device, ref d, out tex);
        return hr >= 0 ? tex : IntPtr.Zero;
    }

    public IntPtr CreateShared(uint w, uint h, uint format)
    {
        D3D11_TEXTURE2D_DESC d = new D3D11_TEXTURE2D_DESC();
        d.Width = w; d.Height = h; d.MipLevels = 1; d.ArraySize = 1;
        d.Format = format;
        d.SampleCount = 1; d.SampleQuality = 0;
        d.Usage = Native.D3D11_USAGE_DEFAULT;
        d.BindFlags = Native.D3D11_BIND_SHADER_RESOURCE | Native.D3D11_BIND_RENDER_TARGET;
        d.MiscFlags = Native.D3D11_RESOURCE_MISC_SHARED;
        IntPtr tex;
        int hr = Com.CreateTexture2D(Device, ref d, out tex);
        return hr >= 0 ? tex : IntPtr.Zero;
    }

    public void Dispose()
    {
        if (Context != IntPtr.Zero) { Com.Release(Context); Context = IntPtr.Zero; }
        if (Device != IntPtr.Zero) { Com.Release(Device); Device = IntPtr.Zero; }
    }
}

internal static class Program
{
    static volatile bool running = true;
    static ImageCodecInfo jpegCodec;

    static bool OnCtrl(uint ctrl) { running = false; return true; }

    static int Main(string[] args)
    {
        Native.SetConsoleCtrlHandler(OnCtrl, true);
        bool list = false, sendTest = false, selfTest = false;
        string name = "";
        int fps = 30, quality = 72, maxWidth = 880;
        string writeFrame = null;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--list") list = true;
            else if (a == "--send-test") sendTest = true;
            else if (a == "--self-test") selfTest = true;
            else if (a == "--active") name = "";
            else if ((a == "--name" || a == "--sender") && i + 1 < args.Length) name = args[++i];
            else if (a == "--fps" && i + 1 < args.Length) fps = Math.Max(1, Math.Min(60, int.Parse(args[++i])));
            else if (a == "--quality" && i + 1 < args.Length) quality = Math.Max(20, Math.Min(95, int.Parse(args[++i])));
            else if ((a == "--max-width" || a == "--width") && i + 1 < args.Length) maxWidth = Math.Max(160, int.Parse(args[++i]));
            else if (a == "--write-frame" && i + 1 < args.Length) writeFrame = args[++i];
        }
        try
        {
            if (list) { ListSenders(); return 0; }
            if (selfTest) return SelfTest();
            if (sendTest) { SendTest(name, fps); return 0; }
            Receive(name, fps, quality, maxWidth, writeFrame);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERROR " + ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
    }

    static void ListSenders()
    {
        string active = SpoutNames.GetActiveSenderName();
        List<SenderInfo> senders = SpoutNames.ListSenders();
        if (senders.Count == 0)
        {
            Console.Out.WriteLine("{\"senders\":[],\"active\":\"\"}");
            Console.Out.Flush();
            return;
        }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"active\":\"").Append(Esc(active)).Append("\",\"senders\":[");
        for (int i = 0; i < senders.Count; i++)
        {
            SenderInfo s = senders[i];
            if (i > 0) sb.Append(",");
            sb.Append("{\"name\":\"").Append(Esc(s.Name)).Append("\",\"width\":").Append(s.Width)
                .Append(",\"height\":").Append(s.Height).Append(",\"format\":").Append(s.Format)
                .Append(",\"active\":").Append(s.Name == active ? "true" : "false").Append("}");
        }
        sb.Append("]}");
        Console.Out.WriteLine(sb.ToString());
        Console.Out.Flush();
    }

    static string Esc(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    static IntPtr ShareHandlePtr(uint handle)
    {
        return new IntPtr((long)handle);
    }

    static DxDevice OpenDeviceForHandle(IntPtr shareHandle, out IntPtr tex)
    {
        tex = IntPtr.Zero;
        DxDevice dx = DxDevice.Create(IntPtr.Zero);
        if (dx != null)
        {
            tex = dx.OpenShared(shareHandle);
            if (tex != IntPtr.Zero) return dx;
            dx.Dispose();
        }
        Guid iid = Native.IID_IDXGIFactory;
        IntPtr factory;
        if (Native.CreateDXGIFactory(ref iid, out factory) < 0 || factory == IntPtr.Zero) return null;
        try
        {
            for (uint i = 0; i < 8; i++)
            {
                IntPtr adapter;
                if (Com.EnumAdapters(factory, i, out adapter) < 0 || adapter == IntPtr.Zero) break;
                dx = DxDevice.Create(adapter);
                Com.Release(adapter);
                if (dx == null) continue;
                tex = dx.OpenShared(shareHandle);
                if (tex != IntPtr.Zero) return dx;
                dx.Dispose();
            }
        }
        finally { Com.Release(factory); }
        return null;
    }

    static bool IsKeyed(IntPtr tex)
    {
        D3D11_TEXTURE2D_DESC d;
        Com.GetDesc(tex, out d);
        return (d.MiscFlags & Native.D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX) != 0;
    }

    static bool AcquireAccess(string sender, IntPtr tex, IntPtr mutex)
    {
        if (tex != IntPtr.Zero && IsKeyed(tex))
        {
            IntPtr keyed;
            if (Com.QueryInterface(tex, Native.IID_IDXGIKeyedMutex, out keyed) >= 0 && keyed != IntPtr.Zero)
            {
                int hr = Com.AcquireSync(keyed, 67);
                Com.Release(keyed);
                return hr == 0;
            }
        }
        if (mutex == IntPtr.Zero) return true;
        uint w = Native.WaitForSingleObject(mutex, 67);
        return w == Native.WAIT_OBJECT_0;
    }

    static void ReleaseAccess(string sender, IntPtr tex, IntPtr mutex)
    {
        if (tex != IntPtr.Zero && IsKeyed(tex))
        {
            IntPtr keyed;
            if (Com.QueryInterface(tex, Native.IID_IDXGIKeyedMutex, out keyed) >= 0 && keyed != IntPtr.Zero)
            {
                Com.ReleaseSync(keyed);
                Com.Release(keyed);
                return;
            }
        }
        if (mutex != IntPtr.Zero) Native.ReleaseMutex(mutex);
    }

    static ImageCodecInfo JpegCodec()
    {
        if (jpegCodec != null) return jpegCodec;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
        {
            if (c.MimeType == "image/jpeg") { jpegCodec = c; return c; }
        }
        throw new Exception("JPEG codec missing");
    }

    static bool IsSupportedFormat(uint format)
    {
        return format == Native.DXGI_FORMAT_R8G8B8A8_UNORM
            || format == Native.DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
            || format == Native.DXGI_FORMAT_B8G8R8A8_UNORM
            || format == Native.DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;
    }

    static byte[] EncodeJpeg(byte[] bgra, int width, int height, int stride, bool invert, bool swapRB, int maxWidth, int quality)
    {
        int dw = width, dh = height;
        if (maxWidth > 0 && width > maxWidth)
        {
            dw = maxWidth;
            dh = Math.Max(1, (int)Math.Round(height * (double)maxWidth / width));
        }
        using (Bitmap src = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        {
            BitmapData data = src.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            byte[] row = new byte[width * 4];
            try
            {
                for (int y = 0; y < height; y++)
                {
                    int sy = invert ? (height - 1 - y) : y;
                    IntPtr dst = new IntPtr(data.Scan0.ToInt64() + y * data.Stride);
                    int srcOff = sy * stride;
                    Buffer.BlockCopy(bgra, srcOff, row, 0, width * 4);
                    for (int x = 0; x < width; x++)
                    {
                        int i = x * 4;
                        if (swapRB)
                        {
                            byte r = row[i];
                            row[i] = row[i + 2];
                            row[i + 2] = r;
                        }
                        // The browser panel is opaque; do not let sender alpha flatten RGB to black.
                        row[i + 3] = 255;
                    }
                    Marshal.Copy(row, 0, dst, row.Length);
                }
            }
            finally { src.UnlockBits(data); }

            Bitmap outBmp = src;
            bool scaled = dw != width || dh != height;
            if (scaled)
            {
                outBmp = new Bitmap(dw, dh, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(outBmp))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(src, 0, 0, dw, dh);
                }
            }
            try
            {
                using (MemoryStream ms = new MemoryStream())
                {
                    EncoderParameters ep = new EncoderParameters(1);
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                    outBmp.Save(ms, JpegCodec(), ep);
                    return ms.ToArray();
                }
            }
            finally
            {
                if (scaled) outBmp.Dispose();
            }
        }
    }

    static void WriteFrame(Stream stdout, byte[] jpeg)
    {
        byte[] hdr = new byte[8];
        hdr[0] = (byte)'S'; hdr[1] = (byte)'P'; hdr[2] = (byte)'U'; hdr[3] = (byte)'T';
        int n = jpeg.Length;
        hdr[4] = (byte)n; hdr[5] = (byte)(n >> 8); hdr[6] = (byte)(n >> 16); hdr[7] = (byte)(n >> 24);
        stdout.Write(hdr, 0, 8);
        stdout.Write(jpeg, 0, jpeg.Length);
        stdout.Flush();
    }

    static void LogMeta(string sender, uint w, uint h, string state)
    {
        Console.Error.WriteLine("SPOUT_META {\"sender\":\"" + Esc(sender) + "\",\"width\":" + w + ",\"height\":" + h + ",\"state\":\"" + state + "\"}");
        Console.Error.Flush();
    }

    static string ResolveSender(string requested)
    {
        if (!string.IsNullOrEmpty(requested))
        {
            SenderInfo info;
            if (SpoutNames.TryGetInfo(requested, out info)) return requested;
            return requested; // wait for named sender
        }
        string active = SpoutNames.GetActiveSenderName();
        if (!string.IsNullOrEmpty(active)) return active;
        List<SenderInfo> all = SpoutNames.ListSenders();
        if (all.Count > 0) return all[0].Name;
        return "";
    }

    static void Receive(string requested, int fps, int quality, int maxWidth, string writeFrame)
    {
        Stream stdout = Console.OpenStandardOutput();
        int interval = Math.Max(8, 1000 / Math.Max(1, fps));
        DxDevice dx = null;
        IntPtr shared = IntPtr.Zero, staging = IntPtr.Zero, mutex = IntPtr.Zero;
        uint lastHandle = 0, lastW = 0, lastH = 0, lastFmt = 0;
        string connected = "";
        bool wroteOnce = false;
        bool frameReported = false;
        int lockFailures = 0, mapFailures = 0;
        DateTime lastWaitLog = DateTime.MinValue;

        while (running)
        {
            string sender = ResolveSender(requested);
            SenderInfo info;
            if (string.IsNullOrEmpty(sender) || !SpoutNames.TryGetInfo(sender, out info))
            {
                if ((DateTime.UtcNow - lastWaitLog).TotalSeconds >= 2)
                {
                    LogMeta(sender ?? "", 0, 0, "waiting");
                    lastWaitLog = DateTime.UtcNow;
                }
                ReleaseGpu(ref dx, ref shared, ref staging, ref mutex);
                lastHandle = lastW = lastH = lastFmt = 0;
                connected = "";
                frameReported = false;
                Thread.Sleep(250);
                continue;
            }

            bool reopen = dx == null || shared == IntPtr.Zero || sender != connected
                || info.ShareHandle != lastHandle || info.Width != lastW || info.Height != lastH || info.Format != lastFmt;
            if (reopen)
            {
                ReleaseGpu(ref dx, ref shared, ref staging, ref mutex);
                IntPtr h = ShareHandlePtr(info.ShareHandle);
                IntPtr tex;
                dx = OpenDeviceForHandle(h, out tex);
                if (dx == null || tex == IntPtr.Zero)
                {
                    LogMeta(sender, info.Width, info.Height, "open-failed");
                    Thread.Sleep(400);
                    continue;
                }
                shared = tex;
                D3D11_TEXTURE2D_DESC desc;
                Com.GetDesc(shared, out desc);
                uint fmt = desc.Format != 0 ? desc.Format : (info.Format != 0 ? info.Format : Native.DXGI_FORMAT_B8G8R8A8_UNORM);
                if (!IsSupportedFormat(fmt))
                {
                    LogMeta(sender, desc.Width, desc.Height, "unsupported-format");
                    ReleaseGpu(ref dx, ref shared, ref staging, ref mutex);
                    Thread.Sleep(400);
                    continue;
                }
                if (desc.SampleCount != 1 || desc.MipLevels != 1 || desc.ArraySize != 1)
                {
                    LogMeta(sender, desc.Width, desc.Height, "unsupported-texture");
                    ReleaseGpu(ref dx, ref shared, ref staging, ref mutex);
                    Thread.Sleep(400);
                    continue;
                }
                staging = dx.CreateStaging(desc.Width, desc.Height, fmt);
                if (staging == IntPtr.Zero)
                {
                    LogMeta(sender, desc.Width, desc.Height, "staging-failed");
                    ReleaseGpu(ref dx, ref shared, ref staging, ref mutex);
                    Thread.Sleep(400);
                    continue;
                }
                mutex = Native.CreateMutexA(IntPtr.Zero, false, sender + "_SpoutAccessMutex");
                lastHandle = info.ShareHandle;
                lastW = desc.Width;
                lastH = desc.Height;
                lastFmt = fmt;
                connected = sender;
                frameReported = false;
                lockFailures = 0;
                mapFailures = 0;
                LogMeta(sender, lastW, lastH, "opened");
            }

            if (!AcquireAccess(sender, shared, mutex))
            {
                lockFailures++;
                if (lockFailures == 1 || lockFailures % 60 == 0)
                    LogMeta(sender, lastW, lastH, "lock-timeout");
                Thread.Sleep(4);
                continue;
            }
            lockFailures = 0;
            try { Com.CopyResource(dx.Context, staging, shared); }
            finally { ReleaseAccess(sender, shared, mutex); }

            D3D11_MAPPED_SUBRESOURCE mapped;
            int hr = Com.Map(dx.Context, staging, out mapped);
            if (hr < 0 || mapped.pData == IntPtr.Zero)
            {
                mapFailures++;
                if (mapFailures == 1 || mapFailures % 30 == 0)
                    LogMeta(sender, lastW, lastH, "map-failed");
                Thread.Sleep(interval);
                continue;
            }
            mapFailures = 0;
            byte[] bgra;
            int stride = (int)mapped.RowPitch;
            try
            {
                int bytes = stride * (int)lastH;
                bgra = new byte[bytes];
                Marshal.Copy(mapped.pData, bgra, 0, bytes);
            }
            finally { Com.Unmap(dx.Context, staging); }

            bool swapRB = lastFmt == Native.DXGI_FORMAT_R8G8B8A8_UNORM
                || lastFmt == Native.DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
            byte[] jpeg = EncodeJpeg(bgra, (int)lastW, (int)lastH, stride, true, swapRB, maxWidth, quality);
            if (jpeg.Length > Native.MaxJpegBytes)
            {
                LogMeta(sender, lastW, lastH, "frame-too-large");
                Thread.Sleep(interval);
                continue;
            }
            if (writeFrame != null && !wroteOnce)
            {
                File.WriteAllBytes(writeFrame, jpeg);
                wroteOnce = true;
                LogMeta(sender, lastW, lastH, "wrote-frame");
            }
            WriteFrame(stdout, jpeg);
            if (!frameReported)
            {
                frameReported = true;
                LogMeta(sender, lastW, lastH, "connected");
            }
            if (writeFrame != null && fps <= 1) break;
            Thread.Sleep(interval);
        }
        ReleaseGpu(ref dx, ref shared, ref staging, ref mutex);
    }

    static void ReleaseGpu(ref DxDevice dx, ref IntPtr shared, ref IntPtr staging, ref IntPtr mutex)
    {
        if (staging != IntPtr.Zero) { Com.Release(staging); staging = IntPtr.Zero; }
        if (shared != IntPtr.Zero) { Com.Release(shared); shared = IntPtr.Zero; }
        if (dx != null) { dx.Dispose(); dx = null; }
        if (mutex != IntPtr.Zero) { Native.CloseHandle(mutex); mutex = IntPtr.Zero; }
    }

    static void SendTest(string name, int fps)
    {
        if (string.IsNullOrEmpty(name)) name = "VDJ Overlay Test";
        const uint w = 1280, h = 720;
        DxDevice dx = DxDevice.Create(IntPtr.Zero);
        if (dx == null) throw new Exception("D3D11CreateDevice failed");
        IntPtr tex = dx.CreateShared(w, h, Native.DXGI_FORMAT_B8G8R8A8_UNORM);
        if (tex == IntPtr.Zero) throw new Exception("CreateShared texture failed");
        IntPtr resource;
        if (Com.QueryInterface(tex, Native.IID_IDXGIResource, out resource) < 0 || resource == IntPtr.Zero)
            throw new Exception("IDXGIResource QI failed");
        IntPtr handle;
        int hr = Com.GetSharedHandle(resource, out handle);
        Com.Release(resource);
        if (hr < 0 || handle == IntPtr.Zero) throw new Exception("GetSharedHandle failed");
        uint share32 = unchecked((uint)handle.ToInt64());
        if (!SpoutNames.RegisterSender(name, w, h, share32, Native.DXGI_FORMAT_B8G8R8A8_UNORM))
            throw new Exception("Spout sender registration failed");
        IntPtr mutex = Native.CreateMutexA(IntPtr.Zero, false, name + "_SpoutAccessMutex");
        LogMeta(name, w, h, "sending");
        int interval = Math.Max(8, 1000 / Math.Max(1, fps));
        byte[] pixels = new byte[w * h * 4];
        int frame = 0;
        GCHandle pin = GCHandle.Alloc(pixels, GCHandleType.Pinned);
        try
        {
            while (running)
            {
                FillTestPattern(pixels, (int)w, (int)h, frame++);
                if (mutex != IntPtr.Zero) Native.WaitForSingleObject(mutex, 67);
                try { Com.UpdateSubresource(dx.Context, tex, pin.AddrOfPinnedObject(), w * 4); }
                finally { if (mutex != IntPtr.Zero) Native.ReleaseMutex(mutex); }
                Thread.Sleep(interval);
            }
        }
        finally
        {
            pin.Free();
            if (mutex != IntPtr.Zero) Native.CloseHandle(mutex);
            Com.Release(tex);
            dx.Dispose();
        }
    }

    static void FillTestPattern(byte[] px, int w, int h, int frame)
    {
        int t = frame * 3;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                int i = (y * w + x) * 4;
                int band = x * 6 / w;
                byte r = 0, g = 0, b = 0;
                switch (band)
                {
                    case 0: r = 220; g = 146; b = 79; break;
                    case 1: r = 255; g = 90; b = 120; break;
                    case 2: r = 40; g = 18; b = 12; break;
                    case 3: r = 244; g = 239; b = 232; break;
                    case 4: r = 255; g = 209; b = 102; break;
                    default: r = 26; g = 11; b = 8; break;
                }
                int pulse = 40 + (int)(20 * Math.Sin((x + t) * 0.02 + y * 0.01));
                px[i] = (byte)Math.Min(255, (int)b + (pulse / 4));
                px[i + 1] = (byte)Math.Min(255, (int)g + (pulse / 6));
                px[i + 2] = (byte)Math.Min(255, (int)r);
                px[i + 3] = 255;
            }
        }
        // moving bar so the overlay obviously updates
        int bar = ((frame * 8) % w);
        for (int y = 0; y < h; y++)
        {
            for (int x = bar; x < bar + 18 && x < w; x++)
            {
                int i = (y * w + x) * 4;
                px[i] = 232; px[i + 1] = 239; px[i + 2] = 244; px[i + 3] = 255;
            }
        }
    }

    static int SelfTest()
    {
        Thread sender = new Thread(() =>
        {
            try { SendTest("VDJ Overlay SelfTest", 30); }
            catch (Exception ex) { Console.Error.WriteLine("SEND_ERROR " + ex.Message); }
        });
        sender.IsBackground = true;
        sender.Start();
        string tmp = Path.Combine(Path.GetTempPath(), "vdj-spout-selftest.jpg");
        DateTime start = DateTime.UtcNow;
        bool got = false;
        while ((DateTime.UtcNow - start).TotalSeconds < 8)
        {
            SenderInfo info;
            if (SpoutNames.TryGetInfo("VDJ Overlay SelfTest", out info))
            {
                Receive("VDJ Overlay SelfTest", 1, 70, 640, tmp);
                got = File.Exists(tmp) && new FileInfo(tmp).Length > 800;
                break;
            }
            Thread.Sleep(50);
        }
        running = false;
        Console.Error.WriteLine(got ? "SELFTEST ok file=" + tmp : "SELFTEST failed");
        return got ? 0 : 2;
    }
}
