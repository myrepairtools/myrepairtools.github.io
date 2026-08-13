# CPR Tool Organizer — icons engraved

Takes your `CPR_Tool_Organizer_Master.stl` and cuts the tool-tip icons into it.

| | |
| --- | --- |
| Output | `stl/CPR_Tool_Organizer_Master-engraved.stl` |
| Depth | 0.6 mm, measured along the face normal |
| Icon sizes | 7 mm in the grid, 10 mm where there's room |
| Volume removed | 91.1 mm³ — matches the icon outlines exactly |

![Engraved face](svg/engraved-face.png)

## The face is a slope, and that changes the job

The front of the organizer isn't flat and isn't horizontal. It's a plane at

```
z = 30.0 + 0.75 · y          (3-in-4, 36.87° from horizontal)
```

measured off your mesh and re-checked by the build every run. So the icons are
cut **along the face normal**, not straight down. A vertical cut would land as a
smeared ellipse and would be deeper at the bottom than the top.

## Two things the top view got wrong

**Pocket rims have a lead-in.** The opening you see from above starts about
1.5 mm before the flat face actually ends. Between the grid rows there is only
**8.0 mm** of real flat face, not the 10 mm a top-view survey implies. Sizes
here come from raycasting the mesh, and the build re-measures nine points
around every icon before cutting — it refuses to cut if any of them is more
than 0.05 mm off the plane.

**An icon centred in a gap belongs to neither hole.** With 8 mm of face between
two rows, a centred icon sits equidistant from both. Each one is hung from the
top of its band instead: 0.5 mm of face above, 1.9 mm below, so it's nearly
four times closer to the hole it labels.

That's also why the grid icons are 7 mm and the far-right ones are 10 mm — the
slots at 12 and 13 have 18.7 mm of clear face beneath them, so there's no
reason to shrink those.

## What I assumed

Numbers refer to the pocket map:

![Pocket map](svg/pocket-map.png)

| Pocket | Icon | Why |
| --- | --- | --- |
| 7, 8, 9 | pentalobe, phillips, tripoint-y | 3×3 read left→right, top→bottom |
| 14 | standoff | fourth in that reading order |
| 12, 13 | sim, grinder | the only two holes at the far right, and narrow — 15, 17 are the same oval as the driver holes |
| 11 | jimmy | 56 mm wide = 2 × 28 mm, a Jimmy's width |
| 23 | snips | 51 mm wide = 2 × 25 mm, a snip's width |

**Five of the nine grid holes are unlabelled** (15, 16, 20, 21, 22) — you gave
four icons for a nine-hole grid, so I filled the first four in reading order.

## Re-running

```sh
pip install trimesh manifold3d shapely scipy
python3 src/engrave.py
```

`PLACEMENTS` at the top of `src/engrave.py` is the whole mapping — icon name,
x, the clear band it sits in, size, and whether it hangs under the pocket or
centres in its band. Changing an assignment is one line.
