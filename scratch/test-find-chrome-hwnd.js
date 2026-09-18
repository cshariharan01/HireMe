const { execSync } = require('child_process');

const ps = `
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  public class Win32 {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
  }
"@

$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*browser-profile*" }
Write-Output "Found matching procs: $($procs.Count)"
foreach ($p in $procs) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    Write-Output "Found MainWindowHandle: $($proc.MainWindowHandle) for PID $($proc.Id) Title: $($proc.MainWindowTitle)"
    # Unlock foreground
    [Win32]::keybd_event(0x12, 0, 0, 0) # ALT down
    [Win32]::ShowWindow($proc.MainWindowHandle, 3) # SW_MAXIMIZE
    [Win32]::SetForegroundWindow($proc.MainWindowHandle)
    [Win32]::keybd_event(0x12, 0, 2, 0) # ALT up
  }
}
`;

try {
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`).toString();
  console.log('Result:\n', out);
} catch (e) {
  console.log('Error:', e.message);
}
