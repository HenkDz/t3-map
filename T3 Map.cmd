@echo off
rem Starts the T3 Map bridge if needed, then opens the map.
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:4773/api/health | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath node -ArgumentList '--no-deprecation','server/index.mjs' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
  timeout /t 2 /nobreak >nul
)
start "" http://127.0.0.1:4773/
