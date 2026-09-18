const { execSync } = require('child_process');

const ps = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class WinChecker {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public static string[] GetWindows() {
        var list = new List<string>();
        EnumWindows((hWnd, lParam) => {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            var sb = new StringBuilder(256);
            GetWindowText(hWnd, sb, 256);
            string title = sb.ToString();
            RECT r;
            GetWindowRect(hWnd, out r);
            bool vis = IsWindowVisible(hWnd);
            if (!string.IsNullOrWhiteSpace(title)) {
                list.Add("PID: " + pid + " | Vis: " + vis + " | Rect: (" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + ") | Title: " + title);
            }
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }
}
"@
[WinChecker]::GetWindows()
`;

const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync('powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded).toString();
console.log(out);
