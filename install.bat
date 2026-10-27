@echo off
rem Runs install.ps1. Pass options through, e.g.  install.bat -Port 9000
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
