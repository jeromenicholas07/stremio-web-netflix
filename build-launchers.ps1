# build-launchers.ps1
# Compiles StremioLauncher.exe + StremioLauncherFULL.exe, creates the addon zip,
# and copies everything into ./build/ (which gets pushed to gh-pages).
#
# Run AFTER `pnpm build`:
#   pnpm build
#   powershell -File build-launchers.ps1

$ErrorActionPreference = "Stop"
Write-Host "=== Building launchers ===" -ForegroundColor Cyan

# Find csc.exe
$csc = Get-ChildItem -Path "C:\Windows\Microsoft.NET\Framework64" -Filter "csc.exe" -Recurse |
       Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) { throw "csc.exe not found" }
Write-Host "Using: $($csc.FullName)"

# Find .NET 4.5+ reference assemblies for System.IO.Compression
$refDir = Get-ChildItem "C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework" -Directory -ErrorAction SilentlyContinue |
          Where-Object { Test-Path (Join-Path $_.FullName 'System.IO.Compression.FileSystem.dll') } |
          Select-Object -Last 1 -ExpandProperty FullName

if (-not $refDir) {
    # Fallback: try the GAC or framework dir directly
    $refDir = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319"
}

# 1. Compile StremioLauncher.exe (base)
Write-Host "`n[1/4] Compiling StremioLauncher.exe..." -ForegroundColor Yellow
& $csc.FullName /target:exe /out:build\StremioLauncher.exe StremioLauncher.cs
if ($LASTEXITCODE -ne 0) { throw "StremioLauncher.exe compilation failed" }
Write-Host "  OK: build\StremioLauncher.exe"

# 2. Compile StremioLauncherFULL.exe (bootstrapper)
Write-Host "`n[2/4] Compiling StremioLauncherFULL.exe..." -ForegroundColor Yellow
& $csc.FullName `
    /target:exe `
    /out:build\StremioLauncherFULL.exe `
    /r:"$refDir\System.IO.Compression.dll" `
    /r:"$refDir\System.IO.Compression.FileSystem.dll" `
    StremioLauncherFULL.cs
if ($LASTEXITCODE -ne 0) { throw "StremioLauncherFULL.exe compilation failed" }
Write-Host "  OK: build\StremioLauncherFULL.exe"

# 3. Zip the addon (source + production node_modules)
Write-Host "`n[3/4] Packaging stremio-adult-addon.zip..." -ForegroundColor Yellow
if (-not (Test-Path "stremio-adult-addon\node_modules")) {
    Write-Host "  Installing addon dependencies..."
    Push-Location stremio-adult-addon
    npm install --omit=dev
    Pop-Location
}

$addonZip = "build\stremio-adult-addon.zip"
if (Test-Path $addonZip) { Remove-Item $addonZip }

# Stage addon files (excluding junk)
$staging = "build\_addon_staging\stremio-adult-addon"
if (Test-Path "build\_addon_staging") { Remove-Item "build\_addon_staging" -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
Copy-Item "stremio-adult-addon\index.js"        "$staging\"
Copy-Item "stremio-adult-addon\package.json"    "$staging\"
Copy-Item "stremio-adult-addon\src"             "$staging\" -Recurse
Copy-Item "stremio-adult-addon\node_modules"    "$staging\" -Recurse

Compress-Archive -Path "build\_addon_staging\*" -DestinationPath $addonZip -CompressionLevel Optimal
Remove-Item "build\_addon_staging" -Recurse -Force
$sz = [math]::Round((Get-Item $addonZip).Length / 1MB, 1)
Write-Host "  OK: $addonZip ($sz MB)"

# 4. Summary
Write-Host "`n[4/4] Build complete!" -ForegroundColor Green
Write-Host "Files in build/:"
Get-ChildItem build\*.exe, build\*.zip | ForEach-Object {
    $s = [math]::Round($_.Length / 1KB, 1)
    Write-Host "  $($_.Name) ($s KB)"
}
Write-Host "`nNext steps:"
Write-Host "  1. Push the build/ folder to gh-pages"
Write-Host "  2. Users download StremioLauncherFULL.exe from GH Pages"
Write-Host "  3. First run downloads Prowlarr + Node automatically"
