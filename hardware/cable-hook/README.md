# Cable Hooks — TBK 801 bench

Open hooks: no cutting and re-fitting zip ties. Cables go in, cables come out.

| File | Mount | Size | Each (4 walls / 20 % infill) |
| --- | --- | --- | --- |
| `stl/cable-hook-screw.stl` | 1 × #8 screw into the bench underside | 36 × 23 × 20 mm | ~4.8 g |
| `stl/cable-hook-clip.stl` | hangs over a 12.75 × 40 mm cross bar | 35.4 × 38 × 20 mm | ~5.5 g |

![S bracket section](svg/s-bracket-section.png)

## The S bracket — third attempt, and the first one that works

The first two versions both **clamped the bar from underneath**. That was the
mistake, and no amount of tuning the retaining lip was ever going to fix it:
with the jaws opening upward, the only thing holding a loaded hook on the bar
was friction. Hang enough cable on it and it walks straight off the bottom.
That is exactly what *"either the cables will fall or it won't hook to the
track"* was pointing at.

It now goes **over the top of the bar**, like an S-hook on a rail.

| | |
| --- | --- |
| Crown | 4 mm of material sitting on the bar's top face — **this** carries the load |
| Jaws | 12.40 mm gap on a 12.75 mm bar — 0.35 mm interference, 0.31 % strain |
| Back jaw | 16 mm down the far face |
| Front jaw | 34 mm down the near face, running straight on into the cradle |
| Cradle | 14 mm wide, cables sit 13 mm down, **open at the top** |

Upper hook opens **down**, lower hook opens **up**. That is the S — and both
halves now work with gravity instead of against it:

- The bar's top face holds the bracket up. The jaws only stop it rattling and
  sliding along the bar.
- Cables drop into the cradle from above and cannot fall out, because the only
  way out is back up. Lift them out whenever you want.

It is one closed profile from the crown to the cradle floor — no join anywhere
for a load to pull open.

### Fitting

Push it up onto the bar from below until the crown seats on top; the jaw tips
are chamfered so they spread onto it. Or slide it on from the end of the bar.
Slides along to reposition either way.

If it rattles, raise `RAIL_FIT`. If it will not go on, lower it. One line,
10-minute reprint.

## The screw version

Side-opening throat, 14 × 16 mm, with an 8 mm mouth — narrower than the
throat, so cables push in and stay. One #8 screw through the middle of the
foot. Drops 23 mm below the bench.

## Printing

Both are a single constant cross-section, so they print **on their side with
every face a vertical wall — no supports**. That also puts the layers running
*along* the jaws rather than across the point where they would break.

**Use a brim.** The first layer is small for a 20 mm-tall part.

PETG. The clip's jaws are a spring and the screw version sits under a bench
that gets warm; neither is a job for PLA.

## Rebuilding

```sh
pip install cadquery
python3 src/cable_hook.py
```
