# Cable Hooks — TBK 801 bench

Open hooks: push cables in through the mouth, they drop into the throat and
gravity holds them. Lift them out any time — no cutting and re-fitting ties.

Two mounts, same hook:

| File | Mount | Size | Each |
| --- | --- | --- | --- |
| `stl/cable-hook-screw.stl` | 2 × #8 screws into the bench underside | 36 × 23 × 20 mm | ~4.8 g |
| `stl/cable-hook-clip.stl` | springs onto a 12.75 mm cross bar | 20 × 46 × 20 mm | ~6.5 g |

| | |
| --- | --- |
| Throat | 14 × 16 mm — a handful of charge cables |
| Mouth | 8 mm, narrower than the throat so nothing falls out |
| Screw version drops | 23 mm below the bench |
| Clip jaws | 12.20 mm gap on a 12.75 mm bar — 0.55 mm interference |

## The clip is an S, not a C

The jaws and the hook are **stacked, not nested**. A first version sized the
whole body to the jaw span (17.2 mm) and made the hook squeeze inside it, which
left a **1.6 mm retaining lip instead of 3 mm** — cables would have slid back
out of the mouth. The hook now keeps its full 20 mm width and steps proud of
the jaws, which is what gives the part its S profile.

With that fixed: lip 3 mm wide × 11 mm tall, and a cable resting in the bottom
of the throat sits **4 mm below the top of the lip**. An assert now fails the
build if the lip ever gets squeezed again.

## Print one clip and test the grip

The jaw gap is the only guessed number here. 0.55 mm of interference works out
to **11 N to spread onto the bar at 0.26 % strain** — light, and nowhere near
PETG's ~4–5 % yield, so there is plenty of room to tighten it.

If it slides off too easily, raise `RAIL_FIT`. If it will not go on, lower it.
One line, 10-minute reprint.

## Printing

Both are a single constant cross-section, so they print **on their side with
every face a vertical wall — no supports**. That also puts the layers running
*along* the hook and the jaws rather than across the point where they would
break.

**Use a brim.** The first layer is only ~270 mm² on a 20 mm-tall part.

PETG. The clip jaws are a spring, and the screw version sits under a bench that
gets warm; neither is a job for PLA.

## Fitting

**Screw version** — hold it to the underside, mark two holes, 3 mm pilots,
#8 pan heads. Check screw length against the bench top before driving.

**Clip version** — push it up onto the bottom edge of a cross bar until the
jaws seat. Slides along to reposition.

## Rebuilding

```sh
pip install cadquery
python3 src/cable_hook.py
```
