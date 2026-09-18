param([string]$port = "9222")
Add-Type -Path "c:\Users\cshar\PycharmProjects\hiresignal-personal\scratch\DesktopSpawner.cs"

$chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profileDir = "C:\Users\cshar\PycharmProjects\hiresignal-personal\data\playwright\browser-profile"

# Kill any existing chrome on this profile
$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -like "*browser-profile*" }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Sleep -Milliseconds 800

# Remove stale lockfile if any
$lock = Join-Path $profileDir "lockfile"
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }

$args = "--remote-debugging-port=$port --user-data-dir=`"$profileDir`" --new-window --start-maximized --no-first-run --no-default-browser-check --disable-blink-features=AutomationControlled about:blank"

$pid = [DesktopSpawner]::SpawnOnDefaultDesktop($chromePath, $args)
Write-Host "Launched Chrome on WinSta0\Default with PID: $pid"
