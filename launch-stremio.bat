@echo off
:: ============================================================
::  Stremio Custom UI Launcher
::  Starts audio extraction sidecar + CORS proxy + Stremio Shell.
::  Single file — no Node.js, no Python, no extra software.
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

:: Derive FFmpeg path from Stremio install directory
for %%I in ("%SHELL_PATH%") do set "STREMIO_DIR=%%~dpI"
set "FFMPEG_PATH=%STREMIO_DIR%ffmpeg.exe"
if not exist "%FFMPEG_PATH%" (
    :: Try system PATH as fallback
    where ffmpeg >nul 2>&1
    if not errorlevel 1 (
        for /f "delims=" %%F in ('where ffmpeg 2^>nul') do set "FFMPEG_PATH=%%F"
    ) else (
        set "FFMPEG_PATH="
    )
)

:: Start the audio extraction sidecar (PowerShell, port 12471)
:: Provides fast FFmpeg-based audio extraction for WhisperSync.
:: Falls back to HLS extraction if FFmpeg is not available.
if defined FFMPEG_PATH (
    start /min "StremioAudioExtract" powershell -NoProfile -WindowStyle Hidden -Command ^
      "$ffmpeg='%FFMPEG_PATH%';" ^
      "$l=[System.Net.HttpListener]::new();" ^
      "$l.Prefixes.Add('http://127.0.0.1:12471/');" ^
      "$l.Start();" ^
      "while($l.IsListening){" ^
      "  $c=$l.GetContext();" ^
      "  $q=$c.Request; $r=$c.Response;" ^
      "  $r.AddHeader('Access-Control-Allow-Origin','*');" ^
      "  $r.AddHeader('Access-Control-Allow-Methods','GET, OPTIONS');" ^
      "  $r.AddHeader('Access-Control-Allow-Headers','*');" ^
      "  if($q.HttpMethod -eq 'OPTIONS'){$r.StatusCode=204;$r.Close();continue}" ^
      "  $path=$q.Url.AbsolutePath;" ^
      "  if($path -eq '/health'){" ^
      "    $r.ContentType='application/json';" ^
      "    $b=[Text.Encoding]::UTF8.GetBytes('{\"status\":\"ok\",\"ffmpeg\":\"'+$ffmpeg+'\"}');" ^
      "    $r.OutputStream.Write($b,0,$b.Length);$r.Close();continue" ^
      "  }" ^
      "  if($path -ne '/audio-extract'){$r.StatusCode=404;$r.Close();continue}" ^
      "  $qs=$q.QueryString;" ^
      "  $mediaURL=$qs['mediaURL'];" ^
      "  $start=$qs['start'];if(!$start){$start='0'}" ^
      "  $dur=$qs['duration'];if(!$dur){$dur='5'}" ^
      "  if(!$mediaURL){" ^
      "    $r.StatusCode=400;" ^
      "    $b=[Text.Encoding]::UTF8.GetBytes('Missing mediaURL');" ^
      "    $r.OutputStream.Write($b,0,$b.Length);$r.Close();continue" ^
      "  }" ^
      "  $fargs=@('-ss',$start,'-i',$mediaURL,'-t',$dur,'-vn','-ac','1','-ar','16000','-f','f32le','-y','pipe:1');" ^
      "  $hdrs=$qs['headers'];" ^
      "  if($hdrs){$fargs=@('-headers',\"$hdrs`r`n\")+$fargs}" ^
      "  $psi=New-Object System.Diagnostics.ProcessStartInfo;" ^
      "  $psi.FileName=$ffmpeg;" ^
      "  $psi.Arguments=($fargs|ForEach-Object{if($_ -match '\s'){'\"'+$_+'\"'}else{$_}}) -join ' ';" ^
      "  $psi.UseShellExecute=$false;" ^
      "  $psi.RedirectStandardOutput=$true;" ^
      "  $psi.RedirectStandardError=$true;" ^
      "  $psi.CreateNoWindow=$true;" ^
      "  try{" ^
      "    $p=[System.Diagnostics.Process]::Start($psi);" ^
      "    $errTask=$p.StandardError.ReadToEndAsync();" ^
      "    $ms=New-Object System.IO.MemoryStream;" ^
      "    $p.StandardOutput.BaseStream.CopyTo($ms);" ^
      "    $stderr=$errTask.Result;" ^
      "    $done=$p.WaitForExit(30000);" ^
      "    if(!$done){$p.Kill();$r.StatusCode=504;$b=[Text.Encoding]::UTF8.GetBytes('Timeout');$r.OutputStream.Write($b,0,$b.Length);$r.Close();continue}" ^
      "    if($p.ExitCode -ne 0){" ^
      "      $r.StatusCode=500;" ^
      "      $msg='FFmpeg error (code '+$p.ExitCode+'): '+$stderr.Substring([Math]::Max(0,$stderr.Length-200));" ^
      "      $b=[Text.Encoding]::UTF8.GetBytes($msg);$r.OutputStream.Write($b,0,$b.Length);$r.Close();continue" ^
      "    }" ^
      "    $bytes=$ms.ToArray();" ^
      "    $r.ContentType='application/octet-stream';" ^
      "    $r.ContentLength64=$bytes.Length;" ^
      "    $r.OutputStream.Write($bytes,0,$bytes.Length);" ^
      "    $r.Close()" ^
      "  }catch{" ^
      "    $r.StatusCode=500;" ^
      "    $b=[Text.Encoding]::UTF8.GetBytes('Error: '+$_.Exception.Message);" ^
      "    try{$r.OutputStream.Write($b,0,$b.Length)}catch{};" ^
      "    try{$r.Close()}catch{}" ^
      "  }" ^
      "}"
    echo  Audio extract server started on port 12471
) else (
    echo  FFmpeg not found — audio extraction will use HLS fallback
)

:: Start the CORS proxy (PowerShell, runs in background)
:: Forwards all requests to streaming server on 11470, adding CORS headers.
:: Handles POST bodies, Content-Type, and error responses.
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
  "    if($q.ContentType){$w.ContentType=$q.ContentType}" ^
  "    if($q.HttpMethod -ne 'GET' -and $q.HttpMethod -ne 'HEAD' -and $q.ContentLength64 -gt 0){" ^
  "      $rs=$w.GetRequestStream();" ^
  "      $q.InputStream.CopyTo($rs);" ^
  "      $rs.Close()" ^
  "    }" ^
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

:: When shell closes, kill the proxy and audio extract server
taskkill /fi "windowtitle eq StremioProxy" /f >nul 2>&1
taskkill /fi "windowtitle eq StremioAudioExtract" /f >nul 2>&1
powershell -NoProfile -Command "Get-Process powershell | Where-Object {$_.MainWindowTitle -eq 'StremioProxy'} | Stop-Process -Force" >nul 2>&1
