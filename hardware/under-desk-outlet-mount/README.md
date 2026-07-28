# Under-Desk Outlet Mount

A printed cradle that lets a **recessed furniture outlet strip** mount under a
TBK 801 workbench without cutting the bench top. It gets charger cables off the
work surface.

The part is a "false desktop": a rectangular shell whose front face carries the
same cut-out the outlet would normally get in a real bench top. The outlet drops
in from the front, its faceplate lands on that face exactly as it would on a
desk, and the shell's top plate screws up into the underside of the bench. The
outlet ends up **facing forward**, toward whoever is sitting at the bench.

```
        screws up into the bench underside
         ^        ^        ^
    ═════╪════════╪════════╪═════════════   bench top
    ┌────┴────────┴────────┴────────────┐
    │           top plate               │
    │   ┌───────────────────────────┐   │
    │   │  ▯  ▯  ▯   ▮▮   ▯         │   │  ← outlet faces you
    │   └───────────────────────────┘   │
    └───────────────────────────────────┘
              ▼ cables hang down
```

## Files

| File | What it is |
| --- | --- |
| `stl/fit-test-coupon.stl` | **Print this first.** A 72 mm slice of one end. ~25 min. |
| `stl/outlet-mount-short.stl` | **Use this one.** 48.75 mm deep — clears the TBK 801 frame rail. See below. |
| `stl/outlet-mount.stl` | Generic full-depth version, 60.75 mm. For benches with no rail in the way. |
| `stl/fixture-cut-template.stl` | Marking template for cutting the outlet into a store fixture. |
| `step/*.step` | Same parts as STEP, for editing in real CAD. |
| `src/outlet_mount.py` | The parametric source. Every dimension is a named constant. |
| `src/fixture_template.py` | The template, built from the same outlet dimensions. |
| `svg/outlet-mount.svg` | Line drawing. |

## Dimensions this was built to

| | source | inches | mm |
| --- | --- | --- | --- |
| Faceplate | listing | 8.28 × 2.40 | 210.31 × 60.96 |
| Body through the cut-out | **measured** | 7-1/6 × 1-15/16 | 182.03 × 49.21 |
| Body depth behind the faceplate | **measured** | 1.722 | 43.75 |

The cut-out is sized to the **measured body**, not to the listing's "cut size"
of 7.30 × 2.13 in. That figure is a deliberately generous recommendation for
cutting wood, and using it would have thrown away nearly half the face the
faceplate lands on.

The reported length of 7-1/6" isn't a reading any rule gives — 7-1/16 (179.39),
7-1/8 (180.98) and 7-1/6 (182.03) are all plausible, so the model takes the
largest. Too big only costs slop the faceplate covers; too small won't go in.
Worst case the body is really 7-1/16", which leaves 1.7 mm of hidden play at
each end and *more* bearing, not less.

Which produces:

| | |
| --- | --- |
| Printed part | 222.3 W × 48.75 D × 73.0 H mm (short) / 60.75 D (full) |
| Printed cut-out | 182.8 × 50.0 mm (0.4 mm clearance per side) |
| Faceplate lands on | 13.74 mm of face at each end, 5.47 mm top and bottom |
| Headroom above the body | 5.47 mm |
| Driver access holes | 6 × 16 mm through the bottom plate, under each screw |
| Hangs below the bench | **73 mm** |
| Bed footprint | 222.3 × 73.0 mm, 48.75 mm tall |

## Placement

Mounted at the far left end of the 4' bench, hard against the front edge, out of
the way of anyone working. The 73 mm of hang is not a knee problem there.

**Flush or set back?** Two choices, both fine:

- **Flush** — the printed face lines up with the bench's front edge. Easiest to
  reach; charging bricks stick out past the edge where they can get knocked.
- **Set back ~45 mm** — a typical GaN charging brick is 30–45 mm deep, so
  setting the mount back by that much leaves the bricks roughly level with the
  bench edge instead of hanging past it, and the cables drop *behind* the front
  face where nothing catches them. Costs you reaching 45 mm under to plug in.

Set-back is the better default for chargers that stay plugged in.

Two things to check before drilling:

- **Don't put screws too close to the bench edge.** Mounted flush, the front
  screw row lands 13 mm back from the edge — too close if the top is
  particleboard or MDF, which will blow out. Either set the mount back, or use
  only the rear screw row plus the two rear corners.
- **Look for a frame rail or apron** under that corner of the bench. If the
  top plate can't sit flat against the underside there, shift inboard until it
  can.

