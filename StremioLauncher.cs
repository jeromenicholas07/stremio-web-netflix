using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

class StremioLauncher
{
    static string _ffmpeg;
    static TcpListener _audioTcp;
    static TcpListener _corsTcp;

    static int Main()
    {
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

        // Start CORS proxy (port 12470)
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

        Thread.Sleep(500);

        // Graceful shutdown on Ctrl+C or console close
        Console.CancelKeyPress += delegate { Shutdown(); };
        AppDomain.CurrentDomain.ProcessExit += delegate { Shutdown(); };

        // Launch Stremio Shell
        Console.WriteLine("[OK] Launching Stremio...");
        var proc = Process.Start(shell, "--webui-url=https://jeromenicholas07.github.io/stremio-web-netflix/");
        proc.WaitForExit();

        Shutdown();
        return 0;
    }

    static int _shutdown = 0;
    static void Shutdown()
    {
        if (Interlocked.Exchange(ref _shutdown, 1) == 1) return;
        Console.WriteLine("Shutting down...");
        try { if (_audioTcp != null) _audioTcp.Stop(); } catch { }
        try { if (_corsTcp != null) _corsTcp.Stop(); } catch { }
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
            catch { break; }
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

                // Build FFmpeg arguments — URL is always quoted
                string ffArgs = string.Format(
                    "-ss {0} -i \"{1}\" -t {2} -vn -ac 1 -ar 16000 -f f32le -y pipe:1",
                    start, mediaURL, duration);

                string customHeaders = GetQueryParam(qs, "headers");
                if (!string.IsNullOrEmpty(customHeaders))
                    ffArgs = string.Format("-headers \"{0}\r\n\" {1}", customHeaders, ffArgs);

                Console.WriteLine("[Extract] start={0}s dur={1}s url={2}...",
                    start, duration, mediaURL.Length > 80 ? mediaURL.Substring(0, 80) : mediaURL);

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
                    Console.WriteLine("[Extract] FFmpeg exit code {0}", proc.ExitCode);
                    WriteResponse(stream, 500, "text/plain",
                        Encoding.UTF8.GetBytes("FFmpeg error (code " + proc.ExitCode + "): " + tail), true);
                    return;
                }

                byte[] pcm = ms.ToArray();
                Console.WriteLine("[Extract] Done - {0} bytes ({1:F1}s of audio)",
                    pcm.Length, (double)pcm.Length / 4.0 / 16000.0);
                WriteResponse(stream, 200, "application/octet-stream", pcm, true);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[Extract] Error: " + ex.Message);
        }
    }

    // ── CORS Proxy ───────────────────────────────────────────

    static void CorsAcceptLoop()
    {
        while (true)
        {
            TcpClient client;
            try { client = _corsTcp.AcceptTcpClient(); }
            catch { break; }
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
