// StremioLauncherFULL — self-contained launcher.
//
// A single .exe with the entire payload (Prowlarr, portable Node, the
// stremio-adult-addon with its node_modules, and the base StremioLauncher.exe)
// embedded as a resource. On first run it extracts everything to
// %LOCALAPPDATA%\StremioLauncherFULL\<version>\ and then runs from there.
// Subsequent runs skip extraction.
//
// Build (CI):
//   csc.exe /target:exe /out:StremioLauncherFULL.exe ^
//           /resource:payload.zip,StremioLauncherFULL.payload.zip ^
//           /r:System.IO.Compression.dll ^
//           /r:System.IO.Compression.FileSystem.dll ^
//           StremioLauncherFULL.cs
//
// Ports (all loopback-only):
//   7000  — adult addon
//   9696  — Prowlarr
//   11470 — Stremio streaming server   (base launcher)
//   12470 — CORS proxy                 (base launcher)
//   12471 — audio extract              (base launcher)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Sockets;
using System.Reflection;
using System.Threading;

class StremioLauncherFULL
{
    // Bump this whenever the payload changes so users auto-re-extract on upgrade.
    const string PAYLOAD_VERSION = "1.1.0";
    const string PAYLOAD_RESOURCE = "StremioLauncherFULL.payload.zip";

    const int PROWLARR_PORT = 9696;
    const int ADDON_PORT = 7000;

    static Process _prowlarrProc;
    static Process _addonProc;
    static Process _baseProc;

    static int Main()
    {
        string rootDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "StremioLauncherFULL",
            PAYLOAD_VERSION);
        string marker = Path.Combine(rootDir, ".extracted");

        Console.WriteLine("[FULL] StremioLauncherFULL " + PAYLOAD_VERSION);
        Console.WriteLine("[FULL] Install root: " + rootDir);

        if (!File.Exists(marker))
        {
            Console.WriteLine("[FULL] First run for this version — extracting bundled payload...");
            try
            {
                ExtractPayload(rootDir);
                File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
                Console.WriteLine("[FULL] [OK] Extraction complete");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[FULL] [FATAL] Extraction failed: " + ex.Message);
                Console.WriteLine("Press any key to exit...");
                Console.ReadKey();
                return 1;
            }
        }
        else
        {
            Console.WriteLine("[FULL] Payload already extracted");
        }

        // Resolve extracted paths
        string prowlarrExe = Path.Combine(rootDir, "prowlarr", "Prowlarr.exe");
        string prowlarrDataDir = Path.Combine(rootDir, "prowlarr", "data");
        string addonEntry = Path.Combine(rootDir, "stremio-adult-addon", "index.js");
        string nodeExe = Path.Combine(rootDir, "node", "node.exe");
        string baseExe = Path.Combine(rootDir, "StremioLauncher.exe");

        // Free ports we're going to claim
        KillByPort(PROWLARR_PORT);
        KillByPort(ADDON_PORT);

        Console.CancelKeyPress += delegate { Shutdown(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };

        // Start Prowlarr
        if (File.Exists(prowlarrExe))
        {
            StartProwlarr(prowlarrExe, prowlarrDataDir);
            // Prowlarr's first boot is slow (migrations + cert generation),
            // give it up to ~30s to start listening.
            WaitForPort(PROWLARR_PORT, "Prowlarr", 60);
        }
        else
        {
            Console.WriteLine("[FULL] [WARN] Prowlarr not found in payload at " + prowlarrExe);
        }

        // Start adult addon (requires portable node)
        if (File.Exists(addonEntry))
        {
            string nodeToUse = File.Exists(nodeExe) ? nodeExe : "node";
            StartAddon(nodeToUse, addonEntry, prowlarrDataDir);
            WaitForPort(ADDON_PORT, "Incognito addon", 20);
        }
        else
        {
            Console.WriteLine("[FULL] [WARN] Adult addon not found in payload at " + addonEntry);
        }

        // Run the base launcher (streaming server, CORS proxy, audio, shell window)
        if (!File.Exists(baseExe))
        {
            Console.WriteLine("[FULL] [FATAL] StremioLauncher.exe missing from payload");
            Console.WriteLine("Press any key to exit...");
            Console.ReadKey();
            Shutdown();
            return 1;
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
            Console.WriteLine("[FULL] [OK] Launched base StremioLauncher (PID " + _baseProc.Id + ")");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FULL] [FATAL] Failed to start base launcher: " + ex.Message);
            Shutdown();
            return 1;
        }

