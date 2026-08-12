"""
Letter-size riser platen for the UV printer.

A flat 5.00 mm slab the size of a sheet of paper.  The paper sits on it, which
puts the print surface 0.67 mm clear of the 4.33 mm Milwaukee L bracket that
cannot be moved without losing the 0,0 calibration.

Letter is 279.4 mm long and the P2S bed is 256, so it prints as TWO halves that
key together at the seam:

    +--------+####+--------+####+     <- half A, tongues at 1 and 3
    |                            |
    +----+####+--------+####+----+    <- half B: the same part, turned round
    |                            |
    +----------------------------+

The tongue/socket pattern is symmetric about the middle and alternates, so one
part mates with a copy of itself rotated 180 degrees.  Print the same file
twice.

Both halves lie on the same flat bed, so their top faces are coplanar by
construction -- the seam can be misaligned sideways but it cannot make a step,
which is the only error that matters when this is a height reference.

MEASURE THE PRINTED THICKNESS before trusting it.  If it comes out 4.93, set
MRT_THICK=5.07 and print again; that is what the override is for.

Run:  python3 platen.py            (or MRT_THICK=5.07 python3 platen.py)
"""

import os

import cadquery as cq
from cadquery import exporters

BED = 256.0        # P2S build plate

# ---------------------------------------------------------------------------
# The sheet
# ---------------------------------------------------------------------------
LETTER_W = 215.9   # 8.5 in
LETTER_L = 279.4   # 11 in

# ---------------------------------------------------------------------------
# The riser
# ---------------------------------------------------------------------------
BRACKET_H = 4.33   # the L bracket being cleared
THICK = float(os.environ.get("MRT_THICK", 5.00))

N_HALF = 2
HALF_L = LETTER_L / N_HALF

# ---------------------------------------------------------------------------
# Seam
# ---------------------------------------------------------------------------
TONGUE_W = 25.0    # along the seam
TONGUE_D = 10.0    # across it
FIT      = 0.15    # per side, so it drops together instead of being forced
BOT_CHAM = 0.4     # bottom edges, so first-layer squish cannot make it rock

# Four features, symmetric about the middle so the part mates with itself when
# turned round, and alternating so a tongue always meets a socket.
FEATURE_X = [32.40, 82.00, 133.90, 183.50]
FEATURE_T = ["tongue", "socket", "tongue", "socket"]

CLEAR = THICK - BRACKET_H

assert LETTER_W < BED - 6, "half is too wide for the bed"
assert HALF_L < BED - 6, "half is too long for the bed"
assert THICK > BRACKET_H, \
    f"a {THICK:.2f} mm riser does not clear a {BRACKET_H} mm bracket"
assert CLEAR < 2.0, "riser is needlessly tall -- more head travel than needed"
assert len(FEATURE_X) == len(FEATURE_T)
assert len(FEATURE_X) % 2 == 0, "odd feature count cannot self-mate"
for i, (x, t) in enumerate(zip(FEATURE_X, FEATURE_T)):
    j = len(FEATURE_X) - 1 - i
    assert abs((x - LETTER_W / 2) + (FEATURE_X[j] - LETTER_W / 2)) < 0.01, \
        "features are not symmetric about the middle -- it will not self-mate"
    assert t != FEATURE_T[j], \
        "a tongue lands on a tongue when the second half is turned round"
assert TONGUE_D + FIT < HALF_L / 4, "seam features eat too much of the half"


def half():
    r = cq.Workplane("XY").box(LETTER_W, HALF_L, THICK,
                               centered=(False, False, False))

    for x, kind in zip(FEATURE_X, FEATURE_T):
        if kind == "tongue":
            r = r.union(
                cq.Workplane("XY")
                .box(TONGUE_W, TONGUE_D, THICK, centered=(False, False, False))
                .translate((x - TONGUE_W / 2.0, HALF_L, 0))
            )
        else:
            r = r.cut(
                cq.Workplane("XY")
                .box(TONGUE_W + 2 * FIT, TONGUE_D + FIT, THICK + 2,
                     centered=(False, False, False))
                .translate((x - TONGUE_W / 2.0 - FIT,
                            HALF_L - TONGUE_D - FIT, -1))
            )

    try:
        r = r.edges("<Z").chamfer(BOT_CHAM)
    except Exception as exc:
        print(f"  (bottom chamfer skipped: {exc})")

    bb = r.val().BoundingBox()
    assert abs(bb.zlen - THICK) < 1e-6, "the slab is not the thickness asked for"
    assert bb.xlen <= LETTER_W + 1e-6, "a feature broke out of the sheet width"
    return r


def assembled():
    """Both halves together -- for checking, not for printing."""
    a = half()
    b = half().rotate((LETTER_W / 2.0, 0, 0), (LETTER_W / 2.0, 0, 1), 180)
    bb = b.val().BoundingBox()
    b = b.translate((0, LETTER_L - bb.ymax, 0))
    return a.union(b)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"sheet     {LETTER_W} x {LETTER_L} mm (letter)")
    print(f"riser     {THICK:.2f} mm thick over a {BRACKET_H} mm bracket "
          f"-> {CLEAR:.2f} mm of clearance")
    print(f"halves    {N_HALF} x {LETTER_W} x {HALF_L} mm -- print the SAME "
          f"file twice, turn one round")
    print(f"seam      {len(FEATURE_X)} keys, {TONGUE_W} x {TONGUE_D} mm, "
          f"{FIT} mm clearance per side")

    part = half()
    exporters.export(part, os.path.join(root, "stl", "uv-platen-half.stl"),
                     tolerance=0.005, angularTolerance=0.05)
    exporters.export(part, os.path.join(root, "step", "uv-platen-half.step"))
    v = part.val().Volume() / 1000.0
    bb = part.val().BoundingBox()
    print(f"wrote uv-platen-half   {v:.1f} cm3 solid   "
          f"{bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.2f} mm")

    full = assembled()
    exporters.export(full, os.path.join(root, "stl", "uv-platen-assembled.stl"),
                     tolerance=0.005, angularTolerance=0.05)
    fb = full.val().BoundingBox()
    print(f"assembled              {fb.xlen:.1f} x {fb.ylen:.1f} x "
          f"{fb.zlen:.2f} mm  (want {LETTER_W} x {LETTER_L} x {THICK:.2f})")
    assert abs(fb.xlen - LETTER_W) < 0.01 and abs(fb.ylen - LETTER_L) < 0.01, \
        "the two halves do not add up to a sheet of paper"
