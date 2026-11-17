# Everything for one version, ready for a GitHub release (and, for the 0.5.0 bridge only, the old
# updates folder - copies before 0.5.0 read it there once):
#   build/publish-v<version>/  latest.json (signed), app-v<version>.zip, Rev-Radar-Setup-<version>.exe,
#                              source-v<version>.zip, README.txt, HOW-TO-PUBLISH.txt
#   python3 scripts/publish.py
# Needs: the signing key (keys/rev-radar-update-signing.pem or RR_SIGNING_KEY - see
# electron/updsig.cjs), the Windows Electron runtime in ~/.cache/revradar
# (electron-v<ver>-win32-x64.zip, same version as node_modules/electron), Go, node, python zstandard.
import datetime, hashlib, json, os, shutil, subprocess, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pkg = json.load(open(os.path.join(ROOT, 'package.json')))
ver = pkg['version']
evr = json.load(open(os.path.join(ROOT, 'node_modules', 'electron', 'package.json')))['version']
out = os.path.join(ROOT, 'build', f'publish-v{ver}')

def make_latest(app, setup):
    """latest.json: what installed copies read (app / setup: {file, sha256, size})"""
    notes = {}
    nf = os.path.join(ROOT, 'release-notes.json')
    if os.path.exists(nf):
        notes = json.load(open(nf, encoding='utf-8')).get(ver, {})
    groups = notes if isinstance(notes, dict) and notes else None
    flat = notes if isinstance(notes, list) else [x for xs in (groups or {}).values() for x in xs][:8]
    return {
        'product': 'Rev Radar',  # (a setup or app finding another program's latest.json ignores it)
        'version': ver,
        'runtime': evr,
        'published': datetime.date.today().isoformat(),
        'notes': flat,
        **({'groups': groups} if groups else {}),
        'app': app,
        'setup': setup,
    }

# (python3 scripts/publish.py --dry-latest: latest.json as it would be, packages left blank -
#  tests/public-scan.test.ts reads it)
if '--dry-latest' in sys.argv[1:]:
    blank = lambda f: {'file': f, 'sha256': '0' * 64, 'size': 0}
    print(json.dumps(make_latest(blank(f'app-v{ver}.zip'), blank(f'Rev-Radar-Setup-{ver}.exe')), indent=2))
    sys.exit(0)

def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()

# the signing key first (there, and the one the app trusts): found missing only after the whole
# build, it would leave a complete-looking folder with an unsigned latest.json (the PDF Editor's lesson)
subprocess.run(['node', os.path.join(ROOT, 'scripts', 'sign-latest.mjs'), '--check'], cwd=ROOT, check=True)

ez = os.path.expanduser(f'~/.cache/revradar/electron-v{evr}-win32-x64.zip')
if not os.path.exists(ez):
    sys.exit(f'missing {ez} (the Windows Electron {evr} runtime)')
sums = os.path.join(os.path.dirname(ez), 'SHASUMS256.txt')
if os.path.exists(sums):
    want = next((l.split()[0] for l in open(sums) if l.strip().endswith(f'electron-v{evr}-win32-x64.zip')), None)
    assert want and sha(ez) == want, 'the Electron runtime does not match its published checksum'

# 1. the app package (also builds dist/)
subprocess.run(['node', 'scripts/pack.mjs'], cwd=ROOT, check=True)
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
app = os.path.join(out, f'app-v{ver}.zip')
shutil.copyfile(os.path.join(ROOT, 'build', f'app-v{ver}.zip'), app)
# (the README's version line stamped from package.json - the PDF Editor once went out saying the
#  version before)
import re
readme = open(os.path.join(ROOT, 'pack', 'README.txt'), encoding='utf-8').read()
readme = re.sub(r'^REV RADAR \S+', f'REV RADAR {ver}', readme, count=1)
open(os.path.join(out, 'README.txt'), 'w', encoding='utf-8', newline='').write(readme)

# 2. the setup (runtime + this app inside)
subprocess.run([sys.executable, os.path.join(ROOT, 'installer', 'build.py'), ez, app, out], cwd=ROOT, check=True)
setup = os.path.join(out, f'Rev-Radar-Setup-{ver}.exe')

