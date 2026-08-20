# Extension tests

Two node + jsdom harnesses. There is no package manager in this repo and these
do not add one — install jsdom wherever you like and point `NODE_PATH` at it:

```bash
mkdir -p /tmp/mrt-test && cd /tmp/mrt-test && npm install jsdom
NODE_PATH=/tmp/mrt-test/node_modules node extension/test/boot-smoke.test.mjs
NODE_PATH=/tmp/mrt-test/node_modules node extension/test/followup-ownership.test.mjs
```

Both exit non-zero on failure.

**`boot-smoke.test.mjs`** — loads each DOM-coupled content script against a
RepairQ-shaped page and asserts it comes up without throwing. This catches what
`node --check` cannot: a ReferenceError at boot leaves the feature silently dead
with the button looking merely unresponsive, which is what shipped in v2.5.73.

**`followup-ownership.test.mjs`** — boots the real `followUp.js` and asserts what
reaches `contact_set` for four stash-ownership scenarios: a hand-typed number on
its own customer (must flush — staff report #592), another customer's stash (must
be held — #3106), a number already on the record (must still flush), and a
contact-less skip stash from another customer (must be held).

It is a regression test with a **verified control**: run it against
`git show <pre-fix>:extension/scripts/followUp.js` and scenarios 1 and 4 fail,
which is how we know it detects the bug rather than merely agreeing with the
current code.

## Writing more

The mock page must mirror RepairQ's real sidebar — a `.sub-head h3` reading
"Customer" with a sibling `.block-content` carrying a phone — or
`customerAnchor()` finds nothing and boot stalls in `whenSummaryReady`. jsdom
reports `offsetWidth` as 0, which satisfies the ≤480px check for free.

Content scripts are IIFEs, so they are loaded with `new w.Function(...)` and
called with the jsdom window's globals rather than imported.
