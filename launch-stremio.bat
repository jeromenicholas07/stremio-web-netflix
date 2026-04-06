@echo off
:: ============================================================
::  Stremio Custom UI Launcher
::  Just double-click StremioLauncher.exe instead!
::  This .bat is a fallback that compiles and runs it.
:: ============================================================

:: If the exe exists next to this bat, just run it
if exist "%~dp0StremioLauncher.exe" (
    start "" "%~dp0StremioLauncher.exe"
    exit /b
)

:: Otherwise, try to compile from source
set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo .NET Framework not found. Download StremioLauncher.exe from the release page.
    pause
    exit /b 1
)

if exist "%~dp0StremioLauncher.cs" (
    echo Compiling launcher...
    "%CSC%" /target:exe /out:"%~dp0StremioLauncher.exe" /platform:anycpu /optimize "%~dp0StremioLauncher.cs"
    if exist "%~dp0StremioLauncher.exe" (
        start "" "%~dp0StremioLauncher.exe"
    ) else (
        echo Compilation failed.
        pause
    )
) else (
    echo StremioLauncher.exe not found. Download it from the release page.
    pause
)
