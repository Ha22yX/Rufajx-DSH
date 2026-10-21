// Fixed 0.3.0 bootstrap. This binary is outside the incremental managed file set.
// A release may replace application files, never the bootstrap, its trust key,
// arbitrary commands, user profiles, or paths outside the installation.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal sealed class FileEntry { public string path; public long size; public string sha256; public string sha512; }
internal sealed class Change { public string Path; public string OldHash; public string NewHash; public bool Existed; public bool Started; }
internal sealed class Journal { public int Schema = 1; public string State = "prepared"; public string ManifestHash; public List<Change> Items = new List<Change>(); }
internal sealed class SignedManifest {
    public string Version; public byte[] Bytes; public byte[] Envelope;
    public Dictionary<string, FileEntry> Files = new Dictionary<string, FileEntry>(StringComparer.OrdinalIgnoreCase);
}

internal static class Bootstrap {
    internal const string Version = "0.3.0";
    internal static readonly string Root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
    internal static readonly string Area = Path.Combine(Root, ".rufa-update");
    internal static readonly string Tx = Path.Combine(Area, "transaction");
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 80 };
    private static string MutexName { get { return "Local\\RufaUpdate-" + Hex(Encoding.UTF8.GetBytes(Root.ToUpperInvariant())).Substring(0, 32); } }
    private static Mutex owner;
    private static bool owns;
    internal static ProgressWindow Window;
    internal static bool Active;
    internal static bool Recovered;
    private sealed class VerificationState {
        internal readonly byte[] Buffer = new byte[64 * 1024];
        internal readonly SHA256 Sha256 = new SHA256Cng();
        internal readonly SHA512 Sha512 = new SHA512Cng();
    }
    // Apply/recovery run sequentially on one worker. Keep hash providers and a
    // small buffer per thread instead of allocating 1 MiB for every file.
    [ThreadStatic] private static VerificationState verification;
    private static string lastStatusPhase;
    private static long lastStatusTimestamp;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string path);

    [STAThread] public static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try {
            NoLinks(Root); Directory.CreateDirectory(Area); NoLinks(Area);
            owner = new Mutex(false, MutexName);
            try { owns = owner.WaitOne(0); } catch (AbandonedMutexException) { owns = true; }
            if (!owns) { Application.Run(new ProgressWindow(true)); return 0; }
            bool apply = args.Length == 2 && args[0] == "--apply-update";
            if (args.Length > 0 && args[0] == "--apply-update" && !apply) throw new InvalidDataException();
            if (apply || Directory.Exists(Tx)) {
                Window = new ProgressWindow(false); Active = true;
                Window.Shown += delegate {
                    Task.Run(delegate {
                        try {
                            if (Directory.Exists(Tx)) { using (var recovering = ExclusiveRunLock()) Recover(); Recovered = true; }
                            if (apply) {
                                // Show a real window before permitting Electron to disappear.
                                Status("waiting", 0, 0);
                                using (var output = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true }) {
                                    output.Write("RUFA_UPDATE_READY\n");
                                    using (var input = new StreamReader(Console.OpenStandardInput())) if (input.ReadLine() != "APPLY") throw new IOException("handoff");
                                    output.Write("RUFA_UPDATE_ACCEPTED\n");
                                }
                                int parent;
                                if (!Int32.TryParse(args[1], out parent) || parent < 1) throw new InvalidDataException();
                                try { using (var process = Process.GetProcessById(parent)) if (!process.WaitForExit(60000)) throw new IOException("busy"); } catch (ArgumentException) { }
                                using (var runLock = ExclusiveRunLock()) Apply();
                            }
                            Active = false; Status("complete", 1, 1);
                            Window.BeginInvoke((Action)(delegate { Window.Success(); }));
                        } catch {
                            bool safe = false;
                            try { if (Directory.Exists(Tx)) { using (var recovering = ExclusiveRunLock()) Recover(); } safe = true; Recovered = true; } catch { }
                            Active = false; Status(safe ? "restored" : "blocked", 0, 0);
                            Window.BeginInvoke((Action)(delegate { Window.Failed(safe); }));
                        }
                    });
                };
                Application.Run(Window);
                if (!Window.OpenApp) return 2;
            }
            // Keep a shared handle until Electron exits. An update waits for all
            // launchers, including a second shortcut click, before replacing files.
            NoLinks(Path.Combine(Area, "run.lock"));
            using (var running = new FileStream(Path.Combine(Area, "run.lock"), FileMode.OpenOrCreate, FileAccess.Read, FileShare.Read)) {
                if (Directory.Exists(Tx)) throw new IOException("recovery pending");
                var exe = Local("Rufajx-DSH-App.exe");
                var start = new ProcessStartInfo(exe, Recovered ? "--rufa-update-recovered" : "") { WorkingDirectory = Root, UseShellExecute = false };
                using (var app = Process.Start(start)) { ReleaseOwner(); app.WaitForExit(); return app.ExitCode; }
            }
        } catch {
            MessageBox.Show("客户端未能安全启动。请重新打开以恢复更新；若仍失败，请联系管理员。", "Rufajx-DSH", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 2;
        } finally { ReleaseOwner(); if (owner != null) owner.Dispose(); }
    }
    private static void ReleaseOwner() { if (owns) { owns = false; owner.ReleaseMutex(); } }
    private static FileStream ExclusiveRunLock() {
        for (int i = 0; i < 600; i++) {
            try { NoLinks(Path.Combine(Area, "run.lock")); return new FileStream(Path.Combine(Area, "run.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { Thread.Sleep(100); }
        }
        throw new IOException("application busy");
    }
    internal static bool UpdateFinished() {
        using (var mutex = new Mutex(false, MutexName)) {
            bool got = false;
            try { try { got = mutex.WaitOne(0); } catch (AbandonedMutexException) { got = true; } return got; }
            finally { if (got) mutex.ReleaseMutex(); }
        }
    }
    internal static void Status(string phase, long completed, long total) {
        long now = Stopwatch.GetTimestamp();
        if (phase == lastStatusPhase && completed != total && (now - lastStatusTimestamp) * 1000.0 / Stopwatch.Frequency < 200) return;
        lastStatusPhase = phase; lastStatusTimestamp = now;
        // Progress is disposable UI data. Transaction journals and release
        // receipts still use the durable default of Atomic below.
        try { Atomic(Path.Combine(Area, "status.json"), Encoding.UTF8.GetBytes(Json.Serialize(new { phase, completed, total })), false); } catch { }
        if (Window != null && !Window.IsDisposed) Window.BeginInvoke((Action)(delegate { Window.SetProgress(phase, completed, total); }));
    }
    internal static Dictionary<string, object> Obj(object value) {
        var result = value as Dictionary<string, object>; if (result == null) throw new InvalidDataException(); return result;
    }
    private static string Str(Dictionary<string, object> value, string key) { object item; if (!value.TryGetValue(key, out item) || !(item is string)) throw new InvalidDataException(); return (string)item; }
    private static long Num(Dictionary<string, object> value, string key) {
        object item; if (!value.TryGetValue(key, out item) || !(item is int || item is long || item is decimal)) throw new InvalidDataException();
        decimal number = Convert.ToDecimal(item, CultureInfo.InvariantCulture); if (number < 0 || number > 9007199254740991M || Decimal.Truncate(number) != number) throw new InvalidDataException(); return (long)number;
    }
    private static bool Stable(string value) { return Regex.IsMatch(value, @"^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$"); }
    private static int Compare(string left, string right) {
        if (!Stable(left) || !Stable(right)) throw new InvalidDataException();
        var a = left.Split('.'); var b = right.Split('.'); for (int i = 0; i < 3; i++) { int c = Int32.Parse(a[i]).CompareTo(Int32.Parse(b[i])); if (c != 0) return c; } return 0;
    }
    private static string InstalledVersion(string executable) {
        string value = FileVersionInfo.GetVersionInfo(executable).ProductVersion;
        // Windows PE metadata emitted by the pinned builder uses a zero fourth
        // component. Only that exact representation maps to a stable release;
        // nonzero revisions, labels and malformed versions remain unsupported.
        if (value != null && value.EndsWith(".0", StringComparison.Ordinal)) {
            string candidate = value.Substring(0, value.Length - 2);
            if (Stable(candidate)) return candidate;
        }
        if (value != null && Stable(value)) return value;
        throw new InvalidDataException("unknown installed version");
    }
    internal static bool Managed(string path) {
        if (String.IsNullOrEmpty(path) || path.Length > 2048 || Regex.IsMatch(path, "[\\\\\x00-\x1f\x7f<>:\"|?*]")) return false;
        for (int i = 0; i < path.Length; i++) if (Char.IsSurrogate(path[i])) { if (!Char.IsHighSurrogate(path[i]) || ++i == path.Length || !Char.IsLowSurrogate(path[i])) return false; }
        var parts = path.Split('/');
        if (parts.Any(p => p.Length == 0 || p.Length > 255 || p == "." || p == ".." || p.EndsWith(".") || p.EndsWith(" ") || Regex.IsMatch(p, @"^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))) return false;
        return !new [] { ".rufa-update", "Rufajx-DSH.exe", "Rufajx-DSH.exe.config" }.Contains(parts[0], StringComparer.OrdinalIgnoreCase)
            && !Regex.IsMatch(parts[0], @"^Uninstall.*\.exe$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
    internal static void NoLinks(string path) {
        string full = Path.GetFullPath(path);
        if (!full.Equals(Root, StringComparison.OrdinalIgnoreCase) && !full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException();
        string current = full;
        while (true) {
            // One fresh OS query per component replaces three managed queries.
            // No path result is cached: all ancestors are rechecked on every
            // invocation, including immediately before filesystem mutations.
            string nativePath = current.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + current.Substring(2) : @"\\?\" + current;
            uint attributes = GetFileAttributesW(nativePath);
            if (attributes == UInt32.MaxValue) {
                int error = Marshal.GetLastWin32Error();
                if (error != 2 && error != 3) throw new Win32Exception(error);
            } else if ((attributes & (uint)FileAttributes.ReparsePoint) != 0) throw new IOException("reparse point");
            string parent = Path.GetDirectoryName(current); if (String.IsNullOrEmpty(parent) || parent == current) break;
            current = parent;
        }
    }
    private static string ResolveLocal(string path) { if (!Managed(path)) throw new InvalidDataException(); return Path.GetFullPath(Path.Combine(Root, path.Replace('/', Path.DirectorySeparatorChar))); }
    private static string Local(string path) { string target = ResolveLocal(path); NoLinks(target); return target; }
    private static byte[] Read(string path, int max) { NoLinks(path); var info = new FileInfo(path); if (!info.Exists || info.Length > max) throw new InvalidDataException(); return File.ReadAllBytes(path); }
    internal static string Hex(byte[] value) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(value)).Replace("-", "").ToLowerInvariant(); }
    private static string FileHash(string path) { NoLinks(path); using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant(); }
    private static bool Matches(string path, FileEntry entry) {
        NoLinks(path); if (!File.Exists(path)) { if (Directory.Exists(path)) throw new IOException("directory collision"); return false; }
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.SequentialScan)) {
            if (stream.Length != entry.size) return false;
            var state = verification ?? (verification = new VerificationState());
            state.Sha256.Initialize(); state.Sha512.Initialize(); int n;
            while ((n = stream.Read(state.Buffer, 0, state.Buffer.Length)) > 0) { state.Sha256.TransformBlock(state.Buffer, 0, n, null, 0); state.Sha512.TransformBlock(state.Buffer, 0, n, null, 0); }
            state.Sha256.TransformFinalBlock(new byte[0], 0, 0); state.Sha512.TransformFinalBlock(new byte[0], 0, 0);
            return BitConverter.ToString(state.Sha256.Hash).Replace("-", "").ToLowerInvariant() == entry.sha256 && Convert.ToBase64String(state.Sha512.Hash) == entry.sha512;
        }
    }
    internal static void Atomic(string path, byte[] bytes, bool durable = true) {
        NoLinks(path); string temp = path + "." + Guid.NewGuid().ToString("N") + ".writing"; NoLinks(temp);
        using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(durable); }
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
    private static SignedManifest Load(string envelopePath, string manifestPath) {
        byte[] envelopeBytes = Read(envelopePath, 64 * 1024), bytes = Read(manifestPath, 64 * 1024 * 1024);
        var envelope = Obj(Json.DeserializeObject(Encoding.UTF8.GetString(envelopeBytes))); var descriptor = Obj(envelope["manifest"]);
        string version = Str(envelope, "version"), minimum = Str(envelope, "minUpdaterVersion");
        if (Num(envelope, "schema") != 1 || !Stable(version) || Compare(minimum, Version) > 0 || Num(descriptor, "size") != bytes.Length
            || Str(descriptor, "url") != "releases/" + version + "/incremental-manifest.json" || Str(descriptor, "keyId") != UpdateTrust.KeyId
            || Str(descriptor, "algorithm") != "rsa-sha256") throw new InvalidDataException();
        using (var sha = SHA512.Create()) if (Convert.ToBase64String(sha.ComputeHash(bytes)) != Str(descriptor, "sha512")) throw new InvalidDataException();
        using (var rsa = new RSACryptoServiceProvider()) {
            rsa.PersistKeyInCsp = false; rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(UpdateTrust.Modulus), Exponent = Convert.FromBase64String(UpdateTrust.Exponent) });
            if (!rsa.VerifyData(bytes, CryptoConfig.MapNameToOID("SHA256"), Convert.FromBase64String(Str(descriptor, "signature")))) throw new InvalidDataException();
        }
        var raw = Obj(Json.DeserializeObject(new UTF8Encoding(false, true).GetString(bytes)));
        if (Num(raw, "schema") != 1 || Str(raw, "version") != version || Str(raw, "minUpdaterVersion") != minimum
            || Str(raw, "platform") != "win32" || Str(raw, "arch") != "x64" || Str(raw, "releaseDate") != Str(envelope, "releaseDate")) throw new InvalidDataException();
        var items = raw["files"] as object[]; if (items == null || items.Length < 1 || items.Length > 200000) throw new InvalidDataException();
        var result = new SignedManifest { Version = version, Bytes = bytes, Envelope = envelopeBytes };
        foreach (var item in items) {
            var file = Obj(item); var entry = new FileEntry { path = Str(file, "path"), size = Num(file, "size"), sha256 = Str(file, "sha256"), sha512 = Str(file, "sha512") };
            if (!Managed(entry.path) || !Regex.IsMatch(entry.sha256, "^[a-f0-9]{64}$") || !Regex.IsMatch(entry.sha512, "^[A-Za-z0-9+/]{86}==$")) throw new InvalidDataException();
            if (result.Files.ContainsKey(entry.path)) throw new InvalidDataException(); result.Files.Add(entry.path, entry);
        }
        foreach (string path in result.Files.Keys) { var parts = path.Split('/').ToList(); parts.RemoveAt(parts.Count - 1); while (parts.Count > 0) { if (result.Files.ContainsKey(String.Join("/", parts))) throw new InvalidDataException(); parts.RemoveAt(parts.Count - 1); } }
        if (!result.Files.ContainsKey("Rufajx-DSH-App.exe") || !result.Files.ContainsKey("resources/app.asar")) throw new InvalidDataException();
        return result;
    }
    private static SignedManifest Current() {
        string envelope = Path.Combine(Area, "current.json"), manifest = Path.Combine(Area, "current-manifest.json");
        if (!File.Exists(envelope) && !File.Exists(manifest)) return null;
        return Load(envelope, manifest);
    }
    private static void SaveJournal(Journal journal) { Atomic(Path.Combine(Tx, "journal.json"), Encoding.UTF8.GetBytes(Json.Serialize(journal))); }
    private static void Apply() {
        Status("checking", 0, 0);
        var target = Load(Path.Combine(Area, "pending.json"), Path.Combine(Area, "pending-manifest.json"));
        var prior = Current();
        string installedVersion = prior == null ? InstalledVersion(Local("Rufajx-DSH-App.exe")) : prior.Version;
        if (!Stable(installedVersion) || Compare(target.Version, installedVersion) <= 0) throw new InvalidDataException();
        var journal = new Journal { ManifestHash = Hex(target.Bytes) };
        long count = 0;
        foreach (var file in target.Files.Values) {
            string path = ResolveLocal(file.path);
            if (!Matches(path, file)) journal.Items.Add(new Change { Path = file.path, Existed = File.Exists(path), OldHash = File.Exists(path) ? FileHash(path) : null, NewHash = file.sha256 });
            if (++count % 64 == 0) Status("checking", count, target.Files.Count);
        }
        if (prior != null) foreach (var file in prior.Files.Values) {
            if (!target.Files.ContainsKey(file.path) && File.Exists(Local(file.path))) {
                // Preserve an externally changed old file rather than deleting it.
                if (!Matches(Local(file.path), file)) throw new IOException("old managed file changed");
                journal.Items.Add(new Change { Path = file.path, Existed = true, OldHash = file.sha256, NewHash = null });
            }
        }
        NoLinks(Tx); if (Directory.Exists(Tx)) throw new IOException("transaction exists");
        Directory.CreateDirectory(Tx); Directory.CreateDirectory(Path.Combine(Tx, "backup")); Directory.CreateDirectory(Path.Combine(Tx, "new"));
        Atomic(Path.Combine(Tx, "target.json"), target.Envelope); Atomic(Path.Combine(Tx, "target-manifest.json"), target.Bytes);
        if (prior != null) { Atomic(Path.Combine(Tx, "prior.json"), prior.Envelope); Atomic(Path.Combine(Tx, "prior-manifest.json"), prior.Bytes); }
        SaveJournal(journal);
        for (int i = 0; i < journal.Items.Count; i++) {
            var item = journal.Items[i]; if (item.NewHash == null) { Status("preparing", i + 1, journal.Items.Count); continue; }
            FileEntry entry = target.Files[item.Path]; string blob = Path.Combine(Area, "download", entry.sha256);
            if (!Matches(blob, entry)) throw new InvalidDataException();
            string staged = Path.Combine(Tx, "new", i.ToString(CultureInfo.InvariantCulture));
            NoLinks(staged); File.Copy(blob, staged, false);
            using (var file = new FileStream(staged, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) file.Flush(true);
            if (!Matches(staged, entry)) throw new InvalidDataException();
            Status("preparing", i + 1, journal.Items.Count);
        }
        for (int i = 0; i < journal.Items.Count; i++) {
            var item = journal.Items[i]; string destination = Local(item.Path), backup = Path.Combine(Tx, "backup", i.ToString(CultureInfo.InvariantCulture));
            if (item.Existed ? !File.Exists(destination) || FileHash(destination) != item.OldHash : File.Exists(destination) || Directory.Exists(destination)) throw new IOException("file changed");
            item.Started = true; SaveJournal(journal);
            Directory.CreateDirectory(Path.GetDirectoryName(destination)); NoLinks(destination); NoLinks(backup);
            if (item.Existed) File.Move(destination, backup);
            if (item.NewHash != null) File.Move(Path.Combine(Tx, "new", i.ToString(CultureInfo.InvariantCulture)), destination);
            Status("installing", i + 1, journal.Items.Count);
        }
        // Every changed file must match before publishing the version receipt.
        foreach (var item in journal.Items) if (item.NewHash != null && !Matches(Local(item.Path), target.Files[item.Path])) throw new IOException("installed file changed");
        journal.State = "committed"; SaveJournal(journal);
        Complete(target); CleanTransaction();
    }
    private static void Complete(SignedManifest target) {
        Atomic(Path.Combine(Area, "current-manifest.json"), target.Bytes); Atomic(Path.Combine(Area, "current.json"), target.Envelope);
        // Successful payloads are no longer needed. Failed updates retain their
        // verified download cache for retry; user files are never cache entries.
        string download = Path.Combine(Area, "download");
        try {
            NoLinks(download);
            if (Directory.Exists(download)) {
                var hashes = new HashSet<string>(target.Files.Values.Select(file => file.sha256), StringComparer.Ordinal);
                foreach (string cached in Directory.EnumerateFiles(download)) if (hashes.Contains(Path.GetFileName(cached))) { NoLinks(cached); File.Delete(cached); }
            }
        } catch { }
    }
    private static void Recover() {
        NoLinks(Tx); Status("recovering", 0, 0);
        string path = Path.Combine(Tx, "journal.json");
        // No journal is written until planning, prior receipt, and target receipt
        // are durable. No installed file has been touched before that point.
        if (!File.Exists(path)) { CleanTransaction(); return; }
        var journal = Json.Deserialize<Journal>(Encoding.UTF8.GetString(Read(path, 64 * 1024 * 1024)));
        if (journal == null || journal.Schema != 1 || journal.Items == null || journal.Items.Count > 200000 || (journal.State != "prepared" && journal.State != "committed" && journal.State != "rolledback")) throw new InvalidDataException();
        var target = Load(Path.Combine(Tx, "target.json"), Path.Combine(Tx, "target-manifest.json"));
        if (journal.ManifestHash != Hex(target.Bytes)) throw new InvalidDataException();
        SignedManifest prior = File.Exists(Path.Combine(Tx, "prior.json")) ? Load(Path.Combine(Tx, "prior.json"), Path.Combine(Tx, "prior-manifest.json")) : null;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in journal.Items) {
            FileEntry entry;
            if (!Managed(item.Path) || !seen.Add(item.Path) || (item.Existed && !Regex.IsMatch(item.OldHash ?? "", "^[a-f0-9]{64}$"))) throw new InvalidDataException();
            if (item.NewHash != null) { if (!target.Files.TryGetValue(item.Path, out entry) || entry.sha256 != item.NewHash) throw new InvalidDataException(); }
            else if (prior == null || target.Files.ContainsKey(item.Path) || !prior.Files.TryGetValue(item.Path, out entry) || entry.sha256 != item.OldHash) throw new InvalidDataException();
        }
        if (journal.State == "committed") {
            long checkedFiles = 0;
            foreach (var file in target.Files.Values) {
                if (!Matches(ResolveLocal(file.path), file)) throw new IOException("committed file changed");
                if (++checkedFiles % 64 == 0) Status("checking", checkedFiles, target.Files.Count);
            }
            foreach (var item in journal.Items) if (item.NewHash == null && File.Exists(Local(item.Path))) throw new IOException("committed removal incomplete");
            Complete(target); CleanTransaction(); return;
        }
        int restoredFiles = 0, restoreTotal = journal.Items.Count(item => item.Started);
        for (int i = journal.Items.Count - 1; i >= 0; i--) {
            var item = journal.Items[i]; if (!item.Started) continue;
            string destination = Local(item.Path), backup = Path.Combine(Tx, "backup", i.ToString(CultureInfo.InvariantCulture)); NoLinks(backup);
            if (File.Exists(backup)) {
                if (FileHash(backup) != item.OldHash) throw new IOException("backup changed");
                if (File.Exists(destination)) {
                    string hash = FileHash(destination);
                    if (hash != item.NewHash && hash != item.OldHash) throw new IOException("recovery conflict");
                    File.Delete(destination);
                }
                File.Move(backup, destination);
            } else if (item.Existed) {
                if (!File.Exists(destination) || FileHash(destination) != item.OldHash) throw new IOException("missing backup");
            } else if (File.Exists(destination)) {
                if (FileHash(destination) != item.NewHash) throw new IOException("recovery conflict"); File.Delete(destination);
            }
            item.Started = false; SaveJournal(journal); Status("recovering", ++restoredFiles, restoreTotal);
        }
        journal.State = "rolledback"; SaveJournal(journal); CleanTransaction();
    }
    private static void CleanTransaction() {
        NoLinks(Tx); if (!Directory.Exists(Tx)) return;
        // Do not follow junctions during cleanup, even under our private tree.
        string garbage = Path.Combine(Area, "retired-" + Guid.NewGuid().ToString("N")); NoLinks(garbage);
        Directory.Move(Tx, garbage);
        // Once detached, a crash while reclaiming backups cannot turn a complete
        // commit or rollback into an incomplete recovery transaction.
        try { DeleteTree(garbage); } catch { }
    }
    private static void DeleteTree(string path) {
        NoLinks(path);
        foreach (var entry in Directory.EnumerateFileSystemEntries(path)) { NoLinks(entry); if (Directory.Exists(entry)) DeleteTree(entry); else File.Delete(entry); }
        Directory.Delete(path, false);
    }
}

internal sealed class ProgressWindow : Form {
    private readonly Label title = new Label(), detail = new Label();
    private readonly ProgressBar bar = new ProgressBar(); private readonly Button open = new Button();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly bool monitor; internal bool OpenApp;
    internal ProgressWindow(bool monitoring) {
        monitor = monitoring; Text = "Rufajx-DSH · 客户端更新"; ClientSize = new Size(460, 194);
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = true; StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(25, 25, 25); ForeColor = Color.FromArgb(235, 235, 235); Font = new Font("Microsoft YaHei UI", 10);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        title.SetBounds(24, 24, 412, 30); title.Font = new Font(Font.FontFamily, 13, FontStyle.Bold);
        detail.SetBounds(24, 65, 412, 44); bar.SetBounds(24, 117, 412, 8); bar.Style = ProgressBarStyle.Marquee;
        open.SetBounds(306, 145, 130, 30); open.Text = "打开客户端"; open.Visible = false;
        open.Click += delegate { OpenApp = !monitor; if (monitor) Process.Start(new ProcessStartInfo(Path.Combine(Bootstrap.Root, "Rufajx-DSH.exe")) { UseShellExecute = false }); Close(); };
        Controls.AddRange(new Control[] { title, detail, bar, open }); SetProgress("waiting", 0, 0);
        FormClosing += delegate(object sender, FormClosingEventArgs args) { if (!monitor && Bootstrap.Active && args.CloseReason == CloseReason.UserClosing) args.Cancel = true; };
        if (monitor) {
            timer.Interval = 300; timer.Tick += delegate {
                try {
                    var state = Bootstrap.Obj(Bootstrap.Json.DeserializeObject(File.ReadAllText(Path.Combine(Bootstrap.Area, "status.json"))));
                    SetProgress(Convert.ToString(state["phase"]), Convert.ToInt64(state["completed"]), Convert.ToInt64(state["total"]));
                } catch { }
                if (Bootstrap.UpdateFinished()) { timer.Stop(); title.Text = "更新窗口已结束"; detail.Text = "打开客户端以继续，或完成更新恢复。"; bar.Visible = false; open.Visible = true; }
            }; timer.Start();
        }
    }
    internal void SetProgress(string phase, long completed, long total) {
        string message;
        switch (phase) {
            case "checking": message = "正在核对本机文件"; break;
            case "preparing": message = "正在准备变化的文件"; break;
            case "installing": message = "正在安装更新"; break;
            case "recovering": message = "正在恢复原有版本"; break;
            case "complete": message = "更新完成"; break;
            case "restored": message = "更新未完成，原版本已恢复"; break;
            case "blocked": message = "更新需要恢复"; break;
            default: message = "正在等待客户端安全退出"; break;
        }
        title.Text = message; detail.Text = total > 0
            ? String.Format(CultureInfo.InvariantCulture, "已处理 {0:N0} / {1:N0} 个文件\r\n完成后将打开客户端，请保留此窗口。", Math.Min(completed, total), total)
            : "此窗口会持续显示进度。请保留窗口，完成后将打开客户端。";
        if (total > 0) { bar.Style = ProgressBarStyle.Continuous; bar.Value = (int)Math.Min(100, Math.Max(0, (double)completed / total * 100)); }
        else bar.Style = ProgressBarStyle.Marquee;
    }
    internal void Success() { OpenApp = true; Close(); }
    internal void Failed(bool safe) {
        SetProgress(safe ? "restored" : "blocked", 0, 0); bar.Visible = false;
        detail.Text = safe ? "未完成的更改已撤回。可以打开原版本，之后再次尝试更新。" : "已保留恢复资料。请关闭后重新打开；若仍失败，请联系管理员。";
        open.Visible = safe;
    }
    protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
}
