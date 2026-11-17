"""Synthetic CAD-like drawing sets with known changes (ground truth) for Rev Radar tests.

A sheet = list of primitives (each with an id). A revision copies the list and applies
changes; ground truth = union bbox (page points, origin top-left) of the primitives that
differ. Rendered with reportlab (vector, Helvetica text like CAD 'TrueType' output).
"""
import json, math, random, copy, sys, os
from reportlab.pdfgen import canvas
from reportlab.lib.colors import Color

MM = 72 / 25.4

PAPER = {'A0': (1189, 841), 'A1': (841, 594), 'A2': (594, 420), 'A3': (420, 297)}

class Sheet:
    def __init__(self, w, h):
        self.w, self.h = w, h      # mm
        self.items = []            # dicts: id, kind, ...
        self.n = 0

    def add(self, kind, tag=None, **kw):
        self.n += 1
        d = dict(id=f'{kind}{self.n}', kind=kind, tag=tag or '', **kw)
        self.items.append(d)
        return d

    def line(self, x1, y1, x2, y2, w=0.18, tag=None, dash=None, col=(0, 0, 0)):
        return self.add('line', tag, p=[x1, y1, x2, y2], w=w, dash=dash, col=col)

    def rect(self, x, y, ww, hh, w=0.25, tag=None, fill=None, col=(0, 0, 0)):
        return self.add('rect', tag, r=[x, y, ww, hh], w=w, fill=fill, col=col)

    def circle(self, x, y, r, w=0.25, tag=None, fill=None):
        return self.add('circle', tag, c=[x, y, r], w=w, fill=fill)

    def arc(self, x, y, r, a0, a1, w=0.18, tag=None):
        return self.add('arc', tag, c=[x, y, r], a=[a0, a1], w=w)

    def text(self, x, y, s, size=2.5, tag=None, angle=0, bold=False, col=(0, 0, 0)):
        return self.add('text', tag, t=[x, y], s=s, size=size, angle=angle, bold=bold, col=col)


def bbox(it):
    k = it['kind']
    if k == 'line':
        x1, y1, x2, y2 = it['p']; pad = it['w'] / 2
        return [min(x1, x2) - pad, min(y1, y2) - pad, max(x1, x2) + pad, max(y1, y2) + pad]
    if k == 'rect':
        x, y, w, h = it['r']; pad = it['w'] / 2
        return [x - pad, y - pad, x + w + pad, y + h + pad]
    if k in ('circle', 'arc'):
        x, y, r = it['c']
        return [x - r, y - r, x + r, y + r]
    if k == 'text':
        x, y = it['t']; s = it['size']
        wdt = len(it['s']) * s * 0.62
        if it['angle'] == 90:
            return [x - s * 1.1, y - wdt, x + s * 0.3, y]
        return [x, y - s * 1.05, x + wdt, y + s * 0.3]
    raise ValueError(k)


def draw(sheet, path, meta=None, xf=None, page=None):
    W, H = sheet.w * MM, sheet.h * MM
    PW, PH = (page[0] * MM, page[1] * MM) if page else (W, H)
    c = canvas.Canvas(path, pagesize=(PW, PH), pageCompression=1)
    if meta:
        c.setTitle(meta)
    c.setLineCap(0)
    if xf:
        # xf = dict(dx, dy (mm, + = right / down), s (scale), rot (degrees, clockwise on paper))
        c.translate(PW / 2 + xf.get('dx', 0) * MM, PH / 2 - xf.get('dy', 0) * MM)
        c.rotate(-xf.get('rot', 0))
        c.scale(xf.get('s', 1), xf.get('s', 1))
        c.translate(-W / 2, -H / 2)
    for it in sheet.items:
        k = it['kind']
        col = it.get('col', (0, 0, 0))
        c.setStrokeColor(Color(*col)); c.setFillColor(Color(*col))
        if k != 'text':
            c.setLineWidth(it['w'] * MM)
        if k == 'line':
            x1, y1, x2, y2 = it['p']
            if it['dash']:
                c.setDash([d * MM for d in it['dash']])
            c.line(x1 * MM, H - y1 * MM, x2 * MM, H - y2 * MM)
            c.setDash([])
        elif k == 'rect':
            x, y, w, h = it['r']
            if it['fill'] is not None:
                c.setFillColor(Color(*it['fill']))
            c.rect(x * MM, H - (y + h) * MM, w * MM, h * MM, stroke=1, fill=1 if it['fill'] is not None else 0)
        elif k == 'circle':
            x, y, r = it['c']
            if it['fill'] is not None:
                c.setFillColor(Color(*it['fill']))
            c.circle(x * MM, H - y * MM, r * MM, stroke=1, fill=1 if it['fill'] is not None else 0)
        elif k == 'arc':
            x, y, r = it['c']; a0, a1 = it['a']
            p = c.beginPath()
            p.arc((x - r) * MM, H - (y + r) * MM, (x + r) * MM, H - (y - r) * MM, startAng=a0, extent=a1 - a0)
            c.drawPath(p, stroke=1, fill=0)
        elif k == 'text':
            x, y = it['t']
            c.setFont('Helvetica-Bold' if it['bold'] else 'Helvetica', it['size'] * MM / 0.72 * 0.72)
            if it['angle']:
                c.saveState(); c.translate(x * MM, H - y * MM); c.rotate(it['angle'])
                c.drawString(0, 0, it['s']); c.restoreState()
            else:
                c.drawString(x * MM, H - y * MM, it['s'])
    c.showPage()
    c.save()


