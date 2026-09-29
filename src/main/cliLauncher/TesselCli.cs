// The tessel command's launcher: tessel.exe in %LOCALAPPDATA%\Tessel\bin
// (Settings > General > Tessel CLI, src/main/cliInstall.js).
//
// It starts Tessel's own executable as Node (ELECTRON_RUN_AS_NODE) on the
// command's script (out/main/cli.js) and passes its own command line through
// untouched: nothing reads it as a batch file would (no | > & % expansion,
// no console code page), so a card title or a path reaches the script as typed.
// Where Tessel is comes from <this exe's name>.ini next to it (UTF-8,
// key=value), written by Tessel.
//
// Tessel's executable is a Windows (GUI) program: it gets this console's
// standard handles explicitly (STARTF_USESTDHANDLES), so its output shows here.
//
// Built with the C# compiler of the .NET Framework that ships with Windows
// (scripts/build-askpass.mjs); C# 5, no dependencies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class TesselCli
{
    const string Mark = "# Tessel command line";

    static int Main()
    {
        string self = System.Reflection.Assembly.GetEntryAssembly().Location;
        string ini = Path.ChangeExtension(self, ".ini");
        var conf = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            string[] lines = File.ReadAllLines(ini, new UTF8Encoding(false));
            if (lines.Length == 0 || !lines[0].StartsWith(Mark)) return Fail();
            foreach (string line in lines)
            {
                int eq = line.IndexOf('=');
                if (line.StartsWith("#") || eq <= 0) continue;
                conf[line.Substring(0, eq).Trim()] = line.Substring(eq + 1);
            }
        }
        catch
        {
            return Fail();
        }
        string exec = Get(conf, "exec"), script = Get(conf, "script");
        if (exec == "" || script == "" || !File.Exists(exec) || !File.Exists(script) || exec.Contains("\"") || script.Contains("\"")) return Fail();

        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string)e.Value;
        env["ELECTRON_RUN_AS_NODE"] = "1";
        env["TESSEL_CLI_NAME"] = Get(conf, "name") == "" ? "tessel" : Get(conf, "name");
        env["TESSEL_CLI_USER_DATA"] = Get(conf, "userData");
        env["TESSEL_CLI_APP"] = Get(conf, "app");
        env["TESSEL_CLI_LANG"] = Get(conf, "lang");
        var block = new StringBuilder();
        foreach (var kv in env)
        {
            if (kv.Key.Length == 0 || kv.Key.IndexOf('=') > 0 || kv.Value == null) continue;
            block.Append(kv.Key).Append('=').Append(kv.Value).Append('\0');
        }
        block.Append('\0');

        string commandLine = "\"" + exec + "\" \"" + script + "\"";
        string tail = Tail(Environment.CommandLine);
        if (tail.Length > 0) commandLine += " " + tail;

        // Ctrl+C goes to Tessel's process too; this one waits for it to end.
        Console.CancelKeyPress += delegate (object s, ConsoleCancelEventArgs a) { a.Cancel = true; };

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = Inheritable(GetStdHandle(STD_INPUT_HANDLE));
        si.hStdOutput = Inheritable(GetStdHandle(STD_OUTPUT_HANDLE));
        si.hStdError = Inheritable(GetStdHandle(STD_ERROR_HANDLE));
        PROCESS_INFORMATION pi;
        IntPtr envPtr = Marshal.StringToHGlobalUni(block.ToString());
        try
        {
            if (!CreateProcessW(exec, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT, envPtr, null, ref si, out pi))
            {
                Console.Error.WriteLine("tessel: could not start Tessel (" + Marshal.GetLastWin32Error() + ").");
                return 1;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(envPtr);
        }
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) code = 1;
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return (int)code;
    }

    static string Get(Dictionary<string, string> d, string k)
    {
        string v;
        return d.TryGetValue(k, out v) && v != null ? v : "";
    }

    static int Fail()
    {
        Console.Error.WriteLine("tessel: this command is not set up. Register it again in Tessel: Settings > General > Tessel CLI.");
        return 1;
    }

    // The command line after this program's own name (Windows' own rule for
    // the first word: up to the closing quote, or to the first blank).
    public static string Tail(string cl)
    {
        if (cl == null) return "";
        int i = 0;
        if (cl.Length > 0 && cl[0] == '"')
        {
            int close = cl.IndexOf('"', 1);
            i = close < 0 ? cl.Length : close + 1;
        }
        else
        {
            while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++;
        }
        while (i < cl.Length && (cl[i] == ' ' || cl[i] == '\t')) i++;
        return cl.Substring(i);
    }

    static IntPtr Inheritable(IntPtr h)
    {
        if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        return h;
    }

    const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
    const uint HANDLE_FLAG_INHERIT = 1, STARTF_USESTDHANDLES = 0x100, CREATE_UNICODE_ENVIRONMENT = 0x400, INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
}
