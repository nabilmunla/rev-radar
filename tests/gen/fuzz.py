"""Random known-answer pairs (accuracy fuzzing). python3 fuzz.py <outdir> <n> <seed>
Each case: random paper / density, 0-3 random planted changes, maybe a title block bump, maybe a
re-plot of the new sheet (scale 99.8-100.2 %, turn up to 0.12 deg, shift up to 8 mm). truth.json
like suite.py (boxes in the new sheet's page points, top-left origin)."""
import json, os, random, copy, sys, math
from drawgen import make_sheet, draw, apply_change, bump_title, MM, bbox

out, N, SEED = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
os.makedirs(out, exist_ok=True)
KINDS = ['dim_text', 'room_name', 'area_text', 'wall_move', 'add_partition', 'remove_window', 'furniture_move', 'note_add', 'tile_remove', 'hatch_change', 'tiny_text']
def info():
    return dict(revs=[('A', '01.09.26', 'ISSUED FOR TENDER')], client='ESTATE RESIDENCES', project='RESIDENTIAL TOWER', title='GROUND FLOOR PLAN', scale='1:100', date='01.09.26', sheet='PRJ-AR-GA-L00', rev='A')
def tb_boxes(old, new):
    ok = {(it['id'], json.dumps(it, sort_keys=True)) for it in old.items}
    return [bbox(it) for it in new.items if it['tag'] in ('tbrev', 'tbdate', 'revtable') and (it['id'], json.dumps(it, sort_keys=True)) not in ok]
truth = {}
R = random.Random(SEED)
for i in range(N):
    paper = R.choice(['A1', 'A1', 'A3', 'A0'])
    dense = R.choice([1, 1, 2])
    seedv = R.randrange(10**6)
    rnd = random.Random(seedv)
    s0, plan = make_sheet(paper, info(), seedv, dense=dense)
    s1 = copy.deepcopy(s0)
    kinds = [R.choice(KINDS) for _ in range(R.choice([0, 1, 1, 2, 3]))]
    gt = []
    for k in kinds:
        try: gt += apply_change(s1, plan, k, rnd, k)
        except Exception as e: print('skip', k, e)
    title = []
    if R.random() < 0.5:
        before = copy.deepcopy(s1)
        bump_title(s1, 'B', '15.10.26', R.choice(['REVISED AS CLOUDED', 'ISSUED FOR CONSTRUCTION']))
        title = tb_boxes(before, s1)
    xf = None
    if R.random() < 0.5:
        xf = dict(s=1 + R.uniform(-0.002, 0.002), rot=R.uniform(-0.12, 0.12), dx=R.uniform(-8, 8), dy=R.uniform(-8, 8))
    W, H = s1.w * MM, s1.h * MM
    def tp(x, y):
        if not xf: return x, y
        X, Y = x - W / 2, (H - y) - H / 2
        sc = xf['s']; r = math.radians(-xf['rot'])
        X, Y = X * sc, Y * sc
        X, Y = X * math.cos(r) - Y * math.sin(r), X * math.sin(r) + Y * math.cos(r)
        X, Y = X + W / 2 + xf['dx'] * MM, Y + H / 2 - xf['dy'] * MM
        return X, H - Y
    def tbox(b, scale):
        b = [v * scale for v in b]
        pts = [tp(b[0], b[1]), tp(b[2], b[1]), tp(b[0], b[3]), tp(b[2], b[3])]
        return [round(min(p[0] for p in pts), 2), round(min(p[1] for p in pts), 2), round(max(p[0] for p in pts), 2), round(max(p[1] for p in pts), 2)]
    name = f'f{SEED}-{i:03d}-{paper}{"d" if dense > 1 else ""}-{"+".join(kinds) or "none"}{"-tb" if title else ""}{"-xf" if xf else ""}'
    draw(s0, f'{out}/{name}-old.pdf', 'old')
    draw(s1, f'{out}/{name}-new.pdf', 'new', xf=xf)
    truth[name] = dict(changes=[tbox(b, 1) for b in gt], title=[tbox(b, MM) for b in title], xf=xf)
    json.dump(truth, open(f'{out}/truth.json', 'w'), indent=1)
print(len(truth), 'cases')
