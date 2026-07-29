"""
U-bracket for holding a power adapter under a bench.

Two of these, spaced along the adapter, screw up into the underside of the
bench. The adapter sits in the U and the bench underside closes the top, so
the bracket plus the bench form a closed box around it.

Cross-section, as installed:

     screw            screw
       ^                ^
   ====+================+====   bench underside
   +---+--+          +--+---+
   |      |          |      |   <- flanges
   +--+   |          |   +--+
      |   |<- OPEN_W ->|  |
      |                  |      <- legs, OPEN_H tall
      +------------------+
            bottom (WALL)

Prints flat: the cross-section lies on the bed, so every face is a vertical
wall. No supports.

WIDTHS is the list of adapter widths to build -- one STL per entry.  Only the
width changes between them; everything else (height, wall, flanges, tie loop)
is shared, so a new size is one number.

Run:  python3 u_bracket.py
"""

import os
from types import SimpleNamespace

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The adapters.  Width across the bracket; thickness is the same for both.
# ---------------------------------------------------------------------------
WIDTHS  = [52.00, 56.00]
BRICK_H = 33.25    # thickness of the adapter

# Clearance.  The widths above are the adapter's own measurements, so the
# opening has to be bigger or it will not go in.  If a width is already the
# opening you want, set these to 0 and re-run.
CLR_W = 0.50       # per side
CLR_H = 0.50       # total, at the top

# ---------------------------------------------------------------------------
# The bracket -- shared by every width
# ---------------------------------------------------------------------------
WALL     = 5.0     # bottom and leg thickness
BAND_W   = 25.0    # how wide the strap is along the adapter
FLANGE_L = 16.0    # how far each mounting flange sticks out
FLANGE_T = 4.0     # flange thickness
FILLET_R = 2.0     # inside corners

SCREW_D = 4.4      # #8 pan-head clearance.  No countersink needed: the head
                   # sits under the flange, clear of the adapter.

# ---------------------------------------------------------------------------
# Cable-tie anchor: a closed loop hanging BELOW the bottom of the U
# ---------------------------------------------------------------------------
# Slots through the floor would have to be threaded blind, from underneath,
# with the adapter already in the U and the bracket already screwed to the
# bench.  A loop that hangs below is reachable with the whole thing installed,
# and it keeps the floor of the U flat so nothing props the adapter up.
#
# The tunnel runs ACROSS the bracket (along X) so a tie threaded through it
# wraps naturally around a cable running lengthwise underneath.
TIE_LOOP_X = 18.0  # tunnel length, across the bracket
TIE_LOOP_Y = 6.0   # opening along the adapter
TIE_LOOP_Z = 5.0   # opening depth below the floor
TIE_LEG    = 3.0   # loop side thickness
TIE_BAR    = 3.0   # loop bottom bar thickness

TIE_DROP = TIE_LOOP_Z + TIE_BAR    # how far the loop hangs down

assert SCREW_D + 4 < FLANGE_L, "flange too narrow for the screw hole"
assert TIE_LOOP_Y + 2 * TIE_LEG < BAND_W, "tie loop wider than the band"
assert TIE_LOOP_Z >= 4.0, "tie loop opening too shallow to thread"


def spec(brick_w, brick_h=BRICK_H):
    """Everything derived from one adapter size."""
    d = SimpleNamespace(brick_w=brick_w, brick_h=brick_h)
    d.open_w = brick_w + 2 * CLR_W
    d.open_h = brick_h + CLR_H
    d.w = d.open_w + 2 * WALL + 2 * FLANGE_L     # overall width
    d.h = WALL + d.open_h                        # overall height
    d.screw_x = d.open_w / 2 + WALL + FLANGE_L / 2
    d.tag = f"{brick_w:g}mm"

    assert FLANGE_T <= d.h, "flange thicker than the bracket is tall"
    assert TIE_LOOP_X < d.open_w, "tie loop wider than the inside of the U"
    assert d.w < 250, f"bracket {d.w:.0f} mm wide -- will not fit the bed"
    return d


