/* assets/locations.js — canonical store list for all CPR Oregon internal tools.
 *
 * ONE source of truth for: store names, short display labels, and display order.
 * Used by: cash-tracker, cash-admin, employee-records, claim-ledger, commission-calculator.
 *
 * IMPORTANT: `name` must match EXACTLY what RepairQ exports and what the Auth /
 * Setup sheets store, or store-matching breaks. To add, remove, or rename a store,
 * edit ONLY this file. `aliases` catches older / shorter spellings seen in data so
 * they still resolve to the right store.
 */
(function (global) {
  var STORES = [
    { name: 'CPR Eugene',          display: 'Eugene',          order: 1, aliases: ['Eugene'] },
    { name: 'CPR Salem Northeast', display: 'Salem Northeast', order: 2, aliases: ['Salem', 'Salem NE', 'CPR Salem', 'CPR Salem NE'] },
    { name: 'CPR Clackamas OR',    display: 'Clackamas',       order: 3, aliases: ['Clackamas', 'CPR Clackamas'] }
  ];

  function byOrder(a, b) { return a.order - b.order; }

  // Full canonical store records, in display order.
  function list() { return STORES.slice().sort(byOrder); }

  // Canonical full names, in display order: ['CPR Eugene', ...].
  function names() { return list().map(function (s) { return s.name; }); }

  // Resolve any raw string (canonical name, display label, or alias) to a record.
  function find(raw) {
    if (!raw) return null;
    var q = String(raw).trim().toLowerCase();
    for (var i = 0; i < STORES.length; i++) {
      var s = STORES[i];
      if (s.name.toLowerCase() === q || s.display.toLowerCase() === q) return s;
      var al = s.aliases || [];
      for (var j = 0; j < al.length; j++) if (al[j].toLowerCase() === q) return s;
    }
    return null;
  }

  // Canonical full name for any raw string; returns input unchanged if unknown.
  function normalize(raw) { var s = find(raw); return s ? s.name : (raw || ''); }

  // Short label for tabs / pills. Falls back to stripping "CPR " and trailing " OR".
  function display(raw) {
    var s = find(raw);
    if (s) return s.display;
    return String(raw || '').replace(/^CPR\s+/i, '').replace(/\s+OR$/i, '').trim();
  }

  // Sort a list of raw store strings into canonical order. Unknowns sort last, alpha.
  function sort(rawNames) {
    return (rawNames || []).slice().sort(function (a, b) {
      var sa = find(a), sb = find(b);
      if (sa && sb) return sa.order - sb.order;
      if (sa) return -1;
      if (sb) return 1;
      return String(a).localeCompare(String(b));
    });
  }

  // <option> markup for a <select>; pass the currently-selected raw value (optional).
  function options(selected) {
    var sel = normalize(selected);
    return list().map(function (s) {
      return '<option value="' + s.name + '"' + (s.name === sel ? ' selected' : '') + '>' + s.display + '</option>';
    }).join('');
  }

  global.CPRLocations = {
    list: list, names: names, find: find,
    normalize: normalize, display: display, sort: sort, options: options
  };
})(typeof window !== 'undefined' ? window : this);
