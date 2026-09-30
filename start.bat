@echo off
setlocal enabledelayedexpansion
title HireMe - Personal Job Assistant

echo.
echo  ==========================================
echo   HireMe - Personal Job Assistant
echo  ==========================================
echo.
echo  First-time setup: get a FREE Gemini API key at
echo  https://aistudio.google.com/apikey  then paste it
echo  in Settings (top-right) after the app opens.
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js is not installed.
  echo  Download from: https://nodejs.org (LTS version)
  echo  Then run start.bat again.
  pause
  exit /b 1
)
echo  Node.js found.

:: Install npm dependencies (first-time only)
if not exist node_modules (
  echo.
  echo  Installing dependencies (first-time setup ~1-2 minutes)...
  call npm install --prefer-offline --no-audit --no-fund
  if errorlevel 1 (
    echo  ERROR: npm install failed. Check internet connection.
    pause
    exit /b 1
  )
  echo  Dependencies installed.
)

:: Check if Google Chrome exists
set CHROME_FOUND=0
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1

if "!CHROME_FOUND!"=="1" (
  echo  Google Chrome detected on system.
) else (
  if not exist "node_modules\playwright-core\.local-chromium" (
    if not exist "node_modules\playwright\.local-chromium" (
      echo.
      echo  Chrome not found. Installing bundled browser engine (~150 MB download)...
      call npx playwright install chromium
    )
  )
)

:: Create data directories
if not exist data mkdir data
if not exist "data\playwright" mkdir "data\playwright"

:: Launch app + open browser after 10s delay
echo.
echo  Starting HireMe at http://127.0.0.1:3001
echo  Press Ctrl+C to stop.
echo.
start /min "" cmd /c "timeout /t 5 /nobreak >nul && start http://127.0.0.1:3001"
call npm run dev -- -H 0.0.0.0 -p 3001
endlocal
