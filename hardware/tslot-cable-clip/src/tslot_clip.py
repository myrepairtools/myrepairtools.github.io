"""
Snap-in cable clip for the TBK 801 bench's aluminium T-slot.

Pushes into the slot anywhere along its length -- no access to an open end, no
disassembly. Two leaf springs run lengthwise inside the slot and spring out
behind the lip; the head sits flat on the outside face and carries a pair of
cable-tie slots.

    outside                     |  inside the extrusion
                                |
      cable                     |
       ___      head            |
      (___)  ___________________|__________
             |  tie   tie  |    |
             |  slot  slot |    |    <- head, flat on the face
             +------+ +----+    |
                    | |         |     <- leaves squeeze together to enter,
                    |=|=========|=       spring out behind the lip
                    | |         |
                                |

Why a snap and not a drop-in T-nut: a plate long enough to catch a 8.49 mm
opening cannot be tilted upright inside a cavity this shallow, and sliding one
in needs an open end. A snap goes in anywhere.

Run:  python3 tslot_clip.py
"""

import os

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The slot  -- measured on the bench
# ---------------------------------------------------------------------------
SLOT_W = 8.49      # opening width
SLOT_D = 10.00     # depth, face to the back of the cavity

# ---------------------------------------------------------------------------
# The insert
# ---------------------------------------------------------------------------
STEM_W    = 8.00   # across the slot; SLOT_W - 0.49 total clearance
STEM_L    = 26.0   # along the slot
STEM_D    = 7.0    # how far it goes in.  Must stay clear of the cavity back.
LEAF_T    = 1.8    # leaf spring thickness
LEAF_GAP  = 1.2    # flexure gap behind each leaf
LEAF_FREE = 22.0   # how far the flexure gap runs -> free length of the leaf

# The catch is a chevron, not a step: it grows to full height then falls away.
# The lower ramp wedges against the inside of the lip, so it self-adjusts to
# whatever the lip thickness turns out to be instead of needing it measured.
BUMP    = 1.4      # protrusion per side -> 10.8 mm across, vs an 8.49 opening
BUMP_Z0 = 1.2      # ramp starts, measured in from the face
BUMP_Z1 = 4.0      # full protrusion
BUMP_Z2 = 6.8      # back to flush
BUMP_L  = 10.0     # length along the slot, at the free end of the leaf

# ---------------------------------------------------------------------------
# The head
# ---------------------------------------------------------------------------
HEAD_L = 30.0
HEAD_W = 24.0
HEAD_T = 3.0
HEAD_R = 3.0       # corner radius

TIE_W = 4.0        # cable-tie slots through the head
TIE_L = 9.0
TIE_X = 7.5        # from centre

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
CORE_W = STEM_W - 2 * LEAF_T - 2 * LEAF_GAP
SPREAD = STEM_W + 2 * BUMP

assert STEM_W < SLOT_W, "stem will not enter the slot"
assert STEM_D < SLOT_D - 1.5, "stem bottoms out in the cavity"
assert SPREAD > SLOT_W + 1.5, "catch does not reach behind the lip"
assert CORE_W > 1.5, f"central core only {CORE_W:.1f} mm -- too thin"
assert BUMP_Z2 <= STEM_D, "catch runs past the end of the stem"
assert LEAF_FREE < STEM_L - 2, "no anchored section left at the end"
assert TIE_X - TIE_W / 2 > STEM_W / 2, "tie slots run into the stem"
assert TIE_X + TIE_W / 2 < HEAD_W / 2 - 1.5, "tie slots break the head edge"


def clip():
    # Head, lying with its OUTSIDE face on the bed (z = 0).
    r = (
        cq.Workplane("XY")
        .box(HEAD_W, HEAD_L, HEAD_T, centered=(True, True, False))
        .edges("|Z").fillet(HEAD_R)
    )

    # Cable-tie slots straight through the head.
    for tx in (-TIE_X, TIE_X):
        r = r.cut(
            cq.Workplane("XY")
            .box(TIE_W, TIE_L, HEAD_T + 2, centered=(True, True, False))
            .translate((tx, 0, -1))
        )

    # Stem rising off the head, into the slot.
    r = r.union(
        cq.Workplane("XY")
        .box(STEM_W, STEM_L, STEM_D, centered=(True, True, False))
        .translate((0, 0, HEAD_T))
    )

    # Flexure gaps, open at one end so each leaf is a cantilever.
    for gx in (-1, 1):
        x0 = gx * (STEM_W / 2.0 - LEAF_T - LEAF_GAP / 2.0)
        r = r.cut(
            cq.Workplane("XY")
            .box(LEAF_GAP, LEAF_FREE, STEM_D + 1, centered=(True, False, False))
            .translate((x0, -STEM_L / 2.0 - 0.5, HEAD_T))
        )

    # Catch chevrons on the outside of each leaf, near the free end.
    by = -STEM_L / 2.0 + 1.0
    for sx in (-1, 1):
        prof = (
            cq.Workplane("XZ")
            .polyline([
                (sx * STEM_W / 2.0, HEAD_T + BUMP_Z0),
                (sx * (STEM_W / 2.0 + BUMP), HEAD_T + BUMP_Z1),
                (sx * STEM_W / 2.0, HEAD_T + BUMP_Z2),
            ]).close()
            .extrude(BUMP_L)
            .translate((0, by + BUMP_L, 0))
        )
        r = r.union(prof)

    return r


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"slot      {SLOT_W} mm opening, {SLOT_D} mm deep")
    print(f"stem      {STEM_W} x {STEM_L} mm, {STEM_D} mm into the slot")
    print(f"leaves    {LEAF_T} mm thick, {LEAF_FREE} mm free, core {CORE_W:.1f} mm")
    print(f"catch     spreads to {SPREAD:.1f} mm  "
          f"({(SPREAD - SLOT_W) / 2:.2f} mm behind the lip per side)")
    print(f"head      {HEAD_W} x {HEAD_L} x {HEAD_T} mm, 2 tie slots "
          f"{TIE_W} x {TIE_L} at x=+/-{TIE_X}")

    part = clip()
    exporters.export(part, os.path.join(root, "stl", "tslot-cable-clip.stl"),
                     tolerance=0.01, angularTolerance=0.1)
    exporters.export(part, os.path.join(root, "step", "tslot-cable-clip.step"))
    print("wrote tslot-cable-clip")
