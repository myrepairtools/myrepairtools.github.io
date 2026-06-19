# design-sync notes — @myrepairtools/design-system

This design system was **built from scratch** for the design-sync skill: the
repo (`myrepairtools.github.io`) is a static HTML site with no components, so
`packages/design-system/` is a new React+TS library that extracts the CPR Oregon
brand (10 colors, Nunito/Nunito Sans) and the recurring UI patterns from the
hand-authored HTML tools into 13 real components.

## Build facts
- **Shape:** package. Built with `tsup` → `dist/index.mjs` + `dist/index.d.ts`.
- **Build command:** `npm --prefix packages/design-system run build` (cfg.buildCmd).
- **Converter invocation (from repo root):**
  `--node-modules packages/design-system/node_modules --entry packages/design-system/dist/index.mjs --out ./ds-bundle`
- **CSS:** single source of truth is `packages/design-system/styles.css`
  (cfg.cssEntry). It holds tokens, all `mrt-` component classes, and a remote
  Google Fonts `@import`. The converter copies it into `_ds_bundle.css` and
  makes root `styles.css` `@import` it — tokens live in `_ds_bundle.css`, not
  the root file, when grepping.
- **Styling model:** className-based with semantic props (no CSS modules, no
  CSS-in-JS). Components carry no co-located CSS imports — the stylesheet is the
  only style source.

## Known render warns (triaged legitimate)
- `[FONT_REMOTE]` "Nunito" / "Nunito Sans" — expected. Fonts load at runtime via
  a Google Fonts `@import` in styles.css; no font files ship. This is the same
  way the live HTML tools load them. Not an action item.

## Re-sync risks (what can silently go stale)
- **Fonts are remote.** If the design agent's render environment blocks the
  Google Fonts host, components fall back to system fonts. If that ever matters,
  ship woff2 files via `cfg.extraFonts` instead.
- **The library mirrors the HTML tools by hand.** New brand colors / UI patterns
  added to the HTML tools (e.g. new `.op-pill` tones in cash-admin.html) will NOT
  appear here until a component/prop is added in `packages/design-system/src/`.
  Treat the HTML tools as the design source; this package is a curated subset.
- Preview content (store names Eugene/Salem Northeast/Clackamas, cash amounts)
  is illustrative and inlined in `.design-sync/previews/*.tsx` — purely cosmetic.

## Re-sync procedure
Standard: re-copy `.ds-sync/` scripts, run `cfg.buildCmd`, then
`node .ds-sync/resync.mjs --config .design-sync/config.json --node-modules packages/design-system/node_modules --entry packages/design-system/dist/index.mjs --out ./ds-bundle --remote .design-sync/.cache/remote-sync.json`.
