using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;

class StremioLauncher
{
    static string _ffmpeg;
    static HttpListener _audioLn;
    static HttpListener _corsLn;

    static int Main()
    {
        // Kill any previous launcher instances
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

        // Start audio extraction server
        if (_ffmpeg != null)
        {
            try
            {
                _audioLn = new HttpListener();
                _audioLn.Prefixes.Add("http://127.0.0.1:12471/");
                _audioLn.Start();
                new Thread(AudioLoop) { IsBackground = true }.Start();
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

        // Start CORS proxy
        try
        {
            _corsLn = new HttpListener();
            _corsLn.Prefixes.Add("http://127.0.0.1:12470/");
            _corsLn.Start();
            new Thread(CorsLoop) { IsBackground = true }.Start();
            Console.WriteLine("[OK] CORS proxy on :12470");
        }
        catch (Exception ex)
        {
            Console.WriteLine("[WARN] CORS proxy failed to start: " + ex.Message);
        }

        Thread.Sleep(500);

        // Launch Stremio Shell
        Console.WriteLine("[OK] Launching Stremio...");
        var proc = Process.Start(shell, "--webui-url=https://jeromenicholas07.github.io/stremio-web-netflix/");
        proc.WaitForExit();

        // Cleanup
        Console.WriteLine("Stremio closed. Cleaning up...");
        try { if (_audioLn != null) _audioLn.Stop(); } catch { }
        try { if (_corsLn != null) _corsLn.Stop(); } catch { }
        return 0;
    }

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
        // 1. Same directory as Stremio Shell
        string inStremio = Path.Combine(stremioDir, "ffmpeg.exe");
        if (File.Exists(inStremio)) return inStremio;

        // 2. stremio-runtime subdirectory
        string inRuntime = Path.Combine(stremioDir, "stremio-runtime", "ffmpeg.exe");
        if (File.Exists(inRuntime)) return inRuntime;

        // 3. System PATH
        try
        {
            var psi = new ProcessStartInfo("ffmpeg", "-version")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            var p = Process.Start(psi);
            p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            if (p.ExitCode == 0) return "ffmpeg";
        }
        catch { }

        return null;
    }

    static void KillExisting()
    {
        int myPid = Process.GetCurrentProcess().Id;

        // Kill previous launcher instances
        string myName = Process.GetCurrentProcess().ProcessName;
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

        // Kill anything holding our ports (e.g. leftover PowerShell processes)
        KillByPort(12471);
        KillByPort(12470);

        // Brief pause for ports to release
        Thread.Sleep(500);
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
                if (line.IndexOf(search) < 0) continue;
                if (line.IndexOf("LISTENING") < 0) continue;
                string trimmed = line.Trim();
                string[] parts = trimmed.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 5) continue;
                int pid;
                if (int.TryParse(parts[parts.Length - 1], out pid) && pid != myPid && pid != 0)
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

    // ── Audio Extraction Server ──────────────────────────────

    static void AudioLoop()
    {
        while (_audioLn.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = _audioLn.GetContext(); }
            catch { break; }

            ThreadPool.QueueUserWorkItem(_ => HandleAudio(ctx));
        }
    }

    static void HandleAudio(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;

        res.AddHeader("Access-Control-Allow-Origin", "*");
        res.AddHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.AddHeader("Access-Control-Allow-Headers", "*");

        try
        {
            if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; res.Close(); return; }

            string path = req.Url.AbsolutePath;

            if (path == "/health")
            {
                string json = "{\"status\":\"ok\",\"ffmpeg\":\"" + _ffmpeg.Replace("\\", "\\\\") + "\"}";
                byte[] b = Encoding.UTF8.GetBytes(json);
                res.ContentType = "application/json";
                res.OutputStream.Write(b, 0, b.Length);
                res.Close();
                return;
            }

            if (path != "/audio-extract") { res.StatusCode = 404; res.Close(); return; }

            string mediaURL = req.QueryString["mediaURL"];
            string start = req.QueryString["start"] ?? "0";
            string duration = req.QueryString["duration"] ?? "5";

            if (string.IsNullOrEmpty(mediaURL))
            {
                res.StatusCode = 400;
                byte[] b = Encoding.UTF8.GetBytes("Missing mediaURL");
                res.OutputStream.Write(b, 0, b.Length);
                res.Close();
                return;
            }

            // Build FFmpeg arguments — URL is always quoted
            string args = string.Format(
                "-ss {0} -i \"{1}\" -t {2} -vn -ac 1 -ar 16000 -f f32le -y pipe:1",
                start, mediaURL, duration);

            string hdrs = req.QueryString["headers"];
            if (!string.IsNullOrEmpty(hdrs))
                args = string.Format("-headers \"{0}\r\n\" {1}", hdrs, args);

            Console.WriteLine("[Extract] start={0}s dur={1}s url={2}...",
                start, duration, mediaURL.Length > 80 ? mediaURL.Substring(0, 80) : mediaURL);

            var psi = new ProcessStartInfo(_ffmpeg, args)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };

