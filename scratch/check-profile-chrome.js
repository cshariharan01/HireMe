const { execSync } = require('child_process');

const ps = `
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {
  [PSCustomObject]@{
    Id = $_.ProcessId
    CommandLine = $_.CommandLine
  }
} | ConvertTo-Json
`;

try {
  const stdout = execSync(`powershell -NoProfile -Command "${ps.replace(/\r?\n/g, ' ')}"`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  const list = JSON.parse(stdout);
  const items = Array.isArray(list) ? list : [list];
  const profileChrome = items.filter(p => p.CommandLine && p.CommandLine.includes('browser-profile'));
  console.log('Total Chrome:', items.length);
  console.log('Chrome instances using browser-profile:', profileChrome.length);
  for (const c of profileChrome) {
    console.log(`PID: ${c.Id}`);
  }
} catch (e) {
  console.error('Error:', e.message);
}
