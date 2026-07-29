"""
Open cable hooks for the TBK 801 bench.

Two mounts, two different hook shapes:

  cable-hook-screw   screws to the underside of the bench.  Side-opening
                     throat with a retaining lip -- push cables in, the lip
                     keeps them there.

  cable-hook-clip    the S bracket.  Hangs OVER a cross bar, cables ride in
                     an open-top cradle in front of it.

Screw version (mouth faces right, foot goes against the bench):

    v=0   +----------------+========+   <- foot, flat against the bench
          |                |        |
          |   +--------+   |  mouth |   <- 8 mm gap, cables push in here
          |   |        |   +--------+
          |   | throat |   |
          |   |14 x 16 |   |            <- cables sit here
          |   +--------+   |
          |                |
          +----------------+

Both parts are one constant cross-section, so they print on their side with
every face a vertical wall: no supports, and the layers run along the part
rather than across the point where it would break.

Run:  python3 cable_hook.py
"""

import os

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The hook throat -- shared by both versions
# ---------------------------------------------------------------------------
CAV_U = 14.0    # throat width
CAV_V = 16.0    # throat depth
WALL  = 3.0     # hook wall
GAP   = 8.0     # screw version's mouth -- narrower than the throat
DEPTH = 20.0    # how wide the hook is

# ---------------------------------------------------------------------------
# The mounting foot (screw version)
# ---------------------------------------------------------------------------
FOOT_EXT = 16.0   # how far the foot reaches past the back of the hook
FOOT_V   = 4.0    # foot thickness

SCREW_D  = 4.4    # #8 clearance -- one screw
FILLET_R = 1.5    # throat corners only, so cables do not chafe

# ---------------------------------------------------------------------------
# The S bracket -- hangs over the bench cross bar
# ---------------------------------------------------------------------------
# Third attempt.  The first two both clamped the bar from BELOW, which meant
# nothing but friction stood between a loaded hook and the floor: hang enough
# cable on it and it walks straight off the bottom of the bar.  That is what
# "the cables will fall or it won't hook to the track" was pointing at, and no
# amount of tuning the lip was ever going to fix it.
#
# So it now goes OVER the bar, like an S-hook on a rail.  Section:
#
#         +=======+          <- crown, sits on top of the bar
#         |  bar  |
#     +---+       +---+
#     |   |       |   |      <- jaws, gripping the 12.75 mm faces
#     +---+       |   +---+
#      short      |   |   |
#                 |   |   |  <- cradle: open at the TOP
#                 |   +---+
#                 +-------+
#
# Upper hook opens DOWN over the bar, lower hook opens UP for the cables.
# That is the S -- and both halves are now working WITH gravity instead of
# against it.  The bar's top face carries the load; the jaws only stop it
# rattling and sliding.  Cables drop into the cradle from above and cannot
# fall out, because the only way out is back up.
RAIL_T   = 12.75   # measured cross-bar thickness -- the jaws grip this
RAIL_H   = 40.0    # measured cross-bar height
RAIL_FIT = 0.35    # total interference -> the jaws pinch the bar

JAW_T    = 3.0     # jaw thickness
CROWN_T  = 4.0     # material over the top of the bar -- this carries the load
BACK_L   = 16.0    # back jaw, down the far face
FRONT_L  = 34.0    # front jaw, down the near face -- runs on into the cradle
LEAD_CH  = 1.2     # lead-in at the jaw tips so it pushes on

CRADLE_FLOOR = WALL    # under the cables
CRADLE_LIP   = 13.0    # outer wall height -> how deep the cables sit

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
BODY_U = 2 * WALL + CAV_U        # screw-version hook block width
BODY_V = FOOT_V + CAV_V + WALL   # screw-version hook block height

JAW_GAP = RAIL_T - RAIL_FIT      # clamped opening
U_F0    = JAW_T + JAW_GAP        # inner face of the front jaw
U_F1    = U_F0 + JAW_T           # outer face of the front jaw = cradle back
U_T1    = U_F1 + CAV_U           # inner face of the cradle's outer wall
U_O1    = U_T1 + WALL            # outside of the whole part

Y_BOT   = -FRONT_L                       # bottom of the part
Y_FLOOR = Y_BOT + CRADLE_FLOOR           # the cables rest here
Y_LIP   = Y_FLOOR + CRADLE_LIP           # top of the cradle's outer wall

# Cantilever strain when a jaw spreads onto the bar (3*c*d / L^2).
JAW_STRAIN = 3 * (JAW_T / 2) * (RAIL_FIT / 2) / BACK_L ** 2

assert GAP < CAV_V, "mouth is not narrower than the throat -- cables fall out"
assert GAP > 5.0, "mouth too tight to push a cable through"
assert FOOT_EXT > SCREW_D + 6, "foot too short for a screw head"
assert SCREW_D + 4 < DEPTH, "screw head wider than the hook"

assert JAW_GAP < RAIL_T, "jaws do not grip the bar"
assert 0.15 < RAIL_FIT < 1.0, "interference outside the printable range"
assert JAW_STRAIN < 0.015, f"jaws strained {JAW_STRAIN*100:.2f} % -- they crack"
assert BACK_L < RAIL_H - 4, "back jaw runs past the bottom of the bar"
assert FRONT_L < RAIL_H, "front jaw runs past the bottom of the bar"
assert FRONT_L > BACK_L + CRADLE_LIP, "no room for the cradle below the jaws"
assert CRADLE_LIP < CAV_V, "cradle has no mouth -- cables cannot go in"
assert CRADLE_LIP > 8.0, "cradle too shallow to hold a bundle"
assert LEAD_CH < JAW_T - 1.0, "lead-in eats the whole jaw tip"


