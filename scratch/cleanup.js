const { execSync } = require('child_process');
const fs = require('fs');

try {
  const ps = `$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like '*browser-profile*' }; foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  execSync(`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`);
} catch {}

try {
  if (fs.existsSync('data/playwright/browser-profile/lockfile')) {
    fs.unlinkSync('data/playwright/browser-profile/lockfile');
  }
} catch {}

console.log('Profile cleaned and ready!');
