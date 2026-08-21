#!/usr/bin/env python3
"""Font migration: Nunito -> system stack, weights rebalanced. v2

WHAT IT DOES

1. font-family values that mention Nunito become var(--font-sans).
   The value is matched as a real comma-separated font list (quoted or bare
   names), so the match ends where the list ends. That is what stops it
   swallowing the closing quote of style="..." or of a JS string — the v1
   character-class approach either missed single-quoted names entirely or ran
   past the terminator.

2. SVG presentation attributes (font-family="Nunito") are removed rather than
   rewritten: SVG <text> inherits font-family from the page, and an attribute
   is not CSS so var() is not dependable there.

3. Weights step down one notch, because the system stack renders heavier than
   Nunito at the same number:
       normal text   900->700   800->600   700->500
   EXCEPT in label/badge rules, which the handoff says keep their weight
   because they carry meaning through weight rather than size. Those clamp to
   the handoff's target instead of stepping:
       labels/badges 900->700   800->700   700 unchanged
   A rule counts as label/badge if it sets text-transform:uppercase or its
   selector names one (chip, pill, badge, tag, fldl, lbl, eyebrow, ownertag).

The uppercase/selector test runs per innermost {...} block, which is exactly
one CSS rule — @media wrappers contain rules, so the innermost block is always
a declaration list. Inline style="" attributes and weights inside JS-built HTML
get the same test over a local window of text.

NOT idempotent for weights — a second pass would step 700->500 again. The
guard below skips any file already migrated; restore from backup if you need
to re-run one.
"""
import re
import sys

STACK = "var(--font-sans)"
STEP = {"900": "700", "800": "600", "700": "500"}
CLAMP = {"900": "700", "800": "700", "700": "700"}

# allows \'Nunito\' — CSS built inside JS strings escapes its quotes
NAME = r"""(?:\\?'[^']*\\?'|\\?"[^"]*\\?"|[A-Za-z0-9\-_ ]+)"""
FAMILY = re.compile(
    rf"font-family\s*:\s*(?P<val>{NAME}(?:\s*,\s*{NAME})*)", re.IGNORECASE)
SVG_ATTR = re.compile(r"""\s+font-family\s*=\s*(['"])[^'"]*Nunito[^'"]*\1""", re.IGNORECASE)
WEIGHT = re.compile(r"(font-weight\s*:\s*)(900|800|700)\b", re.IGNORECASE)
RULE = re.compile(r"(?P<sel>[^{}]*)(?P<body>\{[^{}]*\})", re.DOTALL)
STYLE_TAG = re.compile(r"<style\b[^>]*>.*?</style>", re.DOTALL | re.IGNORECASE)
STYLE_ATTR = re.compile(r"""style\s*=\s*"[^"]*\"""", re.IGNORECASE)
BADGEY = re.compile(r"(chip|pill|badge|\btag\b|fldl|\blbl\b|eyebrow|ownertag|\.lab\b)", re.IGNORECASE)


def is_label(sel: str, body: str) -> bool:
    return "uppercase" in body.lower() or bool(BADGEY.search(sel))


def remap(text: str, table) -> str:
    return WEIGHT.sub(lambda m: m.group(1) + table[m.group(2)], text)


def fix_families(text: str) -> tuple[str, int]:
    n = 0

    def sub(m):
        nonlocal n
        if "nunito" not in m.group("val").lower():
            return m.group(0)
        n += 1
        return "font-family:" + STACK
    return FAMILY.sub(sub, text), n


def fix_rules(css: str) -> str:
    def sub(m):
        sel, body = m.group("sel"), m.group("body")
        return sel + remap(body, CLAMP if is_label(sel, body) else STEP)
    return RULE.sub(sub, css)


def migrate(src: str, is_css: bool):
    out, nfam = fix_families(src)
    out, nsvg = SVG_ATTR.subn("", out)
    before = len(WEIGHT.findall(out))

    if is_css:
        out = fix_rules(out)
    else:
        # Segment the document so every weight is touched EXACTLY once. Running
        # the <style> pass and then a document-wide pass double-maps: 900->700
        # inside the stylesheet, then that 700->500 on the second sweep, which
        # is how h1 landed on 500 instead of the 700 the handoff asks for.
        parts, pos = [], 0
        for m in STYLE_TAG.finditer(out):
            parts.append(("other", out[pos:m.start()]))
            parts.append(("style", m.group(0)))
            pos = m.end()
        parts.append(("other", out[pos:]))

        def do_other(text: str) -> str:
            text = STYLE_ATTR.sub(
                lambda m: remap(m.group(0), CLAMP if is_label("", m.group(0)) else STEP), text)

            # weights inside JS-built HTML — judge by a local window so a badge
            # assembled in JS still keeps its weight
            def loose(m):
                w = text[max(0, m.start() - 160):m.end() + 160]
                if "style=\"" in w and m.group(0) in STYLE_ATTR.sub("", text):
                    pass
                return m.group(1) + (CLAMP if is_label(w, w) else STEP)[m.group(2)]
            # only the weights the style-attr pass did not already rewrite
            spans = [(a.start(), a.end()) for a in STYLE_ATTR.finditer(text)]

            def outside(m):
                return not any(s <= m.start() < e for s, e in spans)
            res, last = [], 0
            for m in WEIGHT.finditer(text):
                if not outside(m):
                    continue
                res.append(text[last:m.start()])
                res.append(loose(m))
                last = m.end()
            res.append(text[last:])
            return "".join(res)

        out = "".join(fix_rules(t) if kind == "style" else do_other(t) for kind, t in parts)

    changed_w = before - len(WEIGHT.findall(out))
    return out, nfam, nsvg, changed_w


def main(paths):
    tf = ts = tw = 0
    for p in paths:
        src = open(p, encoding="utf-8").read()
        if "--font-sans" in src and not re.search("nunito", src, re.I):
            print(f"  {p:<40} already migrated, skipped")
            continue
        new, nf, ns, nw = migrate(src, p.endswith(".css"))
        if new != src:
            open(p, "w", encoding="utf-8").write(new)
        left = len(re.findall("nunito", new, re.IGNORECASE))
        flag = f"  <-- {left} NUNITO LEFT" if left else ""
        print(f"  {p:<40} fam:{nf:<4} svg:{ns:<3} wt:{nw:<5}{flag}")
        tf += nf; ts += ns; tw += nw
    print(f"\n  totals: {tf} font-family, {ts} svg attrs, {tw} weights changed")


if __name__ == "__main__":
    main(sys.argv[1:])
