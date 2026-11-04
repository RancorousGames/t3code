@echo off
setlocal
cd /d "%~dp0\..\.."
echo Publishing committed T3 + Monku code to GitHub main...
git push origin main:refs/heads/main
if errorlevel 1 goto failed
echo Mirroring main to the legacy wife-deploy branch for older installations...
git push origin main:refs/heads/wife-deploy
if errorlevel 1 goto failed
echo.
echo Published. The repository-owned EXE updater pulls main automatically.
pause
exit /b 0
:failed
echo.
echo Publish failed. Commit changes and resolve any branch divergence before retrying.
pause
exit /b 1
