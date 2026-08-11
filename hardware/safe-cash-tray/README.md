# Safe Cash Tray

Same idea as the acrylic trays on Amazon — notes stood on edge, leaning back so
every denomination is visible at once — with three changes that matter for us.

![Layout](svg/layout.png)

| | |
| --- | --- |
| File | `stl/safe-cash-tray.stl` |
| Footprint | **162.2 × 165.0 mm** |
| Height | 20 mm front lip rising to 45 mm at the back |
| Slots | 5 × 30 mm — $50s and $100s share the last one |
| Labels | `$1 $5 $10 $20` + a stacked `$50 / $100`, engraved 0.6 mm |
| Material | ~159 cm³, so roughly 185–200 g |

## Check the safe first

**Floor needed: 162 × 165 mm. Height needed: 62 mm.**

That 62 mm is the *standing note*, not the 45 mm wall — a note leans across its
slot, and a US note is 66.3 mm on the short side, so it projects well above the
tray. Measure the inside of the safe against 62 mm, not 45.

Widening the slots is the lever on that number, because a wider slot lets the
note lean flatter: 24 mm slots stood 64 mm, 30 mm slots stand 62, and 40 mm
would stand 55. If the safe is tight on height, that's where to spend width.

I sized this to the print bed and to a real note, since I don't have your safe's
interior dimensions. **Give me interior width, depth and height and I'll resize
it** — the whole tray is derived from a handful of numbers at the top of
`src/cash_tray.py`, so it's a re-run, not a redesign.

## What's different from the Amazon one

**5 slots, not 8.** No coin slots — coin rolls aren't kept in the safe. And
**$50s and $100s share the last one**: neither moves in the volume the small
notes do, and merging them buys a whole slot's width to spread over the rest.
Every slot went from 24 mm to **30 mm** — 25 % more notes each, and the tray is
still narrower than the 8-slot version it started as.

The shared slot's label stacks — `$50` over `$100` — because two denominations
can't sit side by side in 30 mm at a readable size. Label sizing is automatic:
each one shrinks to fit its slot and the front lip, and an assert fails the
build if a label ever drops below 4.5 mm.

If coins ever do need a home, `N_COIN = 2` at the top of the source puts two
28 mm slots back. Nothing else needs touching.

**Denominations engraved in the front lip.** A count gets read off the tray
instead of remembered, which is the whole point when the number ends up in a
cash audit.

**Sized to a note, not to a box.** 160 mm of slot length for a 156 mm note.

## How it's built

The front is cut down on a **slope** — 20 mm at the lip rising to 45 mm over the
front 95 mm. That leans the notes out toward you and gives you something to
pinch. It's an upward-facing surface, so it costs nothing in print time.

A **scallop in each end wall** gives you somewhere to get your fingers to lift
the tray out of the safe. The tray's stiffness under that lift comes from the
front and back walls, not the floor — a full tray of cash deflects well under a
tenth of a millimetre across the span.

## Printing

Prints as exported: **flat on the floor, walls up. No supports, no brim** — the
first layer is a solid 162 × 165 mm rectangle, so adhesion is not going to be
the problem.

0.2 mm layers, 4 walls, 15 % infill (it's nearly all perimeter anyway). PLA+ is
right: it lives in a safe, never gets warm, and stiffness is what you want.

**It's still a long print** at ~159 cm³ — slice it and look at the real number
before you commit. The acrylic one is $20 and arrives in two days, so the case
for printing rests entirely on the two things it can't do: fitting *your* safe
exactly, and carrying the denomination labels.

## Rebuilding

```sh
pip install cadquery
python3 src/cash_tray.py
```

Slot count, widths and labels are all constants at the top of the file.
