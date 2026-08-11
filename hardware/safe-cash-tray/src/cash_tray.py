"""
Cash tray for the store safes.

Same idea as the acrylic Amazon trays: eight slots, notes stood on edge leaning
back so every denomination is visible at once.  Differences that matter for us:

  - 6 note slots + 2 WIDER slots for coin rolls, instead of 8 identical ones.
  - Denominations engraved in the front wall, so a count is read off the tray
    rather than remembered.
  - Sized to the print bed and to a real US note, not to a generic box.

Layout, looking down:

    +---------------------------------------------+
    |  |    |    |    |    |    |     |     |     |   <- back wall, full height
    |  |    |    |    |    |    |     |     |     |
    |  | $1 | $5 | $10| $20| $50| $100|COIN |COIN |   <- notes lie front-to-back
    |  |    |    |    |    |    |     |     |     |
    +--+----+----+----+----+----+-----+-----+-----+   <- front wall, low
       $1   $5   $10  $20  $50  $100  COIN  COIN      <- engraved here

The front of the tray is cut down on a slope, so the notes lean out toward you
and there is something to pinch.  The slope is an upward-facing surface, so it
prints with no supports -- the whole tray is walls on a flat floor.

Notes stand ~63 mm above the floor once they lean, which is the number to check
against the inside height of the safe, NOT the wall height.

Run:  python3 cash_tray.py
"""

import os

import cadquery as cq
from cadquery import exporters

BED = 256.0        # P2S build plate

# ---------------------------------------------------------------------------
# What goes in it
# ---------------------------------------------------------------------------
BILL_L   = 156.0   # US note, long side -- all denominations are the same
BILL_H   = 66.3    # US note, short side.  This is what leans.
BILL_CLR = 4.0     # slack along the note's length

N_BILL = 6         # $1 $5 $10 $20 $50 $100 -- US notes are all one size
N_COIN = 0         # coin rolls are not kept in the safe.  Set to 2 to get
SLOT_W = 24.0      # them back; nothing else needs touching.
COIN_W = 28.0      # coin-roll slot: a quarter roll is 25 mm across

LABELS = ["$1", "$5", "$10", "$20", "$50", "$100"] + ["COIN"] * N_COIN

# ---------------------------------------------------------------------------
# The tray
# ---------------------------------------------------------------------------
WALL    = 2.5
DIV_T   = 1.8      # between slots
FLOOR_T = 2.5

H_BACK  = 45.0     # back and sides
H_FRONT = 20.0     # front lip
SLOPE_Y = 95.0     # how far back the slope runs before reaching full height

GRIP_W = 45.0      # scallop in each end wall, to lift the tray out
GRIP_D = 12.0

LABEL_H = 8.0      # engraved text
LABEL_D = 0.6
LABEL_Z = 10.0     # centre height on the front wall

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
SLOTS   = [SLOT_W] * N_BILL + [COIN_W] * N_COIN
N_SLOT  = len(SLOTS)
INNER_D = BILL_L + BILL_CLR
OUTER_D = INNER_D + 2 * WALL
INNER_W = sum(SLOTS) + (N_SLOT - 1) * DIV_T
OUTER_W = INNER_W + 2 * WALL

# How high a note actually stands once it leans across its slot.
LEAN_H = max((BILL_H ** 2 - w ** 2) ** 0.5 for w in SLOTS) + FLOOR_T

# DejaVu Sans Bold runs about 0.64 em per character.
def _label_w(text, size=LABEL_H):
    return 0.64 * size * len(text)

assert len(LABELS) == N_SLOT, "one label per slot"
assert OUTER_W < BED - 6, f"tray {OUTER_W:.0f} mm wide -- will not fit the bed"
assert OUTER_D < BED - 6, f"tray {OUTER_D:.0f} mm deep -- will not fit the bed"
assert INNER_D > BILL_L + 2, "notes will not drop in"
assert min(SLOTS) > 15.0, "slot too narrow to get fingers into"
if N_COIN:
    assert COIN_W > 26.0, "coin slot too narrow for a quarter roll"
assert H_FRONT < H_BACK, "front lip is not lower than the back"
assert SLOPE_Y < INNER_D, "slope runs past the back of the tray"
assert GRIP_D < H_BACK - H_FRONT, "grip scallop cuts below the front lip"
for lbl, w in zip(LABELS, SLOTS):
    assert _label_w(lbl) < w * 0.92, \
        f"label {lbl!r} is wider than its {w} mm slot"


