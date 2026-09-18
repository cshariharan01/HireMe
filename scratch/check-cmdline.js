const { execSync } = require('child_process');
const ps = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*browser-profile*" -and $_.CommandLine -notlike "*--type=*" } | Select-Object ProcessId, CommandLine | Format-List`;
const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`).toString();
console.log(out);