            var proc = Process.Start(psi);

            // Read stderr async to avoid deadlock
            StringBuilder stderrBuf = new StringBuilder();
            proc.ErrorDataReceived += (s, e) => { if (e.Data != null) stderrBuf.AppendLine(e.Data); };
            proc.BeginErrorReadLine();

            // Read stdout (binary PCM data)
            var ms = new MemoryStream();
            proc.StandardOutput.BaseStream.CopyTo(ms);

            if (!proc.WaitForExit(30000))
            {
                try { proc.Kill(); } catch { }
                res.StatusCode = 504;
                byte[] b = Encoding.UTF8.GetBytes("FFmpeg timed out (30s)");
                res.OutputStream.Write(b, 0, b.Length);
                res.Close();
                return;
            }

            if (proc.ExitCode != 0)
            {
                string stderr = stderrBuf.ToString();
                string tail = stderr.Length > 300 ? stderr.Substring(stderr.Length - 300) : stderr;
                Console.WriteLine("[Extract] FFmpeg exit code {0}", proc.ExitCode);
                res.StatusCode = 500;
                byte[] b = Encoding.UTF8.GetBytes("FFmpeg error (code " + proc.ExitCode + "): " + tail);
                res.OutputStream.Write(b, 0, b.Length);
                res.Close();
                return;
            }

            byte[] pcm = ms.ToArray();
            Console.WriteLine("[Extract] Done - {0} bytes ({1:F1}s of audio)",
                pcm.Length, (double)pcm.Length / 4.0 / 16000.0);

            res.ContentType = "application/octet-stream";
            res.ContentLength64 = pcm.Length;
            res.OutputStream.Write(pcm, 0, pcm.Length);
            res.Close();
        }
        catch (Exception ex)
        {
            try
            {
                res.StatusCode = 500;
                byte[] b = Encoding.UTF8.GetBytes("Error: " + ex.Message);
                res.OutputStream.Write(b, 0, b.Length);
                res.Close();
            }
            catch { }
        }
    }

    // ── CORS Proxy ───────────────────────────────────────────

    static void CorsLoop()
    {
        while (_corsLn.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = _corsLn.GetContext(); }
            catch { break; }

            ThreadPool.QueueUserWorkItem(_ => HandleCors(ctx));
        }
    }

    static void HandleCors(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var res = ctx.Response;

        try
        {
            if (req.HttpMethod == "OPTIONS")
            {
                res.AddHeader("Access-Control-Allow-Origin", "*");
                res.AddHeader("Access-Control-Allow-Methods", "*");
                res.AddHeader("Access-Control-Allow-Headers", "*");
                res.StatusCode = 204;
                res.Close();
                return;
            }

            string targetUrl = "http://127.0.0.1:11470" + req.Url.PathAndQuery;

            var wr = (HttpWebRequest)WebRequest.Create(targetUrl);
            wr.Method = req.HttpMethod;
            wr.Timeout = 120000;
            wr.ServicePoint.Expect100Continue = false;
            if (req.ContentType != null) wr.ContentType = req.ContentType;

            if (req.HttpMethod != "GET" && req.HttpMethod != "HEAD" && req.ContentLength64 > 0)
            {
                using (var rs = wr.GetRequestStream())
                    req.InputStream.CopyTo(rs);
            }

            HttpWebResponse upstream;
            try
            {
                upstream = (HttpWebResponse)wr.GetResponse();
            }
            catch (WebException wex)
            {
                upstream = wex.Response as HttpWebResponse;
                if (upstream == null) { res.StatusCode = 502; res.Close(); return; }
            }

            using (upstream)
            {
                res.AddHeader("Access-Control-Allow-Origin", "*");
                res.StatusCode = (int)upstream.StatusCode;
                if (upstream.ContentType != null) res.ContentType = upstream.ContentType;

                using (var s = upstream.GetResponseStream())
                {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                        res.OutputStream.Write(buf, 0, n);
                }
            }
            res.Close();
        }
        catch
        {
            try { res.StatusCode = 502; res.Close(); } catch { }
        }
    }
}
