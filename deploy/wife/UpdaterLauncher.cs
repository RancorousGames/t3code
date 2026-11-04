// Small .NET Framework launcher. The installer script is embedded for a first PC
// without Git, but every run fetches the newest repo script before building.
// Use an app-data copy while running so Git can replace this EXE in the checkout.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const string StagedFlag = "--staged";
    private const string HeadlessFlag = "--headless";

    [STAThread]
    private static void Main(string[] args)
    {
        bool headless = Array.IndexOf(args, HeadlessFlag) >= 0;
        string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "T3MonkuInstaller");
        Directory.CreateDirectory(home);
        if (Array.IndexOf(args, StagedFlag) < 0)
        {
            try
            {
                string staging = Path.Combine(home, "staging");
                Directory.CreateDirectory(staging);
                foreach (string old in Directory.GetFiles(staging, "T3-Monku-Updater-*.exe"))
                {
                    try { if (File.GetLastWriteTimeUtc(old) < DateTime.UtcNow.AddDays(-1)) File.Delete(old); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                }
                string copy = Path.Combine(staging, "T3-Monku-Updater-" + Guid.NewGuid().ToString("N") + ".exe");
                File.Copy(Assembly.GetExecutingAssembly().Location, copy);
                using (Process staged = Process.Start(new ProcessStartInfo {
                    FileName = copy,
                    Arguments = StagedFlag + (headless ? " " + HeadlessFlag : ""),
                    UseShellExecute = false,
                    WorkingDirectory = staging
                })) {
                    // Remote/headless callers need the real final exit code,
                    // not the success of merely launching the staged EXE.
                    if (headless) { staged.WaitForExit(); Environment.ExitCode = staged.ExitCode; }
                }
                return;
            }
            catch (Exception error)
            {
                if (headless) { Console.Error.WriteLine(error); Environment.ExitCode = 1; }
                else MessageBox.Show(error.Message, "T3 + Monku updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
        }
        if (headless)
        {
            string logPath = Path.Combine(home, "launcher.log");
            object logLock = new object();
            File.WriteAllText(logPath, "Updater started at " + DateTime.Now + Environment.NewLine);
            int result = RunUpdate(home, message => { lock (logLock) File.AppendAllText(logPath, message + Environment.NewLine); });
            lock (logLock) File.AppendAllText(logPath, "Updater exit code: " + result + Environment.NewLine);
            Environment.ExitCode = result;
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new UpdaterWindow(home));
    }

    internal static int RunUpdate(string home, Action<string> log)
    {
        string bootstrap = Path.Combine(home, "installer-running-" + Process.GetCurrentProcess().Id + ".ps1");
        try
        {
            using (Stream src = Assembly.GetExecutingAssembly().GetManifestResourceStream("MoriInstallScript"))
            {
                if (src == null) throw new InvalidOperationException("Installer resource is missing from this executable.");
                using (FileStream dst = File.Create(bootstrap)) src.CopyTo(dst);
            }
            ProcessStartInfo info = new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + bootstrap + "\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            // No working-directory dependency: the embedded script clones or
            // refreshes %USERPROFILE%\\t3code, then runs the repo script.
            using (Process process = new Process { StartInfo = info, EnableRaisingEvents = true })
            {
                process.OutputDataReceived += (s, e) => { if (e.Data != null) log(e.Data); };
                process.ErrorDataReceived += (s, e) => { if (e.Data != null) log(e.Data); };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            log("Updater failed: " + error.Message);
            return 1;
        }
        finally
        {
            try { File.Delete(bootstrap); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}

internal sealed class UpdaterWindow : Form
{
    private readonly Label status;
    private readonly TextBox output;
    private readonly Button close;
    private bool running = true;

    internal UpdaterWindow(string home)
    {
        Text = "Update T3 Code + Monku no Mori";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(820, 490);
        MinimumSize = new Size(560, 340);
        BackColor = Color.FromArgb(18, 23, 21);
        ForeColor = Color.FromArgb(225, 233, 227);
        Font = new Font("Segoe UI", 10);
        status = new Label { Dock = DockStyle.Top, Height = 56, Text = "Installing the latest T3 Code + Monku no Mori...", Padding = new Padding(16, 16, 8, 8) };
        output = new TextBox {
            Dock = DockStyle.Fill, Multiline = true, ReadOnly = true,
            BackColor = Color.FromArgb(12, 17, 15), ForeColor = ForeColor,
            BorderStyle = BorderStyle.None, ScrollBars = ScrollBars.Vertical,
            Font = new Font("Consolas", 9), WordWrap = false
        };
        close = new Button { Dock = DockStyle.Right, Width = 130, Enabled = false, Text = "Close" };
        close.Click += (s, e) => Close();
        Panel footer = new Panel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(8) };
        footer.Controls.Add(close);
        Controls.Add(output);
        Controls.Add(footer);
        Controls.Add(status);
        Shown += (s, e) => ThreadPool.QueueUserWorkItem(_ => {
            int code = Program.RunUpdate(home, AppendLog);
            if (IsDisposed || !IsHandleCreated) return;
            BeginInvoke(new Action(() => {
                running = false;
                status.Text = code == 0 ? "Updated successfully. Both apps are ready." : "Update stopped. See details and installer log below.";
                status.ForeColor = code == 0 ? Color.FromArgb(140, 207, 167) : Color.FromArgb(231, 145, 121);
                close.Enabled = true;
                close.Focus();
            }));
        });
    }

    private void AppendLog(string text)
    {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(new Action(() => {
            if (output.TextLength > 180000) output.Text = output.Text.Substring(output.TextLength - 100000);
            output.AppendText(text + Environment.NewLine);
        })); }
        catch (InvalidOperationException) { }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (running) { e.Cancel = true; return; } // Never interrupt an in-flight pull/build.
        base.OnFormClosing(e);
    }
}
