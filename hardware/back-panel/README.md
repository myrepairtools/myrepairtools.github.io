# Back Panel System — TBK 801, middle rail to desktop

Three parts. Fit both tracks, then slide the panels in from the side.

| File | What | Per bay |
| --- | --- | --- |
| `stl/panel-track-top.stl` | snaps into the middle rail's T-slot, groove down | 5 |
| `stl/panel-track-bottom.stl` | VHB to the desktop, groove up | 5 |
| `stl/back-panel.stl` | 219.8 × 247 × 3 mm, shiplap edges | 5 |

| | |
| --- | --- |
| Opening | 272 mm tall, bay ~1067 mm (42") |
| Track segments | 213.4 mm, butted end to end |
| Groove | 3.8 mm for a 3.0 mm panel — 0.4 mm per side so it **slides** |
| Top track | 10 × 29 mm, 3 snap stems, drops 21 mm |
| Bottom track | 16 × 9 mm, flat base for VHB |
| Panel engagement | 8 mm top, 6 mm bottom |
| **Per bay** | **~1,353 g PLA, ~55 h** |

## The seam

The vertical edges are **shiplapped**: the back is rabbeted away on the left
edge and the front on the right, so each panel nests into the one before it as
it slides in. Every panel is identical — no left/right/middle variants.

| | |
| --- | --- |
| Overlap | 8 mm |
| Lap thickness | 1.4 mm each, **2.8 mm nested** |
| Slide clearance | 0.2 mm across the joint, 0.3 mm at the shoulder |

The nested seam is *thinner* than the panel, so it never binds in the 3.8 mm
groove. Five lapped panels span **1067.0 mm** — exactly the bay.

**Why not a snapping tongue.** At 3 mm the tongue works out to ~1.4 mm and the
groove lips to ~0.8 mm — two perimeters of brittle PLA on a part that has to
flex. The tracks already capture the panels top and bottom, so the joint only
has to close the seam and keep the faces aligned, which a lap does without any
thin flexing features. If you go to a 4 mm panel a barbed tongue becomes
practical and I can swap it in.

## The vertical budget

```
272 = 21 drop + 247 panel + 3 base + 1 clearance
```

**The 21 mm drop exists only to get the panel under the 256 mm bed limit.** A
cut sheet would need about 4 mm of it, and would be one piece per bay instead of
five with four vertical seams. If you ever switch materials, drop `TOP_DROP` to
4 and the top track shrinks from 29 mm to 12 mm.

## Why the bottom is adhesive and the top is not

The top of the opening is the middle rail, so that track snaps into the 8.49 mm
T-slot — three stems per segment, same leaf-spring geometry already proven on
the cable clip (5.4 N to push in, 0.78 % strain).

The bottom of the opening is the **desktop**, not a rail, so there's nothing to
snap into. Flat base, VHB tape. Keep the surface clean with IPA before sticking
it — the panel's weight works on that bond every time someone bumps it.

## Printing

**Top track** — print as exported. Stems up, groove down; the groove ceiling is
only a 3.8 mm bridge and the leaves end up flexing along the layers rather than
across them.

**Bottom track** — print as exported, groove open upward, nothing to bridge.

**Panels** — flat on the bed. **Brim is not optional.** A 213 × 247 × 3 mm plate
is close to the worst case for corner lift. PLA is the right pick here; PETG
would warp more.

0.2 mm layers, 4 walls, 15 % infill on the tracks.

## Fitting

1. Snap the five top track segments into the rail, butted end to end.
2. Stick the five bottom segments down, lined up under the top ones.
3. Slide panels in from the open side, one after another.

## Rebuilding

```sh
pip install cadquery
python3 src/back_panel.py
```

`PANEL_T` sets the groove. `BAY_W` and `N_PANELS` set the segment length — the
last segment of a bay usually needs trimming, or set `N_PANELS` so it divides
evenly.