## The short variant — clearing the bench's frame rail

**Use `outlet-mount-short.stl` on the TBK 801 benches.** It is **48.75 mm
deep**, which puts its back face flush with the back of the outlet body — as
short as the part can be without the shell stopping before the outlet does.

The full-depth mount runs into the steel rail under the bench top:

| | from the front edge |
| --- | --- |
| Frame rail, front face | 2-3/8" = 60.32 mm |
| Frame rail, depth | 1-5/8" = 41.27 mm (occupies 60.3 → 101.6 mm) |
| **Short variant reaches** | **48.75 mm** |
| **Clearance** | **11.57 mm** |

That margin is the point. The benches were assembled by hand with no
pre-drilled holes, so the rail does not sit in the same place on every desk —
a variant that just barely clears one bench will foul the next one. Trimming
only to the end of the support rails removes 4 mm and still buries the mount
in the rail; the 58 mm intermediate version cleared by 2.3 mm, which is inside
the assembly variation. Flush with the outlet is the right stopping point.

Everything else is unchanged: same faceplate opening, same 13.7/5.5 mm
bearing, same 73 mm height, same six screws. Both screw rows (Y=16 and
Y=32.8) sit well forward of the rail, and 39.8 mm of the outlet body still
rides on the support rails.

**This also fixes the cord fouling.** The metal strain relief on the cord was
hitting the back of the shell — the material that came off is exactly what it
was hitting. The cord-relief notches in both side walls are unchanged and
still symmetric, so one part works mounted at either end of a bench; there is
no left/right version to keep straight.

### Where BODY_D came from

Measuring the built bracket gave **3/4" of shell sticking out past the back of
the outlet body**, so the real depth behind the faceplate is
67.8 − 5 − 19.05 = **43.75 mm** — not the 50.8 mm the listing implied. The
listing's "2 inch" is the unit's *total* depth including the faceplate:
43.75 + a ~7 mm faceplate = 50.8 mm = exactly 2". `BODY_D` is now that
measured figure.

To regenerate at a different depth:

```sh
MRT_BACK_GAP=0 MRT_SUFFIX=-short python3 src/outlet_mount.py
```

`BACK_GAP` is the clear space behind the body; depth = 5 + `BODY_D` +
`BACK_GAP`. The asserts will stop you if a value leaves no room for the
outlet, or pushes the screw access holes or cable-tie slots off the plate.

The fit-test coupon is only the front 20 mm, so it is identical for both
variants — there is one coupon file.

## Check your outlet first

The body is measured, but the **faceplate is still a listing figure** — and the
faceplate is what sets the whole part's outer size and how much face it lands
on. Verify before committing to a 7–10 hour print:

1. **Print `fit-test-coupon.stl`** (~25 min). Push one end of the outlet into
   its cut-out corner. The body should pass through without forcing, and the
   faceplate should sit flat on the printed face with no rock.
2. If it doesn't fit, put calipers on the outlet and update the top block of
   `src/outlet_mount.py`:

   | Measure | Constant |
   | --- | --- |
   | Faceplate length and height | `FLANGE_L`, `FLANGE_H` |
   | Body cross-section | `BODY_L`, `BODY_H` |
   | How far the body sticks out behind the faceplate | `BODY_D` |
   | Too tight / too sloppy overall | `CLR` (0.4 mm per side) |

3. Re-run `python3 src/outlet_mount.py` and reprint the coupon.

The coupon can't check overall **length** — that's why the model rounds the
ambiguous 7-1/6" up rather than down.

**Where does your cord exit?** The listing photo doesn't show this clearly, so
the design leaves the whole back open plus a notch in the back of each side
wall. If your unit's cord leaves the **top** of the body, there's 5.5 mm of
headroom — probably enough, but raise `REVEAL_TOP` if not (each mm added is
1 mm more hanging below the bench).

## Printing

Orientation and supports are already handled: the STL has the front face lying
on the bed, and there is nothing in the part that needs support.

| Setting | Value |
| --- | --- |
| Material | **PLA+** |
| Nozzle / bed | 210–220 °C / 55–60 °C (generic PLA profile is fine) |
| Layer height | 0.2 mm |
| Walls | 4 |
| Infill | 15 % gyroid |
| Supports | None |
| Brim | Not needed — the front face gives a large flat first layer |

