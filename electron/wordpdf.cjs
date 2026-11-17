// Word files turned into PDFs (PLAN T7, DECISIONS 24): the Documents tab compares and shows the PDF.
// Converter order: Word by COM on Windows (PowerShell, hidden, alerts off, read only, always quit, 90 s then
// killed) -> LibreOffice `soffice --headless --convert-to pdf` (on Windows also in Program Files) -> none.
// The PDF goes to the OS temp folder under rev-radar/docx, named by a hash of path + size + mtime (re-used
// when it is there), and is cleaned when the app quits. Nothing is run when RR_OFF has `docxpdf`.
// Written without a Windows PC to run the COM path on: the command building and the timeout / kill logic are
// unit-tested with a fake runner (tests/text.test.ts), the COM script itself has not been run.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { pathToFileURL } = require('url');

const TIMEOUT = 90000;
const list = (s) => String(s || '').split(/[,\s]+/).filter(Boolean);

/** the converted PDF's name: path + size + mtime (a file changed is another name) */
const cacheName = (p, size, mtimeMs) => crypto.createHash('sha1').update(`${p}\u0000${size}\u0000${mtimeMs}`).digest('hex').slice(0, 24);
/** a string as a PowerShell single-quoted literal */
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
/** a script as -EncodedCommand wants it (UTF-16LE, base64): no quoting, no script file, no execution policy */
const encodePs = (script) => Buffer.from(script, 'utf16le').toString('base64');

/** Word through COM: a Word of its own (never the person's open one), no window, no alerts, the file read
 *  only, saved as PDF (the final text, no markup); the Word always quit; its process id printed first so a
 *  run that hangs can be ended without touching the person's own Word */
