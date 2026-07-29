# Back Panel System — TBK 801, middle rail to desktop

Four parts. Fit both tracks, lift each panel in, then drop a mullion into each
seam.

| File | What | Per bay |
| --- | --- | --- |
| `stl/panel-track-top.stl` | snaps into the middle rail's T-slot, groove down | 5 |
| `stl/panel-track-bottom.stl` | VHB to the desktop, groove up | 5 |
| `stl/back-panel.stl` | 211 × 247 × 3 mm | 5 |
| `stl/panel-mullion.stl` | closes each seam, 15 × 6.8 × 226 mm | 4 |

| | |
| --- | --- |
| Opening | 272 mm tall, bay ~1067 mm (42") |
| Track segments | 213.4 mm, butted end to end |
| Groove | 3.8 mm for a 3.0 mm panel |
| Top track | 10 × 36 mm, 3 snap stems, drops 21 mm |
| Bottom track | 16 × 9 mm, flat base for VHB |
| **Per bay** | **~1,454 g PLA, ~59 h** |

## Lift-in, not slide-in

Panels go in **one at a time, in place**:

1. Tilt a panel and push its top edge up into the deep top groove.
2. Swing it upright — the bottom clears the bottom track by 7 mm.
3. Drop it. 8 mm still engaged at the top, 6 mm at the bottom.

**This needs no side clearance at all.** Sliding panels in from the end would
need ~220 mm beside the bench; sliding a pre-assembled sheet in would need the
full 1067 mm, which is why that idea doesn't survive contact with a real room.

It also means **nothing has to clip together** — each panel installs and comes
back out on its own, without dismantling the rest of the wall.

The cost is 7 mm of top-groove depth: 15 mm total, 8 mm resting plus 7 mm of
lift. That takes the top track from 29 mm to 36 mm.

## Mullions

A mullion drops into each seam after the panels are placed. Both panel edges
slot 6 mm into it, so the seam closes and the two faces are forced flush — which
matters, because 3 mm PLA panels this size will have some warp in them.

It is deliberately **not** captured by the tracks: it rests on the bottom track
and the panels hold it fore and aft. That keeps it 6.8 mm thick (a 3.8 mm groove
plus two walls), which would never fit the 3.8 mm track groove. It stands about
1.9 mm proud of the panels on each face.

Five panels plus four 3 mm webs span **1067.0 mm** — exactly the bay.

## Printing

**Top track** — as exported. Stems up, groove down; the groove ceiling is only a
3.8 mm bridge and the leaf springs flex along the layers, not across them.

**Bottom track** — as exported, groove open upward.

**Mullion** — as exported, lying down with one groove up and one down. The
downward groove is a 3.8 mm bridge. Stood the other way each groove ceiling
would be a 6 mm cantilever and would droop.

**Panels** — flat on the bed. **Brim is not optional**; a 211 × 247 × 3 mm plate
is close to the worst case for corner lift. PLA is the right pick here.

0.2 mm layers, 4 walls, 15 % infill on the tracks and mullions.

## Fitting

1. Snap the five top track segments into the rail, butted end to end.
2. Clean the desktop with IPA, stick the five bottom segments down, lined up.
3. Lift each panel in — tilt, swing, drop.
4. Drop a mullion into each of the four seams.

## Rebuilding

```sh
pip install cadquery
python3 src/back_panel.py
```

`PANEL_T` sets every groove. `BAY_W` and `N_PANELS` set panel width and segment
length. `TOP_GROOVE_D` must stay at least 8 + `BOT_GROOVE_D` + 1 or the panel
can't be lifted clear — there's an assert on it.
