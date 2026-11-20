@echo off
setlocal
title Build Vision installer
cd /d "%~dp0"

rem The installer builder needs administrator rights on Windows, so ask for them once.
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Asking for administrator permission...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo Node.js is not installed. Opening its download page...
  start https://nodejs.org
  echo.
  echo Install Node.js ^(the LTS button^), then double-click BUILD-INSTALLER.bat again.
  pause
  exit /b 1
)

echo.
echo === Step 1 of 2: downloading what is needed (first time takes a few minutes) ===
call npm install
if errorlevel 1 goto fail

echo.
echo === Step 2 of 2: building Vision-Setup.exe ===
call npm run dist
if errorlevel 1 goto fail

echo.
echo ============================================================
echo  Done! Your installer is: dist\Vision-Setup.exe
echo  Double-click it to install Vision. You can copy it anywhere.
echo ============================================================
explorer "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Something went wrong. Copy the text above and send it to me.
pause
exit /b 1
