const { execSync } = require('child_process');
const ps = `
$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'"
$targets = $procs | Where-Object { $_.CommandLine -like '*browser-profile*' }
foreach ($t in $targets) {
  Write-Host "Target PID: " $t.ProcessId " Cmd: " $t.CommandLine.Substring(0, [Math]::Min(80, $t.CommandLine.Length))
}
`;
const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync('powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded).toString();
console.log(out);
