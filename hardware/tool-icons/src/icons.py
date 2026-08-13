"""
Tool-tip icons for the tool organizer, as SVGs TinkerCAD will actually import.

TinkerCAD's SVG importer has three rules that quietly ruin most icon files:

  - it reads FILLS only.  A stroked outline with no fill imports as nothing.
  - it ignores <text>.  Anything lettered has to be outlines already.
  - curves are fine, but nothing beats plain polygons for surviving the trip.

So every icon here is a single <path> of straight-line segments with a solid
fill and no stroke anywhere.  Curves are polygonised at build time.

Everything is drawn in a 20 x 20 mm box.  The thinnest feature in the set is
MIN_FEATURE mm at that size, which is the number that decides how far you can
shrink an icon before it stops printing -- see the README.

Run:  python3 icons.py
"""

import math
import os

SIZE = 20.0
C = SIZE / 2.0

# Nothing in the set is drawn thinner than this at 20 mm.  Engraving a groove
# narrower than about two nozzle widths does not come out, so this is what
# sets the smallest usable icon.
MIN_FEATURE = 1.8

N_ARC = 96          # segments per full circle when polygonising


def _fmt(pts):
    return "M " + " L ".join(f"{x:.4f},{y:.4f}" for x, y in pts) + " Z"


def _ngon(n, r, rot=0.0, ccw=True):
    step = 2 * math.pi / n
    idx = range(n) if ccw else range(n - 1, -1, -1)
    return [(C + r * math.cos(rot + i * step),
             C + r * math.sin(rot + i * step)) for i in idx]


def _rosette(lobes, r_mid, amp, n=N_ARC * 2):
    """The lobed profile a Torx or Pentalobe driver actually has."""
    out = []
    for i in range(n):
        t = 2 * math.pi * i / n
        r = r_mid + amp * math.cos(lobes * t)
        out.append((C + r * math.cos(t), C + r * math.sin(t)))
    return out


