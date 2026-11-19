// Word files turned into PDFs (PLAN T7, DECISIONS 24): the Documents tab compares and shows the PDF.
// Converter order: Word by COM on Windows (PowerShell, hidden, alerts off, read only, quit when it has no other
// document, 90 s then killed, a protected file refused at once) -> LibreOffice `soffice --headless --convert-to pdf` (on Windows also in Program Files) -> none.
// The PDF goes to the OS temp folder under rev-radar/docx, named by a hash of path + size + mtime (re-used
// when it is there), and is cleaned when the app quits. On by default (DECISIONS 81); nothing is run when RR_OFF
// has `docxpdf`. The command building and the timeout / kill logic are unit-tested with a fake runner
// (tests/text.test.ts); the COM script itself runs only on Windows with Word.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { pathToFileURL } = require('url');

const TIMEOUT = 90000;
/** given to Documents.Open as the document's (and write) password: a protected file is refused at once; an unprotected one ignores it */
const DUMMY_PASSWORD = 'rr-no-password';
const list = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);

/** the converted PDF's name: path + size + mtime (a file changed is another name) */
const cacheName = (p, size, mtimeMs) => crypto.createHash('sha1').update(`${p}\u0000${size}\u0000${mtimeMs}`).digest('hex').slice(0, 24);
/** a string as a PowerShell single-quoted literal */
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** a script as -EncodedCommand wants it (UTF-16LE, base64): no quoting, no script file, no execution policy */
const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** Word through COM: a Word of its own (never the person's open one), no window, no alerts, the file read
 *  only, saved as PDF (the final text, no markup). Its process id is found by a WINWORD snapshot taken before
 *  the Word is started (Application has no Hwnd; Window.Hwnd does not exist before a document is open) and
 *  printed before Documents.Open, so a run that hangs - or the app quitting - can end exactly that Word.
 *  A dummy password goes in as PasswordDocument (5th) and WritePasswordDocument (8th): a protected file then
 *  errors at once - DisplayAlerts = 0 does not stop the password prompt, which would sit there unseen.
 *  The Word is quit only when it has no other document (one the person opened meanwhile may have been handed
 *  to it); else it is made visible and left. `out` is the part file: the caller renames it when finished. */
function wordScript(src, out) {
  return [
    "$ErrorActionPreference = 'Stop'",
    // (no progress records: PowerShell writes them to the error stream as CLIXML - T16a)
    "$ProgressPreference = 'SilentlyContinue'",
    `$src = ${psq(src)}`,
    `$out = ${psq(out)}`,
    `$pw = '${DUMMY_PASSWORD}'`,
    '$w = $null; $d = $null; $code = 0; $own = $false; $pick = $null',
    '$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })',
    'try {',
    "  $w = New-Object -ComObject Word.Application",
    '  try {',
    '    $new = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id })',
    '    $pick = $null',
    '    if ($new.Count -eq 1) { $pick = $new[0] } elseif ($new.Count -gt 1) {',
    "      $emb = @(Get-CimInstance Win32_Process -Filter \"Name = 'WINWORD.EXE'\" | Where-Object { $_.CommandLine -match '-Embedding' } | ForEach-Object { [int]$_.ProcessId })",
    '      $pick = $new | Where-Object { $emb -contains $_.Id } | Sort-Object StartTime -Descending -ErrorAction SilentlyContinue | Select-Object -First 1',
    '      if ($pick -eq $null) { $pick = $new | Sort-Object StartTime -Descending -ErrorAction SilentlyContinue | Select-Object -First 1 }',
    '    }',
    '    if ($pick -ne $null) { Write-Output "WORDPID:$($pick.Id)" }',
    '  } catch { }',
    // (a Word this script did not start - the person's own, handed over by COM - is left as it was: not hidden, its
    //  settings put back, never quit; one with no new process and no document open, unseen, is taken as ours)
    '  $own = ($pick -ne $null) -or ((-not $w.Visible) -and $w.Documents.Count -eq 0)',
    '  $da = $w.DisplayAlerts; $as = $null; try { $as = $w.AutomationSecurity } catch { }',
    '  if ($own) { $w.Visible = $false }',
    '  $w.DisplayAlerts = 0',
    '  try { $w.AutomationSecurity = 3 } catch { }',
    '  $m = [Type]::Missing',
    '  $d = $w.Documents.Open($src, $false, $true, $false, $pw, $pw, $false, $pw, $pw, 0, $m, $false)',
    '  try { $d.ActiveWindow.View.RevisionsFilter.Markup = 0 } catch { }',
    '  try { $d.ExportAsFixedFormat($out, 17) } catch { $d.SaveAs2($out, 17) }',
    "  Write-Output 'OK'",
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message); $code = 3',
    '} finally {',
    '  if ($d -ne $null) { try { $d.Close($false) } catch { } }',
    '  if ($w -ne $null) {',
    '    if ($own) { try { if ($w.Documents.Count -eq 0) { $w.Quit([ref]0) } else { $w.Visible = $true } } catch { } }',
    '    else { try { $w.DisplayAlerts = $da } catch { }; if ($as -ne $null) { try { $w.AutomationSecurity = $as } catch { } } }',
    '    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) } catch { }',
    '  }',
    '}',
    'exit $code',
  ].join('\r\n');
}