# 3. the source: the public copy (scripts/export-public.py - the AGPL's offer; never the notes, the
#    tests with the corpus, the key), zipped
import tempfile
pub = os.path.join(tempfile.mkdtemp(prefix='rev-radar-source-'), 'rev-radar')
subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'export-public.py'), pub], cwd=ROOT, check=True)
src = os.path.join(out, f'source-v{ver}.zip')
with zipfile.ZipFile(src, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, dn, fn in os.walk(pub):
        dn[:] = sorted(x for x in dn if x != '.git')
        for f in sorted(fn):
            if f == '.rev-radar-export':
                continue
            p = os.path.join(dp, f)
            z.write(p, f'rev-radar-{ver}/' + os.path.relpath(p, pub).replace(os.sep, '/'))
shutil.rmtree(os.path.dirname(pub), ignore_errors=True)

# 4. latest.json: what installed copies read
latest = make_latest({'file': os.path.basename(app), 'sha256': sha(app), 'size': os.path.getsize(app)},
                     {'file': os.path.basename(setup), 'sha256': sha(setup), 'size': os.path.getsize(setup)})
# signed with the publisher's key: copies from 0.5.0 on take nothing that isn't (electron/updsig.cjs).
# The plain fields stay beside the signed part: copies before 0.5.0 read those (the bridge).
# (written under another name and signed there: latest.json is never in the folder unsigned)
unsigned = os.path.join(out, 'latest.json.unsigned')
with open(unsigned, 'w') as f:
    json.dump(latest, f, indent=2)
try:
    subprocess.run(['node', os.path.join(ROOT, 'scripts', 'sign-latest.mjs'), unsigned], cwd=ROOT, check=True)
except subprocess.CalledProcessError:
    os.remove(unsigned)
    raise
os.replace(unsigned, os.path.join(out, 'latest.json'))
open(os.path.join(out, 'HOW-TO-PUBLISH.txt'), 'w', newline='\r\n').write(f'''Rev Radar {ver} - publishing

1. GitHub: a new release on https://github.com/nabilmunla/rev-radar/releases
   Tag: v{ver}   Title: Rev Radar {ver}
   Files (all in the same release):
     app-v{ver}.zip
     Rev-Radar-Setup-{ver}.exe
     source-v{ver}.zip
     latest.json
   Publish it as the latest release. Every installed copy (0.5.0 on) reads
   releases/latest/download/latest.json and takes app-v{ver}.zip from this release, asking
   its user first. To hold a version back: publish it as a pre-release or a draft.

2. Only for the bridge release (0.5.0): copies before 0.5.0 still read the old updates folder.
   Copy into that folder app-v{ver}.zip, Rev-Radar-Setup-{ver}.exe and README.txt, and LAST
   latest.json. They update to {ver} once; from then on they read GitHub only and the folder
   can be left as it is. Later versions go to GitHub only.

latest.json is signed with the key in keys/ (never in a zip, a release or the folder): don't
edit it by hand - an edited one is refused. An unsigned one is refused too.

New PCs: "Rev-Radar-Setup-{ver}.exe" from the release. Silently, with a tool:
  "Rev-Radar-Setup-{ver}.exe" --silent   (--just-me: for the person only; --no-desktop: no desktop
  shortcut; exit code 0 = installed, the log is %TEMP%\\Rev Radar Setup.log). Remove: --uninstall
  --silent on the copy in the program folder, or Windows' Installed apps.

How updating works: the app downloads app-v{ver}.zip (checked against the signed latest.json),
unpacks it into the person's own folder and restarts itself onto it. No helper program is
started, so the antivirus has nothing to block. A version with a new runtime ("runtime" in
latest.json) is installed by running its setup once - the app says so and opens the release page.

To go back on a PC: Settings > Updates > "Go back to <version>" - or run an older setup: what a
setup installs is what runs.
''')
print('\n'.join(f'{f}  {os.path.getsize(os.path.join(out, f)) // 1024} KB' for f in sorted(os.listdir(out))))
