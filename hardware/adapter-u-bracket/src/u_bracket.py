"""
U-bracket for holding a power adapter under a bench.

Two of these, spaced along the adapter, screw up into the underside of the
bench. The adapter sits in the U and the bench underside closes the top, so
the bracket plus the bench form a closed box around it.

Cross-section, as installed:

     screw            screw
       ^                ^
   ════╪════════════════╪════   bench underside
   ┌───┴──┐          ┌──┴───┐
   │      │          │      │   <- flanges
   └──┐   │          │   ┌──┘
      │   |<- OPEN_W ->| │
      │                  │      <- legs, OPEN_H tall
      └──────────────────┘
            bottom (WALL)

Prints flat: the cross-section lies on the bed, so every face is a vertical
wall. No supports.

Run:  python3 u_bracket.py
"""

import os

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The adapter
# ---------------------------------------------------------------------------
BRICK_W = 52.00    # across the bracket
BRICK_H = 33.25    # thickness of the adapter

# Clearance.  BRICK_W/H are the adapter's own measurements, so the opening has
# to be bigger or it will not go in.  If 52 x 33.25 was already the opening you
# wanted, set both of these to 0 and re-run.
CLR_W = 0.50       # per side
CLR_H = 0.50       # total, at the top

# ---------------------------------------------------------------------------
# The bracket
# ---------------------------------------------------------------------------
WALL     = 4.0     # bottom and leg thickness
BAND_W   = 20.0    # how wide the strap is along the adapter
FLANGE_L = 16.0    # how far each mounting flange sticks out
FLANGE_T = 4.0     # flange thickness
FILLET_R = 2.0     # inside corners

SCREW_D = 4.4      # #8 pan-head clearance.  No countersink needed: the head
                   # sits under the flange, clear of the adapter.

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
OPEN_W = BRICK_W + 2 * CLR_W
OPEN_H = BRICK_H + CLR_H

W = OPEN_W + 2 * WALL + 2 * FLANGE_L    # overall width
H = WALL + OPEN_H                       # overall height
SCREW_X = OPEN_W / 2 + WALL + FLANGE_L / 2

assert FLANGE_T <= H, "flange thicker than the bracket is tall"
assert SCREW_D + 4 < FLANGE_L, "flange too narrow for the screw hole"


def bracket():
    # Outer profile: the U plus its two flanges, drawn in the XZ plane and
    # extruded along Y by BAND_W.
    half = W / 2.0
    inner = OPEN_W / 2.0
    leg_out = inner + WALL

    pts = [
        (-half, H), (-half, H - FLANGE_T),
        (-leg_out, H - FLANGE_T), (-leg_out, 0),
        (leg_out, 0), (leg_out, H - FLANGE_T),
        (half, H - FLANGE_T), (half, H),
        (inner, H), (inner, WALL),
        (-inner, WALL), (-inner, H),
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
               (-leg_out, H - FLANGE_T), (leg_out, H - FLANGE_T)]
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
    for sx in (-SCREW_X, SCREW_X):
        r = r.cut(
            cq.Workplane("XY")
            .cylinder(FLANGE_T + 2, SCREW_D / 2.0, centered=(True, True, False))
            .translate((sx, BAND_W / 2.0, H - FLANGE_T - 1))
        )

    made = [e for e in r.val().Edges()
            if e.geomType() == "CIRCLE" and abs(e.radius() - SCREW_D / 2) < 0.01]
    assert len(made) == 4, f"expected 4 screw-hole edges, got {len(made)}"

    return r


def print_ready(part):
    """Lay the cross-section on the bed: +Y becomes +Z."""
    return part.rotate((0, 0, 0), (1, 0, 0), 90).translate((0, H, 0))


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"opening   {OPEN_W:.2f} W x {OPEN_H:.2f} H mm  "
          f"(adapter {BRICK_W} x {BRICK_H})")
    print(f"bracket   {W:.2f} W x {H:.2f} H x {BAND_W:.1f} deep mm")
    print(f"screws    2 per bracket at x = +/-{SCREW_X:.2f} mm "
          f"({2*SCREW_X:.2f} mm apart)")
    print(f"hangs     {H:.2f} mm below the bench")

    part = bracket()
    exporters.export(print_ready(part), os.path.join(root, "stl", "u-bracket.stl"),
                     tolerance=0.01, angularTolerance=0.1)
    exporters.export(part, os.path.join(root, "step", "u-bracket.step"))
    print("wrote u-bracket   (print 2)")