# ---------------------------------------------------------------- content

def title_block(s, info):
    W, H = s.w, s.h
    x0 = W - 10 - 160
    s.rect(10, 10, W - 20, H - 20, w=0.7, tag='frame')
    s.rect(15, 15, W - 30, H - 30, w=0.35, tag='frame')
    s.line(x0, 15, x0, H - 15, w=0.5, tag='tb')
    y = 22
    s.text(x0 + 5, y + 6, 'CONSULTANT', 4, tag='tb', bold=True)
    s.text(x0 + 5, y + 12, 'ARCHITECTURE & ENGINEERING CONSULTANTS', 2.2, tag='tb')
    y = 45; s.line(x0, y, W - 15, y, w=0.35, tag='tb')
    # revision table
    s.text(x0 + 5, y + 6, 'REV', 2.2, tag='tb', bold=True)
    s.text(x0 + 20, y + 6, 'DATE', 2.2, tag='tb', bold=True)
    s.text(x0 + 45, y + 6, 'DESCRIPTION', 2.2, tag='tb', bold=True)
    for i, (r, d, desc) in enumerate(info['revs']):
        yy = y + 13 + i * 6
        s.text(x0 + 5, yy, r, 2.2, tag='revtable')
        s.text(x0 + 20, yy, d, 2.2, tag='revtable')
        s.text(x0 + 45, yy, desc, 2.2, tag='revtable')
        s.line(x0, yy + 2, W - 15, yy + 2, w=0.13, tag='revtable')
    y = H - 140
    s.line(x0, y, W - 15, y, w=0.35, tag='tb')
    s.text(x0 + 5, y + 8, 'CLIENT', 2.2, tag='tb', bold=True)
    s.text(x0 + 5, y + 15, info['client'], 3, tag='tb')
    y += 25; s.line(x0, y, W - 15, y, w=0.35, tag='tb')
    s.text(x0 + 5, y + 8, 'PROJECT', 2.2, tag='tb', bold=True)
    s.text(x0 + 5, y + 15, info['project'], 3.5, tag='tb', bold=True)
    y += 25; s.line(x0, y, W - 15, y, w=0.35, tag='tb')
    s.text(x0 + 5, y + 8, 'DRAWING TITLE', 2.2, tag='tb', bold=True)
    s.text(x0 + 5, y + 16, info['title'], 4, tag='tb', bold=True)
    y += 30; s.line(x0, y, W - 15, y, w=0.35, tag='tb')
    s.text(x0 + 5, y + 8, 'SCALE', 2.2, tag='tb', bold=True)
    s.text(x0 + 5, y + 15, info['scale'], 3, tag='tb')
    s.text(x0 + 60, y + 8, 'DATE', 2.2, tag='tb', bold=True)
    s.text(x0 + 60, y + 15, info['date'], 3, tag='tbdate')
    y += 22; s.line(x0, y, W - 15, y, w=0.35, tag='tb')
    s.text(x0 + 5, y + 8, 'DRAWING No.', 2.2, tag='tb', bold=True)
    s.text(x0 + 5, y + 20, info['sheet'], 6, tag='tb', bold=True)
    s.text(x0 + 120, y + 8, 'REV', 2.2, tag='tb', bold=True)
    s.text(x0 + 122, y + 20, info['rev'], 6, tag='tbrev', bold=True)
    return x0


