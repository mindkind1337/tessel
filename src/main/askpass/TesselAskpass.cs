// Tessel's SSH_ASKPASS helper (see src/main/sshAskpass.js), and the server of
// Tessel's command-line pipe (src/main/cliServer.js).
//
// OpenSSH runs it when it needs an answer from the user: a password, a key
// passphrase, a keyboard-interactive challenge, the host key question. The
// question is argv[1] (Win32-OpenSSH starts it with CreateProcess, the prompt
// as one quoted argument); the answer goes to stdout, exit 0; exit 1 means
// "no answer" (cancelled, timed out, Tessel gone).
//
// It never shows anything itself: it asks the Tessel window that started the
// ssh pane, over the named pipe in TESSEL_ASKPASS_PIPE, with the pane's
// one-time token (TESSEL_ASKPASS_TOKEN). Only ssh passes it a question, so a
// remote program's "Password:" can never reach it.
//
// Why a small .exe and not a .cmd shim running Node: cmd.exe cuts an argument
// at its first line break (the host key question has several lines) and
// expands % and & in it (a keyboard-interactive prompt is chosen by the
// server); Electron / Node started with the prompt as argv[1] would read a
// prompt starting with "--" as an option. This program reads its argument as
// plain text and nothing else.
//
// The same program, started by Tessel as "tessel-askpass.exe --serve <name>",
// is also the pipe's server: Node cannot set a pipe's security, and a pipe
// made by Node lets every account (and the network) open it for reading. This
// one is made with an explicit DACL: full control for the current user only,
// network logons denied. It relays each question to Tessel on stdout and
// takes the answers on stdin (private pipes to its parent), and ends when
// Tessel does.
//
// Built with the C# compiler of the .NET Framework that ships with Windows
// (scripts/build-askpass.mjs); C# 5, no dependencies.
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class TesselAskpass
{
    // A little longer than Tessel's own 120 s, so Tessel's timeout answers first.
    const int TimeoutMs = 125000;
    const int MaxReply = 64 * 1024;

    static int Main(string[] args)
    {
        // Only Tessel starts the server mode (two arguments; ssh passes one,
        // and ssh's helper has a pane token in its environment).
        if (args.Length == 2 && args[0] == "--serve" && Environment.GetEnvironmentVariable("TESSEL_ASKPASS_TOKEN") == null)
            return Server.Run(args[1]);
        try
        {
            var timer = new Timer(delegate { Environment.Exit(1); }, null, TimeoutMs, Timeout.Infinite);
            string pipe = Environment.GetEnvironmentVariable("TESSEL_ASKPASS_PIPE") ?? "";
            string token = Environment.GetEnvironmentVariable("TESSEL_ASKPASS_TOKEN") ?? "";
            if (!Regex.IsMatch(pipe, "^tessel-askpass-[0-9a-f]{32}$")) return 1;
            if (!Regex.IsMatch(token, "^[0-9a-f]{64}$")) return 1;
            string prompt = args.Length > 0 ? args[0] : "";
            // "confirm" (a yes/no question), "none" (a notice, no answer) or unset.
            string mode = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") ?? "";

            using (var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut))
            {
                client.Connect(5000);
                string line = "TESSEL-ASKPASS 1 " + token + " " + B64(mode) + " " + B64(prompt) + "\n";
                byte[] req = Encoding.ASCII.GetBytes(line);
                client.Write(req, 0, req.Length);
                client.Flush();

                string reply = ReadLine(client);
                GC.KeepAlive(timer);
                if (reply == null || !reply.StartsWith("OK ")) return 1;
                byte[] answer = Convert.FromBase64String(reply.Substring(3));
                // The answer as UTF-8 bytes, no line break (ssh reads until
                // the end of the output).
                using (Stream stdout = Console.OpenStandardOutput())
                {
                    stdout.Write(answer, 0, answer.Length);
                    stdout.Flush();
                }
                Array.Clear(answer, 0, answer.Length);
                return 0;
            }
        }
        catch
        {
            return 1;
        }
    }

    static string B64(string s)
    {
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(s ?? ""));
    }

    static string ReadLine(Stream s)
    {
        var buf = new MemoryStream();
        int b;
        while ((b = s.ReadByte()) >= 0)
        {
            if (b == '\n') return Encoding.ASCII.GetString(buf.ToArray());
            if (buf.Length >= MaxReply) return null;
            buf.WriteByte((byte)b);
        }
        return null;
    }
}

