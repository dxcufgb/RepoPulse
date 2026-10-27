@echo off
rem Start RepoPulse in this window. Close the window or press Ctrl+C to stop it.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo RepoPulse is not installed yet. Double-click install.bat first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m repopulse serve %*
pause
