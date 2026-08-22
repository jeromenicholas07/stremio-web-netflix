// StremioLauncherFULL — lightweight bootstrapper + launcher.
//
// A small exe (~30 KB) that on first run downloads Prowlarr, portable Node,
// and the incognito addon from known URLs, extracts them to
// %LOCALAPPDATA%\StremioLauncherFULL\<version>\, then starts all services.
// Subsequent runs skip downloads and go straight to launching.
//
// Deployable via GitHub Pages alongside the web UI. No CI required — compile
// locally with:
//   csc.exe /target:winexe /out:StremioLauncherFULL.exe ^
//           /r:System.IO.Compression.dll ^
//           /r:System.IO.Compression.FileSystem.dll ^
//           StremioLauncherFULL.cs
//
// Ports (all loopback):
//   7000  — adult addon          9696  — Prowlarr       8191  — FlareSolverr
//   11470 — streaming server     12470 — CORS proxy     12471 — audio extract
using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

class StremioLauncherFULL
{
    // ── Version & download URLs ──────────────────────────────
    // Bump PAYLOAD_VERSION whenever you update these URLs so users re-download.
    // NOTE: Prowlarr config (indexers, API keys, app profiles) lives in the
    // SHARED dir, NOT under this version. Bumping the version does NOT cost
    // the user their Prowlarr setup — see `sharedProwlarrData` below.
    const string PAYLOAD_VERSION = "1.6.1";

    // The launcher checks https://.../StremioLauncherFULL.version on every
    // start. If the remote string differs from this constant, it self-replaces
    // with the freshly-downloaded exe and relaunches. Bump this whenever you
    // ship a new StremioLauncherFULL.exe — and update the same value in the
    // version file deployed to gh-pages (the deploy script handles this).
    const string LAUNCHER_VERSION = "2026-08-08-managed-app-update";

    // Bump BASE_LAUNCHER_VERSION whenever StremioLauncher.exe changes. We
    // write this string into <rootDir>\StremioLauncher.version on a fresh
    // install AND on every successful update; on every start, if the value
    // on disk differs we re-download just the base launcher. This is the
    // same pattern as ADDON_VERSION below — small targeted update, no
    // full re-install.
    const string BASE_LAUNCHER_VERSION = "2026-06-30-launcher-probe";

    // Bump ADDON_VERSION on every addon code change. The launcher checks
    // <rootDir>\stremio-adult-addon\.addon-version against this on every
    // start; on mismatch it re-downloads/extracts JUST the addon zip
    // (~5MB, a few seconds) instead of forcing a full re-download via
    // PAYLOAD_VERSION bump (~200MB). This is what makes "deploy a new
    // addon" actually take effect on existing installs — the prior
    // launcher only extracted the addon on first run, so users who'd
    // already initialised stayed on stale buggy code forever.
    const string ADDON_VERSION = "2026-05-08-hybrid-search";

    // Portable Node.js — just need node.exe for the addon
    const string NODE_URL = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip";
    // Prowlarr (portable, .NET-included build)
    const string PROWLARR_URL = "https://github.com/Prowlarr/Prowlarr/releases/download/v1.28.2.4885/Prowlarr.master.1.28.2.4885.windows-core-x64.zip";
    // FlareSolverr — Cloudflare/DDoS-GUARD bypass proxy. Prowlarr uses this via
    // its Indexer Proxy setting (Settings → Indexers → Indexer Proxies →
    // add FlareSolverr, host http://127.0.0.1:8191/) so indexers behind CF
    // challenges (most adult indexers do) work from a cold start.
    const string FLARESOLVERR_URL = "https://github.com/FlareSolverr/FlareSolverr/releases/download/v3.3.21/flaresolverr_windows_x64.zip";
    // Addon zip hosted on GitHub Pages alongside the web UI
    const string ADDON_URL = "https://jeromenicholas07.github.io/stremio-web-netflix/stremio-adult-addon.zip";
    // Base launcher (also on Pages)
    const string BASE_LAUNCHER_URL = "https://jeromenicholas07.github.io/stremio-web-netflix/StremioLauncher.exe";
    // Self-update endpoints
    const string LAUNCHER_VERSION_URL = "https://jeromenicholas07.github.io/stremio-web-netflix/StremioLauncherFULL.version";
    const string LAUNCHER_EXE_URL = "https://jeromenicholas07.github.io/stremio-web-netflix/StremioLauncherFULL.exe";

    const int PROWLARR_PORT = 9696;
    const int ADDON_PORT = 7000;
    const int FLARESOLVERR_PORT = 8191;

    // Authenticode subject on every official Stremio binary. We only execute a
    // staged installer out of %TEMP% if it's signed by this publisher — see
    // CheckStremioAppUpdate.
    const string STREMIO_SIGNER = "Smart Code OOD";
    // Stremio's installer is ~73MB and unpacks a 115MB libmpv; five minutes is
    // slow-disk headroom, not an expected duration.
    const int STREMIO_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

    static Process _prowlarrProc;
    static Process _addonProc;
    static Process _flaresolverrProc;
    static Process _baseProc;

    // Hold the console open on exit so the user can read any output/errors.
    // Double-clicking the exe otherwise closes the window the instant Main
    // returns, which is how most users launch it.
    static int ExitWithPause(int code)
    {
        Console.WriteLine();
        Console.WriteLine("(press any key to close this window)");
        try { Console.ReadKey(true); } catch { /* no console attached */ }
        return code;
    }

    // ── Debug console (winexe by default — no terminal popup) ──
    // Compiled with /target:winexe so the bootstrapper runs without a
    // console window. If the "Debug" toggle is on (flag file present), we
    // attach a console at startup so the user can see service logs.
    [DllImport("kernel32.dll")]
    static extern bool AllocConsole();

