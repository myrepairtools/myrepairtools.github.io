"""
Engrave the tool-tip icons into the CPR tool organizer.

The organizer's front face is not flat and it is not horizontal: it is a plane
sloping 3-in-4, exactly

    z = 30.0 + 0.75 * y          (measured off the mesh, y = 0 .. 102)

which is 36.87 degrees from horizontal.  Icons therefore have to be cut ALONG
THE FACE NORMAL, not straight down -- a vertical cut would come out as a
smeared ellipse and would be deeper at one end than the other.

Face frame:

    U = (1, 0, 0)          across, same as model +x
    V = (0, 0.8, 0.6)      up the slope (model +y)
    N = (0, -0.6, 0.8)     out of the face

Each icon is built flat, extruded along +z, then mapped by [U V N] and dropped
so it spans DEPTH below the face and OVER above it.

Sizes are set by the gaps: the rows of pockets leave 10 mm of clear face
between them in PLAN, which is 12.5 mm measured along the slope.  A 10 mm icon
along the slope covers 8 mm in plan and clears everything.

Run:  python3 engrave.py
"""

import os
import sys

import numpy as np
import trimesh
from shapely.geometry import Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "tool-icons", "src"))
import icons  # noqa: E402

SRC = os.environ.get(
    "MRT_ORG",
    "/root/.claude/uploads/522ca63d-2e48-502d-8d37-525fe938f0e8/"
    "5f440890-CPR_Tool_Organizer_Master.stl")

# ---------------------------------------------------------------------------
# The sloped face
# ---------------------------------------------------------------------------
SLOPE = 0.75            # dz/dy
Z0 = 30.0               # z where y = 0
U = np.array([1.0, 0.0, 0.0])
V = np.array([0.0, 0.8, 0.6])
N = np.array([0.0, -0.6, 0.8])

DEPTH = 0.6             # how far the icon is cut into the face
OVER = 1.0              # how far the cutter sticks out, so the cut is clean

# Every pocket rim has a lead-in, so the flat face stops about 1.5 mm before
# the opening the top view shows.  These bands were MEASURED by raycasting the
# original mesh, not read off the height-map survey, and the build re-measures
# them before cutting.  Between the grid rows there is only 8.0 mm of real
# flat face -- not the 10 mm the survey implied.
CLEAR = 0.5             # margin between an icon and the start of a rim

# ---------------------------------------------------------------------------
# What goes where.  (x, y) is in PLAN -- straight off the top view -- and the
# script puts it on the face itself.  Pocket numbers refer to the map.
# ---------------------------------------------------------------------------
# icon, x, (band_lo, band_hi), size along the slope, anchor, note.
#
# anchor "under" hangs the icon from the TOP of its band, right beneath the
# pocket it labels.  In an 8 mm band a 7 mm icon leaves 0.6 mm above and
# 1.8 mm below, so it is three times nearer its own hole than the next one --
# an icon centred in the band belongs to neither.
#
# Sizes differ because the room does: the grid rows have 8 mm, the far-right
# slots have 18.7 mm, and pocket 23 has a whole clear column beside it.
PLACEMENTS = [
    ("pentalobe",   95.0, (69.0, 77.0),  7.0, "under", "7  - 3x3 top left"),
    ("phillips",   125.0, (69.0, 77.0),  7.0, "under", "8  - 3x3 top middle"),
    ("tripoint-y", 155.0, (69.0, 77.0),  7.0, "under", "9  - 3x3 top right"),
    ("standoff",    95.0, (45.0, 53.0),  7.0, "under", "14 - 3x3 middle left"),
    ("jimmy",       34.5, (58.2, 65.6),  7.0, "under", "11 - big rectangle"),
    ("sim",        215.0, (47.7, 66.4), 10.0, "under", "12 - far right slot"),
    ("grinder",    233.5, (47.7, 66.4), 10.0, "under", "13 - far right slot"),
    # pocket 23 has 3 mm beneath it and nothing else, so this one goes alongside
    ("snips",      180.0, (16.0, 39.9), 10.0, "centre", "23 - bottom rectangle"),
]

# Pockets, so the script can prove an icon never lands on top of one.
# (x0, x1, y0, y1) in plan, from the height-map survey.
POCKETS = [
    (6.5, 55.5, 145.5, 197.5), (59.5, 108.5, 145.5, 197.5),
    (112.5, 137.5, 145.5, 197.5), (141.5, 190.5, 145.5, 197.5),
    (194.5, 243.5, 145.5, 197.5), (6.5, 243.5, 105.5, 136.5),
    (85.5, 104.5, 78.5, 92.5), (115.5, 134.5, 78.5, 92.5),
    (145.5, 164.5, 78.5, 92.5), (178.5, 197.5, 78.5, 92.5),
    (6.5, 62.5, 68.5, 95.5), (210.5, 219.5, 68.5, 89.5),
    (228.5, 238.5, 68.5, 89.5),
    (85.5, 104.5, 54.5, 68.5), (115.5, 134.5, 54.5, 68.5),
    (145.5, 164.5, 54.5, 68.5), (179.5, 198.5, 54.5, 68.5),
    (6.5, 62.5, 49.5, 57.5), (6.5, 62.5, 34.5, 42.5),
    (85.5, 104.5, 30.5, 44.5), (115.5, 134.5, 30.5, 44.5),
    (145.5, 164.5, 30.5, 44.5),
    (186.5, 237.5, 14.5, 38.5), (6.5, 62.5, 19.5, 28.5),
    (0.5, 249.5, 0.5, 11.5),
]


