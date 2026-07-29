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
| Cable-tie loop | hangs 8 mm below, 6 × 5 mm opening, 18 mm tunnel |
| Hangs below the bench | 46.75 mm |
| Each bracket | ~17 g, ~30 min |

## Clearance — read this before printing

The opening is **0.5 mm per side wider** than the 52 × 33.25 you gave me,
because those are the adapter's own measurements. A 52.00 mm opening will not
accept a 52.00 mm adapter.

If 52 × 33.25 was already the opening you wanted rather than the brick itself,
set `CLR_W` and `CLR_H` to 0 in `src/u_bracket.py` and re-run.

## Cable-tie loop

A closed loop hangs **8 mm below the floor** of the U, with a 6 × 5 mm opening
and an 18 mm tunnel running across the bracket.

It hangs below rather than passing through the floor because slots in the
floor would have to be threaded blind — from underneath, with the adapter
already in the U and the bracket already screwed to the bench. The loop is
reachable with everything installed.

It also keeps the floor of the U completely flat. A tie crossing the inside
would sit proud of the seating surface and rock the adapter, and the opening
only carries 0.5 mm of clearance to absorb that.

The tunnel runs **across** the bracket so a tie threaded through it wraps
naturally around a cable running lengthwise underneath.

Walls are 5 mm and the band 25 mm — the floor is what the loop hangs off, so
it carries the cable tension.

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
