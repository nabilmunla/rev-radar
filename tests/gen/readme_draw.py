"""Generated drawing sets for the README's screenshot (never a real tender): python3 readme_draw.py <outdir>
Writes <outdir>/Issue A/*.pdf and <outdir>/Issue B/*.pdf - four A1 sheets each, three of them
changed in Issue B (a dimension, a wall moved and a partition added, a note), one unchanged."""
import copy, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drawgen import make_sheet, draw, apply_change, bump_title

out = sys.argv[1]
A, B = os.path.join(out, 'Issue A'), os.path.join(out, 'Issue B')
os.makedirs(A, exist_ok=True)
os.makedirs(B, exist_ok=True)

def info(title, sheet, rev='A', revs=None):
    return dict(revs=revs or [('A', '01.09.26', 'ISSUED FOR TENDER')], client='SAMPLE DEVELOPMENTS', project='SAMPLE RESIDENTIAL BUILDING',
                title=title, scale='1:100', date='01.09.26', sheet=sheet, rev=rev)

SHEETS = [
    ('AR-GA-L00', 'GROUND FLOOR PLAN', 11, ['wall_move', 'add_partition', 'room_name']),
    ('AR-GA-L01', 'FIRST FLOOR PLAN', 12, ['dim_text']),
    ('AR-GA-L02', 'SECOND FLOOR PLAN', 13, []),
    ('AR-GA-L03', 'THIRD FLOOR PLAN', 14, ['note_add', 'furniture_move']),
]
for num, title, seed, changes in SHEETS:
    s, plan = make_sheet('A1', info(title, num), seed)
    draw(s, os.path.join(A, f'{num} {title.title()}.pdf'), 'old')
    n = copy.deepcopy(s)
    rnd = random.Random(seed * 7)
    for k, kind in enumerate(changes):
        apply_change(n, plan, kind, rnd, f'c{k}')
    if changes:
        bump_title(n, 'B', '15.10.26', 'REVISED FOR TENDER')
    draw(n, os.path.join(B, f'{num} {title.title()}.pdf'), 'new')
print(out)
