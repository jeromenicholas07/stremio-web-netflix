@echo off
:: Stremio Custom UI Launcher
:: Launches Stremio Shell with the custom Netflix UI + Whisper Auto-Sync
:: Disables CORS so the web UI on GitHub Pages can talk to the local streaming server

set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-web-security

:: Find Stremio Shell
set "SHELL_PATH="
if exist "%LOCALAPPDATA%\Programs\Stremio\stremio-shell-ng.exe" (
    set "SHELL_PATH=%LOCALAPPDATA%\Programs\Stremio\stremio-shell-ng.exe"
) else if exist "%ProgramFiles%\Stremio\stremio-shell-ng.exe" (
    set "SHELL_PATH=%ProgramFiles%\Stremio\stremio-shell-ng.exe"
) else if exist "%ProgramFiles(x86)%\Stremio\stremio-shell-ng.exe" (
    set "SHELL_PATH=%ProgramFiles(x86)%\Stremio\stremio-shell-ng.exe"
)

if "%SHELL_PATH%"=="" (
    echo Stremio not found. Please install from https://www.stremio.com/downloads
    pause
    exit /b 1
)

start "" "%SHELL_PATH%" --webui-url=https://jeromenicholas07.github.io/stremio-web-netflix/