    static string DebugFlagPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "StremioLauncherFULL", "debug.flag");
    }

    static void TryAttachDebugConsole()
    {
        try
        {
            if (!File.Exists(DebugFlagPath())) return;
            if (!AllocConsole()) return;
            var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
            Console.SetOut(stdout);
            var stderr = new StreamWriter(Console.OpenStandardError()) { AutoFlush = true };
            Console.SetError(stderr);
            Console.WriteLine("[DEBUG] Console attached (debug flag is set)");
        }
        catch { /* never block startup on console init */ }
    }

    static int Main()
    {
        TryAttachDebugConsole();

        // TLS 1.2 required for GitHub / nodejs.org downloads
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

        // Check for self-update FIRST. If a new build is available we
        // download it, swap in over our own exe, and relaunch — by the time
        // we get past this call we're either on the current version or
        // running with the latest one. Failures are non-fatal and silent.
        if (CheckSelfUpdate())
        {
            // Self-update spawned a swap-and-relaunch script and we should exit
            // immediately so the script can replace our exe.
            return 0;
        }

        // Install any Stremio release the shell staged into %TEMP% on an
        // earlier run, then (re)claim the Start Menu shortcuts. Order matters:
        // the installer reclaims "Stremio.lnk" for the stock shell, so the
        // shortcut pass has to come after it to undo that in the same launch.
        CheckStremioAppUpdate();
        EnsureShortcuts();

        string appRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "StremioLauncherFULL");
        string rootDir = Path.Combine(appRoot, PAYLOAD_VERSION);
        // Shared state that must survive version bumps. Prowlarr's DB holds
        // the user's configured indexers, API keys, and app-sync profiles —
        // losing it on every upgrade means re-adding ~20 indexers by hand.
        string sharedDir = Path.Combine(appRoot, "shared");
        string sharedProwlarrData = Path.Combine(sharedDir, "prowlarr-data");
        string marker = Path.Combine(rootDir, ".ready");

        Console.WriteLine("=== StremioLauncherFULL " + LAUNCHER_VERSION + " (payload " + PAYLOAD_VERSION + ") ===");
        Console.WriteLine("Install root: " + rootDir);
        Console.WriteLine("Shared data:  " + sharedDir);
        Console.WriteLine();

        // Put ourselves + all children into a Win32 Job Object with
        // KILL_ON_JOB_CLOSE so that when THIS process dies — by any means,
        // including the user clicking the X on the console window or
        // taskkill /F — the kernel guarantees every child dies too. This
        // replaces the fragile ProcessExit / CancelKeyPress hooks which
        // silently miss those shutdown paths.
        InitJobObject();

        if (!File.Exists(marker))
        {
            Console.WriteLine("First run — downloading bundled components...");
            Console.WriteLine("(this only happens once, future launches will be instant)");
            Console.WriteLine();
            try
            {
                Directory.CreateDirectory(rootDir);
                DownloadAndExtract("Portable Node.js", NODE_URL, rootDir, "node");
                DownloadAndExtract("Prowlarr", PROWLARR_URL, rootDir, "prowlarr");
                DownloadAndExtract("FlareSolverr", FLARESOLVERR_URL, rootDir, "flaresolverr");
                DownloadAndExtract("Incognito Addon", ADDON_URL, rootDir, "stremio-adult-addon");
                DownloadFile("StremioLauncher.exe", BASE_LAUNCHER_URL, Path.Combine(rootDir, "StremioLauncher.exe"));

                // Mark the addon as current-version so we don't re-extract
                // it on the very next start.
                WriteAddonVersionMarker(rootDir);

                File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
                Console.WriteLine();
                Console.WriteLine("[OK] All components downloaded and extracted");
                Console.WriteLine();
            }
            catch (Exception ex)
            {
                Console.WriteLine();
                Console.WriteLine("[FATAL] Download/extraction failed: " + ex.Message);
                Console.WriteLine();
                Console.WriteLine("Check your internet connection and try again.");
                Console.WriteLine("To force re-download, delete: " + rootDir);
                return ExitWithPause(1);
            }
        }

        // Resolve extracted paths.
        // Node zip extracts to node-v20.18.1-win-x64\ — we need to find node.exe
        string nodeExe = FindFile(rootDir, "node", "node.exe");
        // Prowlarr zip may extract to Prowlarr\ subfolder or flat
        string prowlarrExe = FindFile(rootDir, "prowlarr", "Prowlarr.exe");
        string prowlarrDataDir = sharedProwlarrData;
        // FlareSolverr zip extracts to flaresolverr\flaresolverr.exe
        string flaresolverrExe = FindFile(rootDir, "flaresolverr", "flaresolverr.exe");
        string addonEntry = FindFile(rootDir, "stremio-adult-addon", "index.js");
        string baseExe = Path.Combine(rootDir, "StremioLauncher.exe");

        // Free ports FIRST so any Prowlarr from an older launcher releases
        // its DB file before migration tries to copy it. The job object
        // guarantees OUR children die with us, but older pre-job-object
        // launchers (1.5.2 and earlier) could leak orphans. Same story for
        // FlareSolverr — it spawns a persistent Chromium that keeps :8191
        // held long after the parent dies on a crash.
        KillByPort(PROWLARR_PORT);
        KillByPort(ADDON_PORT);
        KillByPort(FLARESOLVERR_PORT);

        // Auto-update the base launcher if its version constant has moved.
        // KillByPort already freed the audio/CORS ports above so any running
        // copy from a previous start has released its file lock.
        EnsureBaseLauncherUpToDate(rootDir);

        // Auto-update just the addon if the deployed version differs from
        // what's on disk. Runs AFTER KillByPort so the addon process can't
        // hold a file lock on its own files mid-replace. This is what makes
        // "deploy a new addon" actually take effect on existing installs;
        // without it, a pre-existing .ready marker means the addon is only
        // ever extracted once.
        EnsureAddonUpToDate(rootDir);

        // Re-resolve the addon entry path now in case we just re-extracted
        // (extraction may produce a slightly different layout depending on
        // how the zip is structured).
        addonEntry = FindFile(rootDir, "stremio-adult-addon", "index.js");

        // Prowlarr data: ALWAYS the shared dir, regardless of PAYLOAD_VERSION.
        // If this is a first install on a machine that previously ran an
        // older version, migrate that version's DB over so the user keeps
        // all their indexers and settings. Runs after KillByPort so the
        // source DB isn't locked.
        Directory.CreateDirectory(sharedProwlarrData);
        MigrateProwlarrDataIfNeeded(appRoot, sharedProwlarrData);

        Console.CancelKeyPress += delegate { Shutdown(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };

        // Background-start every sidecar and launch Stremio immediately. The
        // per-service WaitForPort runs in its own thread purely for logging
        // (so the user sees "Prowlarr ready" when it actually comes up). The
        // addon registers itself with Stremio asynchronously, and Prowlarr's
        // initial indexer health checks only matter once the user actually
        // searches — both can happen comfortably after Stremio is on screen.
        if (flaresolverrExe != null)
        {
            StartFlareSolverr(flaresolverrExe);
            WaitForPortAsync(FLARESOLVERR_PORT, "FlareSolverr", 40);
        }
        else
        {
            Console.WriteLine("[WARN] flaresolverr.exe not found in " + Path.Combine(rootDir, "flaresolverr"));
        }

        if (prowlarrExe != null)
        {
            StartProwlarr(prowlarrExe, prowlarrDataDir);
            WaitForPortAsync(PROWLARR_PORT, "Prowlarr", 60);
        }
        else
        {
            Console.WriteLine("[WARN] Prowlarr.exe not found in " + Path.Combine(rootDir, "prowlarr"));
        }

        if (addonEntry != null && nodeExe != null)
        {
            StartAddon(nodeExe, addonEntry, prowlarrDataDir);
            WaitForPortAsync(ADDON_PORT, "Incognito addon", 20);
        }
        else
        {
            if (nodeExe == null) Console.WriteLine("[WARN] node.exe not found in " + Path.Combine(rootDir, "node"));
            if (addonEntry == null) Console.WriteLine("[WARN] index.js not found in " + Path.Combine(rootDir, "stremio-adult-addon"));
        }

        // Start base launcher
        if (!File.Exists(baseExe))
        {
            Console.WriteLine("[FATAL] StremioLauncher.exe missing from " + rootDir);
            Shutdown();
            return ExitWithPause(1);
        }

        try
        {
            var psi = new ProcessStartInfo(baseExe)
            {
                UseShellExecute = false,
                CreateNoWindow = false,
                WorkingDirectory = rootDir
            };
            _baseProc = Process.Start(psi);
            AddToJob(_baseProc);
            Console.WriteLine("[OK] Launched StremioLauncher (PID " + _baseProc.Id + ")");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FATAL] Failed to start base launcher: " + ex.Message);
            Shutdown();
            return ExitWithPause(1);
        }

        _baseProc.WaitForExit();
        Console.WriteLine("Base launcher exited with code " + _baseProc.ExitCode);
        Shutdown();
        // Always pause so users see output when Stremio quits — otherwise
        // double-clickers never get to read why things ended.
        return ExitWithPause(_baseProc.ExitCode);
    }

    // ── Download helpers ─────────────────────────────────────

    static void DownloadFile(string label, string url, string destPath)
    {
        Console.Write("  Downloading " + label + "... ");
        using (var wc = new WebClient())
        {
            wc.DownloadFile(url, destPath);
        }
        long size = new FileInfo(destPath).Length;
        Console.WriteLine("done (" + (size / (1024 * 1024)) + " MB)");
    }

    static void DownloadAndExtract(string label, string url, string rootDir, string subDir)
    {
        string destDir = Path.Combine(rootDir, subDir);
        Directory.CreateDirectory(destDir);

        string zipPath = Path.Combine(rootDir, subDir + ".zip");
        Console.Write("  Downloading " + label + "... ");
        using (var wc = new WebClient())
        {
            wc.DownloadFile(url, zipPath);
        }
        long zipSize = new FileInfo(zipPath).Length;
        Console.WriteLine("done (" + (zipSize / (1024 * 1024)) + " MB)");

        Console.Write("  Extracting " + label + "... ");
        ZipFile.ExtractToDirectory(zipPath, destDir);
        Console.WriteLine("done");

        // Clean up the zip
        try { File.Delete(zipPath); } catch { }
    }

    /// <summary>
    /// Re-download and extract just the addon zip if the on-disk version
    /// marker doesn't match ADDON_VERSION. Idempotent — does nothing on
    /// matching version. Failures are logged but non-fatal: the user keeps
    /// running with whatever they had.
    ///
    /// Uses entry-by-entry overwrite extraction so that an antivirus or a
    /// stuck Node child holding a single file doesn't poison the whole
    /// update — files we CAN replace get replaced; ones we can't are
    /// logged but don't abort the rest. The previous wipe-then-extract
    /// approach failed entirely on locked files (extract throws on first
    /// pre-existing entry), leaving the user on a half-updated addon.
    /// </summary>
    static void EnsureAddonUpToDate(string rootDir)
    {
        string addonDir = Path.Combine(rootDir, "stremio-adult-addon");
        string versionFile = Path.Combine(addonDir, ".addon-version");
        string current = "";
        try
        {
            if (File.Exists(versionFile))
            {
                current = File.ReadAllText(versionFile).Trim();
            }
        }
        catch { /* unreadable → treat as outdated */ }

        if (current == ADDON_VERSION)
        {
            Console.WriteLine("[update] addon up to date (" + ADDON_VERSION + ")");
            return;
        }

        Console.WriteLine("[update] addon version mismatch — disk='" + (current.Length > 0 ? current : "(none)") +
            "', wanted='" + ADDON_VERSION + "'");
        Console.WriteLine("[update] downloading fresh addon zip...");

        string zipPath = Path.Combine(rootDir, "stremio-adult-addon.update.zip");
        try
        {
            using (var wc = new WebClient())
            {
                // Bypass any stale CDN cache.
                wc.Headers["Cache-Control"] = "no-cache";
                wc.Headers["Pragma"] = "no-cache";
                wc.DownloadFile(ADDON_URL + "?v=" + Uri.EscapeDataString(ADDON_VERSION), zipPath);
            }
            long size = new FileInfo(zipPath).Length;
            Console.WriteLine("[update] downloaded (" + (size / 1024) + " KB)");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[update] WARN: addon download failed (" + ex.Message + "); keeping existing addon");
            try { File.Delete(zipPath); } catch { }
            return;
        }

        Console.Write("[update] extracting (overwrite mode)... ");
        int extracted = 0, skipped = 0;
        try
        {
            Directory.CreateDirectory(addonDir);
            using (var archive = ZipFile.OpenRead(zipPath))
            {
                foreach (var entry in archive.Entries)
                {
                    string destPath = Path.Combine(rootDir, entry.FullName);

                    // Directory entry
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destPath);
                        continue;
                    }

                    string destParent = Path.GetDirectoryName(destPath);
                    if (!string.IsNullOrEmpty(destParent))
                    {
                        Directory.CreateDirectory(destParent);
                    }

                    try
                    {
                        entry.ExtractToFile(destPath, true);
                        extracted++;
                    }
                    catch (Exception ex)
                    {
                        // File locked by AV / running process / read-only.
                        // Skip it and keep going — partial update beats no
                        // update, and most affected files are non-essential
                        // (e.g. a stray .bin shim).
                        skipped++;
                        if (skipped <= 3)
                        {
                            Console.WriteLine();
                            Console.WriteLine("[update]   skip " + entry.FullName + ": " + ex.Message);
                        }
                    }
                }
            }
            Console.WriteLine("done (" + extracted + " files" + (skipped > 0 ? ", " + skipped + " skipped" : "") + ")");
            WriteAddonVersionMarker(rootDir);
            Console.WriteLine("[update] addon updated to " + ADDON_VERSION);
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("[update] WARN: extract failed (" + ex.Message + "); keeping existing addon");
        }
        finally
        {
            try { File.Delete(zipPath); } catch { }
        }
    }

    // ── Self-update (replace our own exe) ────────────────────
    //
    // Strategy: read the remote version string, compare to our compiled-in
    // LAUNCHER_VERSION, and if they differ, download the new exe to a
    // sibling temp file, write a tiny .cmd script that waits for our PID
    // to exit then replaces our exe and relaunches, then exit. The script
    // self-deletes when done.
    //
    // Failures are non-fatal: we just keep running on the current version.
    // Returns true if a self-update is in progress and the caller should
    // exit immediately. Returns false in every other case (no update,
    // already current, or error during update — keep running).
    static bool CheckSelfUpdate()
    {
        try
        {
            string currentExe = null;
            try { currentExe = Process.GetCurrentProcess().MainModule.FileName; } catch { /* */ }
            if (string.IsNullOrEmpty(currentExe) || !File.Exists(currentExe)) return false;
            // Don't try to self-update if we're running from a non-writable
            // location (e.g. mounted ISO) — fall through to normal start.
            try
            {
                using (var fs = File.OpenWrite(currentExe + ".update.test"))
                    fs.WriteByte(0);
                File.Delete(currentExe + ".update.test");
            }
            catch
            {
                Console.WriteLine("[update] self-update skipped — install location is not writable");
                return false;
            }

            string remote = HttpGetText(LAUNCHER_VERSION_URL, 5000);
            if (string.IsNullOrWhiteSpace(remote)) return false;
            remote = remote.Trim();
            if (remote == LAUNCHER_VERSION)
            {
                // Up to date — silent.
                return false;
            }

            Console.WriteLine("[update] StremioLauncherFULL update available: "
                + LAUNCHER_VERSION + " -> " + remote);

            string tempExe = currentExe + ".update";
            string script = currentExe + ".update.cmd";
            try { File.Delete(tempExe); } catch { }
            try { File.Delete(script); } catch { }

            Console.Write("[update] downloading new exe... ");
            using (var wc = new WebClient())
            {
                wc.Headers["Cache-Control"] = "no-cache";
                wc.Headers["Pragma"] = "no-cache";
                wc.DownloadFile(LAUNCHER_EXE_URL + "?v=" + Uri.EscapeDataString(remote), tempExe);
            }
            long size = new FileInfo(tempExe).Length;
            // Sanity check — a real launcher exe is ~25KB. Anything under 5KB is
            // almost certainly an HTML 404 page that downloaded successfully.
            if (size < 5000)
            {
                Console.WriteLine("FAILED (only " + size + " bytes — keeping current version)");
                try { File.Delete(tempExe); } catch { }
                return false;
            }
            Console.WriteLine("done (" + (size / 1024) + " KB)");

            // Build the swap script. Uses cmd's built-in tools only — no
            // PowerShell dependency. The /b flag on the start command means
            // "no new console window for the swap script itself", and we
            // use start "" (with empty title) when relaunching so the new
            // exe gets its own console.
            int pid = Process.GetCurrentProcess().Id;
            string scriptText =
                "@echo off\r\n"
                + "rem Wait for parent (PID " + pid + ") to exit, then swap and relaunch.\r\n"
                + ":wait\r\n"
                + "tasklist /FI \"PID eq " + pid + "\" 2>nul | find \"" + pid + "\" >nul\r\n"
                + "if not errorlevel 1 (\r\n"
                + "  ping -n 2 127.0.0.1 >nul\r\n"
                + "  goto wait\r\n"
                + ")\r\n"
                + "rem Replace exe; retry a few times in case AV is scanning.\r\n"
                + "set TRIES=0\r\n"
                + ":swap\r\n"
                + "move /Y \"" + tempExe + "\" \"" + currentExe + "\" >nul 2>&1\r\n"
                + "if errorlevel 1 (\r\n"
                + "  set /A TRIES=%TRIES%+1\r\n"
                + "  if %TRIES% LSS 10 (\r\n"
                + "    ping -n 2 127.0.0.1 >nul\r\n"
                + "    goto swap\r\n"
                + "  )\r\n"
                + "  echo [update] FAILED to replace " + currentExe + "\r\n"
                + "  pause\r\n"
                + "  goto cleanup\r\n"
                + ")\r\n"
                + "start \"\" \"" + currentExe + "\"\r\n"
                + ":cleanup\r\n"
                + "del \"%~f0\"\r\n";
            File.WriteAllText(script, scriptText, Encoding.ASCII);

            var psi = new ProcessStartInfo("cmd.exe", "/c \"" + script + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(currentExe),
            };
            Process.Start(psi);
            Console.WriteLine("[update] relaunching with new version...");
            // Give the helper a moment to actually start its wait loop.
            Thread.Sleep(300);
            return true;
        }
        catch (Exception ex)
        {
            Console.WriteLine("[update] self-update check failed: " + ex.Message);
            return false;
        }
    }

    static string HttpGetText(string url, int timeoutMs)
    {
        try
        {
            var wr = (HttpWebRequest)WebRequest.Create(url);
            wr.Timeout = timeoutMs;
            wr.ReadWriteTimeout = timeoutMs;
            wr.Headers["Cache-Control"] = "no-cache";
            wr.Headers["Pragma"] = "no-cache";
            using (var resp = (HttpWebResponse)wr.GetResponse())
            using (var s = resp.GetResponseStream())
            using (var sr = new StreamReader(s, Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }
        catch { return null; }
    }

    /// <summary>
    /// Re-download just StremioLauncher.exe if the version constant has
    /// moved past whatever's noted on disk. The marker is written next to
    /// the exe so it survives PAYLOAD_VERSION roll-forwards — but on a
    /// fresh PAYLOAD_VERSION, we won't find a marker AND the exe will
    /// have just been downloaded by first-run init, so we just write
    /// the marker without redownloading.
    /// </summary>
    static void EnsureBaseLauncherUpToDate(string rootDir)
    {
        string baseExe = Path.Combine(rootDir, "StremioLauncher.exe");
        string versionFile = Path.Combine(rootDir, "StremioLauncher.version");
        string current = "";
        try { if (File.Exists(versionFile)) current = File.ReadAllText(versionFile).Trim(); }
        catch { /* unreadable → treat as outdated */ }

        if (current == BASE_LAUNCHER_VERSION)
        {
            return; // up to date — silent
        }

        // Fresh install: exe was just downloaded by first-run init. We just
        // need to record the version. (No exe → nothing to update against.)
        if (!File.Exists(baseExe))
        {
            try { File.WriteAllText(versionFile, BASE_LAUNCHER_VERSION); } catch { }
            return;
        }

        Console.WriteLine("[update] base launcher version mismatch — disk='"
            + (current.Length > 0 ? current : "(none)") + "', wanted='" + BASE_LAUNCHER_VERSION + "'");
        Console.Write("[update] downloading new StremioLauncher.exe... ");
        try
        {
            string tempExe = baseExe + ".new";
            using (var wc = new WebClient())
            {
                wc.Headers["Cache-Control"] = "no-cache";
                wc.Headers["Pragma"] = "no-cache";
                wc.DownloadFile(BASE_LAUNCHER_URL + "?v=" + Uri.EscapeDataString(BASE_LAUNCHER_VERSION), tempExe);
            }
            long size = new FileInfo(tempExe).Length;
            if (size < 5000)
            {
                Console.WriteLine("FAILED (only " + size + " bytes — keeping existing exe)");
                try { File.Delete(tempExe); } catch { }
                return;
            }
            // Replace the exe. KillByPort already freed any audio/CORS
            // listeners, so the previous base launcher (if still running
            // for some reason) shouldn't have a lock.
            File.Copy(tempExe, baseExe, true);
            try { File.Delete(tempExe); } catch { }
            File.WriteAllText(versionFile, BASE_LAUNCHER_VERSION);
            Console.WriteLine("done (" + (size / 1024) + " KB)");
        }
        catch (Exception ex)
        {
            Console.WriteLine("FAILED (" + ex.Message + " — keeping existing exe)");
        }
    }

    // ── Stremio app update + shortcut ownership ──────────────
    //
    // The stock Stremio shell auto-downloads its next installer into %TEMP%
    // (StremioSetup-v<x.y.z>_x64.exe) and shows the in-app "Install now"
    // banner. Clicking that banner runs the installer interactively, which
    // does two annoying things to this setup:
    //
    //   1. It recreates the Start Menu shortcut pointing at the STOCK
    //      stremio-shell-ng.exe, so the next launch skips this launcher
    //      entirely — no custom web UI, no Prowlarr, no addon.
    //   2. Its post-install step launches vanilla Stremio for that session.
    //
    // Nothing else is at risk: this exe is not tracked in Stremio's
    // unins000.dat (it's an untracked extra file in the app dir), the payload
    // lives under %LOCALAPPDATA%\StremioLauncherFULL, and the custom UI is a
    // remote URL passed as a CLI flag. So we take the update over: install the
    // staged setup ourselves in silent mode (Inno's standard `skipifsilent`
    // flag on [Run] entries means silent mode also skips the vanilla relaunch),
    // then make sure the shortcuts point back here.

    /// <summary>
    /// Install a newer Stremio release if its installer is already sitting in
    /// %TEMP%, staged there by the shell's auto-updater on a previous run.
    /// Runs before anything else starts, so no Stremio process holds a lock.
    /// Every failure path is non-fatal — we log and boot on the old version.
    /// </summary>
    static void CheckStremioAppUpdate()
    {
        try
        {
            Version installed = GetInstalledStremioVersion();
            if (installed == null)
            {
                // No Stremio install detected at all — nothing to upgrade, and
                // running an installer unattended here would be a surprise.
                return;
            }

            string setup = null;
            Version staged = null;
            foreach (var candidate in Directory.GetFiles(Path.GetTempPath(), "StremioSetup-v*_x64.exe"))
            {
                Version v = ParseSetupVersion(Path.GetFileName(candidate));
                if (v == null) continue;
                if (staged == null || v > staged) { staged = v; setup = candidate; }
            }

            if (setup == null || staged <= installed) return;

            // We're about to execute a 73MB binary from %TEMP% unattended, and
            // %TEMP% is writable by anything running as this user. Refuse
            // unless it's actually signed by Stremio's publisher.
            if (!IsSignedByStremio(setup))
            {
                Console.WriteLine("[stremio-update] REFUSING " + Path.GetFileName(setup)
                    + " — not signed by " + STREMIO_SIGNER);
                return;
            }

            Console.WriteLine("[stremio-update] " + installed + " -> " + staged + ", installing silently...");
            var psi = new ProcessStartInfo(setup,
                "/VERYSILENT /NORESTART /SUPPRESSMSGBOXES /NOCANCEL /NOICONS")
            {
                UseShellExecute = false,
                CreateNoWindow = true
            };
            var p = Process.Start(psi);
            if (!p.WaitForExit(STREMIO_INSTALL_TIMEOUT_MS))
            {
                Console.WriteLine("[stremio-update] WARN: installer still running after "
                    + (STREMIO_INSTALL_TIMEOUT_MS / 1000) + "s — continuing without waiting");
                return;
            }

            if (p.ExitCode != 0)
            {
                Console.WriteLine("[stremio-update] WARN: installer exited with code " + p.ExitCode);
                return;
            }

            Version now = GetInstalledStremioVersion();
            Console.WriteLine("[stremio-update] done — now on " + (now != null ? now.ToString() : "(unknown)"));
            try { File.Delete(setup); } catch { /* temp cleanup is best-effort */ }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[stremio-update] check failed: " + ex.Message);
        }
    }

    /// <summary>
    /// Installed Stremio version from the per-user Inno uninstall entry.
    /// Looked up by DisplayName rather than a hardcoded AppId GUID so a
    /// future re-key doesn't silently disable the updater.
    /// </summary>
    static Version GetInstalledStremioVersion()
    {
        try
        {
            using (var uninstall = Registry.CurrentUser.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
            {
                if (uninstall == null) return null;
                foreach (string name in uninstall.GetSubKeyNames())
                {
                    using (var k = uninstall.OpenSubKey(name))
                    {
                        if (k == null) continue;
                        string display = k.GetValue("DisplayName") as string;
                        if (display == null || !display.StartsWith("Stremio", StringComparison.OrdinalIgnoreCase))
                            continue;

                        Version v = ParseVersion(k.GetValue("DisplayVersion") as string);
                        if (v != null) return v;
                    }
                }
            }
        }
        catch { /* fall through to the exe probe */ }

        // Fallback: read it straight off the shell binary.
        try
        {
            string shell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "Stremio", "stremio-shell-ng.exe");
            if (File.Exists(shell))
                return ParseVersion(FileVersionInfo.GetVersionInfo(shell).ProductVersion);
        }
        catch { }

        return null;
    }

    /// <summary>"StremioSetup-v5.0.24_x64.exe" → 5.0.24</summary>
    static Version ParseSetupVersion(string fileName)
    {
        int start = fileName.IndexOf("-v", StringComparison.OrdinalIgnoreCase);
        if (start < 0) return null;
        start += 2;
        int end = fileName.IndexOf('_', start);
        if (end < 0) return null;
        return ParseVersion(fileName.Substring(start, end - start));
    }

    static Version ParseVersion(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        Version v;
        return Version.TryParse(s.Trim(), out v) ? v : null;
    }

    /// <summary>
    /// True if the file carries an Authenticode signature whose subject names
    /// Stremio's publisher. This proves who produced the binary; it does not
    /// walk the trust chain or check revocation, which is why we pin the exact
    /// subject string rather than accepting any valid signature.
    /// </summary>
    static bool IsSignedByStremio(string path)
    {
        try
        {
            var cert = X509Certificate.CreateFromSignedFile(path);
            return cert.Subject.IndexOf(STREMIO_SIGNER, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch
        {
            // Unsigned files throw here — that's a refusal, not an error.
            return false;
        }
    }

    /// <summary>
    /// Point the Start Menu shortcuts back at this exe. Runs on every start,
    /// so whatever a Stremio installer (or the user) did to them gets undone
    /// on the next launch.
    ///
    /// "Stremio.lnk" is the name the Stremio installer itself owns and will
    /// keep reclaiming; "Stremio Custom.lnk" is a name it never writes, so it
    /// stays correct no matter what and is the safe one to pin.
    /// </summary>
    static void EnsureShortcuts()
    {
        string exe;
        try { exe = Process.GetCurrentProcess().MainModule.FileName; }
        catch (Exception ex)
        {
            Console.WriteLine("[shortcut] skipped — can't resolve own path: " + ex.Message);
            return;
        }

        string programs = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            @"Microsoft\Windows\Start Menu\Programs");

        // The plain "Stremio" entry and our installer-proof alias are both
        // created if missing. The Startup entry is only ever repaired — we
        // don't add the app to autostart on someone's behalf.
        WriteShortcut(Path.Combine(programs, "Stremio.lnk"), exe, false);
        WriteShortcut(Path.Combine(programs, "Stremio Custom.lnk"), exe, false);
        WriteShortcut(Path.Combine(programs, "Startup", "Stremio.lnk"), exe, true);
    }

    /// <summary>
    /// Create or repoint a .lnk via late-bound WScript.Shell COM. Late binding
    /// keeps this compiling under the bare `csc` invocation in
    /// build-launchers.ps1, which has no COM interop reference.
    /// </summary>
    /// <param name="repairOnly">Leave the shortcut alone if it doesn't exist.</param>
    static void WriteShortcut(string lnkPath, string targetExe, bool repairOnly)
    {
        try
        {
            bool exists = File.Exists(lnkPath);
            if (repairOnly && !exists) return;

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                Console.WriteLine("[shortcut] skipped — WScript.Shell unavailable");
                return;
            }
            object shell = Activator.CreateInstance(shellType);
            object lnk = shellType.InvokeMember("CreateShortcut",
                BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type lnkType = lnk.GetType();

            // Don't rewrite a shortcut that's already correct — keeps normal
            // startups free of disk writes and keeps this log quiet.
            if (exists)
            {
                var current = lnkType.InvokeMember("TargetPath",
                    BindingFlags.GetProperty, null, lnk, null) as string;
                if (string.Equals(current, targetExe, StringComparison.OrdinalIgnoreCase)) return;
            }

            lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk,
                new object[] { targetExe });
            lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk,
                new object[] { Path.GetDirectoryName(targetExe) });
            lnkType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk,
                new object[] { targetExe + ",0" });
            lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk,
                new object[] { "Stremio (custom launcher)" });
            lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);

            Console.WriteLine("[shortcut] " + (exists ? "repaired " : "created ")
                + Path.GetFileName(lnkPath) + " -> " + Path.GetFileName(targetExe));
        }
        catch (Exception ex)
        {
            Console.WriteLine("[shortcut] WARN: " + Path.GetFileName(lnkPath) + " — " + ex.Message);
        }
    }

    static void WriteAddonVersionMarker(string rootDir)
    {
        try
        {
            string addonDir = Path.Combine(rootDir, "stremio-adult-addon");
            Directory.CreateDirectory(addonDir);
            File.WriteAllText(Path.Combine(addonDir, ".addon-version"), ADDON_VERSION);
        }
        catch (Exception ex)
        {
            Console.WriteLine("[update] WARN: failed to write addon version marker: " + ex.Message);
        }
    }

    /// <summary>
    /// Find a file by name within a directory tree (zip archives often add
    /// an extra nested folder, e.g. node-v20.18.1-win-x64\node.exe or
    /// Prowlarr\Prowlarr.exe). Returns the first match or null.
    /// </summary>
    static string FindFile(string rootDir, string subDir, string fileName)
    {
        string baseDir = Path.Combine(rootDir, subDir);
        // Check direct
        string direct = Path.Combine(baseDir, fileName);
        if (File.Exists(direct)) return direct;

        // Check one level deep (the common nested-folder case)
        if (Directory.Exists(baseDir))
        {
            foreach (string dir in Directory.GetDirectories(baseDir))
            {
                string nested = Path.Combine(dir, fileName);
                if (File.Exists(nested)) return nested;
            }
        }
        return null;
    }

    // ── Service startup ──────────────────────────────────────

    static void StartProwlarr(string prowlarrExe, string dataDir)
    {
        try
        {
            Directory.CreateDirectory(dataDir);
            var psi = new ProcessStartInfo(prowlarrExe, "-nobrowser -data=\"" + dataDir + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(prowlarrExe)
            };
            _prowlarrProc = Process.Start(psi);
            AddToJob(_prowlarrProc);
            Console.WriteLine("[OK] Started Prowlarr (PID " + _prowlarrProc.Id + ") on :" + PROWLARR_PORT);
            PipeOutput(_prowlarrProc, "prowlarr");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Failed to start Prowlarr: " + ex.Message);
        }
    }

    static void StartFlareSolverr(string flaresolverrExe)
    {
        try
        {
            var psi = new ProcessStartInfo(flaresolverrExe)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(flaresolverrExe)
            };
            // Pin port/host so a stale %PORT% from a previous shell or a
            // different FlareSolverr install can't shift our listener.
            psi.EnvironmentVariables["PORT"] = FLARESOLVERR_PORT.ToString();
            psi.EnvironmentVariables["HOST"] = "127.0.0.1";
            psi.EnvironmentVariables["LOG_LEVEL"] = "info";

            _flaresolverrProc = Process.Start(psi);
            AddToJob(_flaresolverrProc);
            Console.WriteLine("[OK] Started FlareSolverr (PID " + _flaresolverrProc.Id + ") on :" + FLARESOLVERR_PORT);
            PipeOutput(_flaresolverrProc, "flaresolverr");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Failed to start FlareSolverr: " + ex.Message);
        }
    }

    static void StartAddon(string nodeExe, string addonEntry, string prowlarrDataDir)
    {
        try
        {
            var psi = new ProcessStartInfo(nodeExe, "\"" + addonEntry + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(addonEntry)
            };
            psi.EnvironmentVariables["ADDON_PORT"] = ADDON_PORT.ToString();
            psi.EnvironmentVariables["PROWLARR_URL"] = "http://127.0.0.1:" + PROWLARR_PORT;
            psi.EnvironmentVariables["PROWLARR_DATA_DIR"] = prowlarrDataDir;

            _addonProc = Process.Start(psi);
            AddToJob(_addonProc);
            Console.WriteLine("[OK] Started Incognito addon (PID " + _addonProc.Id + ") on :" + ADDON_PORT);
            PipeOutput(_addonProc, "addon");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Failed to start addon: " + ex.Message);
        }
    }

    static void PipeOutput(Process proc, string tag)
    {
        new Thread(() =>
        {
            try { string l; while ((l = proc.StandardOutput.ReadLine()) != null) WriteFiltered(tag, l, false); }
            catch { }
        }) { IsBackground = true }.Start();
        new Thread(() =>
        {
            try { string l; while ((l = proc.StandardError.ReadLine()) != null) WriteFiltered(tag, l, true); }
            catch { }
        }) { IsBackground = true }.Start();
    }

    /// <summary>
    /// Write a child-process log line with our tag, skipping noise. The goal
    /// isn't to be invisible — errors and warnings always pass through — but
    /// to drop the per-request chatter and codec/encoder probe spam that
    /// makes the terminal unreadable. Errors are colorised so they pop.
    /// </summary>
    static void WriteFiltered(string tag, string line, bool isStderr)
    {
        if (line == null || line.Length == 0) return;
        if (LogNoise.IsNoise(tag, line)) return;
        ConsoleColor? color = LogNoise.ColorFor(line, isStderr);
        if (color.HasValue)
        {
            ConsoleColor prev = Console.ForegroundColor;
            try { Console.ForegroundColor = color.Value; Console.WriteLine("[" + tag + "] " + line); }
            finally { Console.ForegroundColor = prev; }
        }
        else
        {
            Console.WriteLine("[" + tag + "] " + line);
        }
    }

    static void WaitForPort(int port, string name, int maxTries)
    {
        for (int i = 0; i < maxTries; i++)
        {
            try
            {
                using (var t = new TcpClient()) { t.Connect("127.0.0.1", port); }
                Console.WriteLine("[OK] " + name + " listening on :" + port);
                return;
            }
            catch { }
            Thread.Sleep(500);
        }
        Console.WriteLine("[WARN] " + name + " not responding on :" + port + " (timeout)");
    }

    // Same as WaitForPort, but on a background thread so the main flow can
    // launch Stremio without waiting for sidecars to finish booting.
    static void WaitForPortAsync(int port, string name, int maxTries)
    {
        new Thread(() => WaitForPort(port, name, maxTries)) { IsBackground = true }.Start();
    }

    // ── Shutdown ─────────────────────────────────────────────

    static int _shutdown = 0;
    static void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return;
        Console.WriteLine("Shutting down...");
        SafeKill(_addonProc, "addon");
        SafeKill(_prowlarrProc, "prowlarr");
        // FlareSolverr forks a Chromium tree; killing the parent relies on
        // the job-object's KILL_ON_JOB_CLOSE to reap every descendent.
        SafeKill(_flaresolverrProc, "flaresolverr");
        SafeKill(_baseProc, "base launcher");
    }

    static void SafeKill(Process p, string tag)
    {
        try
        {
            if (p != null && !p.HasExited)
            {
                p.Kill();
                p.WaitForExit(3000);
                Console.WriteLine("  Killed " + tag);
            }
        }
        catch { }
    }

    // ── Port cleanup ─────────────────────────────────────────

    // ── Win32 Job Object (kernel-guaranteed child cleanup) ──
    //
    // When our process dies by ANY means (normal exit, Ctrl-C, clicking
    // the X on the console window, taskkill /F, a crash, or even the
    // machine powering off), Windows decrements the job's handle count.
    // The last handle is held by THIS process, so it reaches zero, the
    // job closes, and KILL_ON_JOB_CLOSE forcibly terminates every process
    // in the job — no cleanup code required.
    //
    // This replaces relying on ProcessExit / CancelKeyPress hooks, which
    // silently don't fire on window-X-button or taskkill /F.

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbLen);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    static IntPtr _job = IntPtr.Zero;

    static void InitJobObject()
    {
        try
        {
            _job = CreateJobObject(IntPtr.Zero, null);
            if (_job == IntPtr.Zero) return;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(info);
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(_job, JobObjectExtendedLimitInformation, ptr, (uint)size);
            }
            finally { Marshal.FreeHGlobal(ptr); }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Failed to create job object, child cleanup may be flaky: " + ex.Message);
        }
    }

    static void AddToJob(Process p)
    {
        if (_job == IntPtr.Zero || p == null) return;
        try { AssignProcessToJobObject(_job, p.Handle); }
        catch (Exception ex) { Console.WriteLine("[WARN] AssignProcessToJobObject failed: " + ex.Message); }
    }

    // ── Prowlarr data migration ─────────────────────────────
    //
    // Older versions stored Prowlarr data under each versioned root
    // (<version>\prowlarr\**\data\prowlarr.db), so bumping the launcher
    // lost every indexer. Now it lives in <appRoot>\shared\prowlarr-data.
    // On first run of a new version, if shared is empty, copy in the
    // newest version's data so the user keeps their setup.
    static void MigrateProwlarrDataIfNeeded(string appRoot, string sharedProwlarrData)
    {
        string dbPath = Path.Combine(sharedProwlarrData, "prowlarr.db");
        if (File.Exists(dbPath)) return; // already populated — nothing to do

        string bestSource = null;
        DateTime bestMtime = DateTime.MinValue;
        try
        {
            foreach (string dir in Directory.GetDirectories(appRoot))
            {
                string name = Path.GetFileName(dir);
                if (name == "shared") continue;
                // Find prowlarr.db anywhere under <version>\prowlarr\
                string prowlarrDir = Path.Combine(dir, "prowlarr");
                if (!Directory.Exists(prowlarrDir)) continue;
                string[] dbs;
                try { dbs = Directory.GetFiles(prowlarrDir, "prowlarr.db", SearchOption.AllDirectories); }
                catch { continue; }
                foreach (string db in dbs)
                {
                    DateTime mt = File.GetLastWriteTimeUtc(db);
                    if (mt > bestMtime) { bestMtime = mt; bestSource = Path.GetDirectoryName(db); }
                }
            }
        }
        catch { /* directory walk failed — no migration is fine */ }

        if (bestSource == null) return;
        Console.WriteLine("[MIGRATE] Copying Prowlarr config from " + bestSource);
        try
        {
            CopyDirectory(bestSource, sharedProwlarrData);
            Console.WriteLine("[OK] Migration complete — your indexers carry over.");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Migration failed (" + ex.Message + "). You may need to re-add indexers.");
        }
    }

    static void CopyDirectory(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (string file in Directory.GetFiles(src))
        {
            File.Copy(file, Path.Combine(dst, Path.GetFileName(file)), true);
        }
        foreach (string sub in Directory.GetDirectories(src))
        {
            string name = Path.GetFileName(sub);
            // Skip log dirs — pure noise, and they can be large.
            if (string.Equals(name, "logs", StringComparison.OrdinalIgnoreCase)) continue;
            if (string.Equals(name, "UpdateLogFiles", StringComparison.OrdinalIgnoreCase)) continue;
            CopyDirectory(sub, Path.Combine(dst, name));
        }
    }

    static void KillByPort(int port)
    {
        try
        {
            var psi = new ProcessStartInfo("netstat", "-ano")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true
            };
            var proc = Process.Start(psi);
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit(5000);

            int myPid = Process.GetCurrentProcess().Id;
            string search = "127.0.0.1:" + port;

            foreach (string line in output.Split('\n'))
            {
                if (line.IndexOf(search) < 0 || line.IndexOf("LISTENING") < 0) continue;
                string[] parts = line.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                int pid;
                if (int.TryParse(parts[parts.Length - 1], out pid) && pid != myPid && pid > 4)
                {
                    try
                    {
                        var p = Process.GetProcessById(pid);
                        Console.WriteLine("[CLEANUP] Killing " + p.ProcessName + " on :" + port + " (PID " + pid + ")");
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                    catch { }
                }
            }
        }
        catch { }
    }
}

