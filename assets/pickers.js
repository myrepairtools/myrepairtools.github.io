/*
 * pickers.js — the site's week / month dropdown pickers as a shared lib.
 *
 * The canonical date-picker pattern (see CLAUDE.md): the label between a
 * navigator's ‹ › arrows is clickable and drops down a calendar popover —
 * pick a week row (week picker) or a month in a year grid (month picker)
 * instead of arrow-stepping one period at a time. Ported from
 * schedule-admin.html's openWeekPicker / my-schedule.html's openMonthPicker.
 *
 * window.CPRPickers:
 *   week(anchor,  { get, set, maxWeek })
 *     get()  -> Date (the current week's start — Sunday, midnight)
 *     set(d) -> called with the picked week's start Date
 *     maxWeek (optional Date) — weeks after this start are not selectable
 *       (for backward-looking reports whose › arrow stops at this week)
 *   month(anchor, { get, set })
 *     get()  -> Date (first of the displayed month)
 *     set(d) -> called with the first of the picked month
 *
 * One popover at a time; clicking outside closes. z-index 2100 (above modals).
 */
(function (root) {
  'use strict';

  var POP = null;
  function close(){ if (POP) { POP.remove(); POP = null; } }
  function iso(d){ return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function weekStart(d){ var x = new Date(d); x.setDate(x.getDate() - x.getDay()); x.setHours(0, 0, 0, 0); return x; }
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var MONL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var BLUE_16 = 'rgba(79,176,227,.16)', BLUE_09 = 'rgba(79,176,227,.09)', BLUE_55 = 'rgba(79,176,227,.55)';

  function shell(anchor, width){
    close();
    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:2100';
    back.onclick = close;
    var pop = document.createElement('div');
    pop.style.cssText = 'position:fixed;z-index:2101;width:' + width + 'px;background:#fff;border:1px solid #E0E2EA;border-radius:11px;box-shadow:0 14px 34px rgba(45,45,59,.18);padding:9px';
    document.body.appendChild(back); document.body.appendChild(pop);
    POP = { remove: function(){ back.remove(); pop.remove(); } };
    var r = anchor.getBoundingClientRect(), vw = window.innerWidth;
    pop.style.left = Math.max(10, Math.min(r.left, vw - width - 10)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    return pop;
  }
  var NAVB = 'border:1px solid #E0E2EA;background:#fff;border-radius:7px;width:28px;height:28px;cursor:pointer;font-weight:800;font-size:15px;color:#4E4E50;line-height:1';

  /* ---- week picker: month calendar, click a week row ---- */
  function week(anchor, opts){
    var get = opts.get, set = opts.set;
    var maxWk = opts.maxWeek ? iso(weekStart(opts.maxWeek)) : null;
    var pop = shell(anchor, 272);
    var pickM = new Date(get().getFullYear(), get().getMonth(), 1);
    function draw(){
      var Y = pickM.getFullYear(), M = pickM.getMonth();
      var selWk = iso(weekStart(get())), todayISO = iso(new Date());
      var start = new Date(Y, M, 1); start.setDate(start.getDate() - start.getDay());
      var cur = new Date(start), rows = '';
      for (var w = 0; w < 6; w++){
        var rowStart = new Date(cur), inMonth = false, cells = '';
        for (var i = 0; i < 7; i++){
          var isM = (cur.getMonth() === M); if (isM) inMonth = true;
          var isToday = iso(cur) === todayISO;
          cells += '<td style="text-align:center;padding:5px 0;font-family:\'Nunito Sans\',sans-serif;font-weight:' + (isM ? 800 : 600) + ';font-size:.72rem;color:' + (isToday ? '#DC282E' : (isM ? '#2D2D3B' : '#C7CAD4')) + '">' + cur.getDate() + (isToday ? '<div style="height:2px;width:12px;background:#DC282E;border-radius:2px;margin:1px auto 0"></div>' : '') + '</td>';
          cur.setDate(cur.getDate() + 1);
        }
        if (w > 0 && !inMonth) break;
        var rs = iso(rowStart), isSel = rs === selWk, blocked = maxWk && rs > maxWk;
        rows += '<tr class="cprwkrow" data-pwk="' + (blocked ? '' : rs) + '" style="' + (blocked ? 'opacity:.35;cursor:default' : 'cursor:pointer') + (isSel ? ';background:' + BLUE_16 + ';box-shadow:inset 0 0 0 1.5px ' + BLUE_55 : '') + '">' + cells + '</tr>';
      }
      pop.innerHTML = '<div style="display:flex;align-items:center;gap:6px;padding:1px 1px 8px">'
        + '<button data-cpm="-1" style="' + NAVB + '">‹</button>'
        + '<div style="flex:1;text-align:center;font-family:\'Nunito\',sans-serif;font-weight:900;font-size:.85rem">' + MONL[M] + ' ' + Y + '</div>'
        + '<button data-cpm="1" style="' + NAVB + '">›</button></div>'
        + '<table style="width:100%;border-collapse:separate;border-spacing:0 2px"><thead><tr>' + DAYS.map(function(d){ return '<th style="text-align:center;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.55rem;color:#B9BDCB;padding-bottom:3px">' + d[0] + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>'
        + '<button data-cjump style="width:100%;margin-top:7px;padding:7px;border:1px solid #E0E2EA;border-radius:8px;background:#fff;cursor:pointer;font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.74rem;color:#4E4E50">↩ Jump to this week</button>';
      pop.querySelectorAll('.cprwkrow').forEach(function(tr){
        var rs = tr.getAttribute('data-pwk'); if (!rs) return;
        if (rs !== selWk){ tr.onmouseenter = function(){ tr.style.background = BLUE_09; }; tr.onmouseleave = function(){ tr.style.background = ''; }; }
        tr.onclick = function(){ var p = rs.split('-').map(Number); close(); set(new Date(p[0], p[1] - 1, p[2])); };
      });
      pop.querySelectorAll('[data-cpm]').forEach(function(b){ b.onclick = function(ev){ ev.stopPropagation(); pickM = new Date(pickM.getFullYear(), pickM.getMonth() + Number(b.getAttribute('data-cpm')), 1); draw(); }; });
      var jb = pop.querySelector('[data-cjump]'); if (jb) jb.onclick = function(){ close(); set(weekStart(new Date())); };
    }
    draw();
  }

  /* ---- month picker: year pager + month grid ---- */
  function month(anchor, opts){
    var get = opts.get, set = opts.set;
    var pop = shell(anchor, 252);
    var year = get().getFullYear();
    function draw(){
      var selY = get().getFullYear(), selM = get().getMonth();
      var grid = MON.map(function(mn, i){
        var on = (year === selY && i === selM);
        return '<button data-cmo="' + i + '" style="padding:9px 0;border:1px solid ' + (on ? '#4FB0E3' : 'transparent') + ';border-radius:8px;background:' + (on ? 'rgba(79,176,227,.14)' : 'transparent') + ';color:' + (on ? '#1E7AA8' : '#2D2D3B') + ';font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.76rem;cursor:pointer">' + mn + '</button>';
      }).join('');
      pop.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><button data-cpy="-1" style="' + NAVB + '">‹</button><div style="flex:1;text-align:center;font-family:\'Nunito\',sans-serif;font-weight:900;font-size:.9rem">' + year + '</div><button data-cpy="1" style="' + NAVB + '">›</button></div>'
        + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px">' + grid + '</div>';
      pop.querySelectorAll('[data-cpy]').forEach(function(b){ b.onclick = function(ev){ ev.stopPropagation(); year += Number(b.getAttribute('data-cpy')); draw(); }; });
      pop.querySelectorAll('[data-cmo]').forEach(function(b){ b.onclick = function(){ close(); set(new Date(year, Number(b.getAttribute('data-cmo')), 1)); }; });
    }
    draw();
  }

  /* ---- year picker: 12-year grid with ‹ › paging ---- */
  function year(anchor, opts){
    var get = opts.get, set = opts.set;                       // get() -> number, set(y)
    var min = opts.min || 2000, max = opts.max || 2099;       // selectable range clamps
    var pop = shell(anchor, 252);
    var base = Math.floor(get() / 12) * 12;                   // page start (12 per page)
    function draw(){
      var sel = get(), now = new Date().getFullYear();
      var grid = '';
      for (var y = base; y < base + 12; y++){
        var on = y === sel, blocked = y < min || y > max;
        grid += '<button data-cyr="' + (blocked ? '' : y) + '" style="padding:9px 0;border:1px solid ' + (on ? '#4FB0E3' : 'transparent') + ';border-radius:8px;background:' + (on ? 'rgba(79,176,227,.14)' : 'transparent') + ';color:' + (blocked ? '#C7CAD4' : (on ? '#1E7AA8' : (y === now ? '#DC282E' : '#2D2D3B'))) + ';font-family:\'Nunito\',sans-serif;font-weight:800;font-size:.76rem;cursor:' + (blocked ? 'default' : 'pointer') + '">' + y + '</button>';
      }
      pop.innerHTML = '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px"><button data-cpy="-12" style="' + NAVB + '">‹</button><div style="flex:1;text-align:center;font-family:\'Nunito\',sans-serif;font-weight:900;font-size:.9rem">' + base + '–' + (base + 11) + '</div><button data-cpy="12" style="' + NAVB + '">›</button></div>'
        + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px">' + grid + '</div>';
      pop.querySelectorAll('[data-cpy]').forEach(function(b){ b.onclick = function(ev){ ev.stopPropagation(); base += Number(b.getAttribute('data-cpy')); draw(); }; });
      pop.querySelectorAll('[data-cyr]').forEach(function(b){ var y = b.getAttribute('data-cyr'); if (!y) return; b.onclick = function(){ close(); set(Number(y)); }; });
    }
    draw();
  }

  root.CPRPickers = { week: week, month: month, year: year, close: close };
})(typeof window !== 'undefined' ? window : this);
