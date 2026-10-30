@echo off
rem The RepoPulse command line with the installed settings, for example (in an administrator command prompt):
rem   repopulse status ^| create-admin ^| set-password ^| collect ^| check-update     (repopulse --help lists all)
rem The server itself runs as the scheduled task "RepoPulse"; do not start a second one with "serve".
setlocal
cd /d "%~dp0"
"%~dp0python\python.exe" -m repopulse --config "%ProgramData%\RepoPulse\config.json" %*
