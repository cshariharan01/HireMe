@echo off
setlocal enabledelayedexpansion
title HireSignal - Personal Job Assistant

echo.
echo  ==========================================
echo   HireSignal - Personal Job Assistant
echo  ==========================================
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

:: Install Playwright browser if needed
if not exist "node_modules\playwright-core\.local-chromium" (
  if not exist "node_modules\playwright\.local-chromium" (
    echo.
    echo  Installing browser engine (one-time ~150 MB download)...
    call npx playwright install chromium
  )
)

:: Create data directories
if not exist data mkdir data
if not exist "data\playwright" mkdir "data\playwright"

:: Launch app + open browser after 10s delay
echo.
echo  Starting HireSignal at http://localhost:3000
echo  Press Ctrl+C to stop.
echo.
start /min "" cmd /c "timeout /t 10 /nobreak >nul && start http://localhost:3000"
call npm run dev
endlocal
