param([string]$appPath, [string]$appArgs)
Add-Type -Path "c:\Users\cshar\PycharmProjects\hiresignal-personal\scratch\DesktopSpawner.cs"
[DesktopSpawner]::SpawnOnDefaultDesktop($appPath, $appArgs)