function wordScript(src, out) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$src = ${psq(src)}`,
    `$out = ${psq(out)}`,
    '$w = $null; $d = $null; $code = 0',
    'try {',
    "  $w = New-Object -ComObject Word.Application",
    '  $w.Visible = $false',
    '  $w.DisplayAlerts = 0',
    '  try { $w.AutomationSecurity = 3 } catch { }',
    '  try {',
    "    Add-Type -Namespace RR -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);'",
    '    $p = [uint32]0; [void][RR.W]::GetWindowThreadProcessId([IntPtr]$w.Hwnd, [ref]$p); Write-Output "WORDPID:$p"',
    '  } catch { }',
    '  $d = $w.Documents.Open($src, $false, $true, $false)',
    '  try { $d.ActiveWindow.View.RevisionsFilter.Markup = 0 } catch { }',
    '  try { $d.ExportAsFixedFormat($out, 17) } catch { $d.SaveAs2($out, 17) }',
    "  Write-Output 'OK'",
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message); $code = 3',
    '} finally {',
    '  if ($d -ne $null) { try { $d.Close($false) } catch { } }',
    '  if ($w -ne $null) { try { $w.Quit($false) } catch { }; try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) } catch { } }',
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
/** run a command, hidden, output kept; past `timeoutMs` it is killed (the tree) and `timedOut` says so */
function spawnRun(cmd, args, { timeoutMs = TIMEOUT } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, done = false, child;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }); };
    let timer = null;
    try { child = cp.spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }); } catch (e) { return resolve({ code: null, stdout: '', stderr: String((e && e.message) || e), timedOut: false }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String((e && e.message) || e); finish(null); });
    child.on('close', (code) => finish(code));
    timer = setTimeout(() => { timedOut = true; killTree(child.pid); setTimeout(() => finish(null), 1500); }, timeoutMs);
  });
}

/** the converter: `convert(path)` -> { ok, pdf, by } or { ok: false, why, none? }; `clean()` at quit */
function makeConverter(d = {}) {
  const platform = d.platform || process.platform, env = d.env || process.env;
  const tmpdir = d.tmpdir || os.tmpdir();
  const timeoutMs = d.timeoutMs || TIMEOUT;
  const run = d.run || spawnRun;
  const killPid = d.killPid || killTree;
  const find = d.find || findSoffice;
  const root = path.join(tmpdir, 'rev-radar', 'docx');
  // (off by default in 0.5.0 - Engineer, 17 Nov: the Word path has not run on Windows yet, and a compare must not
  //  depend on whether Word is on the PC; RR_ON=docxpdf turns it on)
  const off = !list(env.RR_ON).includes('docxpdf') || list(env.RR_OFF).includes('docxpdf');
  const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const made = (f) => { try { return fs.statSync(f).size > 0; } catch (_) { return false; } };
  // (Word stuck once - a dialog, an activation prompt - or not there: not asked again this session; the other
  //  files go to LibreOffice or are read as text at once, not 90 s each; ritual 17 Nov)
  let wordOut = '';

  async function viaWord(src, out) {
    const script = wordScript(src, out);
    const r = await run(platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePs(script)], { timeoutMs });
    if (r.timedOut) {
      // (only the Word this run started - its process id was printed first)
      const m = /WORDPID:(\d+)/.exec(r.stdout || '');
      if (m && +m[1] > 0) killPid(+m[1]);
      fs.rmSync(out, { force: true });
      return { ok: false, missing: false, why: `Microsoft Word did not finish in ${Math.round(timeoutMs / 1000)} s (stopped)` };
    }
    if (r.code === 0 && made(out)) return { ok: true };
    fs.rmSync(out, { force: true });
    const missing = /CLSID|COM class|80040154|not registered|Retrieving the COM/i.test(r.stderr || '');
    return { ok: false, missing, why: missing ? 'Microsoft Word is not installed' : `Microsoft Word could not convert it (${short(r.stderr) || 'exit ' + r.code})` };
  }
  async function viaSoffice(exe, src, out) {
    const work = path.join(root, 'w' + process.pid + '-' + path.basename(out, '.pdf'));
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    try {
      // (a profile of its own: a LibreOffice the person has open is not touched, and none is waited for)
      const profile = path.join(root, 'lo-profile');
      const r = await run(exe, ['--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard', `-env:UserInstallation=${pathToFileURL(profile).href}`, '--convert-to', 'pdf', '--outdir', work, src], { timeoutMs });
      const got = path.join(work, path.basename(src).replace(/\.docx$/i, '') + '.pdf');
      if (r.timedOut) return { ok: false, why: `LibreOffice did not finish in ${Math.round(timeoutMs / 1000)} s (stopped)` };
      if (r.code === 0 && made(got)) { fs.renameSync(got, out); return { ok: true }; }
      return { ok: false, why: `LibreOffice could not convert it (${short(r.stderr || r.stdout) || 'exit ' + r.code})` };
    } finally { fs.rmSync(work, { recursive: true, force: true }); }
  }

  async function one(src) {
    if (!/\.docx$/i.test(src)) return { ok: false, why: 'not a .docx file' };
    if (off) return { ok: false, none: true, off: true, why: 'Word files are compared as their text in this version' };
    let st;
    try { st = fs.statSync(src); } catch (e) { return { ok: false, why: 'the file could not be read' }; }
    const out = path.join(root, cacheName(src, st.size, st.mtimeMs) + '.pdf');
    if (made(out)) return { ok: true, pdf: out, by: 'earlier', cached: true };
    fs.mkdirSync(root, { recursive: true });
    const why = [];
    let wordMissing = platform !== 'win32', loMissing = false;
    if (platform === 'win32' && wordOut) { wordMissing = wordOut === 'missing'; why.push(wordOut === 'missing' ? 'Microsoft Word is not installed' : 'Microsoft Word did not answer earlier - not asked again'); }
    else if (platform === 'win32') {
      const r = await viaWord(src, out);
      if (r.ok) return { ok: true, pdf: out, by: 'Word' };
      wordMissing = !!r.missing; why.push(r.why);
      if (r.missing) wordOut = 'missing'; else if (/did not finish/.test(r.why)) wordOut = 'stuck';
    }
    const exe = find(platform, env);
    if (exe) {
      const r = await viaSoffice(exe, src, out);
      if (r.ok) return { ok: true, pdf: out, by: 'LibreOffice' };
      why.push(r.why);
    } else { loMissing = true; if (platform === 'win32' && !wordMissing) why.push('LibreOffice was not found'); }
    if (wordMissing && loMissing) return { ok: false, none: true, why: 'converting a Word file to pages needs Microsoft Word or LibreOffice on this PC, and neither was found' };
    return { ok: false, why: why.join('; ') };
  }
  // (one at a time: Word and LibreOffice each take one file at a time)
  let queue = Promise.resolve();
  const convert = (src) => { const p = queue.then(() => one(String(src))); queue = p.catch(() => { }); return p.catch((e) => ({ ok: false, why: short((e && e.message) || e) })); };
  const clean = () => { try { fs.rmSync(root, { recursive: true, force: true }); fs.rmdirSync(path.dirname(root)); } catch (_) { /* in use or not empty: fine */ } };
  /** what a crashed run left (older than `ms`) */
  const prune = (ms) => {
    try { for (const n of fs.readdirSync(root)) { if (n === 'lo-profile') continue; const f = path.join(root, n); if (Date.now() - fs.statSync(f).mtimeMs > ms) fs.rmSync(f, { recursive: true, force: true }); } } catch (_) { /* none */ }
  };
  return { convert, clean, prune, root };
}

module.exports = { makeConverter, wordScript, encodePs, sofficeCandidates, findSoffice, cacheName, spawnRun, killTree };