// ════════════════════════════════════════════════════════════════════
//  Log filter — drops codec/encoder probe spam and per-request chatter
//  while always letting genuine errors / warnings through. Keeps the
//  terminal usable without hiding anything that matters when something
//  actually breaks.
// ════════════════════════════════════════════════════════════════════
static class LogNoise
{
    // Always show lines containing any of these (case-insensitive) — even if
    // a downstream rule would otherwise filter them. This is the safety net.
    static readonly string[] AlwaysShowKeywords = {
        "error", "exception", "failed", "fatal", "warn", "cannot",
        "unable", "denied", "refused", "timeout", "crash",
    };

    public static bool IsNoise(string tag, string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return true;
        string trimmed = line.TrimStart();

        // Genuine errors / warnings are NEVER noise.
        if (HasAnyKeyword(line, AlwaysShowKeywords)) return false;

        // ── Streaming server (`server.js`): drop the codec/encoder probe ──
        // The Stremio streaming server probes ffmpeg's available formats,
        // codecs, encoders and decoders at startup, which floods stderr with
        // hundreds of `[mov,mp4,m4a,...]`, `Stream #0:0`, and `D....` lines
        // that don't tell anybody anything useful. We keep the high-level
        // status (listening on port, version banner) and drop the rest.
        if (tag == "server")
        {
            // ffmpeg test/probe banners
            if (trimmed.StartsWith("ffmpeg version")) return true;
            if (trimmed.StartsWith("built with")) return true;
            if (trimmed.StartsWith("configuration:")) return true;
            if (trimmed.StartsWith("lib")) return true;          // libavutil/libavcodec/...
            if (trimmed.StartsWith("Input #")) return true;
            if (trimmed.StartsWith("Output #")) return true;
            if (trimmed.StartsWith("Stream #")) return true;
            if (trimmed.StartsWith("Stream mapping")) return true;
            if (trimmed.StartsWith("Press [q]")) return true;
            if (trimmed.StartsWith("size=") || trimmed.StartsWith("frame=")) return true;
            if (trimmed.StartsWith("video:") || trimmed.StartsWith("audio:")) return true;
            // FFmpeg's per-format diagnostic prefix [mov,mp4,...] / [matroska,...]
            // and per-encoder probes [aac @ 0x...] / [libx264 @ ...]
            if (trimmed.Length > 1 && trimmed[0] == '[' && trimmed.IndexOf("@ 0x") > 0) return true;
            // Probe table rows like " D.V... vp9   On2 VP9 ..."
            if (trimmed.Length > 7 && (trimmed.StartsWith("D.") || trimmed.StartsWith(".V")
                || trimmed.StartsWith(".A") || trimmed.StartsWith("..S") || trimmed.StartsWith("D.V")
                || trimmed.StartsWith(".EV") || trimmed.StartsWith(".EA"))) return true;
            // Standalone progress / tabular noise
            if (trimmed.StartsWith("File '") && trimmed.IndexOf("already exists") < 0) return true;
        }

        // ── FlareSolverr: mute per-request access logs, keep startup/errors ──
        if (tag == "flaresolverr")
        {
            // Successful access log lines start with the timestamp + "GET" / "POST"
            if (trimmed.IndexOf("\"GET ") > 0 && trimmed.IndexOf(" 200 ") > 0) return true;
            if (trimmed.IndexOf("\"POST ") > 0 && trimmed.IndexOf(" 200 ") > 0) return true;
            // The "Incoming request" / "Response in NNNms" pairs that print on
            // every solved challenge — useful when debugging, noise otherwise.
            if (trimmed.IndexOf("Incoming request") >= 0) return true;
            if (trimmed.IndexOf("Response in ") >= 0 && trimmed.IndexOf("ms") > 0) return true;
            // Selenium / Chromium driver chatter
            if (trimmed.StartsWith("DevTools listening")) return true;
            if (trimmed.IndexOf("WebDriverException") >= 0 && trimmed.IndexOf("retry") >= 0) return true;
        }

        // ── Prowlarr: drop info-level periodic health checks ──
        if (tag == "prowlarr")
        {
            // Default Prowlarr log lines look like:
            //   2024-05-05 12:34:56.7|Info|HealthCheck|Health check completed
            // Drop the per-minute Info|HealthCheck and HTTP request log lines,
            // keep Warn / Error / Fatal.
            if (trimmed.IndexOf("|Info|") > 0 && (trimmed.IndexOf("HealthCheck") > 0
                || trimmed.IndexOf("|Http|") > 0 || trimmed.IndexOf("|Bootstrap|") > 0)) return true;
            if (trimmed.IndexOf("|Debug|") > 0) return true;
            if (trimmed.IndexOf("|Trace|") > 0) return true;
        }

        // ── Addon: drop per-request access logs that the express logger emits ──
        if (tag == "addon")
        {
            // Express morgan-style log: GET /path 200 12ms
            if (trimmed.Length > 4 && (trimmed.StartsWith("GET ") || trimmed.StartsWith("POST "))
                && (trimmed.IndexOf(" 200 ") > 0 || trimmed.IndexOf(" 304 ") > 0)) return true;
            // Quota / probe heartbeats — only show on threshold change, drop the rest.
            if (trimmed.IndexOf("[probe]") >= 0 && trimmed.IndexOf("ok") > 0) return true;
        }

        return false;
    }

    /// <summary>
    /// Returns a console color to highlight the line, or null for plain.
    /// Errors → red, warnings → yellow, OK banners → green.
    /// </summary>
    public static ConsoleColor? ColorFor(string line, bool isStderr)
    {
        if (HasAnyKeyword(line, new[] { "error", "exception", "fatal", "failed", "crash" }))
            return ConsoleColor.Red;
        if (HasAnyKeyword(line, new[] { "warn", "warning", "denied", "refused", "timeout" }))
            return ConsoleColor.Yellow;
        // Don't colorise plain stderr — many tools (Prowlarr, FlareSolverr) write
        // benign info lines to stderr, and dyeing them red is misleading.
        return null;
    }

    static bool HasAnyKeyword(string line, string[] keywords)
    {
        if (string.IsNullOrEmpty(line)) return false;
        for (int i = 0; i < keywords.Length; i++)
        {
            if (line.IndexOf(keywords[i], StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }
}