def _arc(r, a0, a1, n=N_ARC // 2):
    """Arc in SVG coordinates (y down), angles in degrees measured as usual."""
    out = []
    for i in range(n + 1):
        t = math.radians(a0 + (a1 - a0) * i / n)
        out.append((C + r * math.cos(t), C - r * math.sin(t)))
    return out


def _bar(p0, p1, w0, w1):
    """A tapered bar from p0 to p1, w0 wide at one end and w1 at the other."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy)
    px, py = -dy / L, dx / L
    return [
        (p0[0] + px * w0 / 2, p0[1] + py * w0 / 2),
        (p1[0] + px * w1 / 2, p1[1] + py * w1 / 2),
        (p1[0] - px * w1 / 2, p1[1] - py * w1 / 2),
        (p0[0] - px * w0 / 2, p0[1] - py * w0 / 2),
    ]


# ---------------------------------------------------------------------------
# Driver tips, drawn end-on
# ---------------------------------------------------------------------------
def phillips():
    a, b = 4.6 / 2, 8.0        # arm half-width, arm reach
    return [[
        (C - a, C - b), (C + a, C - b), (C + a, C - a), (C + b, C - a),
        (C + b, C + a), (C + a, C + a), (C + a, C + b), (C - a, C + b),
        (C - a, C + a), (C - b, C + a), (C - b, C - a), (C - a, C - a),
    ]]


def flathead():
    return [_bar((2.0, C), (18.0, C), 4.6, 4.6)]


def torx():
    return [_rosette(6, 6.4, 1.6)]


def pentalobe():
    return [_rosette(5, 6.4, 1.6)]


def hex_tip():
    return [_ngon(6, 8.0)]


def standoff():
    """Standoff driver seen END-ON, like the rest of the driver tips: a hollow
    hex socket.  The inner ring is wound the OTHER way, so it reads as a hole
    under the nonzero rule and does not depend on evenodd surviving."""
    return [_ngon(6, 8.0, ccw=True) + [None] + _ngon(6, 4.6, ccw=False)]


def standoff_driver():
    """The same tool seen from the SIDE -- a shaft with a socket end and the
    bore open at the tip.  Breaks the set's end-on convention on purpose: some
    people picture the tool, not the tip profile.  Use whichever reads."""
    # The bore must stop exactly ON the tip, never past it.  A hole polygon
    # that overhangs its outer ring has winding -1 out there, which is nonzero,
    # so the overhang renders FILLED -- a stray sliver that imports as a solid.
    tip = 18.6
    outer = [
        (7.5, 2.0), (12.5, 2.0), (12.5, 12.0), (13.6, 13.5),
        (13.6, tip), (6.4, tip), (6.4, 13.5), (7.5, 12.0),
    ]
    bore = [(8.9, 14.2), (8.9, tip), (11.1, tip), (11.1, 14.2)]
    return [outer + [None] + bore]


def tripoint():
    """Three straight arms at 120 degrees -- a Y-tip."""
    w, L = 3.8, 8.0
    angles = [-90, 30, 150]
    inner_r = (w / 2) / math.sin(math.radians(60))
    pts = []
    for k, a in enumerate(angles):
        ar = math.radians(a)
        ux, uy = math.cos(ar), math.sin(ar)
        px, py = -uy, ux
        tip = (C + ux * L, C + uy * L)
        pts.append((tip[0] - px * w / 2, tip[1] - py * w / 2))
        pts.append((tip[0] + px * w / 2, tip[1] + py * w / 2))
        br = math.radians(a + 60)
        pts.append((C + inner_r * math.cos(br), C + inner_r * math.sin(br)))
    return [pts]


# ---------------------------------------------------------------------------
# The tools the organizer actually holds
# ---------------------------------------------------------------------------
def jimmy():
    """A wide flat pry blade with a chisel end -- deliberately NOT stick-shaped,
    so it cannot be confused with the spudger next to it in the set."""
    return [[
        (6.6, 18.6), (13.4, 18.6), (13.4, 4.2),
        (12.3, 2.2), (7.7, 2.2), (6.6, 4.2),
    ]]


def spudger():
    """Thin shaft, point at one end, flat paddle at the other."""
    return [[
        (9.2, 2.2), (10.8, 2.2), (11.3, 6.0), (11.3, 13.5),
        (13.2, 17.2), (13.2, 18.6), (6.8, 18.6), (6.8, 17.2),
        (8.7, 13.5), (8.7, 6.0),
    ]]


def tweezers():
    return [[
        (8.0, 2.0), (12.0, 2.0), (13.8, 7.0), (12.9, 18.4), (11.1, 18.4),
        (10.4, 7.5), (10.0, 6.0), (9.6, 7.5), (8.9, 18.4), (7.1, 18.4),
        (6.2, 7.0),
    ]]


def snips():
    a = _bar((4.5, 17.5), (13.5, 3.5), 3.8, 2.2)
    b = [(SIZE - x, y) for x, y in a]
    return [a, b]


def suction_cup():
    return [
        [(3.5, 17.6), (16.5, 17.6), (13.4, 9.6), (6.6, 9.6)],
        [(8.9, 11.0), (11.1, 11.0), (11.1, 4.6), (8.9, 4.6)],
        [(7.2, 4.9), (12.8, 4.9), (12.8, 2.3), (7.2, 2.3)],
    ]


def sim():
    """A SIM card, cut corner and all.  The pocket holds the eject pin, but a
    pin drawn at 10 mm is a line -- the card is what everyone reads as SIM."""
    return [[
        (3.0, 4.5), (13.5, 4.5), (17.0, 8.0), (17.0, 15.5), (3.0, 15.5),
    ]]


def grinder():
    """Rotary grinding burr: shaft into a barrel with a rounded end."""
    pts = [(9.0, 2.0), (11.0, 2.0), (11.0, 7.5), (14.0, 7.5)]
    for i in range(25):                       # rounded end, y is DOWN here
        t = math.radians(180 * i / 24)
        pts.append((10 + 4 * math.cos(t), 14.5 + 4 * math.sin(t)))
    pts += [(6.0, 7.5), (9.0, 7.5)]
    return [pts]


def magnet():
    """Horseshoe -- the one shape everyone reads as 'magnet'."""
    r_out, r_in, leg = 8.0, 3.6, 17.6
    pts = [(C - r_out, leg)]
    pts += _arc(r_out, 180, 0)
    pts += [(C + r_out, leg), (C + r_in, leg)]
    pts += _arc(r_in, 0, 180)
    pts += [(C - r_in, leg)]
    return [pts]


ICONS = {
    "phillips": phillips,
    "flathead": flathead,
    "pentalobe": pentalobe,
    "torx": torx,
    "tripoint-y": tripoint,
    "hex": hex_tip,
    "standoff": standoff,
    "standoff-driver": standoff_driver,
    "jimmy": jimmy,
    "spudger": spudger,
    "tweezers": tweezers,
    "snips": snips,
    "suction-cup": suction_cup,
    "sim": sim,
    "grinder": grinder,
    "magnet": magnet,
}


def path_data(polys):
    """One path string.  A None inside a ring separates subpaths (the hole in
    the standoff)."""
    out = []
    for poly in polys:
        if None in poly:
            i = poly.index(None)
            out.append(_fmt(poly[:i]))
            out.append(_fmt(poly[i + 1:]))
        else:
            out.append(_fmt(poly))
    return " ".join(out)


def svg_for(name):
    d = path_data(ICONS[name]())
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{SIZE:g}mm" height="{SIZE:g}mm" '
        f'viewBox="0 0 {SIZE:g} {SIZE:g}">\n'
        f'  <path d="{d}" fill="#000000" fill-rule="nonzero"/>\n'
        f'</svg>\n'
    )


def _check_hole(name, poly):
    """A hole ring that pokes outside its outer ring does not vanish -- under
    the nonzero rule the part sticking out has winding -1, which is nonzero, so
    it renders as a solid sliver and imports as one."""
    i = poly.index(None)
    outer, hole = poly[:i], poly[i + 1:]
    ox = [p[0] for p in outer]; oy = [p[1] for p in outer]
    hx = [p[0] for p in hole]; hy = [p[1] for p in hole]
    assert min(ox) <= min(hx) and max(hx) <= max(ox) \
        and min(oy) <= min(hy) and max(hy) <= max(oy), \
        f"{name}: the hole reaches outside the shape -- that becomes a sliver"


def _check(name, polys):
    """Everything has to sit inside the box, or TinkerCAD scales it oddly."""
    for poly in polys:
        if None in poly:
            _check_hole(name, poly)
    for poly in polys:
        for p in poly:
            if p is None:
                continue
            x, y = p
            assert -0.001 <= x <= SIZE + 0.001 and -0.001 <= y <= SIZE + 0.001, \
                f"{name}: point {x:.2f},{y:.2f} is outside the 20 mm box"


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    out = os.path.join(root, "svg")
    os.makedirs(out, exist_ok=True)

    print(f"{len(ICONS)} icons, {SIZE:g} x {SIZE:g} mm, filled paths only")
    for name, fn in ICONS.items():
        polys = fn()
        _check(name, polys)
        body = svg_for(name)
        assert "stroke" not in body, "a stroke crept in -- TinkerCAD drops those"
        assert "<text" not in body, "text does not import"
        with open(os.path.join(out, f"{name}.svg"), "w") as fh:
            fh.write(body)
        n = sum(len(p) for p in polys)
        print(f"  wrote {name:14s} {n:4d} points")