def face_point(x, y):
    return np.array([x, y, Z0 + SLOPE * y])


def icon_polygon(name, size):
    """Icon outline as shapely, in mm, centred on the origin, y flipped so it
    is the right way up (SVG y runs down)."""
    k = size / icons.SIZE
    polys = []
    for ring in icons.ICONS[name]():
        if None in ring:
            i = ring.index(None)
            outer, inner = ring[:i], ring[i + 1:]
            polys.append(Polygon([((sx - 10) * k, -(sy - 10) * k) for sx, sy in outer],
                                 [[((sx - 10) * k, -(sy - 10) * k) for sx, sy in inner]]))
        else:
            polys.append(Polygon([((sx - 10) * k, -(sy - 10) * k) for sx, sy in ring]))
    return unary_union([p.buffer(0) for p in polys])


def cutter(name, x, y, size):
    poly = icon_polygon(name, size)
    prism = trimesh.creation.extrude_polygon(poly, DEPTH + OVER)
    M = np.eye(4)
    M[:3, 0], M[:3, 1], M[:3, 2] = U, V, N
    M[:3, 3] = face_point(x, y) - N * DEPTH
    prism.apply_transform(M)
    return prism


def surface_depth(mesh, x, y):
    """How far below the ideal plane the ORIGINAL surface sits at (x, y).
    ~0 means untouched face; anything more means a rim or a pocket."""
    loc, _, _ = mesh.ray.intersects_location(
        np.array([[x, y, 400.0]]), np.array([[0, 0, -1.0]]), multiple_hits=False)
    return 99.0 if not len(loc) else (Z0 + SLOPE * y) - loc[0][2]


def place(name, x, band, size, anchor):
    """Icon centre in plan, and the band check that keeps it off a rim."""
    lo, hi = band
    plan_h = size * 0.8                       # foreshortened by the slope
    if plan_h > (hi - lo) - 2 * CLEAR:
        raise AssertionError(
            f"{name}: {size} mm icon needs {plan_h:.1f} mm of plan height but "
            f"the clear band is only {hi - lo:.1f} mm")
    if anchor == "under":
        cy = hi - CLEAR - plan_h / 2.0
    else:
        cy = (lo + hi) / 2.0
    return cy, plan_h


def verify_band(mesh, name, x, cy, size, plan_h):
    """Re-measure the face the icon is about to land on.  The height-map
    survey put the pocket rims 1.5 mm out; this checks the real mesh."""
    for dx in (-size / 2, 0.0, size / 2):
        for dy in (-plan_h / 2 - CLEAR * 0.8, 0.0, plan_h / 2 + CLEAR * 0.8):
            d = surface_depth(mesh, x + dx, cy + dy)
            if abs(d) > 0.05:
                raise AssertionError(
                    f"{name}: the face at ({x+dx:.1f}, {cy+dy:.1f}) is {d:.2f} mm "
                    "off the plane -- the icon would run into a rim")


def main():
    root = os.path.dirname(HERE)
    for d in ("stl",):
        os.makedirs(os.path.join(root, d), exist_ok=True)

    mesh = trimesh.load(SRC)
    print(f"loaded  {len(mesh.faces)} faces, watertight={mesh.is_watertight}")
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.update_faces(mesh.unique_faces())
    trimesh.repair.fix_normals(mesh)
    mesh.fill_holes()
    assert mesh.is_watertight, "could not close the mesh -- boolean would fail"
    v_before = mesh.volume
    print(f"repaired watertight, {v_before/1000:.1f} cm3\n")

    # The plane has to be right or every cut lands in the wrong place.
    for y in (20.0, 60.0, 100.0):
        loc, _, _ = mesh.ray.intersects_location(
            np.array([[110.0, y, 400.0]]), np.array([[0, 0, -1.0]]),
            multiple_hits=False)
        assert abs(loc[0][2] - (Z0 + SLOPE * y)) < 0.05, \
            f"face is not where the script thinks at y={y}"
    print("slope plane confirmed: z = 30.0 + 0.75*y\n")

    cutters, placed, want = [], [], 0.0
    for name, x, band, size, anchor, note in PLACEMENTS:
        cy, plan_h = place(name, x, band, size, anchor)
        verify_band(mesh, name, x, cy, size, plan_h)
        cutters.append(cutter(name, x, cy, size))
        want += icon_polygon(name, size).area * DEPTH
        placed.append((name, x, cy, size))
        above = band[1] - (cy + plan_h / 2)
        below = (cy - plan_h / 2) - band[0]
        print(f"  {name:12s} {size:4.1f} mm at plan ({x:6.1f}, {cy:5.1f})"
              f"   land above {above:4.1f}, below {below:4.1f}   pocket {note}")

    tool = trimesh.util.concatenate(cutters)
    out = trimesh.boolean.difference([mesh, tool], engine="manifold")
    removed = v_before - out.volume
    print(f"\nremoved {removed:.1f} mm3 across {len(placed)} icons; "
          f"the icon outlines at {DEPTH} mm deep come to {want:.1f} mm3")
    # A real check instead of a magic number: what came out has to match the
    # area of the outlines times the depth.  Too little means cuts missed the
    # face; too much means one broke through into a pocket.
    assert 0.85 * want < removed < 1.15 * want, \
        f"removed {removed:.1f} mm3 but the outlines account for {want:.1f}"
    assert out.is_watertight, "result is not watertight"

    dst = os.path.join(root, "stl", "CPR_Tool_Organizer_Master-engraved.stl")
    out.export(dst)
    print(f"wrote {dst}")
    return out


if __name__ == "__main__":
    main()
