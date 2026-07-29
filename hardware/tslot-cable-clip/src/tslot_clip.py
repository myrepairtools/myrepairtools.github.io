"""
Snap-in cable clip for the TBK 801 bench's aluminium T-slot.

Pushes into the slot anywhere along its length -- no access to an open end, no
disassembly. Two leaf springs run lengthwise inside the slot and spring out
behind the lip; the head sits flat on the outside face and carries two
cable-tie tunnels.

    installed, looking along the slot:

         ziptie over the cable
               ___
              (___)         <- cables, running along the head
        ========|=|================   <- head, 2.8 mm outer skin
        |       |_|               |
        |    tie tunnel           |   <- 6 x 2.2 mm, open at BOTH ends
        ===========================
                | |
        --------|=|--------  extrusion face
                | |             leaves sprung behind the lip

The tie threads through the tunnel, comes out both sides, wraps up over the
head and the cable, and cinches.  Its loop runs ACROSS the clip, square to the
cable -- which is the only way it holds a cable that runs along the head.

Two things were wrong with the first version, both found on the bench:

  1  The tie slots went straight THROUGH the head, so the aluminium face
     sealed them off the moment the clip was installed.  Nothing can pass
     through a hole with the extrusion behind it.  The tie now runs in a
     tunnel relieved out of the head's INNER face -- the aluminium becomes the
     far wall of the tunnel instead of a plug in it.

  2  It needed a hammer.  Not "a bit tight": the catch wanted 1.155 mm of
     inward travel per leaf and the flexure gap behind it was only 1.20 mm,
     so the gap closed, the stem went solid, and there was nowhere left to
     go.  The catch is smaller now and the gap is bigger -- 0.66 mm of travel
     into a 1.40 mm gap.  It should go in with a thumb.  There is an assert on
     that ratio so it cannot come back.

Why a snap and not a drop-in T-nut: a plate long enough to catch an 8.49 mm
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
LEAF_T    = 1.6    # leaf spring thickness
LEAF_GAP  = 1.4    # flexure gap behind each leaf -- the leaf's travel budget
LEAF_FREE = 22.0   # how far the flexure gap runs -> free length of the leaf

# The catch is a chevron, not a step: it grows to full height then falls away.
# The lower ramp wedges against the inside of the lip, so it self-adjusts to
# whatever the lip thickness turns out to be instead of needing it measured.
BUMP    = 0.9      # protrusion per side -> 9.8 mm across, vs an 8.49 opening
BUMP_Z0 = 1.2      # ramp starts, measured in from the face
BUMP_Z1 = 4.0      # full protrusion
BUMP_Z2 = 6.8      # back to flush
BUMP_L  = 10.0     # length along the slot, at the free end of the leaf

# ---------------------------------------------------------------------------
# The head
# ---------------------------------------------------------------------------
HEAD_L = 46.0      # along the slot -- long enough to put the tie tunnels
HEAD_W = 24.0      # across            outboard of the stem
HEAD_T = 5.0
HEAD_R = 3.0       # corner radius

# Cable-tie tunnels: relieved out of the head's INNER face, running the full
# width so the tie goes straight through and out the far side.
TUN_ROOF = 2.8     # skin left between the tunnel and the outside face
TUN_W    = 6.0     # along the slot -- the tie's width lies here
TUN_Y    = 17.5    # centre of each tunnel, from the middle of the head

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
CORE_W  = STEM_W - 2 * LEAF_T - 2 * LEAF_GAP
SPREAD  = STEM_W + 2 * BUMP
DEFLECT = (STEM_W / 2 + BUMP) - SLOT_W / 2      # travel asked of each leaf
STRAIN  = 3 * (LEAF_T / 2) * DEFLECT / LEAF_FREE ** 2
TUN_H   = HEAD_T - TUN_ROOF

assert STEM_W < SLOT_W, "stem will not enter the slot"
assert STEM_D < SLOT_D - 1.5, "stem bottoms out in the cavity"
assert SPREAD > SLOT_W + 1.0, "catch does not reach behind the lip"
assert CORE_W > 1.5, f"central core only {CORE_W:.1f} mm -- too thin"
assert BUMP_Z2 <= STEM_D, "catch runs past the end of the stem"
assert LEAF_FREE < STEM_L - 2, "no anchored section left at the end"

# THE hammer bug: if a leaf has to travel most of its own flexure gap, the gap
# closes, the stem goes solid and the clip stops being a spring.
assert DEFLECT < LEAF_GAP * 0.75, (
    f"leaf must travel {DEFLECT:.2f} mm into a {LEAF_GAP} mm gap -- "
    "it will bottom out and need a hammer")
assert STRAIN < 0.010, f"leaf strained {STRAIN*100:.2f} % -- it will crack"

assert TUN_H > 1.8, "tunnel too shallow for a zip tie"
assert TUN_W > 5.2, "tunnel too narrow for a zip tie"
assert TUN_ROOF >= 2.4, "not enough skin over the tunnel"
assert TUN_Y - TUN_W / 2 > STEM_L / 2 + 1.0, \
    "tunnel runs under the stem -- the stem would have to bridge over it"
assert TUN_Y + TUN_W / 2 < HEAD_L / 2 - 2.0, "tunnel breaks out of the head end"


def clip():
    # Head, lying with its OUTSIDE face on the bed (z = 0).  Going up, the
    # part only ever gets smaller -- head, then head-minus-tunnels, then stem
    # -- so it prints with no supports and nothing bridging.
    r = (
        cq.Workplane("XY")
        .box(HEAD_W, HEAD_L, HEAD_T, centered=(True, True, False))
        .edges("|Z").fillet(HEAD_R)
    )

    # Cable-tie tunnels, open at both ends across the width.  Once the clip is
    # on the extrusion, the aluminium face closes the far side of each one.
    for ty in (-TUN_Y, TUN_Y):
        r = r.cut(
            cq.Workplane("XY")
            .box(HEAD_W + 2, TUN_W, TUN_H + 1, centered=(True, True, False))
            .translate((0, ty, TUN_ROOF))
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

    # A chevron built on an "XZ" workplane extrudes along -Y, which has twice
    # put a feature outside the part it was meant to be on.  Check it landed.
    tips = [v for v in r.val().Vertices()
            if abs(v.Z - (HEAD_T + BUMP_Z1)) < 0.01]
    assert tips and max(abs(v.X) for v in tips) > SPREAD / 2 - 0.01, \
        "catch chevrons missing or misplaced -- the clip would not hold"

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
    print(f"push-in   {DEFLECT:.2f} mm of travel into a {LEAF_GAP} mm gap "
          f"({DEFLECT/LEAF_GAP*100:.0f} % of it used), {STRAIN*100:.2f} % strain")
    print(f"head      {HEAD_W} x {HEAD_L} x {HEAD_T} mm")
    print(f"tunnels   2 x {TUN_W} x {TUN_H} mm at y=+/-{TUN_Y}, "
          f"{TUN_ROOF} mm skin, open both ends")

    part = clip()
    exporters.export(part, os.path.join(root, "stl", "tslot-cable-clip.stl"),
                     tolerance=0.01, angularTolerance=0.1)
    exporters.export(part, os.path.join(root, "step", "tslot-cable-clip.step"))
    bb = part.val().BoundingBox()
    print(f"wrote tslot-cable-clip   {part.val().Volume()/1000:.2f} cm3  "
          f"{bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm")