/** where LibreOffice may be */
function sofficeCandidates(platform, env) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)'].filter(Boolean);
    return [...new Set(roots)].map((r) => path.join(r, 'LibreOffice', 'program', 'soffice.exe')).concat(['soffice.exe', 'soffice.com']);
  }
  if (platform === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice'];
  return ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice', 'soffice'];
}
/** the first candidate that is there (a bare name: looked for on the PATH) */
function findSoffice(platform, env) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const c of sofficeCandidates(platform, env)) {
    if (path.isAbsolute(c) || /[\\/]/.test(c)) { if (fs.existsSync(c)) return c; continue; }
    for (const d of dirs) { const f = path.join(d, c); if (fs.existsSync(f)) return f; }
  }
  return null;
}

/** a process and its children ended */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') cp.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { });
    else { try { process.kill(-pid, 'SIGKILL'); } catch (_) { process.kill(pid, 'SIGKILL'); } }
  } catch (_) { /* gone already */ }
}
/** run a command, hidden, output kept; past `timeoutMs` it is killed (the tree) and `timedOut` says so.
 *  `onSpawn(pid)` and `onStdout(text)` tell the caller the child and its output while it still runs (so it can be stopped) */
function spawnRun(cmd, args, { timeoutMs = TIMEOUT, onSpawn, onStdout } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, done = false, child;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }); };
    let timer = null;
    try { child = cp.spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); } catch (e) { return resolve({ code: null, stdout: '', stderr: String((e && e.message) || e), timedOut: false }); }
    try { if (onSpawn && child.pid) onSpawn(child.pid); } catch (_) { /* the caller's */ }
    child.stdout.on('data', (d) => { out += d; try { if (onStdout) onStdout(String(d)); } catch (_) { /* the caller's */ } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String((e && e.message) || e); finish(null); });
    child.on('close', (code) => finish(code));
    timer = setTimeout(() => { timedOut = true; killTree(child.pid); setTimeout(() => finish(null), 1500); }, timeoutMs);
  });
}

