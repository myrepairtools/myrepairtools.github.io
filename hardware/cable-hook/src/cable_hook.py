"""
Open cable hook that screws to the underside of a bench.

Same idea as the clips that come on a monitor arm: push cables in through the
mouth, they drop into the throat, gravity keeps them there. Lift them out any
time -- no cutting and re-fitting zip ties.

Profile (mouth faces right, foot goes against the bench):

    v=0   +----------------+========+   <- foot, flat against the bench
          |                |        |
          |   +--------+   |  mouth |   <- 8 mm gap, cables push in here
          |   |        |   +--------+
          |   | throat |   |
          |   |14 x 16 |   |            <- cables sit here
          |   +--------+   |
          |                |
          +----------------+

The whole part is one constant cross-section, so it prints on its side with
every face a vertical wall: no supports, and the layers run along the hook
rather than across the point where it would break.

Run:  python3 cable_hook.py
"""

import os

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The hook
# ---------------------------------------------------------------------------
CAV_U = 14.0    # throat width
CAV_V = 16.0    # throat depth
WALL  = 3.0     # hook wall
GAP   = 8.0     # mouth opening -- narrower than the throat so cables stay put
DEPTH = 20.0    # how wide the hook is

# ---------------------------------------------------------------------------
# The mounting foot
# ---------------------------------------------------------------------------
FOOT_EXT = 16.0   # how far the foot reaches past the back of the hook
FOOT_V   = 4.0    # foot thickness

SCREW_D   = 4.4   # #8 clearance
SCREW_SEP = 12.0  # between the two screws, along the hook's width
FILLET_R  = 1.5   # throat corners only, so cables do not chafe

# ---------------------------------------------------------------------------
# Clip-on variant -- grips the bench's cross bar instead of screwing to it
# ---------------------------------------------------------------------------
RAIL_T   = 12.75  # measured cross-bar thickness
RAIL_FIT = 0.55   # total interference -> the jaws spring onto the bar
JAW_T    = 2.5    # jaw thickness
JAW_L    = 20.0   # how far the jaws reach up the bar's face
JAW_BASE = 3.0    # material under the bar

# ---------------------------------------------------------------------------
# Derived
# ---------------------------------------------------------------------------
BODY_U = 2 * WALL + CAV_U        # hook block width
BODY_V = FOOT_V + CAV_V + WALL   # hook block height
LIP_V  = FOOT_V + GAP            # top of the retaining lip

assert GAP < CAV_V, "mouth is not narrower than the throat -- cables fall out"
assert GAP > 5.0, "mouth too tight to push a cable through"
assert FOOT_EXT > SCREW_D + 6, "foot too short for a screw head"
assert SCREW_SEP + SCREW_D < DEPTH - 2, "screws too far apart for the width"


def hook():
    # One profile, extruded.  u to the right, v downward from the bench.
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

    # Screw holes up through the foot.  Axis given explicitly: a cylinder built
    # on an "XZ" workplane runs along -Y and lands outside the part.
    for dz in (DEPTH / 2 - SCREW_SEP / 2, DEPTH / 2 + SCREW_SEP / 2):
        r = r.cut(
            cq.Workplane(obj=cq.Solid.makeCylinder(
                SCREW_D / 2.0, FOOT_V + 2,
                cq.Vector(-FOOT_EXT / 2.0, -1.0, dz),
                cq.Vector(0, 1, 0),
            ))
        )

    holes = [e for e in r.val().Edges()
             if e.geomType() == "CIRCLE" and abs(e.radius() - SCREW_D / 2) < 0.01]
    assert len(holes) == 4, f"expected 4 screw-hole edges, got {len(holes)}"

    return _soften(r, [(WALL, FOOT_V), (WALL, FOOT_V + CAV_V),
                       (WALL + CAV_U, FOOT_V + CAV_V)])


def _soften(r, corners, rad=FILLET_R):
    """Fillet only the named upright corners.  Filleting every |Z edge fails
    outright -- the 3 mm lip cannot take a radius on both of its corners."""
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


def hook_clip():
    """Same hook, but with jaws that spring onto the bench cross bar."""
    gap = RAIL_T - RAIL_FIT
    span = 2 * JAW_T + gap
    top = -(JAW_BASE + JAW_L)

    pts = [
        (0.0, top), (JAW_T, top),
        (JAW_T, -JAW_BASE), (JAW_T + gap, -JAW_BASE),
        (JAW_T + gap, top), (span, top),
        (span, BODY_V), (0.0, BODY_V),
    ]
    r = cq.Workplane("XY").polyline(pts).close().extrude(DEPTH)

    # Throat and mouth, centred under the jaws.
    off = (span - BODY_U) / 2.0
    r = r.cut(
        cq.Workplane("XY")
        .box(CAV_U, CAV_V, DEPTH + 2, centered=(False, False, False))
        .translate((off + WALL, FOOT_V, -1))
    )
    r = r.cut(
        cq.Workplane("XY")
        .box(span, GAP, DEPTH + 2, centered=(False, False, False))
        .translate((off + WALL + CAV_U, FOOT_V, -1))
    )
    return _soften(r, [(off + WALL, FOOT_V), (off + WALL, FOOT_V + CAV_V),
                       (off + WALL + CAV_U, FOOT_V + CAV_V)])


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    print(f"throat    {CAV_U} x {CAV_V} mm, mouth {GAP} mm")
    print(f"hook      {BODY_U} x {BODY_V} mm profile, {DEPTH} mm wide")
    print(f"foot      reaches {FOOT_EXT} mm past the hook, {FOOT_V} mm thick")
    print(f"screws    2 x #8, {SCREW_SEP} mm apart")
    print(f"drops     {BODY_V} mm below the bench")

    print(f"clip-on   jaws for a {RAIL_T} mm bar, {RAIL_FIT} mm interference, "
          f"{JAW_L} mm reach")

    for name, part in (("cable-hook-screw", hook()),
                       ("cable-hook-clip", hook_clip())):
        exporters.export(part, os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        print(f"wrote {name}")