def floor_plan(s, rnd, x0, dense=1, area=None, pre='', extras=True):
    """Rectilinear plan in the drawing area left of the title block. 1:100 (1 m = 10 mm).
    area = (x0, y0, x1, y1) of the grid (default: the whole drawing area); pre = tag prefix (a
    second plan on the sheet); extras = notes and key plan below it."""
    ax0, ay0, ax1, ay1 = area or (60, 60, x0 - 40, s.h - 110)
    n0 = len(s.items)
    nx, ny = 8, 6
    gx = [ax0 + (ax1 - ax0) * i / (nx - 1) for i in range(nx)]
    gy = [ay0 + (ay1 - ay0) * j / (ny - 1) for j in range(ny)]
    # grid
    for i, x in enumerate(gx):
        s.line(x, ay0 - 30, x, ay1 + 15, w=0.13, dash=[6, 1.5, 1, 1.5], tag='grid', col=(0.3, 0.3, 0.3))
        s.circle(x, ay0 - 35, 5, w=0.25, tag='grid')
        s.text(x - 1.8, ay0 - 33.5, chr(65 + i), 4, tag='grid')
    for j, y in enumerate(gy):
        s.line(ax0 - 30, y, ax1 + 15, y, w=0.13, dash=[6, 1.5, 1, 1.5], tag='grid', col=(0.3, 0.3, 0.3))
        s.circle(ax0 - 35, y, 5, w=0.25, tag='grid')
        s.text(ax0 - 37, y + 1.5, str(j + 1), 4, tag='grid')
    walls = []
    # outer walls (2 mm thick), hatched
    def wall(x, y, w, h, tag, hatch=0.9):
        r = s.rect(x, y, w, h, w=0.35, tag=tag)
        items = [r]
        # diagonal hatch clipped to the rect (45 degrees)
        step = hatch / dense
        t = -h
        while t < w:
            xa, ya = x + max(t, 0), y + max(-t, 0)
            xb = x + min(t + h, w); yb = y + min(h, w - t)
            if xb > xa:
                items.append(s.line(xa, ya, xb, yb, w=0.09, tag=tag + '_h'))
            t += step
        walls.append((tag, [x, y, w, h]))
        return items
    T = 2.0
    wall(gx[0] - T / 2, gy[0] - T / 2, gx[-1] - gx[0] + T, T, 'wallN')
    wall(gx[0] - T / 2, gy[-1] - T / 2, gx[-1] - gx[0] + T, T, 'wallS')
    wall(gx[0] - T / 2, gy[0] + T / 2, T, gy[-1] - gy[0] - T, 'wallW')
    wall(gx[-1] - T / 2, gy[0] + T / 2, T, gy[-1] - gy[0] - T, 'wallE')
    # columns at grid crossings (filled)
    for x in gx:
        for y in gy:
            s.rect(x - 2.5, y - 2.5, 5, 5, w=0.25, fill=(0.15, 0.15, 0.15), tag='col')
    # partitions: every other bay, 1 mm thick
    rooms = []
    names = ['BEDROOM', 'LIVING', 'KITCHEN', 'BATH', 'STORE', 'CORRIDOR', 'LOBBY', 'OFFICE', 'MEETING', 'PANTRY', 'ELEC.', 'W.C.']
    for i in range(1, nx - 1):
        x = gx[i]
        for j in range(ny - 1):
            if rnd.random() < 0.7:
                wall(x - 0.5, gy[j] + 2.5, 1.0, gy[j + 1] - gy[j] - 5, f'pv{i}_{j}', hatch=0.8)
                if rnd.random() < 0.6:  # door
                    dy = gy[j] + (gy[j + 1] - gy[j]) * 0.3
                    s.arc(x + 0.5, dy, 9, 0, 90, w=0.13, tag=f'door{i}_{j}')
                    s.line(x + 0.5, dy, x + 0.5, dy - 9, w=0.25, tag=f'door{i}_{j}')
    for j in range(1, ny - 1):
        y = gy[j]
        for i in range(nx - 1):
            if rnd.random() < 0.5:
                wall(gx[i] + 2.5, y - 0.5, gx[i + 1] - gx[i] - 5, 1.0, f'ph{i}_{j}', hatch=0.8)
    # windows on outer walls
    for i in range(nx - 1):
        mx = (gx[i] + gx[i + 1]) / 2
        for k in range(3):
            s.line(mx - 8, gy[0] - 1 + k, mx + 8, gy[0] - 1 + k, w=0.13, tag=f'winN{i}')
            s.line(mx - 8, gy[-1] - 1 + k, mx + 8, gy[-1] - 1 + k, w=0.13, tag=f'winS{i}')
    # rooms: labels + furniture + floor tiles (dense)
    for i in range(nx - 1):
        for j in range(ny - 1):
            cx = (gx[i] + gx[i + 1]) / 2; cy = (gy[j] + gy[j + 1]) / 2
            nm = rnd.choice(names) + f' {i + 1}{j + 1:02d}'
            area = (gx[i + 1] - gx[i]) * (gy[j + 1] - gy[j]) / 100
            s.text(cx - 12, cy - 2, nm, 2.5, tag=f'room{i}_{j}', bold=True)
            s.text(cx - 8, cy + 2.5, f'{area:.1f} m2', 2.0, tag=f'roomarea{i}_{j}')
            s.text(cx - 8, cy + 6.5, f'FFL +{rnd.choice([0, 150, 300]):d}', 1.8, tag=f'ffl{i}_{j}')
            if rnd.random() < 0.5:
                fx = gx[i] + 6 + rnd.random() * 10; fy = gy[j] + 6 + rnd.random() * 10
                s.rect(fx, fy, 16, 8, w=0.13, tag=f'furn{i}_{j}')
                s.circle(fx + 22, fy + 4, 3, w=0.13, tag=f'furn{i}_{j}')
            if rnd.random() < 0.35 * dense:  # tiled floor = many thin lines
                step = 3.0
                xx = gx[i] + 3
                while xx < gx[i + 1] - 3:
                    s.line(xx, gy[j] + 3, xx, gy[j + 1] - 3, w=0.05, tag=f'tile{i}_{j}', col=(0.45, 0.45, 0.45))
                    xx += step
                yy = gy[j] + 3
                while yy < gy[j + 1] - 3:
                    s.line(gx[i] + 3, yy, gx[i + 1] - 3, yy, w=0.05, tag=f'tile{i}_{j}', col=(0.45, 0.45, 0.45))
                    yy += step
    # dimension chains (top, left)
    def hdim(xs, y, tag):
        s.line(xs[0], y, xs[-1], y, w=0.13, tag=tag)
        for k, x in enumerate(xs):
            s.line(x, y - 2, x, y + 2, w=0.13, tag=tag)
            s.line(x - 1, y + 1, x + 1, y - 1, w=0.35, tag=tag)
        for k in range(len(xs) - 1):
            v = round((xs[k + 1] - xs[k]) * 100)
            s.text((xs[k] + xs[k + 1]) / 2 - 3, y - 1.2, str(v), 2.0, tag=f'{tag}_t{k}')
    def vdim(ys, x, tag):
        s.line(x, ys[0], x, ys[-1], w=0.13, tag=tag)
        for y in ys:
            s.line(x - 2, y, x + 2, y, w=0.13, tag=tag)
            s.line(x - 1, y + 1, x + 1, y - 1, w=0.35, tag=tag)
        for k in range(len(ys) - 1):
            v = round((ys[k + 1] - ys[k]) * 100)
            s.text(x - 1.2, (ys[k] + ys[k + 1]) / 2 + 3, str(v), 2.0, tag=f'{tag}_t{k}', angle=90)
    hdim(gx, ay0 - 20, 'dimT')
    vdim(gy, ax0 - 20, 'dimL')
    hdim([gx[0], gx[-1]], ay0 - 12, 'dimT2')
    if pre:
        for it in s.items[n0:]: it['tag'] = pre + it['tag']
    if not extras:
        return dict(gx=gx, gy=gy, walls=walls)
    # notes block bottom
    ny0 = s.h - 85
    s.text(ax0, ny0, 'GENERAL NOTES', 3, tag='notes', bold=True)
    notes = ['ALL DIMENSIONS ARE IN MILLIMETRES UNLESS OTHERWISE NOTED.',
             'DO NOT SCALE FROM THIS DRAWING. USE WRITTEN DIMENSIONS ONLY.',
             'ALL LEVELS ARE IN METRES ABOVE DUBAI MEAN SEA LEVEL.',
             'REFER TO STRUCTURAL DRAWINGS FOR ALL COLUMN AND SLAB DETAILS.',
             'BLOCKWORK WALLS 200 THK EXTERNAL / 100 THK INTERNAL U.N.O.',
             'CONTRACTOR TO VERIFY ALL SITE DIMENSIONS BEFORE FABRICATION.']
    for k, n in enumerate(notes):
        s.text(ax0, ny0 + 6 + k * 4.5, f'{k + 1}. {n}', 2.0, tag=f'note{k}')
    # key plan bottom-right of drawing area
    kx, ky = x0 - 90, s.h - 85
    s.rect(kx, ky, 60, 40, w=0.25, tag='key')
    s.rect(kx + 10, ky + 8, 25, 20, w=0.13, fill=(0.8, 0.8, 0.8), tag='key')
    s.text(kx, ky - 3, 'KEY PLAN', 2.5, tag='key', bold=True)
    return dict(gx=gx, gy=gy, walls=walls)


