@echo off
REM Rebuilds the dashboard's holdings history and trade activity.
REM Shows what it will do, asks, then writes. Double-click to run.

cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo Python is not on the PATH, so this cannot run.
  echo Install Python, or open a command prompt in this folder and run:
  echo     python scripts\monthly_update.py
  echo.
  pause
  exit /b 1
)

python scripts\monthly_update.py
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" echo Finished with errors - nothing above said DONE, so read the messages.
pause
exit /b %EXITCODE%
