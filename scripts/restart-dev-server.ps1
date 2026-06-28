param(
    [int]$DebounceMs = 1200
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ServerProcess = $null
$LastRestart = Get-Date "2000-01-01"
$PnpmCommandInfo = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
if ($PnpmCommandInfo) {
    $PnpmCommand = $PnpmCommandInfo.Source
} else {
    $PnpmCommand = (Get-Command "pnpm" -ErrorAction Stop).Source
}

$IgnoredPathPattern = "\\(node_modules|\.git|build|dist|coverage|\.cache)\\"
$WatchedExtensions = @(".js", ".jsx", ".ts", ".tsx", ".less", ".css", ".json", ".html")

function Stop-ProcessTree {
    param([int]$ProcessId)

    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId $child.ProcessId
    }

    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-DevServer {
    if ($script:ServerProcess -and -not $script:ServerProcess.HasExited) {
        Write-Host "[watch] Stopping dev server..."
        Stop-ProcessTree -ProcessId $script:ServerProcess.Id
        $script:ServerProcess = $null
    }
}

function Start-DevServer {
    Write-Host "[watch] Starting dev server at http://localhost:8080/"
    $script:ServerProcess = Start-Process `
        -FilePath $PnpmCommand `
        -ArgumentList "start" `
        -WorkingDirectory $Root `
        -NoNewWindow `
        -PassThru
}

function Restart-DevServer {
    param([string]$Reason)

    $now = Get-Date
    if (($now - $script:LastRestart).TotalMilliseconds -lt $DebounceMs) {
        return
    }

    $script:LastRestart = $now
    Write-Host "[watch] Change detected: $Reason"
    Stop-DevServer
    Start-DevServer
}

function Should-Restart {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $false
    }

    if ($Path -match $IgnoredPathPattern) {
        return $false
    }

    $extension = [System.IO.Path]::GetExtension($Path)
    return $WatchedExtensions -contains $extension
}

$watchers = @()
$pathsToWatch = @(
    @{ Path = Join-Path $Root "src"; Recursive = $true },
    @{ Path = Join-Path $Root "tests"; Recursive = $true },
    @{ Path = Join-Path $Root "scripts"; Recursive = $true },
    @{ Path = $Root; Recursive = $false }
)

foreach ($entry in $pathsToWatch) {
    if (-not (Test-Path $entry.Path)) {
        continue
    }

    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = $entry.Path
    $watcher.IncludeSubdirectories = $entry.Recursive
    $watcher.EnableRaisingEvents = $true

    $action = {
        $changedPath = $Event.SourceEventArgs.FullPath
        if (Should-Restart -Path $changedPath) {
            Restart-DevServer -Reason $changedPath
        }
    }

    Register-ObjectEvent $watcher Changed -Action $action | Out-Null
    Register-ObjectEvent $watcher Created -Action $action | Out-Null
    Register-ObjectEvent $watcher Deleted -Action $action | Out-Null
    Register-ObjectEvent $watcher Renamed -Action $action | Out-Null
    $watchers += $watcher
}

try {
    Start-DevServer
    Write-Host "[watch] Watching for changes. Press Ctrl+C to stop."
    while ($true) {
        Start-Sleep -Seconds 1
        if ($ServerProcess -and $ServerProcess.HasExited) {
            Write-Host "[watch] Dev server exited with code $($ServerProcess.ExitCode). Waiting for next file change..."
            $ServerProcess = $null
        }
    }
} finally {
    Stop-DevServer
    foreach ($watcher in $watchers) {
        $watcher.EnableRaisingEvents = $false
        $watcher.Dispose()
    }
}