def make_sheet(paper, info, seed, dense=1):
    w, h = PAPER[paper]
    s = Sheet(w, h)
    rnd = random.Random(seed)
    x0 = title_block(s, info)
    plan = floor_plan(s, rnd, x0, dense)
    return s, plan


def move_items(items, dx, dy):
    """shift items on the paper (mm); returns the union box before and after"""
    boxes = [bbox(it) for it in items]
    for it in items:
        k = it['kind']
        if k == 'line': it['p'] = [it['p'][0] + dx, it['p'][1] + dy, it['p'][2] + dx, it['p'][3] + dy]
        elif k == 'rect': it['r'] = [it['r'][0] + dx, it['r'][1] + dy, it['r'][2], it['r'][3]]
        elif k in ('circle', 'arc'): it['c'] = [it['c'][0] + dx, it['c'][1] + dy, it['c'][2]]
        elif k == 'text': it['t'] = [it['t'][0] + dx, it['t'][1] + dy]
    boxes += [bbox(it) for it in items]
    return union(boxes)


def by_tag(s, prefix):
    return [it for it in s.items if it['tag'] == prefix or it['tag'].startswith(prefix + '_')]


def union(boxes):
    if not boxes:
        return None
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def apply_change(s, plan, kind, rnd, label):
    """Mutate sheet s in place; return list of ground-truth boxes (mm) for the change."""
    gt = []
    if kind == 'dim_text':
        cands = [it for it in s.items if it['tag'].startswith('dimT_t')]
        it = rnd.choice(cands)
        old = bbox(it); it['s'] = str(int(it['s']) + 300); gt.append(union([old, bbox(it)]))
    elif kind == 'room_name':
        cands = [it for it in s.items if it['tag'].startswith('room') and not it['tag'].startswith('roomarea') and it['kind'] == 'text']
        it = rnd.choice(cands)
        old = bbox(it); it['s'] = it['s'].replace(it['s'].split(' ')[0], 'PLANT ROOM'); gt.append(union([old, bbox(it)]))
    elif kind == 'area_text':
        cands = [it for it in s.items if it['tag'].startswith('roomarea')]
        it = rnd.choice(cands)
        old = bbox(it); v = float(it['s'].split()[0]); it['s'] = f'{v + 1.3:.1f} m2'; gt.append(union([old, bbox(it)]))
    elif kind == 'wall_move':
        tags = sorted({it['tag'] for it in s.items if it['tag'].startswith('pv')} - {t for t in [] })
        tags = [t for t in tags if not t.endswith('_h')]
        tag = rnd.choice(tags)
        group = by_tag(s, tag)
        boxes = [bbox(it) for it in group]
        for it in group:
            if it['kind'] == 'rect': it['r'][0] += 3
            elif it['kind'] == 'line': it['p'][0] += 3; it['p'][2] += 3
        boxes += [bbox(it) for it in group]
        gt.append(union(boxes))
    elif kind == 'add_partition':
        gx, gy = plan['gx'], plan['gy']
        i = rnd.randrange(len(gx) - 1); j = rnd.randrange(len(gy) - 1)
        x = (gx[i] + gx[i + 1]) / 2 + 4
        n0 = len(s.items)
        r = s.rect(x - 0.5, gy[j] + 2.5, 1.0, (gy[j + 1] - gy[j]) * 0.6, w=0.35, tag='newpart')
        y = gy[j] + 2.5
        while y < gy[j] + 2.5 + (gy[j + 1] - gy[j]) * 0.6:
            s.line(x - 0.5, y, x + 0.5, min(y + 1, gy[j] + 2.5 + (gy[j + 1] - gy[j]) * 0.6), w=0.09, tag='newpart_h')
            y += 0.8
        s.arc(x + 0.5, y + 1, 8, 0, 90, w=0.13, tag='newpart')
        gt.append(union([bbox(it) for it in s.items[n0:]]))
    elif kind == 'remove_window':
        i = rnd.randrange(len(plan['gx']) - 1)
        tag = rnd.choice([f'winN{i}', f'winS{i}'])
        group = by_tag(s, tag)
        gt.append(union([bbox(it) for it in group]))
        for it in group: s.items.remove(it)
    elif kind == 'furniture_move':
        tags = sorted({it['tag'] for it in s.items if it['tag'].startswith('furn')})
        tag = rnd.choice(tags); group = by_tag(s, tag)
        boxes = [bbox(it) for it in group]
        for it in group:
            if it['kind'] == 'rect': it['r'][1] += 6
            if it['kind'] == 'circle': it['c'][1] += 6
        boxes += [bbox(it) for it in group]; gt.append(union(boxes))
    elif kind == 'note_add':
        notes = [it for it in s.items if it['tag'].startswith('note') and it['kind'] == 'text']
        last = notes[-1]
        k = len(notes) - 1
        it = s.text(last['t'][0], last['t'][1] + 4.5, f'{k + 1}. ALL GLAZING TO BE TEMPERED SAFETY GLASS AS PER DCD REQUIREMENTS.', 2.0, tag='note_new')
        gt.append(bbox(it))
    elif kind == 'tile_remove':
        tags = sorted({it['tag'] for it in s.items if it['tag'].startswith('tile')})
        if tags:
            tag = rnd.choice(tags); group = by_tag(s, tag)
            gt.append(union([bbox(it) for it in group]))
            for it in group: s.items.remove(it)
    elif kind == 'hatch_change':  # wall hatch spacing changed (same outline)
        tags = sorted({it['tag'] for it in s.items if it['tag'].startswith('ph') and it['tag'].endswith('_h')})
        tag = rnd.choice(tags)
        group = [it for it in s.items if it['tag'] == tag]
        gt.append(union([bbox(it) for it in group]))
        for it in group[1::2]: s.items.remove(it)
    elif kind == 'tiny_text':  # single character change in a long note
        notes = [it for it in s.items if it['tag'].startswith('note') and it['kind'] == 'text' and 'THK' in it['s']]
        it = notes[0]; old = bbox(it); it['s'] = it['s'].replace('100 THK', '150 THK'); gt.append(union([old, bbox(it)]))
    else:
        raise ValueError(kind)
    return [[round(v * MM, 2) for v in [b[0], b[1], b[2], b[3]]] for b in gt]


def bump_title(s, rev, date, desc):
    for it in s.items:
        if it['tag'] == 'tbrev': it['s'] = rev
        if it['tag'] == 'tbdate': it['s'] = date
    last = [it for it in s.items if it['tag'] == 'revtable'][-3:]
    yy = last[0]['t'][1] + 6
    W = s.w; x0 = W - 10 - 160
    boxes = []
    for x, t in ((x0 + 5, rev), (x0 + 20, date), (x0 + 45, desc)):
        boxes.append(bbox(s.text(x, yy, t, 2.2, tag='revtable')))
    s.line(x0, yy + 2, W - 15, yy + 2, w=0.13, tag='revtable')
    return boxes


if __name__ == '__main__':
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    s, plan = make_sheet('A1', dict(revs=[('A', '01.09.26', 'ISSUED FOR TENDER')], client='CLIENT', project='PROJECT', title='GROUND FLOOR PLAN', scale='1:100', date='01.09.26', sheet='PRJ-AR-GA-L00', rev='A'), 1)
    draw(s, os.path.join(out, 'demo.pdf'))
    print(len(s.items), 'items')
