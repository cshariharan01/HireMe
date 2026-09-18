const { execSync } = require('child_process');

const ps = `
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    public static List<string> FindWindowsForPid(uint targetPid) {
        var list = new List<string>();
        EnumWindows((hWnd, lParam) => {
            uint pid = 0;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == targetPid) {
                var sb = new StringBuilder(256);
                GetWindowText(hWnd, sb, 256);
                bool vis = IsWindowVisible(hWnd);
                list.Add(string.Format("Handle: {0}, Visible: {1}, Title: '{2}'", hWnd, vis, sb.ToString()));
            }
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

$res = [WinEnum]::FindWindowsForPid(38476)
Write-Output "Windows for PID 38476 ($($res.Count) found):"
$res | ForEach-Object { Write-Output $_ }
`;

const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`).toString();
console.log(out);
