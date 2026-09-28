// Tessel's SSH_ASKPASS helper (see src/main/sshAskpass.js).
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
// Built with the C# compiler of the .NET Framework that ships with Windows
// (scripts/build-askpass.mjs); C# 5, no dependencies.
using System;
using System.IO;
using System.IO.Pipes;
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