        _baseProc.WaitForExit();
        Console.WriteLine("[FULL] Base launcher exited with code " + _baseProc.ExitCode);
        Shutdown();
        return _baseProc.ExitCode;
    }

    // ── Self-extraction ──────────────────────────────────────

    static void ExtractPayload(string destDir)
    {
        var asm = Assembly.GetExecutingAssembly();

        // The csc flag /resource:payload.zip,StremioLauncherFULL.payload.zip
        // registers the resource under the exact name PAYLOAD_RESOURCE.
        Stream stream = asm.GetManifestResourceStream(PAYLOAD_RESOURCE);
        if (stream == null)
        {
            // Fall back: look for any .zip resource
            string[] names = asm.GetManifestResourceNames();
            foreach (var n in names)
            {
                if (n.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                {
                    stream = asm.GetManifestResourceStream(n);
                    break;
                }
            }
            if (stream == null)
                throw new Exception("Embedded payload resource not found. Available resources: " + string.Join(", ", names));
        }

        using (stream)
        {
            // ZipArchive needs a seekable stream; manifest-resource streams already are,
            // but copy to MemoryStream for safety.
            var ms = new MemoryStream();
            byte[] buf = new byte[81920];
            int n;
            long copied = 0;
            while ((n = stream.Read(buf, 0, buf.Length)) > 0)
            {
                ms.Write(buf, 0, n);
                copied += n;
            }
            ms.Position = 0;
            Console.WriteLine("[FULL] Payload size: " + (copied / (1024 * 1024)) + " MB");

            try { Directory.CreateDirectory(destDir); } catch { }

            using (var archive = new ZipArchive(ms, ZipArchiveMode.Read))
            {
                int total = archive.Entries.Count;
                int done = 0;
                int lastPct = -1;
                foreach (var entry in archive.Entries)
                {
                    string target = Path.Combine(destDir, entry.FullName);
                    // Entries ending with / are directories
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        try { Directory.CreateDirectory(target); } catch { }
                    }
                    else
                    {
                        try { Directory.CreateDirectory(Path.GetDirectoryName(target)); } catch { }
                        entry.ExtractToFile(target, true);
                    }
                    done++;
                    int pct = (int)(100L * done / total);
                    if (pct != lastPct && pct % 10 == 0)
                    {
                        Console.WriteLine("[FULL] Extracted " + done + "/" + total + " entries (" + pct + "%)");
                        lastPct = pct;
                    }
                }
            }
        }
    }

    // ── Service startup ──────────────────────────────────────

    static void StartProwlarr(string prowlarrExe, string dataDir)
    {
        try
        {
            try { Directory.CreateDirectory(dataDir); } catch { }

            var psi = new ProcessStartInfo(prowlarrExe, "-nobrowser -data=\"" + dataDir + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(prowlarrExe)
            };
            _prowlarrProc = Process.Start(psi);
            Console.WriteLine("[FULL] [OK] Started Prowlarr (PID " + _prowlarrProc.Id + ") on :" + PROWLARR_PORT);
            PipeProcessOutput(_prowlarrProc, "prowlarr");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FULL] [WARN] Failed to start Prowlarr: " + ex.Message);
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
            Console.WriteLine("[FULL] [OK] Started Incognito addon (PID " + _addonProc.Id + ") on :" + ADDON_PORT);
            PipeProcessOutput(_addonProc, "addon");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[FULL] [WARN] Failed to start addon: " + ex.Message);
        }
    }

    static void PipeProcessOutput(Process proc, string tag)
    {
        new Thread(() =>
        {
            try
            {
                string line;
                while ((line = proc.StandardOutput.ReadLine()) != null)
                    Console.WriteLine("[" + tag + "] " + line);
            }
            catch { }
        }) { IsBackground = true }.Start();

        new Thread(() =>
        {
            try
            {
                string line;
                while ((line = proc.StandardError.ReadLine()) != null)
                    Console.WriteLine("[" + tag + "] " + line);
            }
            catch { }
        }) { IsBackground = true }.Start();
    }

    static void WaitForPort(int port, string name, int maxTries)
    {
        for (int i = 0; i < maxTries; i++)
        {
            try
            {
                var test = new TcpClient();
                test.Connect("127.0.0.1", port);
                test.Close();
                Console.WriteLine("[FULL] [OK] " + name + " listening on :" + port);
                return;
            }
            catch { }
            Thread.Sleep(500);
        }
        Console.WriteLine("[FULL] [WARN] " + name + " did not start listening on :" + port + " within timeout");
    }

    // ── Shutdown ─────────────────────────────────────────────

    static int _shutdown = 0;
    static void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return;
        Console.WriteLine("[FULL] Shutting down bundled services...");
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
                Console.WriteLine("[FULL] Killed " + tag + " (PID " + p.Id + ")");
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
                        Console.WriteLine("[FULL] [CLEANUP] Killing process on port " + port + ": " + p.ProcessName + " (PID " + pid + ")");
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
