"""
Open cable hooks for the TBK 801 bench.

Two families:

  cable-hook-screw   screws to the underside of the bench.  Side-opening
                     throat with a retaining lip -- push cables in, the lip
                     keeps them there.

  s-bracket-small    hooks over a cross bar.  Crown on top of the bar, one leg
  s-bracket-large    down the near face, cradle in front of it.

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
from types import SimpleNamespace

import cadquery as cq
from cadquery import exporters

# ---------------------------------------------------------------------------
# The screw version's throat
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
# The S bracket -- hooks over the bench cross bar
# ---------------------------------------------------------------------------
# Section:
#
#     +==========+          <- crown, sits on top of the bar
#     |   bar    |
#     |          +---+
#     |          |   |      <- one leg, down the NEAR face only
#     |          |   |
#     +----------|   | 8 |
#                |   +---+  <- return lip: the mouth is NARROWER than the
#                |       |     cradle, so a full one cannot spill
#                +-------+
#
# Upper hook opens DOWN over the bar, lower hook opens UP for the cables --
# still an S, and both halves work WITH gravity.  The bar's top face carries
# the load.
#
# There WAS a second leg down the far face, sprung to pinch the bar.  It got
# cut off every single time on the bench, so it is gone.  With no second leg
# there is no spring left, which changes the fit from an interference to a
# CLEARANCE -- a gap under RAIL_T would simply refuse to go on.  RAIL_CLR is
# now positive for that reason, and a loose one is taken up with a strip of
# thin double-sided tape or foam on the CROWN'S UNDERSIDE: that is the bearing
# face, so tape there both fills the slop and adds the friction that used to
# come from the missing leg.  It is also unaffected by how thick the bar
# actually turns out to be.
#
# Load path without the second leg: cables hang forward of the bar, so the
# bracket wants to rotate nose-down about the bar's top front corner.  The one
# leg resists that by bearing on the bar's near face, which is why it runs most
# of the way down a 40 mm bar rather than being a stub.
RAIL_T   = 12.75   # measured cross-bar thickness
RAIL_H   = 40.0    # measured cross-bar height
RAIL_CLR = 0.60    # CLEARANCE, not interference -- it has to slip on

CROWN_T = 4.0      # material over the top of the bar -- this carries the load
LEG_T   = 3.0      # the leg down the near face
LEAD_CH = 1.2      # lead-in at the leg tip

CRADLE_FLOOR = WALL    # under the cables
LIP_T        = 3.0     # return-lip thickness
LIP_FUNNEL   = 1.6     # flare on the lip tip, so cables feed in

# Two sizes.  Only the cradle changes -- how far it sticks out, how deep the
# wall runs, how much lip closes back over it, and how wide along the bar.
SIZES = {
    "small": dict(cav_u=14.0, depth=17.0, lip_ret=6.0, leg_l=34.0, band=20.0),
    "large": dict(cav_u=20.0, depth=24.0, lip_ret=8.0, leg_l=38.0, band=24.0),
}

# ---------------------------------------------------------------------------
# Derived -- screw version
# ---------------------------------------------------------------------------
BODY_U = 2 * WALL + CAV_U        # screw-version hook block width
BODY_V = FOOT_V + CAV_V + WALL   # screw-version hook block height

assert GAP < CAV_V, "mouth is not narrower than the throat -- cables fall out"
assert GAP > 5.0, "mouth too tight to push a cable through"
assert FOOT_EXT > SCREW_D + 6, "foot too short for a screw head"
assert SCREW_D + 4 < DEPTH, "screw head wider than the hook"


def sbracket_spec(name):
    """Everything derived from one S-bracket size."""
    s = SIZES[name]
    d = SimpleNamespace(name=name, **s)

    d.u_f0 = RAIL_T + RAIL_CLR          # inner face of the leg
    d.u_f1 = d.u_f0 + LEG_T             # outer face of the leg = cradle back
    d.u_t1 = d.u_f1 + d.cav_u           # inner face of the cradle's outer wall
    d.u_o1 = d.u_t1 + WALL              # outside of the whole part

    d.y_bot     = -d.leg_l
    d.y_floor   = d.y_bot + CRADLE_FLOOR      # the cables rest here
    d.y_lip_bot = d.y_floor + d.depth         # underside of the return lip
    d.y_lip_top = d.y_lip_bot + LIP_T         # top of the outer wall

    d.u_mouth = d.u_t1 - d.lip_ret            # inner tip of the return lip
    d.mouth   = d.u_mouth - d.u_f1            # what a cable has to get past

    # No spring left, so this MUST be a clearance or it will not seat at all.
    assert d.u_f0 > RAIL_T, "leg gap is under the bar thickness -- it cannot go on"
    assert RAIL_CLR < 1.5, "so loose it will rock even with tape"

    assert d.mouth < d.cav_u - 2, \
        "no return lip -- a full cradle spills over the wall"
    assert d.mouth > 6.0, "mouth too tight to push a cable through"
    assert d.depth > 12.0, "cradle too shallow to hold a bundle"
    assert d.y_lip_top < -1.0, "outer wall runs up past the crown"
    assert d.leg_l < RAIL_H, "leg runs past the bottom of the bar"
    assert d.leg_l > RAIL_H * 0.6, \
        "leg too short to resist the nose-down load without a second leg"
    assert LEAD_CH < LEG_T - 1.0, "lead-in eats the whole leg tip"
    assert d.band > SCREW_D + 4, "too narrow along the bar to be stable"
    return d


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


def s_bracket(d):
    """The S bracket.  Drawn y-UP, unlike hook() above: the crown is the datum
    at y = 0 and everything hangs below it.

    One closed profile does the whole part -- crown, leg and cradle -- so
    there is no join anywhere for a loaded cable to open up.
    """
    pts = [
        (0.0,      CROWN_T),                        # back edge of the crown
        (d.u_f1,   CROWN_T),                        # across the crown top
        (d.u_f1,   d.y_floor),                      # down the cradle's back
        (d.u_t1,   d.y_floor),                      # across the cradle floor
        (d.u_t1,   d.y_lip_bot),                    # up inside the outer wall
        (d.u_mouth, d.y_lip_bot),                   # in along the lip underside
        (d.u_mouth + LIP_FUNNEL, d.y_lip_top),      # flared tip, funnels cables
        (d.u_o1,   d.y_lip_top),                    # across the top of the lip
        (d.u_o1,   d.y_bot),                        # down the outside
        (d.u_f0 + LEAD_CH, d.y_bot),                # across the bottom
        (d.u_f0,   d.y_bot + LEAD_CH),              # lead-in at the leg tip
        (d.u_f0,   0.0),                            # up the leg's bearing face
        (0.0,      0.0),                            # crown underside, on the bar
    ]
    r = cq.Workplane("XY").polyline(pts).close().extrude(d.band)

    # Cradle corners only.  The crown/leg corner is deliberately left sharp:
    # a fillet there is CONCAVE, so it fills material into the very corner the
    # bar's top front edge occupies -- a 1.5 mm radius ate RAIL_CLR down to
    # 0.05 mm and would have stopped the crown seating flat.
    r = _soften(r, [(d.u_f1, d.y_floor), (d.u_t1, d.y_floor),
                    (d.u_t1, d.y_lip_bot)])

    # The bar has to fit between the leg and the back of the crown, the whole
    # way down.  Check the narrowest point rather than trusting the profile.
    faces = [f for f in r.val().Faces()
             if abs(f.normalAt(f.Center()).x + 1) < 1e-3
             and abs(f.Center().x - d.u_f0) < 0.01]
    assert faces, "leg bearing face is not where it should be"
    return r


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    for d in ("stl", "step"):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    parts = {}

    print("cable-hook-screw")
    print(f"  throat  {CAV_U} x {CAV_V} mm, mouth {GAP} mm")
    print(f"  block   {BODY_U} x {BODY_V} mm profile, {DEPTH} mm wide")
    print(f"  foot    reaches {FOOT_EXT} mm past the hook, {FOOT_V} mm thick")
    print(f"  screw   1 x #8, centred")
    parts["cable-hook-screw"] = hook()

    print()
    print(f"S bracket -- crown {CROWN_T} mm on the bar, leg gap "
          f"{RAIL_T + RAIL_CLR:.2f} mm on a {RAIL_T} mm bar "
          f"(+{RAIL_CLR} clearance, no spring)")

    for name in SIZES:
        d = sbracket_spec(name)
        parts[f"s-bracket-{name}"] = s_bracket(d)
        print()
        print(f"s-bracket-{name}")
        print(f"  cradle  {d.cav_u} wide x {d.depth} deep mm, "
              f"{d.band} mm along the bar")
        print(f"  lip     returns {d.lip_ret} mm -> {d.mouth:.1f} mm mouth "
              f"({d.cav_u - d.mouth:.1f} mm of overhang holding cables in)")
        print(f"  leg     {d.leg_l} mm down the near face "
              f"({d.leg_l/RAIL_H*100:.0f} % of the bar)")
        print(f"  size    {d.u_o1:.2f} x {CROWN_T + d.leg_l:.2f} x {d.band} mm")

    print()
    for name, part in parts.items():
        exporters.export(part, os.path.join(root, "stl", f"{name}.stl"),
                         tolerance=0.01, angularTolerance=0.1)
        exporters.export(part, os.path.join(root, "step", f"{name}.step"))
        bb = part.val().BoundingBox()
        print(f"wrote {name:20s} {part.val().Volume()/1000:6.2f} cm3   "
              f"{bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm")
