$procs = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'"
$targets = $procs | Where-Object { $_.CommandLine -like "*browser-profile*" }
Write-Output "Found $($targets.Count) processes matching browser-profile"
foreach ($t in $targets) {
    Write-Output "PID: $($t.ProcessId) -> $($t.CommandLine)"
}
