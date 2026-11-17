# Writes THIRD-PARTY-NOTICES.txt (the repository, the app - Settings > Help > Licences - and the
# setup): Rev Radar's licence and the licence of every open-source part inside it.
#   python3 scripts/notices.py
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NM = os.path.join(ROOT, 'node_modules')
GOROOT = subprocess.run(['go', 'env', 'GOROOT'], capture_output=True, text=True).stdout.strip()
TP = os.path.join(ROOT, 'installer', 'third_party')

def read(*p):
    with open(os.path.join(*p), encoding='utf-8', errors='replace') as f:
        return f.read().strip()

parts = [
    # (name, what it does here, licence, file with the licence text)
    ('MuPDF (mupdf.js)', 'drawing very heavy CAD sheets', 'GNU Affero General Public License v3 or later', (NM, 'mupdf', 'LICENSE')),
    ('PDFium (via @embedpdf/pdfium)', 'reading and drawing PDF pages, text, the clouded PDF export', 'BSD-3-Clause / Apache-2.0 (PDFium)', (NM, '@embedpdf/pdfium', 'LICENSE.pdfium')),
    ('@embedpdf/pdfium', 'PDFium built for the web', 'MIT', (NM, '@embedpdf/pdfium', 'LICENSE')),
    ('Tesseract OCR (tesseract.js)', 'reading scanned BOQs and documents', 'Apache License 2.0', (NM, 'tesseract.js', 'LICENSE.md')),
    ('tesseract.js-core', 'Tesseract compiled for the web', 'Apache License 2.0', (NM, 'tesseract.js-core', 'LICENSE')),
    ('Tesseract language data (English)', 'the OCR language', 'Apache License 2.0 (tessdata)', None),
    ('React, React DOM, Scheduler', 'the interface', 'MIT', (NM, 'react', 'LICENSE')),
    ('fflate', 'zip files (Excel workbooks, updates)', 'MIT', (NM, 'fflate', 'LICENSE')),
    ('Inter (font)', 'interface font', 'SIL Open Font License 1.1', (NM, '@fontsource-variable/inter', 'LICENSE')),
    ('Electron (Chromium, Node.js)', 'the app runtime', 'MIT (Electron); Chromium and Node.js licences: LICENSE and LICENSES.chromium.html in the app folder', (NM, 'electron', 'LICENSE')),
    ('Rev Radar Setup: Go standard library', 'the setup', 'BSD-3-Clause', (GOROOT, 'LICENSE')),
    ('Rev Radar Setup: golang.org/x/sys', 'Windows functions', 'BSD-3-Clause', (TP, 'sys', 'LICENSE')),
    ('Rev Radar Setup: go-webview2', 'the setup window', 'MIT', (TP, 'go-webview2', 'LICENSE')),
    ('Rev Radar Setup: go-winloader', 'loading WebView2Loader', 'MIT', (TP, 'go-winloader', 'LICENSE.md')),
    ('Rev Radar Setup: WebView2Loader (Microsoft)', 'starting Edge WebView2', 'Microsoft WebView2 SDK licence (BSD-style)', (TP, 'go-webview2', 'webviewloader', 'sdk', 'LICENSE.txt')),
    ('Rev Radar Setup: klauspost/compress', 'unpacking the app', 'BSD-3-Clause / Apache-2.0 / MIT parts', (TP, 'compress', 'LICENSE')),
]

# every runtime package in package.json is shipped, so it needs its entry above (a new one added
# without it stops here, instead of going out with its notice missing)
COVERED = {'mupdf', '@embedpdf/pdfium', 'tesseract.js', 'tesseract.js-core', 'react', 'react-dom', 'fflate'}
missing = sorted(set(json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8')).get('dependencies', {})) - COVERED)
if missing:
    sys.exit('notices.py: no licence entry for ' + ', '.join(missing) + ' - add it to the list')

out = ['REV RADAR - LICENCES\n====================\n']
out.append('''Rev Radar is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, version 3 or
(at your option) any later version (the LICENSE file). It comes WITHOUT ANY WARRANTY.

It is built on the open-source parts listed below; each keeps its own licence. MuPDF is licensed
under the AGPL v3 or later, so anyone who passes a copy of Rev Radar on must also make its
complete source code available under the same licence. The source code of every version is at
https://github.com/nabilmunla/rev-radar (and as source-v<version>.zip in each release).
''')
out.append('\nPARTS\n-----\n')
for name, what, lic, _ in parts:
    out.append(f'- {name}: {what}.\n  Licence: {lic}\n')
out.append('\n\nLICENCE TEXTS\n=============\n')
seen = set()
for name, _, lic, f in parts:
    if not f:
        continue
    p = os.path.join(*f)
    if p in seen:
        continue
    # (a licence text that isn't where it should be stops here - not a notice gone out without it)
    if not os.path.exists(p):
        sys.exit(f'notices.py: licence text of {name} not found: {p}')
    seen.add(p)
    out.append('\n' + '-' * 78 + '\n' + name + '\n' + '-' * 78 + '\n\n' + read(p) + '\n')
dst = os.path.join(ROOT, 'THIRD-PARTY-NOTICES.txt')
open(dst, 'w', encoding='utf-8', newline='\n').write(''.join(out))
print(dst, os.path.getsize(dst) // 1024, 'KB', len(seen), 'licence texts')
