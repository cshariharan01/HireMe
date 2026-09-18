const { execSync } = require('child_process');

const ps = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinInfo {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*browser-profile*" }
foreach ($p in $procs) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc) {
    $hWnd = $proc.MainWindowHandle
    $title = $proc.MainWindowTitle
    $visible = if ($hWnd -ne 0) { [WinInfo]::IsWindowVisible($hWnd) } else { $false }
    $rect = New-Object WinInfo+RECT
    if ($hWnd -ne 0) { [WinInfo]::GetWindowRect($hWnd, [ref]$rect) }
    Write-Output "PID: $($proc.Id) Handle: $hWnd Visible: $visible Title: '$title' Rect: $($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
  }
}
`;

const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`).toString();
console.log(out);