// --- Server mode ---------------------------------------------------------------
// stdout (to Tessel): "READY" | "Q <id> <question line>" | "C <id>" (the helper
// went away). stdin (from Tessel): "A <id> <base64 reply>" | "D <id>" (drop).
static class Server
{
    const int MaxLine = 256 * 1024;
    const int FirstLineMs = 5000;
    static readonly object Gate = new object();
    static readonly Dictionary<long, NamedPipeServerStream> Waiting = new Dictionary<long, NamedPipeServerStream>();
    static StreamWriter Out;

    public static int Run(string name)
    {
        // Two pipes use this server: the askpass pipe, and the command-line
        // pipe (src/main/cliServer.js, for the tessel command).
        if (!Regex.IsMatch(name, "^tessel-(askpass|cli)-[0-9a-f]{32}$")) return 2;
        var stdout = Console.OpenStandardOutput();
        Out = new StreamWriter(stdout, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        PipeSecurity security = MakeSecurity();
        var reader = new Thread(ReadAnswers) { IsBackground = true };
        reader.Start();
        bool ready = false;
        long nextId = 0;
        while (true)
        {
            NamedPipeServerStream server;
            try
            {
                server = new NamedPipeServerStream(name, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, security);
            }
            catch
            {
                return 3;
            }
            if (!ready)
            {
                Say("READY");
                ready = true;
            }
            try
            {
                server.WaitForConnection();
            }
            catch
            {
                server.Dispose();
                continue;
            }
            long id = ++nextId;
            var client = server;
            new Thread(delegate () { Handle(id, client); }) { IsBackground = true }.Start();
        }
    }

    static PipeSecurity MakeSecurity()
    {
        var me = WindowsIdentity.GetCurrent().User;
        var security = new PipeSecurity();
        security.SetOwner(me);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(me, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        return security;
    }

    static void Say(string line)
    {
        lock (Gate) Out.WriteLine(line);
    }

    // One question per connection: a line of printable ASCII, at most MaxLine
    // bytes, within FirstLineMs; then wait for the answer or the helper's end.
    static void Handle(long id, NamedPipeServerStream pipe)
    {
        var timer = new Timer(delegate { try { pipe.Dispose(); } catch { } }, null, FirstLineMs, Timeout.Infinite);
        var line = new MemoryStream();
        bool ok = false;
        try
        {
            int b;
            while ((b = pipe.ReadByte()) >= 0)
            {
                if (b == '\n') { ok = true; break; }
                if (b < 0x20 || b > 0x7e || line.Length >= MaxLine) break;
                line.WriteByte((byte)b);
            }
        }
        catch { }
        timer.Dispose();
        if (!ok)
        {
            try { pipe.Dispose(); } catch { }
            return;
        }
        lock (Gate) Waiting[id] = pipe;
        Say("Q " + id + " " + Encoding.ASCII.GetString(line.ToArray()));
        // Nothing more is read from the helper: this only notices its end.
        try { while (pipe.ReadByte() >= 0) { } } catch { }
        bool mine;
        lock (Gate) mine = Waiting.Remove(id);
        if (mine)
        {
            try { pipe.Dispose(); } catch { }
            Say("C " + id);
        }
    }

    static void ReadAnswers()
    {
        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            string[] parts = line.Split(' ');
            long id;
            if (parts.Length < 2 || !long.TryParse(parts[1], out id)) continue;
            NamedPipeServerStream pipe;
            lock (Gate)
            {
                if (!Waiting.TryGetValue(id, out pipe)) continue;
                Waiting.Remove(id);
            }
            try
            {
                if (parts[0] == "A" && parts.Length == 3)
                {
                    byte[] reply = Convert.FromBase64String(parts[2]);
                    pipe.Write(reply, 0, reply.Length);
                    pipe.Flush();
                    pipe.WaitForPipeDrain();
                    Array.Clear(reply, 0, reply.Length);
                }
            }
            catch { }
            try { pipe.Dispose(); } catch { }
        }
        // Tessel is gone: so is the server.
        Environment.Exit(0);
    }
}
