"""A0 sheet of N million separate little strokes (like F104-DNK-...-LS-00412: traced line work, one
'm l S' per segment). python3 gen_monster.py out.pdf N_million [changed]"""
import sys, zlib, random
out, nm = sys.argv[1], float(sys.argv[2]); changed = len(sys.argv) > 3
W, H = 3370, 2384
random.seed(7)
parts = [b'q 0 0 0 RG 0.35 w 1 J\n']
n = int(nm * 1e6)
# "traced" line work: long polylines chopped into 1.5 pt segments, each its own stroke
CH = 200000
buf = []
x, y, ang = 100.0, 100.0, 0.0
import math
for i in range(n):
    if i % 400 == 0:
        x, y, ang = random.uniform(60, W - 60), random.uniform(60, H - 60), random.choice([0, math.pi / 2, math.pi / 4, random.uniform(0, 6.28)])
    nx, ny = x + 1.5 * math.cos(ang), y + 1.5 * math.sin(ang)
    if not (40 < nx < W - 40 and 40 < ny < H - 40): ang += math.pi / 2; continue
    buf.append(f'{x:.2f} {y:.2f} m {nx:.2f} {ny:.2f} l S\n')
    x, y = nx, ny
    if len(buf) >= CH: parts.append(''.join(buf).encode()); buf = []
parts.append(''.join(buf).encode())
# a title block and a note (text), and in the changed copy: a new wall + a dimension changed
parts.append(b'Q q 2 w 0 0 0 RG 3000 60 300 200 re S BT /F1 18 Tf 3020 220 Td (F104-TEST-LS-00412) Tj ET\n')
parts.append(b'BT /F1 14 Tf 1500 1200 Td (' + (b'4500' if changed else b'4200') + b') Tj ET\n')
if changed: parts.append(b'4 w 1200 900 m 1600 900 l S 1200 905 m 1600 905 l S\n')
parts.append(b'Q\n')
content = zlib.compress(b''.join(parts), 6)
objs = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'.encode(),
        b'<< /Length ' + str(len(content)).encode() + b' /Filter /FlateDecode >>\nstream\n' + content + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
pdf = bytearray(b'%PDF-1.7\n'); offs = []
for k, o in enumerate(objs):
    offs.append(len(pdf)); pdf += f'{k+1} 0 obj\n'.encode() + o + b'\nendobj\n'
x = len(pdf)
pdf += f'xref\n0 {len(objs)+1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010d} 00000 n \n'.encode() for o in offs)
pdf += f'trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode()
open(out, 'wb').write(pdf)
print(out, len(pdf) / 1e6, 'MB', n, 'strokes')
