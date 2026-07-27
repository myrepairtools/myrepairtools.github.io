"""
Under-desk mount for a recessed furniture outlet strip (TBK 801 workbench).

The printed part is a "false desktop": a rectangular shell whose front face
carries the same cut-out the outlet would normally get in a real benchtop.  The
outlet drops in from the front, its faceplate lands on the front face exactly as
it would on a desk, and the shell's top plate screws up into the underside of
the bench.

Design orientation (as installed):

    X = along the outlet, left/right
    Y = depth, 0 at the front face, +Y goes back under the bench
    Z = up, 0 at the bottom of the part

                    top plate screws up into the bench
                     ^         ^         ^
    Z=H  +-----------------------------------------+  ---
         |             top plate (TOP_T)           |   |
         |    +-------------------------------+    |   |
         |    |                               |    |   |
         |    |   cut-out (cw x ch)           |    |   H
         |    |   outlet body lives in here   |    |   |
         |    |                               |    |   |
         |    +-------------------------------+    |   |
    Z=0  +-----------------------------------------+  ---
         |<---------------- W -------------------->|

Run:  python3 outlet_mount.py
Writes STL (already rotated into print orientation), STEP and an SVG preview.
"""

import math
import os

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# 1. THE OUTLET -- measure your actual unit and change these first.
#    Faceplate + depth are still listing figures; the body is measured.
# ---------------------------------------------------------------------------
IN = 25.4

FLANGE_L = 8.28 * IN   # 210.31  faceplate length      -- FROM THE LISTING
FLANGE_H = 2.40 * IN   #  60.96  faceplate height      -- FROM THE LISTING
BODY_D   = 2.00 * IN   #  50.80  depth behind the faceplate -- FROM THE LISTING

# Measured off the actual unit: the body that passes through the cut-out.
# The listing's "cut size" of 7.30 x 2.13 in is a deliberately generous
# recommendation for cutting wood; sizing to the real body instead nearly
# doubles how much faceplate lands on the printed face.
#
# The length was reported as 7-1/6", which isn't a reading any rule gives.
# 7-1/16 (179.39), 7-1/8 (180.98) and 7-1/6 (182.03) are all plausible, so
# take the LARGEST: too big only costs slop the faceplate hides, too small
# will not go in.  The end bearing can afford it -- 13.7 mm either side.
BODY_L = 7.1667 * IN   # 182.03
BODY_H = 1.9375 * IN   #  49.21  1-15/16"

# ---------------------------------------------------------------------------
# 2. FIT
# ---------------------------------------------------------------------------
CLR = 0.40   # per-side clearance added around the cut-out

# Printed face left visible beyond the faceplate.  REVEAL_TOP also sets the
# headroom above the outlet body: raise it if your unit's cord exits upward.
REVEAL_TOP = 6.00
REVEAL_BOT = 6.00
REVEAL_END = 6.00

# ---------------------------------------------------------------------------
# 3. THE MOUNT
# ---------------------------------------------------------------------------
FACE_T   = 5.0    # front face thickness - the faceplate bears on this
WALL     = 4.0    # bottom and side shell thickness
TOP_T    = 6.0    # top plate thickness (carries the whole assembly)
BACK_GAP = 12.0   # clear space behind the outlet body for its cable
RIB_D    = 15.0   # depth of the screw-landing ribs behind the front face
RAIL_W   = 14.0   # width of the two rails the outlet body rests on
CORNER_R = 3.0    # outer corner radius

# Cord relief: a notch cut into the back of each side wall, open to the rear,
# so a cord leaving the back or either end of the body has somewhere to go.
NOTCH_D = 26.0
NOTCH_H = 16.0

# ---------------------------------------------------------------------------
# 4. SCREWS INTO THE BENCH UNDERSIDE  (#8 flat-head wood screw, 5/8" or 3/4")
# ---------------------------------------------------------------------------
SCREW_D       = 4.4    # shank clearance hole
HEAD_D        = 8.6    # flat head major diameter
HEAD_ANG      = 90.0   # countersink included angle
SCREW_INSET_Y = 16.0   # in from the front and back edges of the top plate
SCREW_X       = [-88.0, 0.0, 88.0]

