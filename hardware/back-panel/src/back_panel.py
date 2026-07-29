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

# Shiplap on the vertical edges: the back is rabbeted away on one side and the
# front on the other, so each panel nests into the one before it as it slides
# in.  Every panel is identical -- no left/right/middle variants to keep track
# of.  A snapping tongue was the other option and is not practical at 3 mm: the
# tongue would be ~1.4 mm and the groove lips ~0.8 mm, which is two perimeters
# of brittle PLA.  The tracks already capture the panels top and bottom, so the
# lap only has to close the seam and keep the faces aligned.
LAP_W = 8.0          # overlap width
LAP_D = 1.6          # rabbet depth -> 1.4 mm of lap, 2.8 mm nested
LAP_C = 0.3          # slide clearance at the shoulder

# ---------------------------------------------------------------------------
# Grooves
# ---------------------------------------------------------------------------
GROOVE_W     = PANEL_T + 0.8    # 0.4 per side -- it has to SLIDE, not press
TOP_DROP     = 21.0             # groove ceiling below the rail face
TOP_GROOVE_D = 8.0
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
PANEL_W = (BAY_W + (N_PANELS - 1) * LAP_W) / N_PANELS
TOP_H   = TOP_DROP + TOP_GROOVE_D
BOT_H   = BOT_BASE + BOT_GROOVE_D

assert PANEL_H < BED - 6, f"panel {PANEL_H:.1f} mm tall -- will not fit the bed"
assert PANEL_W < BED - 6, f"panel {PANEL_W:.1f} mm wide -- will not fit the bed"
assert SEG_L < BED - 6, f"track segment {SEG_L:.1f} mm -- will not fit the bed"
assert GROOVE_W > PANEL_T, "groove is not wider than the panel"
assert LAP_D < PANEL_T - 1.0, "rabbet leaves too little lap to print"
assert 2 * (PANEL_T - LAP_D) < GROOVE_W, "lapped seam will not fit the groove"
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
    """One panel.  Rabbeted on the BACK at the left edge and on the FRONT at
    the right, so a row of identical panels shiplaps together."""
    p = cq.Workplane("XY").box(PANEL_W, PANEL_T, PANEL_H,
                               centered=(True, True, False))
    hw, ht = PANEL_W / 2.0, PANEL_T / 2.0
    # left edge, back face away
    p = p.cut(
        cq.Workplane("XY")
        .box(LAP_W + LAP_C, LAP_D, PANEL_H + 2, centered=(False, False, False))
        .translate((-hw - LAP_C, ht - LAP_D, -1))
    )
    # right edge, front face away
    p = p.cut(
        cq.Workplane("XY")
        .box(LAP_W + LAP_C, LAP_D, PANEL_H + 2, centered=(False, False, False))
        .translate((hw - LAP_W, -ht, -1))
    )
    return p


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"opening    {OPENING_H:.0f} mm tall, bay {BAY_W:.0f} mm wide")
    print(f"panel      {PANEL_W:.1f} x {PANEL_H:.1f} x {PANEL_T} mm  "
          f"({N_PANELS} per bay)")
    print(f"groove     {GROOVE_W:.1f} mm for a {PANEL_T} mm panel")
    print(f"shiplap    {LAP_W:.0f} mm overlap, {PANEL_T-LAP_D:.1f} mm lap, "
          f"{2*(PANEL_T-LAP_D):.1f} mm nested")
    print(f"top track  {SEG_L:.1f} mm segment, {TOP_W} x {TOP_H} mm, "
          f"{N_STEMS} stems, drops {TOP_DROP:.0f} mm")
    print(f"bot track  {SEG_L:.1f} mm segment, {BOT_W} x {BOT_H} mm, VHB")
    print(f"per bay    {N_PANELS} panels + {N_PANELS} of each track")

    parts = {
        "panel-track-top": track_top(),
        "panel-track-bottom": track_bottom(),
        "back-panel": panel(),
    }
    for name, part in parts.items():
        exporters.export(part, os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        v = part.val().Volume() / 1000.0
        print(f"wrote {name:20s} {v:7.1f} cm3")