/** the converter: `convert(path)` -> { ok, pdf, by } or { ok: false, why, none? }; `stop()` then `clean()` at quit */
function makeConverter(d = {}) {
  const platform = d.platform || process.platform, env = d.env || process.env;
  const tmpdir = d.tmpdir || os.tmpdir();
  const timeoutMs = d.timeoutMs || TIMEOUT;
  const run = d.run || spawnRun;
  const killPid = d.killPid || killTree;
  const alive = d.alive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  const graceMs = d.graceMs || 5000;
  const find = d.find || findSoffice;
  const root = path.join(tmpdir, 'rev-radar', 'docx');
  // (on by default from 0.5.1, DECISIONS 81: Word, else LibreOffice, else the text - and the comparison says which
  //  for each file. RR_OFF=docxpdf is 0.5.0's behaviour: nothing run, Word files as text. RR_ON=docxpdf, which
  //  0.5.0 needed, changes nothing now)
  const off = list(env.RR_OFF).includes('docxpdf');
  const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const made = (f) => { try { return fs.statSync(f).size > 0; } catch (_) { return false; } };
  // (Word stuck once - a dialog, an activation prompt - or not there: not asked again this session; the other
  //  files go to LibreOffice or are read as text at once, not 90 s each; ritual 17 Nov)
  let wordOut = '';
  // (which converter made a PDF in this run: a PDF used again still says by which)
  const madeBy = new Map();
  // (0.6.0 T30: and beside the PDF, for a later session)
  const byOf = (out) => out.replace(/\.pdf$/i, '') + '.by.txt';
  const keepBy = (out, by) => { madeBy.set(out, by); try { fs.writeFileSync(byOf(out), by); } catch (_) { /* the PDF still serves */ } };
  // (what is running now, for stop() at quit: the child, and the Word it started once its id was printed)
  let child = 0, wordPid = 0, stopped = false;
  const rm = (f, o) => { try { fs.rmSync(f, { force: true, ...(o || {}) }); return true; } catch (_) { return false; } };
  const partOf = (out) => out.replace(/\.pdf$/i, '') + '.part.pdf'; // (still ends in .pdf: whatever Word does with the extension, it is the same)
  // (only a whole line: the output comes in pieces, and "WORDPID:12" before "34" would kill process 12 - sweep, 17 Nov)
  const wordPidIn = (s) => { const m = /WORDPID:(\d+)\r?\n/.exec(s || ''); return m && +m[1] > 0 ? +m[1] : 0; };
  /** what Word said, as one plain line */
  // (PowerShell wraps what it writes to the error stream in CLIXML when it is not a console - T16a)
  const unwrap = (e) => String(e || '').replace(/#< CLIXML/g, '').replace(/<Objs[\s\S]*?(<\/Objs>|$)/g, '').replace(/_x000D__x000A_/g, ' ');
  const wordWhy = (err0, code) => {
    const err = unwrap(err0);
    if (/password/i.test(err)) return 'Microsoft Word could not convert it (the file is password-protected)';
    return `Microsoft Word could not convert it (${short(err) || 'exit ' + code})`;
  };
  const go = (cmd, args) => {
    child = 0;
    let seen = '';
    const o = { timeoutMs, onSpawn: (pid) => { child = pid; }, onStdout: (t) => { seen += t; const p = wordPidIn(seen); if (p) { wordPid = p; } } };
    return Promise.resolve(run(cmd, args, o)).finally(() => { child = 0; });
  };

  async function viaWord(src, out) {
    const part = partOf(out);
    rm(part); // (what a stopped run left)
    wordPid = 0;
    const script = wordScript(src, part);
    const r = await go(platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePs(script)]);
    const pid = wordPid || wordPidIn(r.stdout);
    wordPid = 0;
    if (r.timedOut) {
      // (only the Word this run started - its process id was printed before the file was opened)
      if (pid) killPid(pid);
      rm(part); // (Word may still hold it for a moment: then it stays, under a name nothing reads)
      return { ok: false, missing: false, why: `Microsoft Word did not finish in ${Math.round(timeoutMs / 1000)} s (stopped)` };
    }
    // (the Word this run started should have quit; still there a moment after, it is stopped - on the PC every one
    //  stayed while Quit was refused, T16a. Only its own id: printed before our document was opened)
    if (pid) { const t = setTimeout(() => { if (alive(pid)) killPid(pid); }, graceMs); if (t.unref) t.unref(); }
    if (r.code === 0 && made(part)) {
      try { fs.renameSync(part, out); return { ok: true }; } catch (e) { rm(part); return { ok: false, missing: false, why: `Microsoft Word made it but the PDF could not be saved (${short(e && e.message)})` }; }
    }
    rm(part);
    const missing = /CLSID|COM class|80040154|not registered|Retrieving the COM/i.test(r.stderr || '');
    return { ok: false, missing, why: missing ? 'Microsoft Word is not installed' : wordWhy(r.stderr, r.code) };
  }
  async function viaSoffice(exe, src, out) {
    // (into a folder of its own - LibreOffice names its output itself - and moved to `out` only when it is whole)
    const work = path.join(root, 'w' + process.pid + '-' + path.basename(out, '.pdf'));
    rm(work, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      // (a profile of its own: a LibreOffice the person has open is not touched, and none is waited for)
      const profile = path.join(root, 'lo-profile');
      const r = await go(exe, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', 'pdf', '--outdir', work, src]);
      const got = path.join(work, path.basename(src).replace(/\.docx$/i, '') + '.pdf');
      if (r.timedOut) return { ok: false, why: `LibreOffice did not finish in ${Math.round(timeoutMs / 1000)} s (stopped)` };
      if (r.code === 0 && made(got)) {
        try { fs.renameSync(got, out); return { ok: true }; } catch (e) { return { ok: false, why: `LibreOffice made it but the PDF could not be saved (${short(e && e.message)})` }; }
      }
      return { ok: false, why: `LibreOffice could not convert it (${short(r.stderr || r.stdout) || 'exit ' + r.code})` };
    } finally { rm(work, { recursive: true }); }
  }

  const closing = { ok: false, why: 'the app is closing' };
  async function one(src) {
    if (stopped) return closing;
    if (!/\.docx$/i.test(src)) return { ok: false, why: 'not a .docx file' };
    if (off) return { ok: false, none: true, off: true, why: 'Word files are compared as their text in this version' };
    let st;
    try { st = fs.statSync(src); } catch (e) { return { ok: false, why: 'the file could not be read' }; }
    const out = path.join(root, cacheName(src, st.size, st.mtimeMs) + '.pdf');
    if (made(out)) {
      if (madeBy.has(out)) return { ok: true, pdf: out, by: madeBy.get(out), cached: true };
      // (0.6.0 T30: made in an earlier session - the converter's name kept beside it says by which)
      let by = '';
      try { by = fs.readFileSync(byOf(out), 'utf8').trim(); } catch (_) { /* none: made by 0.5.x */ }
      return { ok: true, pdf: out, by: by === 'Word' || by === 'LibreOffice' ? by : 'earlier', cached: true, earlier: true };
    }
    fs.mkdirSync(root, { recursive: true });
    const why = [];
    let wordMissing = platform !== 'win32', loMissing = false;
    if (platform === 'win32' && wordOut) { wordMissing = wordOut === 'missing'; why.push(wordOut === 'missing' ? 'Microsoft Word is not installed' : 'Microsoft Word did not answer earlier - not asked again'); }
    else if (platform === 'win32') {
      const r = await viaWord(src, out);
      if (stopped) return closing; // (stop() ended it: no other converter is started while the app quits)
      if (r.ok) { keepBy(out, 'Word'); return { ok: true, pdf: out, by: 'Word' }; }
      wordMissing = !!r.missing; why.push(r.why);
      if (r.missing) wordOut = 'missing'; else if (/did not finish/.test(r.why)) wordOut = 'stuck';
    }
    if (stopped) return closing;
    const exe = find(platform, env);
    if (exe) {
      const r = await viaSoffice(exe, src, out);
      if (stopped) return closing;
      if (r.ok) { keepBy(out, 'LibreOffice'); return { ok: true, pdf: out, by: 'LibreOffice' }; }
      why.push(r.why);
    } else { loMissing = true; if (platform === 'win32' && !wordMissing) why.push('LibreOffice was not found'); }
    if (wordMissing && loMissing) return { ok: false, none: true, why: 'converting a Word file to pages needs Microsoft Word or LibreOffice on this PC, and neither was found' };
    return { ok: false, why: why.join('; ') };
  }
  // (one at a time: Word and LibreOffice each take one file at a time)
  let queue = Promise.resolve();
  const convert = (src) => { const p = queue.then(() => one(String(src))); queue = p.catch(() => { }); return p.catch((e) => ({ ok: false, why: short((e && e.message) || e) })); };
  /** at quit: the running PowerShell / LibreOffice and the Word it started are ended; nothing new is started */
  const stop = () => {
    stopped = true;
    const c = child, w = wordPid; child = 0; wordPid = 0;
    if (c) killPid(c);
    if (w) killPid(w);
  };
  const clean = () => { try { fs.rmSync(root, { recursive: true, force: true }); fs.rmdirSync(path.dirname(root)); } catch (_) { /* in use or not empty: fine */ } };
  /** what a crashed run left (older than `ms`) */
  const prune = (ms) => {
    try { for (const n of fs.readdirSync(root)) { if (n === 'lo-profile') continue; const f = path.join(root, n); if (Date.now() - fs.statSync(f).mtimeMs > ms) fs.rmSync(f, { recursive: true, force: true }); } } catch (_) { /* none */ }
  };
  return { convert, clean, stop, prune, root };
}

module.exports = { makeConverter, wordScript, encodePs, sofficeCandidates, findSoffice, cacheName, spawnRun, killTree };
