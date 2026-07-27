"""
Marking template for cutting the recessed outlet into a store fixture.

Lay it on the fixture face, line the engraved centrelines up with your layout
marks, trace the inside of the opening, and cut to the line.  The opening's
corners are already radiused to a 1/4" drill bit, so the traced shape IS the
finished hole: drill a 1/4" hole in each corner tangent to the arcs, then jigsaw
the four straights between them.

This is a MARKING template, not a router template -- it has no bushing offset
and it is too thin to guide a bit.  Trace it, don't rout against it.

Outlet dimensions come from outlet_mount.py so there is one source of truth.

Run:  python3 fixture_template.py
"""

import os

import cadquery as cq
from cadquery import exporters

from outlet_mount import BODY_L, BODY_H, FLANGE_L, FLANGE_H

# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------
CUT_CLR   = 0.75   # per side: how much bigger than the body to cut the wood
MARGIN    = 20.0   # template material around the opening
THK       = 3.0    # template thickness
CORNER_R  = 4.0    # outer corner radius of the template itself

# Corner radius of the opening, set by the drill bit you use for the corners.
# NOT a free choice: a rounded hole corner has to clear the outlet body's own
# corner, and a big radius cuts the corner off diagonally.  With the opening
# 0.75 mm oversize, a 3/8" bit (R4.76) only clears a body corner of R3 or more,
# which we cannot verify.  1/4" (R3.17) clears anything down to R1.  Going
# smaller costs nothing but a tighter jigsaw turn.
DRILL_D   = 6.35   # 1/4"

ENGRAVE   = 0.6    # depth of engraved lines and text
LINE_W    = 1.0    # width of engraved lines
NOTCH_W   = 7.0    # centreline V-notch at each edge
NOTCH_D   = 4.0

TEXT_H    = 6.0
FONT      = "DejaVu Sans"

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
ow = BODY_L + 2 * CUT_CLR    # opening width  -- the hole you cut
oh = BODY_H + 2 * CUT_CLR    # opening height
W  = ow + 2 * MARGIN
H  = oh + 2 * MARGIN

LIP_END = (FLANGE_L - ow) / 2.0    # faceplate overlap once cut
LIP_TB  = (FLANGE_H - oh) / 2.0

assert LIP_END > 5.0, f"faceplate would only cover {LIP_END:.1f} mm at the ends"
assert LIP_TB > 2.5, f"faceplate would only cover {LIP_TB:.1f} mm top/bottom"
assert FLANGE_L + 8 < W, "template too narrow to show the faceplate outline"
assert W < 250, "template will not fit a 256 mm bed"


def engraved_rect(r, w, h, line=LINE_W):
    """Engrave a rectangular outline of size w x h into the top face."""
    band = (
        cq.Workplane("XY").box(w + line, h + line, ENGRAVE * 3,
                               centered=(True, True, False))
        .translate((0, 0, THK - ENGRAVE))
        .cut(
            cq.Workplane("XY").box(w - line, h - line, ENGRAVE * 6,
                                   centered=(True, True, False))
            .translate((0, 0, THK - ENGRAVE * 2))
        )
    )
    return r.cut(band)


def template():
    r = cq.Workplane("XY").box(W, H, THK, centered=(True, True, False))
    r = r.edges("|Z").fillet(CORNER_R)

    # The opening, with corners radiused to the jigsaw entry bit.
    opening = (
        cq.Workplane("XY")
        .box(ow, oh, THK + 2, centered=(True, True, False))
        .edges("|Z").fillet(DRILL_D / 2.0)
        .translate((0, 0, -1))
    )
    r = r.cut(opening)

    # Faceplate outline, engraved -- shows what the flange will cover.
    r = engraved_rect(r, FLANGE_L, FLANGE_H)

    # Centreline V-notches on all four edges, with an engraved line running
    # from each notch in to the opening.
    for ang in (0, 90, 180, 270):
        half = W / 2.0 if ang in (0, 180) else H / 2.0
        notch = (
            cq.Workplane("XZ")
            .polyline([(-NOTCH_W / 2, 0), (NOTCH_W / 2, 0), (0, NOTCH_D)])
            .close()
            .extrude(THK + 2)
            .translate((0, 0, -1))
            .rotate((0, 0, 0), (1, 0, 0), -90)
            .translate((0, half - NOTCH_D, 0))
            .rotate((0, 0, 0), (0, 0, 1), ang - 90)
        )
        r = r.cut(notch)

        inner = (oh / 2.0) if ang in (90, 270) else (ow / 2.0)
        span = half - NOTCH_D - inner
        line = (
            cq.Workplane("XY")
            .box(LINE_W, span, ENGRAVE * 2, centered=(True, False, False))
            .translate((0, inner, THK - ENGRAVE))
            .rotate((0, 0, 0), (0, 0, 1), ang - 90)
        )
        r = r.cut(line)

    # Label, offset to one side so it misses the centreline.
    try:
        txt = (
            cq.Workplane("XY").workplane(offset=THK - ENGRAVE)
            .center(W / 4.0, -(oh / 2.0 + MARGIN / 2.0))
            .text(f"CUT {ow:.1f} x {oh:.1f} mm", TEXT_H, ENGRAVE + 1,
                  fontPath=None, font=FONT, combine=False, clean=True)
        )
        r = r.cut(txt)
    except Exception as exc:                       # font trouble is not fatal
        print(f"  (skipped engraved label: {exc})")

    return r


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)

    print(f"template  {W:.1f} x {H:.1f} x {THK:.1f} mm")
    print(f"opening   {ow:.1f} x {oh:.1f} mm  "
          f"({ow / 25.4:.3f} x {oh / 25.4:.3f} in)")
    print(f"corners   R{DRILL_D / 2:.2f} for a {DRILL_D / 25.4:.3f}\" bit")
    print(f"faceplate then covers {LIP_END:.1f} mm at the ends, "
          f"{LIP_TB:.1f} mm top/bottom")

    part = template()
    exporters.export(part, os.path.join(root, "stl", "fixture-cut-template.stl"),
                     tolerance=0.01, angularTolerance=0.1)
    exporters.export(part, os.path.join(root, "step", "fixture-cut-template.step"))
    print("wrote fixture-cut-template")