def _soften(r, corners, rad=FILLET_R):
    """Fillet only the named upright corners.  Filleting every |Z edge fails
    outright -- a 3 mm wall cannot take a radius on both of its corners."""
    solid = r.val()
    picked = [
        e for e in solid.Edges()
        if any(abs(e.Center().x - cx) < 0.9 and abs(e.Center().y - cy) < 0.9
               for cx, cy in corners)
    ]
    if not picked:
        print("  (no corners matched - left sharp)")
        return r
    try:
        return cq.Workplane("XY").add(solid.fillet(rad, picked))
    except Exception as exc:
        print(f"  (fillet skipped: {exc})")
        return r


def hook():
    """Screw-mount version.  One profile, extruded.  u to the right, v
    downward from the bench."""
    pts = [
        (-FOOT_EXT, 0.0),
        (BODY_U, 0.0),
        (BODY_U, BODY_V),
        (0.0, BODY_V),
        (0.0, FOOT_V),
        (-FOOT_EXT, FOOT_V),
    ]
    r = cq.Workplane("XY").polyline(pts).close().extrude(DEPTH)

    # Throat.
    r = r.cut(
        cq.Workplane("XY")
        .box(CAV_U, CAV_V, DEPTH + 2, centered=(False, False, False))
        .translate((WALL, FOOT_V, -1))
    )
    # Mouth, opening to the right between the foot and the top of the lip.
    r = r.cut(
        cq.Workplane("XY")
        .box(WALL + 1, GAP, DEPTH + 2, centered=(False, False, False))
        .translate((WALL + CAV_U, FOOT_V, -1))
    )

    # One screw up through the middle of the foot.  Axis given explicitly: a
    # cylinder built on an "XZ" workplane runs along -Y and lands outside the
    # part.
    r = r.cut(
        cq.Workplane(obj=cq.Solid.makeCylinder(
            SCREW_D / 2.0, FOOT_V + 2,
            cq.Vector(-FOOT_EXT / 2.0, -1.0, DEPTH / 2.0),
            cq.Vector(0, 1, 0),
        ))
    )

    holes = [e for e in r.val().Edges()
             if e.geomType() == "CIRCLE" and abs(e.radius() - SCREW_D / 2) < 0.01]
    assert len(holes) == 2, f"expected 2 screw-hole edges, got {len(holes)}"

    return _soften(r, [(WALL, FOOT_V), (WALL, FOOT_V + CAV_V),
                       (WALL + CAV_U, FOOT_V + CAV_V)])


def hook_clip():
    """The S bracket.  Drawn y-UP, unlike hook() above: the crown is the datum
    at y = 0 and everything hangs below it.

    One closed profile does the whole part -- upper hook, spine and cradle --
    so there is no join anywhere for a loaded cable to open up.
    """
    pts = [
        (0.0,    CROWN_T),              # back jaw, outside, up to the crown
        (U_F1,   CROWN_T),              # across the top of the crown
        (U_F1,   Y_FLOOR),              # down the spine = back of the cradle
        (U_T1,   Y_FLOOR),              # across the cradle floor
        (U_T1,   Y_LIP),                # up the inside of the outer wall
        (U_O1,   Y_LIP),                # over its top
        (U_O1,   Y_BOT),                # down the outside
        (U_F0 + LEAD_CH, Y_BOT),        # across the bottom
        (U_F0,   Y_BOT + LEAD_CH),      # lead-in at the front jaw tip
        (U_F0,   0.0),                  # up the front jaw's gripping face
        (JAW_T,  0.0),                  # under the crown -- the bar bears here
        (JAW_T,  -BACK_L + LEAD_CH),    # down the back jaw's gripping face
        (JAW_T - LEAD_CH, -BACK_L),     # lead-in at the back jaw tip
        (0.0,    -BACK_L),
    ]
    r = cq.Workplane("XY").polyline(pts).close().extrude(DEPTH)

    return _soften(r, [(U_F1, Y_FLOOR), (U_T1, Y_FLOOR), (U_O1, Y_LIP)])


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print("screw version")
    print(f"  throat  {CAV_U} x {CAV_V} mm, mouth {GAP} mm")
    print(f"  block   {BODY_U} x {BODY_V} mm profile, {DEPTH} mm wide")
    print(f"  foot    reaches {FOOT_EXT} mm past the hook, {FOOT_V} mm thick")
    print(f"  screw   1 x #8, centred")
    print(f"  drops   {BODY_V} mm below the bench")

    print("S bracket")
    print(f"  jaws    {JAW_GAP:.2f} mm on a {RAIL_T} mm bar "
          f"({RAIL_FIT} mm interference, {JAW_STRAIN*100:.2f} % strain)")
    print(f"  crown   {CROWN_T} mm over the bar -- this is what carries it")
    print(f"  reach   {BACK_L} mm back jaw, {FRONT_L} mm front jaw")
    print(f"  cradle  {CAV_U} mm wide, cables sit {CRADLE_LIP} mm down, "
          f"open at the top")
    print(f"  size    {U_O1:.1f} x {CROWN_T + FRONT_L:.1f} x {DEPTH} mm")

    for name, part in (("cable-hook-screw", hook()),
                       ("cable-hook-clip", hook_clip())):
        exporters.export(part, os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        bb = part.val().BoundingBox()
        print(f"wrote {name:20s} {part.val().Volume()/1000:6.2f} cm3   "
              f"{bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm")
