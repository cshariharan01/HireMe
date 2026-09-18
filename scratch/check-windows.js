const { execSync } = require('child_process');

try {
  const ps = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize`;
  const res = execSync(`powershell -NoProfile -Command "${ps}"`).toString();
  console.log('=== Visible Windows ===');
  console.log(res);
} catch (e) {
  console.error(e.message);
}
