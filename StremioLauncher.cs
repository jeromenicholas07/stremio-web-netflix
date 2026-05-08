using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class StremioLauncher
{
    static string _ffmpeg;
    static TcpListener _audioTcp;
    static TcpListener _corsTcp;
    static Process _serverProc;

    // ── Debug console (winexe by default — no terminal popup) ──
    // Compiled with /target:winexe so the launcher runs without a console
    // window. If the user has flipped the "Debug" toggle in settings, a
    // shared flag file exists and we attach a console at startup.
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
            // Console.* caches handles before AllocConsole runs — re-bind to
            // the new console's stdout/stderr or the writes go nowhere.
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

        // Kill any previous instances and free ports
        KillExisting();

        // Find Stremio Shell
        string shell = FindShell();
        if (shell == null)
        {
            Console.WriteLine("Stremio not found. Install from https://www.stremio.com/downloads");
            Console.WriteLine("Press any key to exit...");
            Console.ReadKey();
            return 1;
        }

        string stremioDir = Path.GetDirectoryName(shell);
        _ffmpeg = FindFFmpeg(stremioDir);

        // Start CORS proxy FIRST (port 12470) — must bind before streaming server
        // so the streaming server's HTTPS endpoint on 12470 gracefully fails,
        // and all browser requests go through our CORS proxy instead.
        try
        {
            _corsTcp = new TcpListener(IPAddress.Loopback, 12470);
            _corsTcp.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _corsTcp.Start();
            new Thread(CorsAcceptLoop) { IsBackground = true }.Start();
            Console.WriteLine("[OK] CORS proxy on :12470");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] CORS proxy failed to start: " + ex.Message);
        }

        // Start the streaming server (port 11470) — required for everything.
        // Its HTTPS endpoint on 12470 will fail (our CORS proxy is there) — that's fine.
        StartStreamingServer(stremioDir);

        // Start audio extraction server (port 12471)
        if (_ffmpeg != null)
        {
            try
            {
                _audioTcp = new TcpListener(IPAddress.Loopback, 12471);
                _audioTcp.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                _audioTcp.Start();
                new Thread(AudioAcceptLoop) { IsBackground = true }.Start();
                Console.WriteLine("[OK] Audio extract server on :12471 (FFmpeg: " + _ffmpeg + ")");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[WARN] Audio server failed to start: " + ex.Message);
            }
        }
        else
        {
            Console.WriteLine("[INFO] FFmpeg not found - subtitle sync will use HLS fallback");
        }

        // (No artificial wait here — shell launch proceeds immediately.
        //  The streaming server's port-readiness check runs on a background
        //  thread inside StartStreamingServer.)

        // Graceful shutdown on Ctrl+C or console close
        Console.CancelKeyPress += delegate { Shutdown(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };

        // Launch Stremio Shell with dev tools enabled
        // Pass streamingServerUrl via hash param so SearchParamsHandler configures
        // stremio-core to use our CORS proxy (12470) instead of direct 11470.
        string webuiUrl = "https://jeromenicholas07.github.io/stremio-web-netflix/"
            + "#/?streamingServerUrl=" + Uri.EscapeDataString("http://127.0.0.1:12470/");
        Console.WriteLine("[OK] Launching Stremio...");
        Console.WriteLine("[INFO] URL: " + webuiUrl);
        var proc = Process.Start(shell, "--webui-url=" + webuiUrl + " --development");

        // Maximize window + apply dark title bar once the main window appears.
        new Thread(() => ApplyWindowStyling(proc)) { IsBackground = true }.Start();

        proc.WaitForExit();
        Console.WriteLine("[INFO] Stremio exited with code " + proc.ExitCode);

        Shutdown();
        return 0;
    }

    // ── Filtered server logging ──────────────────────────────
    //
    // Stremio's streaming server probes ffmpeg's available formats, codecs,
    // encoders and decoders at startup, dumping hundreds of lines that look
    // like `Stream #0:0`, `[mov,mp4,m4a @ 0x...]`, `D.V... vp9 ...`. None of
    // it's actionable; we drop those and let everything else through.
    // Genuine errors / warnings ALWAYS pass.
    static void WriteServerLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        string t = line.TrimStart();

        // Always show errors, warnings, and "cannot/failed" diagnostics.
        if (HasAny(line, new[] { "error", "exception", "failed", "fatal", "warn", "cannot", "unable", "denied", "refused" }))
        {
            ConsoleColor prev = Console.ForegroundColor;
            try
            {
                Console.ForegroundColor = HasAny(line, new[] { "error", "exception", "fatal", "failed" })
                    ? ConsoleColor.Red : ConsoleColor.Yellow;
                Console.WriteLine("[server] " + line);
            }
            finally { Console.ForegroundColor = prev; }
            return;
        }

        // Drop ffmpeg probe banners + per-format / per-codec diagnostic lines.
        if (t.StartsWith("ffmpeg version") || t.StartsWith("built with") ||
            t.StartsWith("configuration:") || t.StartsWith("lib") ||
            t.StartsWith("Input #") || t.StartsWith("Output #") ||
            t.StartsWith("Stream #") || t.StartsWith("Stream mapping") ||
            t.StartsWith("Press [q]") || t.StartsWith("size=") ||
            t.StartsWith("frame=") || t.StartsWith("video:") || t.StartsWith("audio:")) return;
        // Per-format diagnostic prefix: `[mov,mp4,m4a @ 0x...]` / `[aac @ 0x...]`
        if (t.Length > 1 && t[0] == '[' && t.IndexOf("@ 0x") > 0) return;
        // Codec capability rows: ` D.V... vp9   On2 VP9 ...`
        if (t.Length > 7 && (t.StartsWith("D.") || t.StartsWith(".V")
            || t.StartsWith(".A") || t.StartsWith("..S") || t.StartsWith("D.V")
            || t.StartsWith(".EV") || t.StartsWith(".EA"))) return;

        Console.WriteLine("[server] " + line);
    }

    static bool HasAny(string s, string[] keywords)
    {
        if (string.IsNullOrEmpty(s)) return false;
        for (int i = 0; i < keywords.Length; i++)
        {
            if (s.IndexOf(keywords[i], StringComparison.OrdinalIgnoreCase) >= 0) return true;
        }
        return false;
    }

    static int _shutdown = 0;
    static void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return;
        Console.WriteLine("Shutting down...");
        try { if (_audioTcp != null) _audioTcp.Stop(); } catch { }
        try { if (_corsTcp != null) _corsTcp.Stop(); } catch { }
        try { if (_serverProc != null && !_serverProc.HasExited) _serverProc.Kill(); } catch { }
    }

    static void StartStreamingServer(string stremioDir)
    {
        // Check if streaming server is already running on 11470
        try
        {
            var test = new TcpClient();
            test.Connect(IPAddress.Loopback, 11470);
            test.Close();
            Console.WriteLine("[OK] Streaming server already running on :11470");
            return;
        }
        catch { /* not running, start it */ }

        string runtime = Path.Combine(stremioDir, "stremio-runtime.exe");
        string serverJs = Path.Combine(stremioDir, "server.js");

        if (!File.Exists(runtime) || !File.Exists(serverJs))
        {
            // Try node from PATH as fallback
            runtime = "node";
            if (!File.Exists(serverJs))
            {
                Console.WriteLine("[WARN] Streaming server not found — streaming will not work");
                return;
            }
        }

        try
        {
            var psi = new ProcessStartInfo(runtime, "\"" + serverJs + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            _serverProc = Process.Start(psi);

            // Log server output in background — filtered to drop FFmpeg
            // codec/encoder probe spam. Genuine errors / warnings still pass.
            new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = _serverProc.StandardOutput.ReadLine()) != null)
                        WriteServerLine(line);
                }
                catch { }
            }) { IsBackground = true }.Start();

            new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = _serverProc.StandardError.ReadLine()) != null)
                        WriteServerLine(line);
                }
                catch { }
            }) { IsBackground = true }.Start();

            // Background-poll for port readiness instead of blocking the main
            // thread. The shell launches immediately after the server PROCESS
            // spawns; the web UI gracefully retries until 11470 is listening.
            // Saves up to ~10s of perceived startup time on cold starts.
            new Thread(() =>
            {
                for (int i = 0; i < 60; i++)
                {
                    try
                    {
                        var test = new TcpClient();
                        test.Connect(IPAddress.Loopback, 11470);
                        test.Close();
                        Console.WriteLine("[OK] Streaming server listening on :11470");
                        return;
                    }
                    catch { }
                    Thread.Sleep(500);
                }
                Console.WriteLine("[WARN] Streaming server started but port 11470 still not responding after 30s");
            }) { IsBackground = true }.Start();
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] Failed to start streaming server: " + ex.Message);
        }
    }

    // ── Window styling (fullscreen + dark title bar) ─────────

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    const int SW_MAXIMIZE = 3;
    // DWMWA_USE_IMMERSIVE_DARK_MODE: 20 on Win10 20H1+/Win11, 19 on older builds
    const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    const int DWMWA_USE_IMMERSIVE_DARK_MODE_LEGACY = 19;
    const uint WM_SETICON = 0x0080;
    const int ICON_SMALL = 0;
    const int ICON_BIG = 1;
    const int ICON_SMALL2 = 2;

    static void ApplyWindowStyling(Process proc)
    {
        try
        {
            IntPtr hWnd = IntPtr.Zero;
            // Poll for the main window to appear (shell launches, then creates the window)
            for (int i = 0; i < 100; i++)
            {
                if (proc.HasExited) return;
                try { proc.Refresh(); hWnd = proc.MainWindowHandle; } catch { }
                if (hWnd != IntPtr.Zero && IsWindowVisible(hWnd)) break;
                Thread.Sleep(150);
            }
            if (hWnd == IntPtr.Zero)
            {
                Console.WriteLine("[WindowStyle] Could not locate Stremio window");
                return;
            }

            // Force dark title bar (Win10 20H1+ / Win11)
            int useDark = 1;
            int hr = DwmSetWindowAttribute(hWnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref useDark, sizeof(int));
            if (hr != 0)
                DwmSetWindowAttribute(hWnd, DWMWA_USE_IMMERSIVE_DARK_MODE_LEGACY, ref useDark, sizeof(int));

            // Override the Stremio shell window's icon with the launcher's
            // own embedded icon — title bar, taskbar, and Alt-Tab all pick
            // up WM_SETICON, so the user sees our diamond instead of the
            // default Stremio purple icon.
            try
            {
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                IntPtr[] large = new IntPtr[1];
                IntPtr[] small = new IntPtr[1];
                if (ExtractIconEx(exePath, 0, large, small, 1) > 0)
                {
                    if (large[0] != IntPtr.Zero)
                    {
                        SendMessage(hWnd, WM_SETICON, (IntPtr)ICON_BIG, large[0]);
                    }
                    if (small[0] != IntPtr.Zero)
                    {
                        SendMessage(hWnd, WM_SETICON, (IntPtr)ICON_SMALL, small[0]);
                        SendMessage(hWnd, WM_SETICON, (IntPtr)ICON_SMALL2, small[0]);
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("[WindowStyle] Icon override failed: " + ex.Message);
            }

            // Maximize (full-screen window)
            ShowWindow(hWnd, SW_MAXIMIZE);
            SetForegroundWindow(hWnd);
            Console.WriteLine("[WindowStyle] Applied: maximized + dark title bar + custom icon");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WindowStyle] Error: " + ex.Message);
        }
    }

    // ── Startup cleanup ──────────────────────────────────────

    static void KillExisting()
    {
        int myPid = Process.GetCurrentProcess().Id;
        string myName = Process.GetCurrentProcess().ProcessName;

        // Kill previous launcher instances
        foreach (var p in Process.GetProcessesByName(myName))
        {
            if (p.Id == myPid) continue;
            try
            {
                Console.WriteLine("[CLEANUP] Killing previous launcher (PID " + p.Id + ")");
                p.Kill();
                p.WaitForExit(3000);
            }
            catch { }
        }

        // Kill leftover PowerShell processes from old .bat launcher
        foreach (var p in Process.GetProcessesByName("powershell"))
        {
            try
            {
                string title = p.MainWindowTitle;
                if (title == "StremioProxy" || title == "StremioAudioExtract")
                {
                    Console.WriteLine("[CLEANUP] Killing old PowerShell process: " + title + " (PID " + p.Id + ")");
                    p.Kill();
                    p.WaitForExit(3000);
                }
            }
            catch { }
        }

        // Kill any process holding our ports
        KillByPort(12471);
        KillByPort(12470);

        // If HTTP.sys (PID 4) is still squatting on our ports, restart the HTTP service to release them
        // This requires admin privileges
        if (IsPortHeldBySystem(12470) || IsPortHeldBySystem(12471))
        {
            Console.WriteLine("[CLEANUP] HTTP.sys holding ports - restarting HTTP service (needs admin)...");
            try
            {
                var psi = new ProcessStartInfo("cmd.exe", "/c net stop http /y && net start http")
                {
                    Verb = "runas",
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                var p = Process.Start(psi);
                p.WaitForExit(15000);
                Thread.Sleep(1000);
            }
            catch (Exception ex)
            {
                Console.WriteLine("[WARN] Could not restart HTTP service: " + ex.Message);
            }
        }
    }

    static bool IsPortHeldBySystem(int port)
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

            string search = "127.0.0.1:" + port;
            foreach (string line in output.Split('\n'))
            {
                if (line.IndexOf(search) < 0 || line.IndexOf("LISTENING") < 0) continue;
                string[] parts = line.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                int pid;
                if (int.TryParse(parts[parts.Length - 1], out pid) && pid == 4)
                    return true;
            }
        }
        catch { }
        return false;
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
                        Console.WriteLine("[CLEANUP] Killing process on port " + port + ": " + p.ProcessName + " (PID " + pid + ")");
                        p.Kill();
                        p.WaitForExit(3000);
                    }
                    catch { }
                }
            }
        }
        catch { }
    }

    static void RunCmd(string exe, string args)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var p = Process.Start(psi);
            p.StandardOutput.ReadToEnd();
            p.WaitForExit(10000);
        }
        catch { }
    }

    // ── Find Stremio / FFmpeg ────────────────────────────────

    static string FindShell()
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string progX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

        string[] candidates = {
            Path.Combine(local, "Programs", "Stremio", "stremio-shell-ng.exe"),
            Path.Combine(local, "Programs", "LNV", "Stremio-4", "stremio-shell-ng.exe"),
            Path.Combine(progFiles, "Stremio", "stremio-shell-ng.exe"),
            Path.Combine(progX86, "Stremio", "stremio-shell-ng.exe"),
        };

        foreach (var c in candidates)
            if (File.Exists(c)) return c;
        return null;
    }

    static string FindFFmpeg(string stremioDir)
    {
        string inStremio = Path.Combine(stremioDir, "ffmpeg.exe");
        if (File.Exists(inStremio)) return inStremio;

        string inRuntime = Path.Combine(stremioDir, "stremio-runtime", "ffmpeg.exe");
        if (File.Exists(inRuntime)) return inRuntime;

        try
        {
            var psi = new ProcessStartInfo("ffmpeg", "-version")
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            var p = Process.Start(psi);
            p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            if (p.ExitCode == 0) return "ffmpeg";
        }
        catch { }

        return null;
    }

    // ── Minimal HTTP helpers (no HttpListener/HTTP.sys) ──────

    static string ReadHttpRequest(Stream s, out string method, out string path, out string queryString, out Dictionary<string, string> headers)
    {
        // Read until \r\n\r\n
        var buf = new List<byte>();
        int prev3 = 0, prev2 = 0, prev1 = 0;
        while (true)
        {
            int b = s.ReadByte();
            if (b < 0) break;
            buf.Add((byte)b);
            if (prev2 == '\r' && prev1 == '\n' && b == '\n' && prev3 == '\r') break; // ..but we check prev char
            // Simpler: check for \r\n\r\n at end
            if (buf.Count >= 4)
            {
                int l = buf.Count;
                if (buf[l - 4] == '\r' && buf[l - 3] == '\n' && buf[l - 2] == '\r' && buf[l - 1] == '\n') break;
            }
            prev3 = prev2; prev2 = prev1; prev1 = b;
        }

        string raw = Encoding.ASCII.GetString(buf.ToArray());
        string[] lines = raw.Split(new string[] { "\r\n" }, StringSplitOptions.None);

        method = "GET"; path = "/"; queryString = "";
        headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        if (lines.Length > 0)
        {
            string[] reqParts = lines[0].Split(' ');
            if (reqParts.Length >= 2)
            {
                method = reqParts[0];
                string fullPath = reqParts[1];
                int qIdx = fullPath.IndexOf('?');
                if (qIdx >= 0)
                {
                    path = fullPath.Substring(0, qIdx);
                    queryString = fullPath.Substring(qIdx + 1);
                }
                else
                {
                    path = fullPath;
                }
            }
        }

        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon > 0)
            {
                string key = lines[i].Substring(0, colon).Trim();
                string val = lines[i].Substring(colon + 1).Trim();
                headers[key] = val;
            }
        }

        return raw;
    }

    static string GetQueryParam(string queryString, string name)
    {
        if (string.IsNullOrEmpty(queryString)) return null;
        foreach (string part in queryString.Split('&'))
        {
            int eq = part.IndexOf('=');
            if (eq < 0) continue;
            string key = Uri.UnescapeDataString(part.Substring(0, eq));
            if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase))
                return Uri.UnescapeDataString(part.Substring(eq + 1));
        }
        return null;
    }

    // ── Internal launcher control endpoints ──────────────────
    // GET  /_launcher/debug     → {"enabled": <bool>}
    // POST /_launcher/debug     body: {"enabled": <bool>}
    //   ↳ writes/removes the flag file at %LOCALAPPDATA%\StremioLauncherFULL\debug.flag.
    //     Read by both launcher .exes at startup to decide whether to attach
    //     a console window (AllocConsole). Takes effect on next Stremio start.
    static void HandleLauncherControl(Stream stream, string method, string path, Dictionary<string, string> reqHeaders)
    {
        if (path == "/_launcher/debug")
        {
            string flagPath = DebugFlagPath();
            if (method == "GET")
            {
                bool enabled = File.Exists(flagPath);
                WriteResponse(stream, 200, "application/json",
                    Encoding.UTF8.GetBytes("{\"enabled\":" + (enabled ? "true" : "false") + "}"), true);
                return;
            }
            if (method == "POST")
            {
                string body = ReadRequestBody(stream, reqHeaders);
                bool enabled = body != null && body.IndexOf("\"enabled\"", StringComparison.Ordinal) >= 0
                    && body.IndexOf("true", StringComparison.Ordinal) >= 0;
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(flagPath));
                    if (enabled) File.WriteAllText(flagPath, "1");
                    else if (File.Exists(flagPath)) File.Delete(flagPath);
                    WriteResponse(stream, 200, "application/json",
                        Encoding.UTF8.GetBytes("{\"ok\":true,\"enabled\":" + (enabled ? "true" : "false") + "}"), true);
                }
                catch (Exception ex)
                {
                    WriteResponse(stream, 500, "application/json",
                        Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"" + ex.Message.Replace("\"", "\\\"") + "\"}"), true);
                }
                return;
            }
            WriteResponse(stream, 405, "text/plain", Encoding.UTF8.GetBytes("Method Not Allowed"), true);
            return;
        }
        WriteResponse(stream, 404, "text/plain", Encoding.UTF8.GetBytes("Not Found"), true);
    }

    static string ReadRequestBody(Stream stream, Dictionary<string, string> reqHeaders)
    {
        string clStr;
        int len = 0;
        if (reqHeaders.TryGetValue("Content-Length", out clStr))
            int.TryParse(clStr, out len);
        if (len <= 0) return string.Empty;
        byte[] buf = new byte[len];
        int read = 0;
        while (read < len)
        {
            int n = stream.Read(buf, read, len - read);
            if (n <= 0) break;
            read += n;
        }
        return Encoding.UTF8.GetString(buf, 0, read);
    }

    static void WriteResponse(Stream s, int statusCode, string contentType, byte[] body, bool cors)
    {
        string statusText = statusCode == 200 ? "OK" : statusCode == 204 ? "No Content" :
            statusCode == 400 ? "Bad Request" : statusCode == 404 ? "Not Found" :
            statusCode == 500 ? "Internal Server Error" : statusCode == 504 ? "Gateway Timeout" : "Error";

        var sb = new StringBuilder();
        sb.AppendFormat("HTTP/1.1 {0} {1}\r\n", statusCode, statusText);
        if (cors)
        {
            sb.Append("Access-Control-Allow-Origin: *\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            sb.Append("Access-Control-Allow-Headers: *\r\n");
        }
        if (contentType != null)
            sb.AppendFormat("Content-Type: {0}\r\n", contentType);
        if (body != null)
            sb.AppendFormat("Content-Length: {0}\r\n", body.Length);
        sb.Append("Connection: close\r\n");
        sb.Append("\r\n");

        byte[] header = Encoding.ASCII.GetBytes(sb.ToString());
        s.Write(header, 0, header.Length);
        if (body != null && body.Length > 0)
            s.Write(body, 0, body.Length);
    }

    // ── Audio Extraction Server ──────────────────────────────

    static void AudioAcceptLoop()
    {
        while (true)
        {
            TcpClient client;
            try { client = _audioTcp.AcceptTcpClient(); }
            catch (Exception ex)
            {
                Console.WriteLine("[Audio] Accept loop ended: " + ex.Message);
                break;
            }
            var c = client;
            ThreadPool.QueueUserWorkItem(_ => HandleAudioRequest(c));
        }
    }

    static void HandleAudioRequest(TcpClient client)
    {
        try
        {
            using (client)
            using (var stream = client.GetStream())
            {
                stream.ReadTimeout = 10000;
                string method, path, qs;
                Dictionary<string, string> headers;
                ReadHttpRequest(stream, out method, out path, out qs, out headers);

                if (method == "OPTIONS")
                {
                    WriteResponse(stream, 204, null, null, true);
                    return;
                }

                if (path == "/health")
                {
                    string json = "{\"status\":\"ok\",\"ffmpeg\":\"" + _ffmpeg.Replace("\\", "\\\\") + "\"}";
                    WriteResponse(stream, 200, "application/json", Encoding.UTF8.GetBytes(json), true);
                    return;
                }

                if (path != "/audio-extract")
                {
                    WriteResponse(stream, 404, "text/plain", Encoding.UTF8.GetBytes("Not found"), true);
                    return;
                }

                string mediaURL = GetQueryParam(qs, "mediaURL");
                string start = GetQueryParam(qs, "start") ?? "0";
                string duration = GetQueryParam(qs, "duration") ?? "5";

                if (string.IsNullOrEmpty(mediaURL))
                {
                    WriteResponse(stream, 400, "text/plain", Encoding.UTF8.GetBytes("Missing mediaURL"), true);
                    return;
                }

                // Build FFmpeg arguments — URL is always quoted.
                // -seekable 1 + -ss before -i: fast seek via HTTP range requests.
                // -reconnect flags: retry on transient 5xx or dropped connections.
                // -analyzeduration/probesize: don't read huge amounts before seeking.
                string ffArgs = string.Format(
                    "-seekable 1 -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 " +
                    "-analyzeduration 2000000 -probesize 1000000 " +
                    "-ss {0} -i \"{1}\" -t {2} -vn -ac 1 -ar 16000 -f f32le -y pipe:1",
                    start, mediaURL, duration);

                string customHeaders = GetQueryParam(qs, "headers");
                if (!string.IsNullOrEmpty(customHeaders))
                    ffArgs = string.Format("-headers \"{0}\r\n\" {1}", customHeaders, ffArgs);

                // Per-request start/done lines are noisy on a 4K terminal. We
                // log failures only — successes pass silently and the audio
                // bytes themselves are the success signal.

                var psi = new ProcessStartInfo(_ffmpeg, ffArgs)
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };

                var proc = Process.Start(psi);
                StringBuilder stderrBuf = new StringBuilder();
                proc.ErrorDataReceived += (s, e) => { if (e.Data != null) stderrBuf.AppendLine(e.Data); };
                proc.BeginErrorReadLine();

                var ms = new MemoryStream();
                proc.StandardOutput.BaseStream.CopyTo(ms);

                if (!proc.WaitForExit(30000))
                {
                    try { proc.Kill(); } catch { }
                    WriteResponse(stream, 504, "text/plain", Encoding.UTF8.GetBytes("FFmpeg timed out (30s)"), true);
                    return;
                }

                if (proc.ExitCode != 0)
                {
                    string stderr = stderrBuf.ToString();
                    string tail = stderr.Length > 300 ? stderr.Substring(stderr.Length - 300) : stderr;
                    LogError("[Extract] FAILED (exit code " + proc.ExitCode + ") @ " + start + "s — " + tail);
                    WriteResponse(stream, 500, "text/plain",
                        Encoding.UTF8.GetBytes("FFmpeg error (code " + proc.ExitCode + "): " + tail), true);
                    return;
                }

                byte[] pcm = ms.ToArray();
                if (pcm.Length == 0)
                {
                    string stderr = stderrBuf.ToString();
                    string tail = stderr.Length > 400 ? stderr.Substring(stderr.Length - 400) : stderr;
                    LogError("[Extract] FAILED (0 bytes) @ " + start + "s — " + tail);
                    WriteResponse(stream, 500, "text/plain",
                        Encoding.UTF8.GetBytes("FFmpeg returned 0 bytes. stderr: " + tail), true);
                    return;
                }
                WriteResponse(stream, 200, "application/octet-stream", pcm, true);
            }
        }
        catch (Exception ex)
        {
            LogError("[Extract] Error: " + ex.Message);
        }
    }

    // Red-coloured error line. Shared by extract + (could-be-shared by other
    // callers if we want to swap their plain Console.WriteLine for this).
    static void LogError(string line)
    {
        ConsoleColor prev = Console.ForegroundColor;
        try { Console.ForegroundColor = ConsoleColor.Red; Console.WriteLine(line); }
        finally { Console.ForegroundColor = prev; }
    }

    // ── CORS Proxy ───────────────────────────────────────────

    static void CorsAcceptLoop()
    {
        while (true)
        {
            TcpClient client;
            try { client = _corsTcp.AcceptTcpClient(); }
            catch (Exception ex)
            {
                Console.WriteLine("[CORS] Accept loop ended: " + ex.Message);
                break;
            }
            var c = client;
            ThreadPool.QueueUserWorkItem(_ => HandleCorsRequest(c));
        }
    }

    static void HandleCorsRequest(TcpClient client)
    {
        try
        {
            using (client)
            using (var stream = client.GetStream())
            {
                stream.ReadTimeout = 10000;
                string method, path, qs;
                Dictionary<string, string> reqHeaders;
                ReadHttpRequest(stream, out method, out path, out qs, out reqHeaders);

                if (method == "OPTIONS")
                {
                    WriteResponse(stream, 204, null, null, true);
                    return;
                }

                // Internal launcher control endpoints — handled here instead
                // of being proxied to the streaming server.
                if (path.StartsWith("/_launcher/"))
                {
                    HandleLauncherControl(stream, method, path, reqHeaders);
                    return;
                }

                string pathAndQuery = string.IsNullOrEmpty(qs) ? path : path + "?" + qs;
                string targetUrl = "http://127.0.0.1:11470" + pathAndQuery;

                var wr = (HttpWebRequest)WebRequest.Create(targetUrl);
                wr.Method = method;
                wr.Timeout = 120000;
                wr.ServicePoint.Expect100Continue = false;

                string ct;
                if (reqHeaders.TryGetValue("Content-Type", out ct))
                    wr.ContentType = ct;

                if (method != "GET" && method != "HEAD")
                {
                    string clStr;
                    int contentLen = 0;
                    if (reqHeaders.TryGetValue("Content-Length", out clStr))
                        int.TryParse(clStr, out contentLen);

                    if (contentLen > 0)
                    {
                        byte[] body = new byte[contentLen];
                        int read = 0;
                        while (read < contentLen)
                        {
                            int n = stream.Read(body, read, contentLen - read);
                            if (n <= 0) break;
                            read += n;
                        }
                        using (var rs = wr.GetRequestStream())
                            rs.Write(body, 0, read);
                    }
                }

                HttpWebResponse upstream;
                try
                {
                    upstream = (HttpWebResponse)wr.GetResponse();
                }
                catch (WebException wex)
                {
                    upstream = wex.Response as HttpWebResponse;
                    if (upstream == null)
                    {
                        WriteResponse(stream, 502, "text/plain", Encoding.UTF8.GetBytes("Bad Gateway"), true);
                        return;
                    }
                }

                using (upstream)
                {
                    // Build response with CORS headers
                    var sb = new StringBuilder();
                    sb.AppendFormat("HTTP/1.1 {0} {1}\r\n", (int)upstream.StatusCode, upstream.StatusDescription);
                    sb.Append("Access-Control-Allow-Origin: *\r\n");
                    if (upstream.ContentType != null)
                        sb.AppendFormat("Content-Type: {0}\r\n", upstream.ContentType);
                    if (upstream.ContentLength >= 0)
                        sb.AppendFormat("Content-Length: {0}\r\n", upstream.ContentLength);
                    sb.Append("Connection: close\r\n");
                    sb.Append("\r\n");

                    byte[] header = Encoding.ASCII.GetBytes(sb.ToString());
                    stream.Write(header, 0, header.Length);

                    using (var us = upstream.GetResponseStream())
                    {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = us.Read(buf, 0, buf.Length)) > 0)
                            stream.Write(buf, 0, n);
                    }
                }
            }
        }
        catch { }
    }
}