PLA+ is the right call for this part. It is *stiffer* than PETG, so the bracket
is actually more rigid, and it prints far more predictably — which matters for a
222 mm part on a new machine. PLA's weaknesses don't bite here: it softens near
55–60 °C and creeps under sustained load, but this sits indoors under a bench
carrying well under a pound across six screws. Nothing about it gets warm — the
outlet's own listed housing sheds its heat, and the chargers hang in free air.

Keep it out of a hot car or direct sun before it's installed, and snug the
screws rather than torquing them — PLA is more brittle than PETG and will crack
around a countersink if you lean on the driver.

Rough estimate: **~170–190 g and 7–10 hours** on a P2S. That is an estimate from
the model volume, not a slicer result — load the STL in Bambu Studio for the
real number.

## Installing

1. **Fit the outlet.** Drop it into the cut-out from the front. Hold it square
   and mark through its own faceplate screw holes. Drill 2.5 mm pilots — they
   land in the thick ribs behind the face, so there is ~20 mm of plastic to bite
   into — and drive the outlet's own screws, or #6 × 3/4" pan heads.
2. **Position it under the bench.** Hold the assembly against the underside and
   mark the six countersunk holes.
3. **Check your screw length against the bench top thickness before drilling.**
   The top plate is 6 mm; a 5/8" (16 mm) #8 flat head leaves ~10 mm going into
   the bench. Measure the top and pick a length that cannot punch through the
   work surface.
4. Drill 3 mm pilots, drive #8 flat-head wood screws **through the 16 mm access
   holes in the bottom plate** — drop the screw down the hole onto the
   countersink, then run it up with the driver. See the note below.
5. Route the cord out the back or through a side notch; the two pairs of slots
   in the bottom plate take zip ties.

### You need a long bit

The box is closed on the bottom, so each top-plate screw has a **16 mm access
hole punched straight through the bottom plate below it**. That's big enough to
drop a #8 flat head through (8.6 mm) and then pass a 1/4" magnetic bit holder
(~12 mm) up behind it.

But the screw head sits **67 mm above the bottom face**, so a stubby 2" bit will
not reach. Use a **6" driver bit or a magnetic bit extension** — an $8 part, and
without it you cannot mount this. Mount the empty shell to the bench *first*,
then fit the outlet from the front; with the outlet in place the access holes
are still open but there is much less room to work.

## Fixture cut template

`stl/fixture-cut-template.stl` — for cutting the outlet into a store fixture
rather than mounting it under a bench. **223.5 × 90.7 × 3 mm**, prints flat in
about 1.5–2 hours. Use a brim; a thin plate this long will curl at the corners
otherwise, and a warped template is a useless template.

| | |
| --- | --- |
| Opening | 183.5 × 50.7 mm (7.226 × 1.997 in) |
| Corner radius | R3.17, for a **1/4"** bit |
| Faceplate then covers | 13.4 mm at the ends, 5.1 mm top and bottom |

**How to use it**

1. Mark your centreline and your height line on the fixture.
2. Line up the engraved centrelines — they run from a V-notch on each edge in to
   the opening — and clamp or tape it down.
3. Trace the inside of the opening. The engraved rectangle around it shows where
   the faceplate will land, so you can confirm coverage and check for
   obstructions before cutting anything.
4. Drill a **1/4"** hole in each corner, tangent to both traced arcs. The
   corners are already radiused to that bit, so the traced line *is* the
   finished hole.
5. Jigsaw the four straight runs between the corner holes.

**Why 1/4" and not 3/8".** A rounded hole corner has to clear the outlet body's
own corner, and a large radius cuts across it diagonally. With the opening
0.75 mm oversize, a 3/8" corner (R4.76) only clears a body corner of R3 or
larger — which nobody has measured. R3.17 clears anything down to R1. If a
corner still binds, file it: there's 13.4 mm of faceplate covering the ends.

**This is a marking template, not a router template** — no guide-bushing offset,
and 3 mm is far too thin to guide a bit. Trace it, don't rout against it.

**Already cut one?** The opening follows the same rounded-up 7-1/6" reading as
the mount, so it may be looser than it needs to be. If your first cut came out
tighter and the outlet dropped in fine, measure that hole, drop `CUT_CLR` or
`BODY_L` in `src/outlet_mount.py`, and re-run — the template rebuilds from the
same constants.

## Safety

The printed part is **structural only**. The outlet strip's own listed housing
is the electrical enclosure — don't modify it, don't block its vents, and don't
mount this where the cord gets pinched or pulled. If the strip's housing is
damaged, replace the strip; don't print a substitute.

## Rebuilding

```sh
pip install cadquery
python3 src/outlet_mount.py
```
