@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Wife.ps1"
if errorlevel 1 (
  echo.
  echo Update failed. Read the error above before closing this window.
  pause
  exit /b 1
)
echo.
echo Both apps are up to date. This window will close automatically.
timeout /t 6 /nobreak >nul
