# Broken and odd single files for tests/e2e-hostile.mjs (0.6.0 T31: the 0.5.x set came from the server and was not
# remade - this recipe makes a smaller one from files already here). Exact bytes do not matter; seeded, so a rerun
# makes the same set.
#   python3 tests/gen/gen_hostile.py <out dir> <a good pdf> <a good xlsx> <a good docx>
import os, random, shutil, sys, zipfile, io

out, pdf, xlsx, docx = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
rnd = random.Random(60)
P, X, D = (open(f, 'rb').read() for f in (pdf, xlsx, docx))
shutil.copy(pdf, os.path.join(out, 'base.pdf'))

def w(name, b):
    open(os.path.join(out, name), 'wb').write(b)

def flip(b, share):
    a = bytearray(b)
    for _ in range(max(1, int(len(a) * share))):
        i = rnd.randrange(len(a)); a[i] ^= 0xFF
    return bytes(a)

zipped = io.BytesIO()
with zipfile.ZipFile(zipped, 'w') as z: z.writestr('a.txt', 'not a pdf')
for ext, good in (('pdf', P), ('xlsx', X), ('docx', D)):
    w(f'empty.{ext}', b'')
    w(f'one-byte.{ext}', good[:1])
    w(f'trunc-10.{ext}', good[: len(good) // 10])
    w(f'trunc-50.{ext}', good[: len(good) // 2])
    w(f'trunc-99.{ext}', good[: len(good) * 99 // 100])
    w(f'garbage.{ext}', bytes(rnd.randrange(256) for _ in range(65536)))
    w(f'flipped.{ext}', flip(good, 0.01))
    w(f'html.{ext}', b'<!DOCTYPE html><html><body>' + b'<p>not this file</p>' * 2000 + b'</body></html>')
    w(f'zip.{ext}', zipped.getvalue())
w('header-only.pdf', b'%PDF-1.7\n')
k = P.rfind(b'xref')
w('no-xref.pdf', P[:k] if k > 0 else P[: len(P) // 2])
m = len(P) // 2
w('nul-flood.pdf', P[:m] + b'\0' * 4096 + P[m:])
w('pdf-as.xlsx', P)
w('pdf-as.docx', P)
w('xlsx-as.pdf', X)
print(len(os.listdir(out)) - 1, 'files in', out)
