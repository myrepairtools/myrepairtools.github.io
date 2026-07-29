"""
Back-panel system for the TBK 801 bench -- middle rail down to the desktop.

Three parts:

  panel-track-top     snaps into the middle rail's T-slot, groove faces down
  panel-track-bottom  sticks to the desktop with VHB, groove faces up
  back-panel          the panel itself

Panels slide in from the side once both tracks are on.

Section through one bay:

    ==== middle rail ==========================
         |stem|                                <- snaps into the 8.49 slot
    +----+----+----+
    |               |   <- TOP_DROP: this is what makes the panel fit the bed
    |    +-----+    |
    |    |     |    |   <- groove, panel top sits here
         |     |
         |panel|
         |     |
         |     |
    _____|     |________
    |    +-----+    |        <- bottom track, groove up
    +---------------+
    ///// desktop /////

The drop exists only because the panel has to fit a 256 mm bed.  A cut sheet
needs almost none of it -- see the README.

Run:  python3 back_panel.py
"""

import os

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The opening and the bay
# ---------------------------------------------------------------------------
OPENING_H = 272.0    # middle rail face down to the desktop
BAY_W     = 1067.0   # ~42"
N_PANELS  = 5

# ---------------------------------------------------------------------------
# The panel
# ---------------------------------------------------------------------------
PANEL_T = 3.0
BED     = 256.0
EDGE_CH = 0.6        # chamfer so it feeds into the grooves

# ---------------------------------------------------------------------------
# Mullion -- the vertical strip that closes each seam
# ---------------------------------------------------------------------------
# Panels go in by LIFT-IN, not by sliding: raise one into the deep top groove,
# swing the bottom in, drop it.  That needs no side clearance at all, where
# sliding an assembled sheet in would have needed the full 1067 mm bay width
# beside the bench.
#
# Because each panel drops in on its own, nothing has to clip together.  The
# mullion goes in afterwards, dropping between two placed panels: both edges
# slot into it, so the seam closes and the faces are forced flush even if a
# panel has a little warp in it.  It is not captured by the tracks -- it rests
# on the bottom track and the panels hold it fore and aft.
MUL_GROOVE_D = 6.0   # how far each panel edge sits into the mullion
MUL_WEB      = 3.0   # between the two groove bottoms -> the panel-to-panel gap
MUL_WALL     = 1.5

# ---------------------------------------------------------------------------
# Grooves
# ---------------------------------------------------------------------------
GROOVE_W     = PANEL_T + 0.8    # 0.4 per side -- it has to SLIDE, not press
TOP_DROP     = 21.0             # groove ceiling below the rail face
TOP_GROOVE_D = 15.0   # 8 resting + 7 to lift clear of the bottom track
BOT_BASE     = 3.0              # under the bottom groove, for the VHB
BOT_GROOVE_D = 6.0

# ---------------------------------------------------------------------------
# Track bodies
# ---------------------------------------------------------------------------
SEG_L    = BAY_W / N_PANELS     # track segments butt end to end
TOP_W    = 10.0
BOT_W    = 16.0                 # wide enough for a strip of VHB

# ---------------------------------------------------------------------------
# T-slot stem  -- same geometry already proven on the cable clip
# ---------------------------------------------------------------------------
SLOT_W    = 8.49
STEM_W    = 8.00
STEM_L    = 26.0
STEM_D    = 7.0
LEAF_T    = 1.8
LEAF_GAP  = 1.2
LEAF_FREE = 22.0
BUMP      = 1.4
BUMP_Z0, BUMP_Z1, BUMP_Z2 = 1.2, 4.0, 6.8
BUMP_L    = 10.0
N_STEMS   = 3

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
PANEL_H = OPENING_H - TOP_DROP - BOT_BASE - 1.0
PANEL_W = (BAY_W - (N_PANELS - 1) * MUL_WEB) / N_PANELS
TOP_H   = TOP_DROP + TOP_GROOVE_D
BOT_H   = BOT_BASE + BOT_GROOVE_D
MUL_H   = OPENING_H - TOP_H - BOT_H - 1.0   # sits between the two tracks

assert PANEL_H < BED - 6, f"panel {PANEL_H:.1f} mm tall -- will not fit the bed"
assert PANEL_W < BED - 6, f"panel {PANEL_W:.1f} mm wide -- will not fit the bed"
assert SEG_L < BED - 6, f"track segment {SEG_L:.1f} mm -- will not fit the bed"
assert GROOVE_W > PANEL_T, "groove is not wider than the panel"
assert TOP_GROOVE_D >= 8.0 + BOT_GROOVE_D + 1.0, \
    "top groove too shallow to lift the panel clear of the bottom track"
assert MUL_WEB >= 2.0, "mullion web too thin to print"
assert STEM_W < SLOT_W, "stem will not enter the slot"
assert TOP_W > GROOVE_W + 5, "top track too narrow around the groove"
assert PANEL_H + TOP_GROOVE_D + BOT_GROOVE_D > OPENING_H - TOP_DROP - BOT_BASE, \
    "panel cannot reach both grooves"


