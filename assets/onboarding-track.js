/* ===========================================================================
 * CPR onboarding-track.js — the canonical shape of an onboarding track.
 *
 * Three surfaces render the same track and MUST agree on its order, or an
 * employee's "next" item stops matching what the manager sees:
 *   knowledge.html  #onboarding  (My Onboarding — the employee)
 *   knowledge.html  #modules     (Onboarding Setup — the author)
 *   kb-compliance.html           (the roster / tracking view)
 * kb-compliance used to keep its own copy of this logic; this file replaces it
 * so there is one implementation to change.
 *
 * A module's track = its ARTICLES (kb_articles.module_id) merged with its TASK
 * STEPS (onboarding_steps.module_id), ordered together by sort_order.
 *
 * Sections add a third level. An item with section_id null sits directly under
 * the module, so bare items and sections MIX inside one module and interleave by
 * sort — "Week 1 > How to answer the phone" can sit above the "Important Policy"
 * section. Sections are presentation only: the sequential unlock still walks the
 * flattened order exactly as it did before they existed.
 * ========================================================================= */
(function (root) {
  'use strict';

  /* canonical item ordering: sort_order, then articles before steps, then id */
  function itemCmp(x, y) {
    return (x.sort - y.sort)
      || (x.kind === y.kind ? 0 : (x.kind === 'a' ? -1 : 1))
      || (x.kind === 'a' ? (x.a.id - y.a.id) : (x.s.id - y.s.id));
  }

  /* raw items of a module, flat and ordered (pre-grouping) */
  function itemsFor(modId, arts, steps) {
    var items = (arts || []).filter(function (a) { return a.module_id === modId; })
        .map(function (a) { return { kind: 'a', a: a, sort: a.sort_order || 0, section: a.section_id == null ? null : a.section_id, id: 'a' + a.id }; })
      .concat((steps || []).filter(function (s) { return s.module_id === modId; })
        .map(function (s) { return { kind: 's', s: s, sort: s.sort_order || 0, section: s.section_id == null ? null : s.section_id, id: 's' + s.id }; }));
    return items.sort(itemCmp);
  }

  /* module -> ordered GROUPS. A group is {kind:'item', it} or
     {kind:'section', sec, items[]}. A section sorts by its own `sort` against
     the bare items' sort_order, so the two interleave predictably.
     A section with no items is dropped — an empty header helps nobody. */
  function groupsFor(modId, arts, steps, sections) {
    var items = itemsFor(modId, arts, steps);
    var secs = (sections || []).filter(function (x) { return x.module_id === modId && x.active !== false; });
    var bucket = {};
    secs.forEach(function (x) { bucket[x.id] = []; });
    var groups = [];
    items.forEach(function (it) {
      if (it.section != null && bucket[it.section]) bucket[it.section].push(it);
      else groups.push({ kind: 'item', sort: it.sort, it: it });
    });
    secs.forEach(function (x) {
      if (bucket[x.id].length) groups.push({ kind: 'section', sort: x.sort || 0, sec: x, items: bucket[x.id] });
    });
    groups.sort(function (a, b) {
      return (a.sort - b.sort)
        || (a.kind === b.kind ? 0 : (a.kind === 'item' ? -1 : 1))
        || (a.kind === 'section' ? (a.sec.id - b.sec.id) : 0);
    });
    return groups;
  }

  /* groups -> the flat render/unlock sequence */
  function flatten(groups) {
    var out = [];
    (groups || []).forEach(function (g) {
      if (g.kind === 'item') out.push(g.it);
      else g.items.forEach(function (i) { out.push(i); });
    });
    return out;
  }

  /* Build the full track for one person.
     mods    : onboarding_modules rows, already filtered to what's ASSIGNED
     isDone  : fn(item) -> bool
     Returns [{mod, groups, items, states, done, total, complete, lockedModule}]
     where `states` is parallel to `items` ('done' | 'next' | 'lock').
     Unlock is global and sequential across modules, unchanged by sections. */
  function build(mods, arts, steps, sections, isDone) {
    var out = (mods || []).map(function (mod) {
      var groups = groupsFor(mod.id, arts, steps, sections);
      return { mod: mod, groups: groups, items: flatten(groups) };
    }).filter(function (x) { return x.items.length; });

    var nextFound = false;
    out.forEach(function (mx, mi) {
      mx.done = mx.items.filter(isDone).length;
      mx.total = mx.items.length;
      mx.states = mx.items.map(function (it) {
        if (isDone(it)) return 'done';
        if (!nextFound) { nextFound = true; return 'next'; }
        return 'lock';
      });
      /* state lookup by item id, so a group renderer can find an item's state
         without tracking its flat index */
      mx.stateOf = {};
      mx.items.forEach(function (it, i) { mx.stateOf[it.id] = mx.states[i]; });
      mx.complete = mx.done === mx.total;
      mx.lockedModule = mi > 0 && !out.slice(0, mi).every(function (p) { return p.complete; }) && mx.done === 0;
    });
    return out;
  }

  /* per-section progress, for a section header */
  function sectionProgress(group, isDone) {
    var d = group.items.filter(isDone).length;
    return { done: d, total: group.items.length };
  }

  root.CPROnboarding = {
    itemCmp: itemCmp,
    itemsFor: itemsFor,
    groupsFor: groupsFor,
    flatten: flatten,
    build: build,
    sectionProgress: sectionProgress
  };
})(typeof window !== 'undefined' ? window : this);
