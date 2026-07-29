"""
15 mm hex standoff -- nut-style spacer.

For mounting the mini-PC bracket on the back of the workstations: one of these
goes on the screw between the bracket and the surface, holding the bracket
15 mm proud.  Hex flats so it can be held with a 14 mm wrench (or fingers)
while the screw is driven.

It is a plain spacer, not a nut -- the bore is clearance, not thread.  The
screw does the clamping; this only holds the distance.

    across flats 14.0        +--------+
    across corners 16.2      |  ____  |
                             | (    ) |   <- clearance bore
                             |  ----  |
                             +--------+
                                 15 mm thick

Three bores are exported because the fastener size is not pinned down yet:

    -m4   4.5 mm   M4
    -m5   5.5 mm   M5 / #8 / #10          <- most likely
    -m6   6.8 mm   M6 / 1/4" / #12

Prints axis-up: a 15 mm hex prism with a vertical hole.  No supports, and the
layers stack across the load, which is the strong direction in compression.

Run:  python3 hex_spacer.py
"""

import math
import os

import cadquery as cq
from cadquery import exporters

THICK = 15.0    # 1.5 cm, as asked
AF     = 14.0   # across flats -> 14 mm wrench
CHAM   = 0.8    # bore chamfer, both ends -- lets the screw find the hole
EDGE   = 0.5    # chamfer round the hex ends

BORES = {"m4": 4.5, "m5": 5.5, "m6": 6.8}

AC = AF / math.cos(math.radians(30))   # across corners

assert AF > max(BORES.values()) + 6.0, "not enough meat around the biggest bore"
assert CHAM < min(BORES.values()) / 3, "chamfer swallows the bore"


def spacer(bore):
    r = (
        cq.Workplane("XY")
        .polygon(6, AC)
        .extrude(THICK)
        .faces(">Z").workplane().hole(bore)
    )

    solid = r.val()
    ends = [e for e in solid.Edges()
            if e.geomType() == "CIRCLE" and abs(e.radius() - bore / 2) < 0.01]
    assert len(ends) == 2, f"expected 2 bore edges, got {len(ends)}"
    r = cq.Workplane("XY").add(solid.chamfer(CHAM, None, ends))

    try:
        r = r.edges("%LINE and (>Z or <Z)").chamfer(EDGE)
    except Exception as exc:
        print(f"  (end chamfer skipped: {exc})")

    wall = (AF - bore) / 2.0
    assert wall > 3.0, f"only {wall:.1f} mm of wall -- it will split"
    return r


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"hex     {AF} across flats ({AC:.1f} across corners), {THICK} thick")

    for tag, bore in BORES.items():
        part = spacer(bore)
        name = f"hex-spacer-15mm-{tag}"
        exporters.export(part, os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        bb = part.val().BoundingBox()
        print(f"wrote {name:24s} bore {bore} mm, wall {(AF-bore)/2:.1f} mm, "
              f"{part.val().Volume()/1000:.2f} cm3  "
              f"{bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm")
