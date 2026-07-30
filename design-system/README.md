# CPR Design System — Claude Design sync bundle

A design-system bundle for [claude.ai/design](https://claude.ai/design). Point Claude Design at
this directory and every future artifact it builds — mockups, new tool pages, marketing
one-offs — inherits the real CPR brand instead of generic defaults.

**Source of truth:** the *2026 CPR Brand Guidelines* brand book (corporate) + the production CSS
already running across `myrepairtools.github.io`. Where the two disagree, both are recorded and
the divergence is labeled — see [Two specs on purpose](#two-specs-on-purpose).

## What's here

Each `.html` file is one self-contained preview card. The first line is a `@dsCard` marker that
tells the Design System pane its group, name, and viewport:

```html
<!-- @dsCard group="Components" name="Buttons" subtitle="…" width="1100" height="720" -->
```

| Group | File | Covers |
|---|---|---|
| Brand | `brand/logo.html` | Lockups, background treatments, exclusion zone, minimum sizes |
| Brand | `brand/logo-misuse.html` | The eight prohibited treatments |
| Brand | `brand/photography.html` | Content direction, the dark-blue filter, text over photo |
| Colors | `color/palette.html` | 7 brand colors (hex / Pantone / CMYK) + web-only state colors |
| Colors | `color/combinations.html` | Approved contrast pairs, palette ratios, white-in-negative |
| Type | `type/typography.html` | Avenir spec, the Nunito web substitution, full UI scale |
| Components | `components/buttons.html` | Web + print buttons, sizes, states, icon buttons |
| Components | `components/forms.html` | Inputs, store selector, currency, combobox, choice controls |
| Components | `components/nav-tabs.html` | Tabs, status pills, chips, count badges |
| Components | `components/cards.html` | Content card, stat tiles, accented month card, list row |
| Components | `components/date-nav.html` | `.cpr-navbox` / `.cpr-navjump` + week/day/month popovers |
| Components | `components/overlays.html` | Confirm modal, bottom sheet, toasts, empty states, inline notes |
| Components | `components/icons.html` | All 44 Lucide glyphs, sizes, tinting rules |
| Patterns | `patterns/page-shell.html` | Desktop frame: rail, top bar, header row, content |
| Patterns | `patterns/mobile.html` | Bottom tab bar, cards-over-tables, safe areas, breakpoints |

Plus:

- **`tokens.css`** — the machine-readable token set (colors, fonts, radii, state washes). This is
  the same block every tool page declares in its own `:root`.
- **`assets/`** — the wide CPR lockup, black and white. The vertical and icon lockups are **not**
  in this repo; drop the corporate files into `assets/images/` before using them anywhere.

## Pushing it to Claude Design

The `DesignSync` tool needs design-system authorization, which is only grantable from an
interactive terminal (`/design-login`) — it can't be done from a Claude Code web session. Two
ways to get this bundle into a Design project:

**From a local terminal (Claude Code CLI):**

```
/design-login          # one time, grants design-system scope
/design-sync           # then point it at design-system/
```

**From Claude Design itself:** create (or open) a design-system project, use *Send to Claude Code
Web*, and sync from there — that seeds the project into the workspace with authorization already
attached.

Either way the flow is `list_files` → `finalize_plan` → `write_files`. Sync **incrementally**,
one component at a time; never wholesale-replace a project that already has content in it.

## Two specs on purpose

Two places where the brand book and the shipping site legitimately differ. Both are recorded on
the relevant card — don't "fix" one to match the other, pick by medium.

| | Brand book (print) | Web build (screen) |
|---|---|---|
| **Type** | Avenir — Book / Medium / Heavy / Black | Nunito (display) + Nunito Sans (body) |
| **Buttons** | Avenir Black, ALL CAPS, 5px radius | Nunito 800, sentence case, 10px radius |

Avenir has no web license here, and caps at `.78rem` is unreadable in a dense tool UI. Print
collateral keeps the book's rule; screens keep the web rule.

## Editing

These are hand-authored static HTML — no build step, matching the rest of the repo. Edit a card
directly. Two things to keep in sync when you do:

- **Tokens** live in three places that must agree: `tokens.css`, the `:root` block inlined in each
  card, and each tool page's own `:root`. Change one, change all.
- **Icons** are generated from `NAV_SVG` in `assets/nav.js` — the icon card lists whatever is
  registered there. Add new glyphs to `nav.js` (from the `lucide-static` package), not here.
