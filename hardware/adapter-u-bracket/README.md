# Adapter U-Bracket

Two of these hold a Dell 90 W power adapter under a bench. The adapter sits in
the U, the bench underside closes the top, and each bracket screws up through
its two flanges.

**Print one file twice.**

| | |
| --- | --- |
| Opening | 53.00 W × 33.75 H mm |
| Adapter it fits | 52.00 × 33.25 mm |
| Bracket overall | 95.00 W × 38.75 H × 25 mm deep |
| Screw spacing | 79.00 mm, 2 per bracket |
| Cable-tie slots | 2 × (4 × 8 mm), 14 mm apart, 10 mm web |
| Hangs below the bench | 38.75 mm |
| Each bracket | ~16 g, ~30 min |

## Clearance — read this before printing

The opening is **0.5 mm per side wider** than the 52 × 33.25 you gave me,
because those are the adapter's own measurements. A 52.00 mm opening will not
accept a 52.00 mm adapter.

If 52 × 33.25 was already the opening you wanted rather than the brick itself,
set `CLR_W` and `CLR_H` to 0 in `src/u_bracket.py` and re-run.

## Cable-tie slots

Two slots through the bottom of the U with a 10 mm web between them. The tie
drops through one slot, crosses the web, comes back up the other, and cinches
around a cable running underneath.

**The crossing is recessed 2 mm into the inside face**, so the tie lies below
the adapter's seating surface. Without that, the tie would sit proud on the
floor of the U and the adapter would rock on it — the opening only has 0.5 mm
of clearance to give. That leaves 3 mm of bottom wall under the channel.

Walls went from 4 mm to 5 mm and the band from 20 mm to 25 mm to carry the
slots without weakening the bottom.

## Material: PETG

A 90 W adapter under load runs 50–60 °C on its case, which is right at PLA's
softening point. The bracket is in direct contact with it and sits in dead air
under a bench. Use PETG here. This is the one part in this repo where PLA is
the wrong answer.

The U is open at both ends and along its whole length between the two
brackets, so the adapter can still shed heat.

## Printing

Lay flat as exported — the cross-section sits on the bed, so every face is a
vertical wall. **No supports.** 0.2 mm layers, 4 walls, 20 % infill.

## Fitting

1. Position the two brackets along the adapter — roughly 1/4 and 3/4 of its
   128 mm length, clear of both cable exits.
2. Hold them to the bench underside, mark the four holes, drill 3 mm pilots.
3. **Check screw length against the bench top thickness** before driving. #8
   pan head, long enough to bite but not to punch through the work surface.
4. If the adapter is a loose rattle, a strip of adhesive foam on the inside of
   the U takes up the slack.

## Rebuilding

```sh
pip install cadquery
python3 src/u_bracket.py
```
