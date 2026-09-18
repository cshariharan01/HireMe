$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'"
$targets = $procs | Where-Object { $_.CommandLine -like "*browser-profile*" }
Write-Output "Killing $($targets.Count) browser-profile Chrome processes..."
foreach ($t in $targets) {
    try {
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Output "Killed $($t.ProcessId)"
    } catch {
        Write-Output "Failed to kill $($t.ProcessId): $_"
    }
}

$lock = Join-Path $PSScriptRoot "..\data\playwright\browser-profile\lockfile"
if (Test-Path $lock) {
    Remove-Item $lock -Force
    Write-Output "Removed stale lockfile"
}
Write-Output "Done"
