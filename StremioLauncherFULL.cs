// StremioLauncherFULL — lightweight bootstrapper + launcher.
//
// A small exe (~30 KB) that on first run downloads Prowlarr, portable Node,
// and the incognito addon from known URLs, extracts them to
// %LOCALAPPDATA%\StremioLauncherFULL\<version>\, then starts all services.
// Subsequent runs skip downloads and go straight to launching.
//
// Deployable via GitHub Pages alongside the web UI. No CI required — compile
// locally with:
//   csc.exe /target:exe /out:StremioLauncherFULL.exe ^
//           /r:System.IO.Compression.dll ^
//           /r:System.IO.Compression.FileSystem.dll ^
//           StremioLauncherFULL.cs
//
// Ports (all loopback):
//   7000  — adult addon          9696  — Prowlarr
//   11470 — streaming server     12470 — CORS proxy     12471 — audio extract
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Threading;

class StremioLauncherFULL
{
    // ── Version & download URLs ──────────────────────────────
    // Bump PAYLOAD_VERSION whenever you update these URLs so users re-download.
    const string PAYLOAD_VERSION = "1.5.1";

    // Portable Node.js — just need node.exe for the addon
    const string NODE_URL = "https://nodejs.org/dist/v20.18.1/node-v20.18.1-win-x64.zip";
    // Prowlarr (portable, .NET-included build)
    const string PROWLARR_URL = "https://github.com/Prowlarr/Prowlarr/releases/download/v1.28.2.4885/Prowlarr.master.1.28.2.4885.windows-core-x64.zip";
    // Addon zip hosted on GitHub Pages alongside the web UI
    const string ADDON_URL = "https://jeromenicholas07.github.io/stremio-web-netflix/stremio-adult-addon.zip";
    // Base launcher (also on Pages)
    const string BASE_LAUNCHER_URL = "https://jeromenicholas07.github.io/stremio-web-netflix/StremioLauncher.exe";

    const int PROWLARR_PORT = 9696;
    const int ADDON_PORT = 7000;

    static Process _prowlarrProc;
    static Process _addonProc;
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

    static int Main()
    {
        // TLS 1.2 required for GitHub / nodejs.org downloads
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

        string rootDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "StremioLauncherFULL",
            PAYLOAD_VERSION);
        string marker = Path.Combine(rootDir, ".ready");

        Console.WriteLine("=== StremioLauncherFULL " + PAYLOAD_VERSION + " ===");
        Console.WriteLine("Install root: " + rootDir);
        Console.WriteLine();

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
                DownloadAndExtract("Incognito Addon", ADDON_URL, rootDir, "stremio-adult-addon");
                DownloadFile("StremioLauncher.exe", BASE_LAUNCHER_URL, Path.Combine(rootDir, "StremioLauncher.exe"));

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
        string prowlarrDataDir = prowlarrExe != null
            ? Path.Combine(Path.GetDirectoryName(prowlarrExe), "data")
            : Path.Combine(rootDir, "prowlarr", "data");
        string addonEntry = FindFile(rootDir, "stremio-adult-addon", "index.js");
        string baseExe = Path.Combine(rootDir, "StremioLauncher.exe");

        // Free ports
        KillByPort(PROWLARR_PORT);
        KillByPort(ADDON_PORT);

        Console.CancelKeyPress += delegate { Shutdown(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };

        // Start Prowlarr
        if (prowlarrExe != null)
        {
            StartProwlarr(prowlarrExe, prowlarrDataDir);
            // First boot is slow (migrations + cert generation)
            WaitForPort(PROWLARR_PORT, "Prowlarr", 60);
        }
        else
        {
            Console.WriteLine("[WARN] Prowlarr.exe not found in " + Path.Combine(rootDir, "prowlarr"));
        }

        // Start addon
        if (addonEntry != null && nodeExe != null)
        {
            StartAddon(nodeExe, addonEntry, prowlarrDataDir);
            WaitForPort(ADDON_PORT, "Incognito addon", 20);
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
            Console.WriteLine("[OK] Started Prowlarr (PID " + _prowlarrProc.Id + ") on :" + PROWLARR_PORT);
            PipeOutput(_prowlarrProc, "prowlarr");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Failed to start Prowlarr: " + ex.Message);
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
            try { string l; while ((l = proc.StandardOutput.ReadLine()) != null) Console.WriteLine("[" + tag + "] " + l); }
            catch { }
        }) { IsBackground = true }.Start();
        new Thread(() =>
        {
            try { string l; while ((l = proc.StandardError.ReadLine()) != null) Console.WriteLine("[" + tag + "] " + l); }
            catch { }
        }) { IsBackground = true }.Start();
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

    // ── Shutdown ─────────────────────────────────────────────

    static int _shutdown = 0;
    static void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return;
        Console.WriteLine("Shutting down...");
        SafeKill(_addonProc, "addon");
        SafeKill(_prowlarrProc, "prowlarr");
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
