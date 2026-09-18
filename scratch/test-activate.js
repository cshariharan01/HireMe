const { execSync } = require('child_process');
try {
  const out = execSync(`powershell -NoProfile -Command "$wshell = New-Object -ComObject WScript.Shell; $res = $wshell.AppActivate('Chrome'); Write-Output ('AppActivate Chrome result: ' + $res)"`).toString();
  console.log(out);
} catch (e) {
  console.log('Error:', e.message);
}
