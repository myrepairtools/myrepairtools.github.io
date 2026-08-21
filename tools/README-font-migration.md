# Font migration — status and how to continue

Replacing Nunito / Nunito Sans with the platform UI font stack (Tailwind's
`font-sans`, the same one RepairQ v2 runs). Typography only — no colour,
spacing, layout or component changes.

**Branch:** `claude/elegant-darwin-7nh077` · **Commit:** `cfcd42e`
Rebased onto `main` @ `481c7bd`. Not merged, not deployed.

---

## Done (1 of 3)

| | |
|---|---|
| `assets/fonts.css` | Defines `--font-sans`, sets it on `body` with both smoothing declarations |
| `packages/design-system/styles.css` | Remote Google Fonts `@import` removed; `--mrt-font-head/body` alias `--font-sans` |
| All 16 shared assets | nav, pin-gate, pickers, square-pay, markup-editor, comms, kiosk, assistant, … |
| `receipts.html` | Pilot page |

105 font-family declarations, 79 weights, 3 SVG attributes.

## Not done (2 and 3)

The other **58 root pages**. Run `tools/font-migrate.py` over them in batches.

---

## The one rule that matters

**Do not delete `assets/fonts/*.woff2` or the `@font-face` blocks until the
last page is migrated.**

They are deliberately kept, marked TEMPORARY at the bottom of `assets/fonts.css`.
The 58 unconverted pages still say `font-family:'Nunito'`; drop the faces before
converting them and those pages fall back to the browser default — the
Times-on-iPhone bug the files were vendored to fix in the first place. Migrated
pages use `var(--font-sans)` and never touch them.

Final step of the migration, once `grep -ri nunito` is clean apart from
`fonts.css`'s own comment: delete everything below the TEMPORARY marker plus the
four woff2 files.

---

## Running it

```bash
python3 tools/font-migrate.py page-one.html page-two.html …
```

What it does, and why it is not a `sed`:

- **font-family** values mentioning Nunito become `var(--font-sans)`. The value
  is matched as a real comma-separated font list, so the match ends where the
  list ends — that is what stops it eating the closing quote of `style="…"` or
  of a JS string. It also handles `\'Nunito\'`, the escaped form used by CSS
  built inside JS strings.
- **SVG `font-family="Nunito"` attributes** are removed, not rewritten: SVG
  `<text>` inherits from the page and an attribute is not CSS, so `var()` is not
  dependable there.
- **Weights step down** — the system stack is heavier than Nunito at the same
  number: `900→700`, `800→600`, `700→500`.
- **Labels and badges are exempt** and clamp to 700 instead of stepping, because
  they carry meaning through weight rather than size. A rule counts as one if it
  sets `text-transform:uppercase` or its selector names one (chip, pill, badge,
  tag, fldl, lbl, eyebrow, ownertag).

**It is NOT idempotent for weights** — a second pass would step 700→500 again.
There is a guard that skips already-migrated files, but if you need to re-run
one, restore it from git first.

## Verifying a batch

```bash
grep -ri nunito <files>                      # expect nothing
for f in <changed .js>; do node --check $f; done
python3 -c "s=open('page.html').read(); print(s.count('{')==s.count('}'))"
```

Then render at least one page per batch — static checks do not catch layout:

```bash
python3 -m http.server 8239          # from the repo root
node tools/shot-page.mjs page.html out.png owner 1280
```

It signs in as a real user, reports page errors, lists any font requests
(expect **none**), and tallies computed font families (expect `ui-sans-serif`,
no `Nunito`).

## Things the rendering check caught that static edits did not

- **The top-bar wordmark clipped its final "s".** The stack is wider than
  Nunito, so the SVG text overflowed its viewBox. It now carries
  `textLength="228" lengthAdjust="spacingAndGlyphs"`. This is the right fix
  rather than a smaller font-size: the type is per-platform now, so no fixed
  size is safe on every OS.
- **The wordmark is the one place this is a brand shift**, not a UI one — it
  renders in each platform's UI font. If that ever matters the fix is a real
  SVG path or an image, not a webfont.
- Pages still compute some elements to `Arial` (~10 per page). That is a
  pre-existing stack elsewhere, not a regression from this work.

## Bugs found while piloting (do not reintroduce)

Piloting on one page before the other 83 caught three transform bugs:

1. The first font-family pattern matched **nothing** — it stopped at the opening
   quote and reported success while changing no families.
2. `h1` landed on **500 instead of 700**: the `<style>` pass and a document-wide
   pass both ran, double-stepping 900→700→500. The file is now segmented so each
   weight is touched exactly once.
3. Status pills were **lightened to 600** — the label/badge exemption did not
   cover selectors that were not uppercase.
