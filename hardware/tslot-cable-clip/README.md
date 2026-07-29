# T-Slot Cable Clip — TBK 801 bench

Snap-in cable anchor for the bench frame's aluminium T-slot. Pushes in anywhere
along the slot: no access to an open end, no disassembly.

**Print ONE first and test the fit** before running a batch. ~2.8 g, ~10 min.

| | |
| --- | --- |
| Slot it fits | 8.49 mm opening, 10 mm deep, cavity behind |
| Head | 24 × 30 × 3 mm |
| Stem | 8.0 × 26 mm, 7 mm into the slot |
| Catch spread | 10.8 mm — 1.16 mm behind the lip per side |
| Tie slots | 2 × (4 × 9 mm), 15 mm apart |
| Insertion force | ~5.4 N, 0.78 % peak strain |

## How it works

Two leaf springs run **lengthwise inside the slot**. That's the whole trick: the
slot is only 10 mm deep, so a spring working in the depth direction would be
~5 mm long, far too stiff — it would need ~32 N and 4.9 % strain to deflect,
and snap. Running the leaves along the slot gives 22 mm of free length instead,
which drops it to 5.4 N and 0.78 %. PETG yields around 4–5 %.

A drop-in T-nut was the other option and doesn't work here: a plate long enough
to catch an 8.49 mm opening can't be tilted upright inside a cavity this
shallow, and sliding one in needs an open end.

## The one dimension I don't have

**Lip thickness** — how far in the slot widens. So the catch is a **chevron**,
not a step: it ramps out to full height at 4 mm deep, then falls away again. The
lower ramp wedges against the inside of the lip, so it self-adjusts to anything
from roughly 1.5 to 4 mm instead of needing the number measured.

If your first one is loose, raise `BUMP`. If it won't seat, lower `BUMP_Z0`.
Either is a one-line change and a 10-minute reprint.

## Material

**PETG.** The leaves are a snap feature and PLA is brittle at the root — it
survives the first insertion and cracks on the third. PETG also takes a
permanent set less readily if a clip sits loaded for months.

## Printing

Print as exported: head flat on the bed, stem up. **No supports.** This
orientation matters — it puts the leaves' bending stress *along* the layers
rather than across them, which is the difference between a spring and a part
that shears off at the root.

0.2 mm layers, 4 walls, 30 % infill.

## Fitting

Push it into the slot until the head sits flat. Route cables against the head
and zip-tie through the two slots.

## Rebuilding

```sh
pip install cadquery
python3 src/tslot_clip.py
```
