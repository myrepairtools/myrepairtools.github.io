/* onboarding-track.js — the ONE implementation of the onboarding track:
 * merge a module's articles + task steps, group by section, order canonically,
 * and compute sequential unlock. knowledge.html (Setup preview), training.html
 * (employee track) and kb-compliance.html (per-person panel) all render from
 * this — surfaces must never fork the merge/order/unlock math.
 *
 * window.CPRTrack.build(data) -> [{mod, items, rows, done, total, complete,
 *   lockedModule, states, sections:{id:{done,total}}, due, pastDue}]
 *
 * data = {
 *   modules:      active onboarding_modules rows (sorted by .sort),
 *   sections:     onboarding_sections rows (all modules),
 *   articles:     kb_articles rows to consider (published for live surfaces;
 *                 Setup passes drafts too),
 *   steps:        active onboarding_steps rows,
 *   assignments:  onboarding_assignments rows for ONE person (module_id, due_at)
 *                 — pass null/undefined for the legacy everyone-sees-all track,
 *   reads:        {articleId: kb_reads row} for that person,
 *   quizzes:      {articleId: {id, pass_pct, nq}} active quizzes,
 *   attempts:     {quizId: {best, passed}} that person's attempts,
 *   stepDone:     {stepId: onboarding_step_done row} for that person,
 *   today:        'YYYY-MM-DD' (optional; for pastDue),
 * }
 *
 * Row list per module (`rows`) interleaves section headers with items:
 *   {type:'section', sec, done, total}   — presentation only
 *   {type:'item', it, state:'done'|'next'|'lock'}
 * Sequential unlock is GLOBAL across assigned modules and ignores section
 * boundaries (sections are presentation only). Nothing locks on past-due.
 */
(function (root) {
  /* canonical order for mixed module items: sort, then articles before steps,
     then numeric id — IDENTICAL everywhere. Section grouping wraps around this:
     an item belongs to a section (section_id) or module level (null); the row
     order is: module-level+section blocks interleaved by each block's minimum
     item sort, section header first inside its block. */
  function itemCmp(x, y) {
    return (x.sort - y.sort)
      || (x.kind === y.kind ? 0 : (x.kind === 'a' ? -1 : 1))
      || (x.kind === 'a' ? (x.a.id - y.a.id) : (x.s.id - y.s.id));
  }

  function build(d) {
    var modules = d.modules || [];
    var sections = d.sections || [];
    var articles = d.articles || [];
    var steps = d.steps || [];
    var reads = d.reads || {};
    var quizzes = d.quizzes || {};
    var attempts = d.attempts || {};
    var stepDone = d.stepDone || {};
    var assigned = null, dueBy = {};
    if (Array.isArray(d.assignments)) {
      assigned = {};
      d.assignments.forEach(function (a) {
        if (a.module_id != null) { assigned[a.module_id] = true; if (a.due_at) dueBy[a.module_id] = a.due_at; }
      });
    }
    var today = d.today || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

    function articleDone(a) {
      var r = reads[a.id], q = quizzes[a.id];
      var ok = !!(r && r.acknowledged_at);
      return ok && (!q || !q.nq || (attempts[q.id] && attempts[q.id].passed));
    }
    function itemDone(it) { return it.kind === 'a' ? articleDone(it.a) : !!stepDone[it.s.id]; }

    var mods = modules
      .filter(function (m) { return assigned ? assigned[m.id] : true; })
      .map(function (mod) {
        var items = articles.filter(function (a) { return a.module_id === mod.id; })
          .map(function (a) { return { kind: 'a', a: a, sort: a.sort_order || 0, sec: a.section_id || null, id: 'a' + a.id }; })
          .concat(steps.filter(function (s) { return s.module_id === mod.id; })
            .map(function (s) { return { kind: 's', s: s, sort: s.sort_order || 0, sec: s.section_id || null, id: 's' + s.id }; }))
          .sort(itemCmp);
        return { mod: mod, items: items };
      })
      .filter(function (x) { return x.items.length; });

    var nextFound = false;
    mods.forEach(function (mx, mi) {
      mx.done = mx.items.filter(itemDone).length;
      mx.total = mx.items.length;
      mx.quizzes = mx.items.filter(function (it) { return it.kind === 'a' && quizzes[it.a.id] && quizzes[it.a.id].nq; }).length;
      mx.states = mx.items.map(function (it) {
        if (itemDone(it)) return 'done';
        if (!nextFound) { nextFound = true; return 'next'; }
        return 'lock';
      });
      mx.complete = mx.done === mx.total;
      mx.lockedModule = mi > 0 && !mods.slice(0, mi).every(function (p) { return p.complete; }) && mx.done === 0;
      mx.due = dueBy[mx.mod.id] || null;
      mx.pastDue = !!(mx.due && !mx.complete && String(mx.due).slice(0, 10) < today);

      /* section grouping: blocks of (module-level items) and (sections), each
         block anchored at its minimum item sort so authored interleave holds */
      var modSecs = sections.filter(function (s) { return s.module_id === mx.mod.id && s.active !== false; });
      var blocks = [];
      var loose = mx.items.map(function (it, i) { return { it: it, i: i }; }).filter(function (x) { return !x.it.sec; });
      if (loose.length) loose.forEach(function (x) { blocks.push({ anchor: x.it.sort, order2: x.i, rows: [{ type: 'item', it: x.it, idx: x.i }] }); });
      modSecs.forEach(function (sec) {
        var inSec = mx.items.map(function (it, i) { return { it: it, i: i }; }).filter(function (x) { return x.it.sec === sec.id; });
        if (!inSec.length) return;
        var anchor = Math.min.apply(null, inSec.map(function (x) { return x.it.sort; }));
        var rows = [{ type: 'section', sec: sec, done: inSec.filter(function (x) { return itemDone(x.it); }).length, total: inSec.length }]
          .concat(inSec.map(function (x) { return { type: 'item', it: x.it, idx: x.i }; }));
        blocks.push({ anchor: anchor, order2: inSec[0].i, rows: rows });
      });
      blocks.sort(function (a, b) { return (a.anchor - b.anchor) || (a.order2 - b.order2); });
      mx.rows = [];
      blocks.forEach(function (b) {
        b.rows.forEach(function (r) {
          if (r.type === 'item') r.state = mx.states[r.idx];
          mx.rows.push(r);
        });
      });
    });
    return mods;
  }

  function outstanding(mods) {
    return (mods || []).reduce(function (n, mx) { return n + (mx.total - mx.done); }, 0);
  }

  root.CPRTrack = { build: build, outstanding: outstanding, itemCmp: itemCmp };
})(typeof window !== 'undefined' ? window : this);
