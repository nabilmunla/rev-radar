# Build the portable app folder on the PC from the Electron runtime + the app payload.
# python3 install.py <electron-zip> <app-payload-zip> <target-folder>
# (writes files in place - this shell may not delete files; old app files that are no longer
#  in the payload are left, which is harmless)
import sys, os, zipfile
ez, az, target = sys.argv[1:4]
os.makedirs(target, exist_ok=True)
exe = os.path.join(target, 'Rev Radar.exe')
if not os.path.exists(exe):
    with zipfile.ZipFile(ez) as z:
        for m in z.infolist():
            if m.is_dir() or m.filename.endswith('default_app.asar'):
                continue
            name = 'Rev Radar.exe' if m.filename == 'electron.exe' else m.filename
            out = os.path.join(target, name)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with z.open(m) as src, open(out, 'wb') as dst:
                dst.write(src.read())
    print('runtime unpacked')
app = os.path.join(target, 'resources', 'app')
n = 0
with zipfile.ZipFile(az) as z:
    for m in z.infolist():
        if m.is_dir():
            continue
        out = os.path.join(app, m.filename)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with z.open(m) as src, open(out, 'wb') as dst:
            dst.write(src.read())
        n += 1
print('app files written:', n)