# Access holes straight through the BOTTOM plate, coaxial with each top-plate
# screw.  Without these the box is closed and there is no way to reach the
# screws to drive them.  Big enough to drop a #8 flat head through (8.6 mm head)
# and then pass a 1/4" magnetic bit holder (~12 mm) up behind it.
ACCESS_D = 16.0

# ---------------------------------------------------------------------------
# 5. CABLE-TIE SLOTS in the bottom plate
# ---------------------------------------------------------------------------
TIE_W, TIE_L = 4.0, 12.0
TIE_X = [-60.0, 60.0]
TIE_Y = [40.0, 54.0]

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
cw = BODY_L + 2 * CLR                     # printed cut-out width
ch = BODY_H + 2 * CLR                     # printed cut-out height
W  = FLANGE_L + 2 * REVEAL_END           # part width
H  = FLANGE_H + REVEAL_TOP + REVEAL_BOT  # part height
D  = FACE_T + BODY_D + BACK_GAP          # part depth

Zc0 = REVEAL_BOT + (FLANGE_H - BODY_H) / 2.0 - CLR   # cut-out bottom
Xc  = cw / 2.0                                      # cut-out half width

# How much printed face the faceplate actually lands on:
BEAR_END = (FLANGE_L - BODY_L) / 2.0 - CLR   # at the two ends
BEAR_TB  = (FLANGE_H - BODY_H) / 2.0 - CLR   # along top and bottom

HEADROOM = (H - TOP_T) - (Zc0 + ch)         # clear space above the body
RAIL_H   = Zc0 - WALL                       # how far the rails stand proud

assert BEAR_END > 3.0, f"faceplate ends land on only {BEAR_END:.2f} mm of face"
assert BEAR_TB > 1.5, f"faceplate top/bottom lands on only {BEAR_TB:.2f} mm of face"
assert Zc0 > WALL, "cut-out runs into the bottom plate"
assert HEADROOM >= 0, "cut-out runs into the top plate"
assert W < 250 and D < 250, "part will not fit a 256 mm bed"

# The bottom access holes have to clear everything else on the bottom plate.
assert ACCESS_D > HEAD_D + 2, "access holes too small to drop a screw head through"
assert SCREW_INSET_Y - ACCESS_D / 2 > FACE_T + 1.5, \
    "front access holes break into the back of the front face"
assert D - SCREW_INSET_Y + ACCESS_D / 2 < D - 1.5, "rear access holes run off the back"
for _sx in SCREW_X:
    assert abs(abs(_sx) - BODY_L / 4.0) > (ACCESS_D + RAIL_W) / 2, \
        f"access hole at x={_sx} collides with a support rail"
    for _tx in TIE_X:
        assert abs(_sx - _tx) > (ACCESS_D + TIE_W) / 2, \
            f"access hole at x={_sx} collides with a cable-tie slot"


