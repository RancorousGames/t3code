@echo off
setlocal
cd /d "%~dp0\..\.."
echo Publishing committed T3 + Monku code to the wife-deploy branch...
git push origin main:refs/heads/wife-deploy
if errorlevel 1 (
  echo.
  echo Could not publish. Commit your changes and verify the repository state.
  pause
  exit /b 1
)
echo.
echo Published. Her Update T3 and Monku shortcut can now pull it.
pause