def _spans():
    """(x0, x1) of every slot, tray centred on x = 0."""
    x = -INNER_W / 2.0
    for w in SLOTS:
        yield x, x + w
        x += w + DIV_T


def _text_solid(label):
    """Text lying in the front wall (y = 0), readable from outside.

    Built in XY and rotated rather than drawn on a side workplane: an "XZ"
    workplane extrudes along -Y and has twice put a feature outside the part
    it belonged to.
    """
    t = (
        cq.Workplane("XY")
        .text(label, LABEL_H, LABEL_D + 1.0, kind="bold",
              font="DejaVu Sans", halign="center", valign="center")
    )
    # +90 about X: text-up +Y -> +Z, extrusion +Z -> -Y, normal ends at -Y so
    # it reads from in front of the tray.
    t = t.rotate((0, 0, 0), (1, 0, 0), 90)
    return t.translate((0, LABEL_D, LABEL_Z))


def tray():
    r = cq.Workplane("XY").box(OUTER_W, OUTER_D, H_BACK,
                               centered=(True, False, False))

    # Slots.
    for x0, x1 in _spans():
        r = r.cut(
            cq.Workplane("XY")
            .box(x1 - x0, INNER_D, H_BACK + 2, centered=(False, False, False))
            .translate((x0, WALL, FLOOR_T))
        )

    # Slope the front down.  Built as a prism and then placed by its bounding
    # box, so it does not matter which way "YZ" chooses to extrude.
    wedge = (
        cq.Workplane("YZ")
        .polyline([(0.0, H_FRONT), (SLOPE_Y, H_BACK),
                   (SLOPE_Y, H_BACK + 20), (0.0, H_BACK + 20)])
        .close()
        .extrude(OUTER_W + 20)
    )
    wb = wedge.val().BoundingBox()
    wedge = wedge.translate((-OUTER_W / 2.0 - 10 - wb.xmin, 0, 0))
    before = r.val().Volume()
    r = r.cut(wedge)
    assert r.val().Volume() < before - 1000, "the front slope cut nothing"

    # Grip scallops in the end walls, back where the wall is full height.
    rad = (GRIP_D ** 2 + (GRIP_W / 2) ** 2) / (2 * GRIP_D)
    gy = OUTER_D - 40.0
    for sx in (-1, 1):
        r = r.cut(
            cq.Workplane(obj=cq.Solid.makeCylinder(
                rad, 2 * WALL + 4,
                cq.Vector(sx * (OUTER_W / 2.0 + WALL + 2), gy,
                          H_BACK - GRIP_D + rad),
                cq.Vector(-sx, 0, 0),
            ))
        )

    # Engrave the denominations in the front wall.
    for (x0, x1), lbl in zip(_spans(), LABELS):
        r = r.cut(_text_solid(lbl).translate(((x0 + x1) / 2.0, 0, 0)))

    return r


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"tray      {OUTER_W:.1f} W x {OUTER_D:.1f} D mm, "
          f"{H_FRONT:.0f} mm front lip rising to {H_BACK:.0f} mm at the back")
    print(f"slots     {N_BILL} x {SLOT_W:.0f} mm for notes"
          + (f", {N_COIN} x {COIN_W:.0f} mm for coin rolls" if N_COIN else ""))
    print(f"labels    {', '.join(LABELS)}")
    print(f"notes     {BILL_L} x {BILL_H} mm, {INNER_D:.0f} mm of slot length")
    print(f"CLEARANCE needed inside the safe: "
          f"{OUTER_W:.0f} x {OUTER_D:.0f} mm footprint, "
          f"{LEAN_H:.0f} mm tall -- the notes stand well above the walls")

    part = tray()
    exporters.export(part, os.path.join(root, "stl", "safe-cash-tray.stl"),
                     tolerance=0.01, angularTolerance=0.1)
    exporters.export(part, os.path.join(root, "step", "safe-cash-tray.step"))
    bb = part.val().BoundingBox()
    vol = part.val().Volume() / 1000.0
    print(f"wrote safe-cash-tray   {vol:.1f} cm3 "
          f"(~{vol * 1.24:.0f} g solid)   "
          f"{bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm")