def mount():
    """The full-length mount."""
    # Outer shell. X centred; Y from 0 (front face) going back; Z from 0 up.
    r = cq.Workplane("XY").box(W, D, H, centered=(True, False, False))
    r = r.edges("|Z").fillet(CORNER_R)

    # Hollow it out from behind, leaving the front face and the shell walls.
    r = r.cut(
        cq.Workplane("XY")
        .box(W - 2 * WALL, D - FACE_T + 1, H - WALL - TOP_T,
             centered=(True, False, False))
        .translate((0, FACE_T, WALL))
    )

    # The cut-out through the front face.
    r = r.cut(
        cq.Workplane("XY")
        .box(cw, FACE_T + 2, ch, centered=(True, False, False))
        .translate((0, -1, Zc0))
    )

    # Screw-landing ribs: solid blocks either side of the cut-out, so the
    # outlet's own faceplate screws bite into ~20 mm of plastic instead of 5.
    rib_w = (W / 2.0 - WALL) - Xc
    for x0 in (-(W / 2.0 - WALL), Xc):
        r = r.union(
            cq.Workplane("XY")
            .box(rib_w, RIB_D, H - WALL - TOP_T, centered=(False, False, False))
            .translate((x0, FACE_T, WALL))
        )

    # Rails for the outlet body to rest on, so its weight is not hanging off
    # the two faceplate screws alone.
    if RAIL_H > 0.6:
        for rx in (-BODY_L / 4.0, BODY_L / 4.0):
            r = r.union(
                cq.Workplane("XY")
                .box(RAIL_W, D - FACE_T - 4, RAIL_H, centered=(True, False, False))
                .translate((rx, FACE_T, WALL))
            )

    # Cord relief notched into the back of each side wall, open to the rear.
    for x0 in (-(W / 2.0 + 1), W / 2.0 - WALL):
        r = r.cut(
            cq.Workplane("XY")
            .box(WALL + 1, NOTCH_D + 1, NOTCH_H, centered=(False, False, False))
            .translate((x0, D - NOTCH_D, H - TOP_T - NOTCH_H))
        )

    # Countersunk holes up through the top plate into the bench.
    head_drop = (HEAD_D - SCREW_D) / 2.0 / math.tan(math.radians(HEAD_ANG / 2.0))
    for x in SCREW_X:
        for y in (SCREW_INSET_Y, D - SCREW_INSET_Y):
            r = r.cut(
                cq.Workplane("XY")
                .cylinder(TOP_T + 2, SCREW_D / 2.0, centered=(True, True, False))
                .translate((x, y, H - TOP_T - 1))
            )
            # Cone opens downward so the head finishes flush with the underside.
            r = r.cut(
                cq.Solid.makeCone(HEAD_D / 2.0, SCREW_D / 2.0, head_drop)
                .located(cq.Location(cq.Vector(x, y, H - TOP_T)))
            )
            # Driver access straight through the bottom plate below it.
            r = r.cut(
                cq.Workplane("XY")
                .cylinder(WALL + 2, ACCESS_D / 2.0, centered=(True, True, False))
                .translate((x, y, -1))
            )

    # Cable-tie slots in the bottom plate.
    for x in TIE_X:
        for y in TIE_Y:
            r = r.cut(
                cq.Workplane("XY")
                .box(TIE_W, TIE_L, WALL + 2, centered=(True, True, False))
                .translate((x, y, -1))
            )

    return r


def coupon():
    """A 72 mm slice of the right-hand end.  Print this FIRST and check the
    faceplate end actually seats before committing to the full part."""
    keep = (
        cq.Workplane("XY")
        .box(72, FACE_T + RIB_D, H, centered=(False, False, False))
        .translate((W / 2.0 - 72, 0, 0))
    )
    return mount().intersect(keep)


def print_ready(part):
    """Lay the front face on the bed: rotate +90 about X so +Y becomes +Z."""
    return part.rotate((0, 0, 0), (1, 0, 0), 90).translate((0, H, 0))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)

    print(f"part      {W:.1f} W x {D:.1f} D x {H:.1f} H mm")
    print(f"cut-out   {cw:.1f} x {ch:.1f} mm")
    print(f"bearing   {BEAR_END:.2f} mm at the ends, {BEAR_TB:.2f} mm top/bottom")
    print(f"headroom  {HEADROOM:.2f} mm above the body, {RAIL_H:.2f} mm rails below")
    print(f"access    {ACCESS_D:.0f} mm holes in the bottom plate under each screw")
    print(f"driver reach needed: {H - TOP_T:.0f} mm from the bottom face")
    print(f"hangs     {H:.1f} mm below the bench")

    for name, part in (("outlet-mount", mount()), ("fit-test-coupon", coupon())):
        exporters.export(
            print_ready(part), os.path.join(root, "stl", f"{name}.stl"),
            tolerance=0.01, angularTolerance=0.1,
        )
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        print(f"wrote {name}")

    exporters.export(
        mount(), os.path.join(root, "svg", "outlet-mount.svg"),
        opt={
            "width": 1000, "height": 700, "marginLeft": 40, "marginTop": 40,
            "projectionDir": (0.75, -0.95, 0.55),
            "showAxes": False, "strokeWidth": 0.35, "showHidden": False,
        },
    )
    print("wrote svg")