def _stem(x0):
    """One snap-in stem, rising in +Z from the track's top face."""
    s = (
        cq.Workplane("XY")
        .box(STEM_L, STEM_W, STEM_D, centered=(False, True, False))
        .translate((x0, 0, 0))
    )
    for gy in (-1, 1):
        y0 = gy * (STEM_W / 2.0 - LEAF_T - LEAF_GAP / 2.0)
        s = s.cut(
            cq.Workplane("XY")
            .box(LEAF_FREE + 1, LEAF_GAP, STEM_D + 1, centered=(False, True, False))
            .translate((x0 - 0.5, y0, 0))
        )
    for sy in (-1, 1):
        s = s.union(
            cq.Workplane("YZ")
            .polyline([
                (sy * STEM_W / 2.0, BUMP_Z0),
                (sy * (STEM_W / 2.0 + BUMP), BUMP_Z1),
                (sy * STEM_W / 2.0, BUMP_Z2),
            ]).close()
            .extrude(BUMP_L)
            .translate((x0 + 1.0, 0, 0))
        )
    return s


def track_top():
    """Hangs from the rail; groove faces down.  Modelled as installed, which is
    also how it prints: stems point up, and the groove ceiling is only a
    GROOVE_W bridge."""
    r = (
        cq.Workplane("XY")
        .box(SEG_L, TOP_W, TOP_H, centered=(False, True, False))
        .translate((0, 0, -TOP_H))
    )
    r = r.cut(
        cq.Workplane("XY")
        .box(SEG_L + 2, GROOVE_W, TOP_GROOVE_D + 1, centered=(False, True, False))
        .translate((-1, 0, -TOP_H - 1))
    )
    for i in range(N_STEMS):
        x0 = (i + 0.5) * SEG_L / N_STEMS - STEM_L / 2.0
        r = r.union(_stem(x0))
    return r


def track_bottom():
    """Sticks to the desktop; groove faces up.  Prints as modelled -- the
    groove is open upward, so there is nothing to bridge."""
    r = cq.Workplane("XY").box(SEG_L, BOT_W, BOT_H, centered=(False, True, False))
    r = r.cut(
        cq.Workplane("XY")
        .box(SEG_L + 2, GROOVE_W, BOT_GROOVE_D + 1, centered=(False, True, False))
        .translate((-1, 0, BOT_BASE))
    )
    return r


def panel():
    """A plain rectangle -- the mullions do the joining."""
    p = cq.Workplane("XY").box(PANEL_W, PANEL_T, PANEL_H,
                               centered=(True, True, False))
    try:
        p = p.edges("|Y").chamfer(EDGE_CH)
    except Exception:
        pass
    return p


def mullion():
    """Vertical strip between two panels.  Printed lying down with the grooves
    facing up and down: the upward one is open and the downward one is only a
    GROOVE_W bridge.  Turned the other way each groove ceiling would be a 6 mm
    cantilever and would droop."""
    w = 2 * MUL_GROOVE_D + MUL_WEB
    t = GROOVE_W + 2 * MUL_WALL
    r = cq.Workplane("XY").box(MUL_H, t, w, centered=(False, True, False))
    for z0 in (0.0, w - MUL_GROOVE_D):
        r = r.cut(
            cq.Workplane("XY")
            .box(MUL_H + 2, GROOVE_W, MUL_GROOVE_D + 0.001,
                 centered=(False, True, False))
            .translate((-1, 0, z0))
        )
    return r


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"opening    {OPENING_H:.0f} mm tall, bay {BAY_W:.0f} mm wide")
    print(f"panel      {PANEL_W:.1f} x {PANEL_H:.1f} x {PANEL_T} mm  "
          f"({N_PANELS} per bay)")
    print(f"groove     {GROOVE_W:.1f} mm for a {PANEL_T} mm panel")
    print(f"mullion    {2*MUL_GROOVE_D+MUL_WEB:.0f} mm wide x "
          f"{GROOVE_W+2*MUL_WALL:.1f} mm thick x {MUL_H:.0f} mm tall  "
          f"({N_PANELS-1} per bay)")
    print(f"lift-in    top groove {TOP_GROOVE_D:.0f} mm: 8 resting + "
          f"{TOP_GROOVE_D-8:.0f} to clear the bottom track")
    print(f"top track  {SEG_L:.1f} mm segment, {TOP_W} x {TOP_H} mm, "
          f"{N_STEMS} stems, drops {TOP_DROP:.0f} mm")
    print(f"bot track  {SEG_L:.1f} mm segment, {BOT_W} x {BOT_H} mm, VHB")
    print(f"per bay    {N_PANELS} panels + {N_PANELS} of each track")

    parts = {
        "panel-track-top": track_top(),
        "panel-track-bottom": track_bottom(),
        "back-panel": panel(),
        "panel-mullion": mullion(),
    }
    for name, part in parts.items():
        exporters.export(part, os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        v = part.val().Volume() / 1000.0
        print(f"wrote {name:20s} {v:7.1f} cm3")
