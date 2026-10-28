// Experimental host, independent of ADE's production UI. Never executes code in Gemini.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class AdeGeminiProbe
{
    // Optional standalone entry point for visual QA (the normal PS wrapper uses Run).
    [STAThread]
    public static int Main(string[] args) {
        if (args.Length != 3) return 2;
        Result result;
        try {
            int seconds = int.Parse(args[1]);
            if (seconds < 8 || seconds > 120) return 2;
            result = Run(new IntPtr(long.Parse(args[0])), seconds);
        } catch (Exception error) { result = new Result { Error = error.ToString() }; }
        using (var file = System.IO.File.Create(args[2])) {
            new System.Xml.Serialization.XmlSerializer(typeof(Result)).Serialize(file, result);
        }
        return result.Restored && result.Error == null ? 0 : 1;
    }
    const int Style = -16, ExStyle = -20;
    const long Child = 0x40000000L, Popup = 0x80000000L;
    const long Frame = 0x00C00000L | 0x00040000L | 0x00080000L | 0x00020000L | 0x00010000L;
    const uint PositionFlags = 0x0004 | 0x0010 | 0x0020; // no z-order, no activation, frame changed

    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Placement {
        public int Length, Flags, ShowCmd;
        public Point MinPosition, MaxPosition;
        public Rect NormalPosition;
    }
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetParent(IntPtr window, IntPtr parent);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr window, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetLong(IntPtr window, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);

    public sealed class Result {
        public bool Attached, Resized, Hidden, Shown, Restored;
        public int OriginalDpiAwareness;
        public string Error;
        public List<string> Events = new List<string>();
    }
    public static object Inspect(IntPtr window) {
        if (!IsWindow(window)) throw new InvalidOperationException("Gemini window no longer exists.");
        return new { Handle = window.ToInt64(), Parent = GetParent(window).ToInt64(),
            Visible = IsWindowVisible(window), DpiAwareness = GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window)),
            PerMonitorV1 = AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), new IntPtr(-3)),
            PerMonitorV2 = AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), new IntPtr(-4)) };
    }

    public static Result Run(IntPtr window, int seconds) {
        if (IntPtr.Size != 8) throw new InvalidOperationException("Use 64-bit PowerShell.");
        if (!IsWindow(window) || GetParent(window) != IntPtr.Zero) throw new InvalidOperationException("Expected an unowned top-level Gemini window.");
        var result = new Result();
        var originalStyle = GetLong(window, Style);
        var originalExStyle = GetLong(window, ExStyle);
        bool originallyVisible = IsWindowVisible(window);
        var originalPlacement = new Placement { Length = Marshal.SizeOf(typeof(Placement)) };
        if (!GetWindowPlacement(window, ref originalPlacement)) throw new Win32Exception();
        var dpi = GetWindowDpiAwarenessContext(window);
        result.OriginalDpiAwareness = GetAwarenessFromDpiAwarenessContext(dpi);
        var previousDpi = SetThreadDpiAwarenessContext(dpi);
        if (previousDpi == IntPtr.Zero) throw new Win32Exception();
        Form host = null;
        bool changed = false;
        Action restore = () => {
            if (!changed) return;
            if (!IsWindow(window)) throw new InvalidOperationException("Gemini window disappeared during probe.");
            ShowWindow(window, 0);
            SetParent(window, IntPtr.Zero);
            SetLong(window, Style, originalStyle);
            SetLong(window, ExStyle, originalExStyle);
            bool placed = SetWindowPlacement(window, ref originalPlacement);
            Rect rect;
            GetWindowRect(window, out rect);
            bool positioned = SetWindowPos(window, IntPtr.Zero, rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top, PositionFlags);
            ShowWindow(window, originallyVisible ? originalPlacement.ShowCmd : 0);
            result.Restored = placed && positioned && GetParent(window) == IntPtr.Zero && GetLong(window, Style) == originalStyle && GetLong(window, ExStyle) == originalExStyle;
            if (!result.Restored) throw new InvalidOperationException("Window restoration failed; host kept alive to protect Gemini.");
            changed = false;
            result.Events.Add("Original parent, styles, placement and visibility restored.");
        };
        try {
            host = new Form { Text = "ADE | Gemini native integration probe", StartPosition = FormStartPosition.CenterScreen,
                ClientSize = new Size(1180, 790), BackColor = Color.FromArgb(20, 23, 30) };
            var banner = new Label { Text = "ADE / Gemini Desktop — temporary native host (automatic restore in " + seconds + "s)",
                Dock = DockStyle.Top, Height = 42, ForeColor = Color.White, TextAlign = ContentAlignment.MiddleLeft };
            host.Controls.Add(banner);
            var panel = new Panel { Dock = DockStyle.Fill };
            host.Controls.Add(panel);
            panel.BringToFront();
            IntPtr panelHandle = panel.Handle;
            if (!AreDpiAwarenessContextsEqual(dpi, GetWindowDpiAwarenessContext(panelHandle))) throw new InvalidOperationException("DPI mismatch: refusing cross-process reparenting.");
            Action resize = () => {
                if (changed && IsWindow(window)) {
                    Rect client;
                    GetClientRect(panelHandle, out client);
                    if (!SetWindowPos(window, IntPtr.Zero, 0, 0, client.Right, client.Bottom, PositionFlags)) throw new Win32Exception();
                    Rect actual;
                    GetWindowRect(window, out actual);
                    result.Resized = actual.Right - actual.Left == client.Right && actual.Bottom - actual.Top == client.Bottom;
                }
            };
            panel.Resize += (s, e) => resize();
            host.FormClosing += (s, e) => {
                try { restore(); } catch (Exception error) { result.Error = error.ToString(); e.Cancel = true; }
            };
            host.Shown += (s, e) => {
                try {
                    changed = true;
                    SetLong(window, Style, new IntPtr((originalStyle.ToInt64() & ~(Popup | Frame)) | Child));
                    SetLong(window, ExStyle, new IntPtr(originalExStyle.ToInt64() & ~0x00040000L));
                    SetParent(window, panelHandle);
                    result.Attached = GetParent(window) == panelHandle;
                    if (!result.Attached) throw new Win32Exception(Marshal.GetLastWin32Error());
                    resize();
                    ShowWindow(window, 5);
                    result.Events.Add("Gemini HWND attached to host panel with matching DPI.");
                } catch (Exception error) { result.Error = error.ToString(); host.Close(); }
            };
            int ticks = 0;
            using (var timer = new System.Windows.Forms.Timer { Interval = 1000 }) {
                timer.Tick += (s, e) => {
                    try {
                        ticks++;
                        if (ticks == 3) { host.ClientSize = new Size(1100, 740); resize(); }
                        if (ticks == 5) { ShowWindow(window, 0); result.Hidden = !IsWindowVisible(window); }
                        if (ticks == 6) { ShowWindow(window, 5); result.Shown = IsWindowVisible(window); }
                        if (ticks >= seconds) { timer.Stop(); host.Close(); }
                    } catch (Exception error) { result.Error = error.ToString(); timer.Stop(); host.Close(); }
                };
                timer.Start();
                Application.Run(host);
            }
        } catch (Exception error) { result.Error = error.ToString(); }
        finally {
            restore();
            if (host != null) host.Dispose();
            SetThreadDpiAwarenessContext(previousDpi);
        }
        return result;
    }
}
