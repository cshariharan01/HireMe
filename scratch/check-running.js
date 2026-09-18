const { execSync } = require('child_process');
const ps = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*browser-profile*" } | Select-Object ProcessId`;
const encoded = Buffer.from(ps, 'utf16le').toString('base64');
const out = execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`).toString().trim();
console.log('Running browser-profile Chrome PIDs:\n', out || 'NONE');