def bracket(d):
    # Outer profile: the U plus its two flanges, drawn in the XZ plane and
    # extruded along Y by BAND_W.
    half = d.w / 2.0
    inner = d.open_w / 2.0
    leg_out = inner + WALL

    pts = [
        (-half, d.h), (-half, d.h - FLANGE_T),
        (-leg_out, d.h - FLANGE_T), (-leg_out, 0),
        (leg_out, 0), (leg_out, d.h - FLANGE_T),
        (half, d.h - FLANGE_T), (half, d.h),
        (inner, d.h), (inner, WALL),
        (-inner, WALL), (-inner, d.h),
    ]
    r = (
        cq.Workplane("XZ")
        .polyline(pts).close()
        .extrude(BAND_W)
        .translate((0, BAND_W, 0))   # XZ extrudes along -Y; bring it to 0..BAND_W
    )

    # Round only the four concave corners -- the two inside the U and the two
    # flange roots.  The flange tips are only FLANGE_T thick, so filleting
    # every edge collapses them and the kernel refuses the whole operation.
    corners = [(-inner, WALL), (inner, WALL),
               (-leg_out, d.h - FLANGE_T), (leg_out, d.h - FLANGE_T)]
    solid = r.val()
    picked = [
        e for e in solid.Edges()
        if any(abs(e.Center().x - cx) < 0.75 and abs(e.Center().z - cz) < 0.75
               for cx, cz in corners)
    ]
    if picked:
        r = cq.Workplane("XY").add(solid.fillet(FILLET_R, picked))
    else:
        print("  (no concave corners matched - left sharp)")

    # Mounting holes, straight up through each flange.
    for sx in (-d.screw_x, d.screw_x):
        r = r.cut(
            cq.Workplane("XY")
            .cylinder(FLANGE_T + 2, SCREW_D / 2.0, centered=(True, True, False))
            .translate((sx, BAND_W / 2.0, d.h - FLANGE_T - 1))
        )

    # Cable-tie loop hanging below the floor, with its tunnel running along X.
    cy = BAND_W / 2.0
    loop = (
        cq.Workplane("XY")
        .box(TIE_LOOP_X, TIE_LOOP_Y + 2 * TIE_LEG, TIE_DROP,
             centered=(True, True, False))
        .translate((0, cy, -TIE_DROP))
        .cut(
            cq.Workplane("XY")
            .box(TIE_LOOP_X + 2, TIE_LOOP_Y, TIE_LOOP_Z,
                 centered=(True, True, False))
            .translate((0, cy, -TIE_LOOP_Z))
        )
    )
    r = r.union(loop)

    made = [e for e in r.val().Edges()
            if e.geomType() == "CIRCLE" and abs(e.radius() - SCREW_D / 2) < 0.01]
    assert len(made) == 4, f"expected 4 screw-hole edges, got {len(made)}"

    # The holes must land in the flanges, not in air beside them.  A cylinder
    # built on the wrong workplane has silently missed the part twice now.
    for e in made:
        assert abs(abs(e.Center().x) - d.screw_x) < 0.01, \
            "screw hole is not in the flange"

    return r


def print_ready(part):
    """Lay the cross-section on the bed: +Y becomes +Z, then drop onto Z=0."""
    p = part.rotate((0, 0, 0), (1, 0, 0), 90)
    bb = p.val().BoundingBox()
    return p.translate((0, -bb.ymin, -bb.zmin))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"shared    wall {WALL}, band {BAND_W}, flange {FLANGE_L} x {FLANGE_T}")
    print(f"tie loop  {TIE_LOOP_X:.0f} mm tunnel, opening "
          f"{TIE_LOOP_Y:.0f} x {TIE_LOOP_Z:.0f} mm, hangs {TIE_DROP:.0f} mm below")

    for bw in WIDTHS:
        d = spec(bw)
        part = bracket(d)
        name = f"u-bracket-{d.tag}"
        exporters.export(print_ready(part),
                         os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        print()
        print(f"{name}  (print 2)")
        print(f"  adapter   {d.brick_w} x {d.brick_h} mm")
        print(f"  opening   {d.open_w:.2f} W x {d.open_h:.2f} H mm")
        print(f"  bracket   {d.w:.2f} W x {d.h:.2f} H x {BAND_W:.1f} deep mm")
        print(f"  screws    2 at x = +/-{d.screw_x:.2f} mm "
              f"({2*d.screw_x:.2f} mm apart)")
        print(f"  hangs     {d.h + TIE_DROP:.2f} mm below the bench, "
              f"{part.val().Volume()/1000:.2f} cm3")
