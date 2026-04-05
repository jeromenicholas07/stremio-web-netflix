@echo off
:: ============================================================
::  Stremio Custom UI Launcher
::  Starts a local CORS proxy + Stremio Shell in one click.
::  No Node.js, no Python, no extra software needed.
:: ============================================================

:: Hide the console window so the user only sees Stremio
if not defined STREMIO_HIDDEN (
    set "STREMIO_HIDDEN=1"
    powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~f0' -WindowStyle Hidden"
    exit /b
)

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
    echo  Stremio not found. Install from https://www.stremio.com/downloads
    pause
    exit /b 1
)

:: Start the CORS proxy (PowerShell, runs in background)
start /min "StremioProxy" powershell -NoProfile -WindowStyle Hidden -Command ^
  "$ErrorActionPreference='SilentlyContinue';" ^
  "$l=[System.Net.HttpListener]::new();" ^
  "$l.Prefixes.Add('http://127.0.0.1:12470/');" ^
  "$l.Start();" ^
  "while($l.IsListening){" ^
  "  $c=$l.GetContext();" ^
  "  $q=$c.Request; $r=$c.Response;" ^
  "  if($q.HttpMethod -eq 'OPTIONS'){" ^
  "    $r.AddHeader('Access-Control-Allow-Origin','*');" ^
  "    $r.AddHeader('Access-Control-Allow-Methods','*');" ^
  "    $r.AddHeader('Access-Control-Allow-Headers','*');" ^
  "    $r.StatusCode=204; $r.Close(); continue" ^
  "  }" ^
  "  $u='http://127.0.0.1:11470'+$q.Url.PathAndQuery;" ^
  "  try{" ^
  "    $w=[System.Net.HttpWebRequest]::Create($u);" ^
  "    $w.Method=$q.HttpMethod; $w.Timeout=120000;" ^
  "    $w.ServicePoint.Expect100Continue=$false;" ^
  "    $p=$w.GetResponse();" ^
  "    $r.AddHeader('Access-Control-Allow-Origin','*');" ^
  "    $r.ContentType=$p.ContentType;" ^
  "    $r.StatusCode=[int]$p.StatusCode;" ^
  "    $s=$p.GetResponseStream();" ^
  "    $buf=New-Object byte[] 65536;" ^
  "    while(($n=$s.Read($buf,0,$buf.Length)) -gt 0){$r.OutputStream.Write($buf,0,$n)}" ^
  "    $s.Close(); $p.Close()" ^
  "  }catch [System.Net.WebException]{" ^
  "    $er=$_.Exception.Response;" ^
  "    if($er){" ^
  "      $r.AddHeader('Access-Control-Allow-Origin','*');" ^
  "      $r.StatusCode=[int]$er.StatusCode;" ^
  "      $es=$er.GetResponseStream();" ^
  "      $buf=New-Object byte[] 65536;" ^
  "      while(($n=$es.Read($buf,0,$buf.Length)) -gt 0){$r.OutputStream.Write($buf,0,$n)}" ^
  "      $es.Close(); $er.Close()" ^
  "    }else{$r.StatusCode=502}" ^
  "  }catch{$r.StatusCode=502}" ^
  "  try{$r.Close()}catch{}" ^
  "}"

:: Wait for proxy to start
timeout /t 1 /nobreak >nul

:: Launch Stremio Shell
"%SHELL_PATH%" --webui-url=https://jeromenicholas07.github.io/stremio-web-netflix/

:: When shell closes, kill the proxy
taskkill /fi "windowtitle eq StremioProxy" /f >nul 2>&1
powershell -NoProfile -Command "Get-Process powershell | Where-Object {$_.MainWindowTitle -eq 'StremioProxy'} | Stop-Process -Force" >nul 2>&1
