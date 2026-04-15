// StremioLauncherFULL — bundled launcher that spins up Prowlarr and the
// Incognito Catalogs addon alongside the base StremioLauncher services.
//
// Layout expected (same directory as this exe):
//   StremioLauncherFULL.exe       — this file
//   StremioLauncher.exe           — base launcher (streaming server, CORS proxy, audio)
//   prowlarr\Prowlarr.exe         — bundled Prowlarr
//   stremio-adult-addon\index.js  — bundled adult catalogs addon
//   node\node.exe                 — portable Node.js runtime
//
// Ports (all loopback-only):
//   7000  — adult addon (HTTP)
//   9696  — Prowlarr
//   11470 — Stremio streaming server (base)
//   12470 — CORS proxy (base)
//   12471 — audio extract (base)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Threading;

class StremioLauncherFULL
{
    const int PROWLARR_PORT = 9696;
    const int ADDON_PORT = 7000;

    static Process _prowlarrProc;
    static Process _addonProc;
    static Process _baseProc;

    static int Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        Console.WriteLine("[FULL] StremioLauncherFULL starting from: " + baseDir);

        // Resolve bundled paths
        string prowlarrExe = Path.Combine(baseDir, "prowlarr", "Prowlarr.exe");
        string prowlarrDataDir = Path.Combine(baseDir, "prowlarr", "data");
        string addonEntry = Path.Combine(baseDir, "stremio-adult-addon", "index.js");
        string nodeExe = Path.Combine(baseDir, "node", "node.exe");
        string baseExe = Path.Combine(baseDir, "StremioLauncher.exe");

        // Free ports we're going to claim
        KillByPort(PROWLARR_PORT);
        KillByPort(ADDON_PORT);

        Console.CancelKeyPress += delegate { Shutdown(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };

        // Start Prowlarr
        if (File.Exists(prowlarrExe))
        {
            StartProwlarr(prowlarrExe);
            WaitForPort(PROWLARR_PORT, "Prowlarr", 20);
        }
        else
        {
            Console.WriteLine("[FULL] [WARN] Prowlarr not found at " + prowlarrExe);
            Console.WriteLine("[FULL]        Adult catalogs will be empty until Prowlarr is available.");
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
            Console.WriteLine("[FULL] [WARN] Adult addon not found at " + addonEntry);
        }

        // Start the base launcher (it handles streaming server, CORS proxy, audio,
        // Stremio shell window styling, and the webui navigation).
        if (!File.Exists(baseExe))
        {
            Console.WriteLine("[FULL] [FATAL] StremioLauncher.exe not found at " + baseExe);
            Console.WriteLine("[FULL]         FULL launcher must be placed next to the base launcher.");
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
                WorkingDirectory = baseDir
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

    // ── Service startup ──────────────────────────────────────

    static void StartProwlarr(string prowlarrExe)
    {
        try
        {
            // Prowlarr data directory lives next to the exe so everything is portable.
            string dataDir = Path.Combine(Path.GetDirectoryName(prowlarrExe), "data");
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
            // Tell the addon where Prowlarr's config.xml lives so it can auto-discover
            // the API key without user configuration.
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
        // _baseProc normally exits on its own before Shutdown() runs; if not, kill it too.
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

    // ── Port cleanup (borrowed pattern from StremioLauncher) ──

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
