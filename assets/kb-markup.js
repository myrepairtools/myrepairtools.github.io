/* kb-markup.js — the ONE renderer for the Knowledge Base's light markup.
 *
 * knowledge.html (reading view), training.html (in-page reader) and
 * intake.html (the candidate handbook accordion) all render the same article
 * bodies, so the parser lives here instead of in three places. The editor in
 * knowledge.html keeps its own markup->editable-HTML pass (it needs
 * contenteditable-shaped output), but it writes the syntax defined here.
 *
 *   # / ## / ### / ####   headings, biggest first
 *   - item  /  1. item    lists; two spaces of indent per sub-level
 *   !> text               callout box — amber by default
 *   !r> !g> !b> text      red / green / blue callouts
 *   !n> text              plain grey box · !d> solid dark-blue box
 *   !#fff|#ddd|#333> text  custom box: fill | outline | text color
 *   | a | b |             tables; a |---|---| row under the first row makes it a header
 *   ---                   divider
 *   **bold** *italic* __underline__ `code` [text](url) ![alt](img)
 *
 * Structural CSS (callout colors, tables, heading scale) is injected here so
 * every surface matches — same pattern pickers.js uses. Pages keep their own
 * .artbody typography.
 *
 * Usage:  el.innerHTML = CPRMarkup.render(article.body, { autolink:true })
 */
(function () {
  if (window.CPRMarkup) return;

  var CSS = ''
    /* callouts: one base, four tints + a plain box */
    + '.callout{display:flex;gap:12px;background:#FDF6E7;border:1.5px solid #F2DFAE;border-radius:10px;padding:13px 16px;margin:12px 0}'
    + '.callout .ci{font-size:1rem;flex:none;line-height:1.4}'
    + '.callout .ct{font-size:.85rem;font-weight:700;color:#7A5A08;line-height:1.55;min-width:0}'
    + '.callout.c-red{background:#FDEBEC;border-color:#F2C4C6}.callout.c-red .ct{color:#93262B}'
    + '.callout.c-green{background:#E6F6EE;border-color:#B7E2CC}.callout.c-green .ct{color:#1B6844}'
    + '.callout.c-blue{background:#EAF6FD;border-color:#BFE2F5}.callout.c-blue .ct{color:#175E82}'
    + '.callout.c-plain{background:#F8F8FA;border-color:#E0E2EA}.callout.c-plain .ct{color:#4E4E50}'
    + '.callout.c-dark{background:#2D2D3B;border-color:#2D2D3B}.callout.c-dark .ct{color:#fff}'
    + '.callout .ct h3,.callout .ct h4,.callout .ct h5,.callout .ct h6{margin:0;color:inherit;font-family:Nunito,sans-serif;font-weight:900}'
    + '.callout .ct h3{font-size:1.05rem}.callout .ct h4{font-size:.95rem}'
    + '.callout .ct h5{font-size:.88rem}.callout .ct h6{font-size:.8rem}'
    /* tables scroll on their own rather than pushing the page sideways */
    + '.mk-tblwrap{overflow-x:auto;margin:12px 0;-webkit-overflow-scrolling:touch}'
    + '.mk-tbl{border-collapse:collapse;width:100%;min-width:340px;font-size:.86rem}'
    + '.mk-tbl th,.mk-tbl td{border:1px solid #E0E2EA;padding:8px 11px;text-align:left;vertical-align:top;line-height:1.5}'
    + '.mk-tbl th{background:#F3F6FA;font-family:Nunito,sans-serif;font-weight:800;color:#2D2D3B;white-space:nowrap}'
    + '.mk-tbl tbody tr:nth-child(even) td{background:#FAFAFB}'
    /* sub-lists: 1. -> a. -> i. so an outline reads like an outline */
    + '.artbody ol ol,.hbbody ol ol{list-style-type:lower-alpha}'
    + '.artbody ol ol ol,.hbbody ol ol ol{list-style-type:lower-roman}'
    + '.artbody ul ul,.hbbody ul ul{list-style-type:circle}'
    + '.artbody li>ul,.artbody li>ol,.hbbody li>ul,.hbbody li>ol{margin:4px 0}';

  function injectCss() {
    if (document.getElementById('cpr-markup-css')) return;
    var s = document.createElement('style');
    s.id = 'cpr-markup-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectCss);
  else injectCss();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* inline marks. Runs on ALREADY-ESCAPED text, so `>` reads as &gt;. */
  function inline(s, opts) {
    s = s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (opts && opts.autolink) {
      s = s.replace(/(^|[\s>])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    }
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/__([^_\n]+)__/g, '<u>$1</u>');
    s = s.replace(/(^|[\s(>])\*([^*\n]+)\*/g, '$1<i>$2</i>');
    return s;
  }

  /* ---- lists: indentation nests them, two spaces (or a tab) per level ---- */
  var LIST_RE = /^([ \t]*)([-•]|\d+[.)])[ \t]+(.*)$/;
  function listBlock(items, inline) {
    var tx = inline || function (t) { return t; };
    var prev = 0;
    items.forEach(function (it, i) {
      var lv = Math.floor(it.indent / 2);
      if (i === 0) lv = 0; else if (lv > prev + 1) lv = prev + 1;
      it.depth = lv; prev = lv;
    });
    var i = 0, html = '';
    function build(depth) {
      var tag = items[i].tag, h = '<' + tag + '>';
      while (i < items.length && items[i].depth === depth && items[i].tag === tag) {
        h += '<li>' + tx(items[i].text);
        i++;
        if (i < items.length && items[i].depth > depth) h += build(items[i].depth);
        h += '</li>';
      }
      return h + '</' + tag + '>';
    }
    while (i < items.length) html += build(items[i].depth);
    return html;
  }

  /* ---- tables: | a | b | rows, optional |---|---| header separator ---- */
  var TABLE_RE = /^\s*\|(.*)\|\s*$/;
  var TSEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;
  function cells(line) {
    var m = TABLE_RE.exec(line);
    return (m ? m[1] : line).split('|').map(function (c) { return c.trim(); });
  }
  function tableBlock(rows) {
    var head = null, body = rows;
    if (rows.length > 1 && TSEP_RE.test(rows[1]) && /-/.test(rows[1])) {
      head = cells(rows[0]);
      body = rows.slice(2);
    }
    var cols = Math.max.apply(null, [head ? head.length : 0].concat(body.map(function (r) { return cells(r).length; })));
    var h = '<div class="mk-tblwrap"><table class="mk-tbl">';
    var pad = function (a) { while (a.length < cols) a.push(''); return a; };
    if (head) {
      h += '<thead><tr>' + pad(head).map(function (c) { return '<th>' + c + '</th>'; }).join('') + '</tr></thead>';
    }
    h += '<tbody>';
    body.forEach(function (r) {
      if (TSEP_RE.test(r) && /-/.test(r)) return;
      h += '<tr>' + pad(cells(r)).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    });
    return h + '</tbody></table></div>';
  }

  /* callout prefixes, longest first so !r> never matches the bare !> rule */
  var CALLOUTS = [
    { re: /^!r&gt;\s+(.*)$/, cls: 'c-red', icon: '⛔' },
    { re: /^!g&gt;\s+(.*)$/, cls: 'c-green', icon: '✅' },
    { re: /^!b&gt;\s+(.*)$/, cls: 'c-blue', icon: 'ℹ️' },
    { re: /^!n&gt;\s+(.*)$/, cls: 'c-plain', icon: '' },
    { re: /^!d&gt;\s+(.*)$/, cls: 'c-dark', icon: '' },
    { re: /^!&gt;\s+(.*)$/, cls: '', icon: '⚠️' }
  ];

  function render(text, opts) {
    opts = opts || {};
    var s = inline(esc(text), opts);
    var lines = s.split('\n');
    var out = '', list = [], tbl = [];
    function flush() {
      if (list.length) { out += listBlock(list); list = []; }
      if (tbl.length) { out += tableBlock(tbl); tbl = []; }
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], m = null, hit = false;
      if (/^\s*---+\s*$/.test(ln)) { flush(); out += '<hr>'; continue; }
      if (TABLE_RE.test(ln)) { if (list.length) { out += listBlock(list); list = []; } tbl.push(ln); continue; }
      if ((m = LIST_RE.exec(ln))) {
        if (tbl.length) { out += tableBlock(tbl); tbl = []; }
        list.push({ indent: m[1].replace(/\t/g, '  ').length, tag: /^\d/.test(m[2]) ? 'ol' : 'ul', text: m[3] });
        continue;
      }
      /* custom colors ride in the markup itself: !#fill|#outline|#text> */
      var cm = /^!#([0-9a-fA-F]{6})\|#([0-9a-fA-F]{6})\|#([0-9a-fA-F]{6})&gt;\s+([\s\S]*)$/.exec(ln);
      if (cm) {
        flush();
        var ctx = cm[4], chm = /^(#{1,4})\s+([\s\S]*)$/.exec(ctx), chtag = '';
        if (chm) { chtag = { 1: 'h3', 2: 'h4', 3: 'h5', 4: 'h6' }[chm[1].length]; ctx = chm[2]; }
        out += '<div class="callout c-custom" style="background:#' + cm[1] + ';border-color:#' + cm[2] + '">'
          + '<div class="ct" style="color:#' + cm[3] + '">'
          + (chtag ? '<' + chtag + '>' + ctx + '</' + chtag + '>' : ctx) + '</div></div>';
        continue;
      }
      for (var c = 0; c < CALLOUTS.length; c++) {
        if ((m = CALLOUTS[c].re.exec(ln))) {
          flush();
          /* a box may carry a heading: "!> ## Get the Demo CSV File" */
          var txt = m[1], hm = /^(#{1,4})\s+([\s\S]*)$/.exec(txt), htag = '';
          if (hm) { htag = { 1: 'h3', 2: 'h4', 3: 'h5', 4: 'h6' }[hm[1].length]; txt = hm[2]; }
          out += '<div class="callout' + (CALLOUTS[c].cls ? ' ' + CALLOUTS[c].cls : '') + '">'
            + (CALLOUTS[c].icon ? '<span class="ci">' + CALLOUTS[c].icon + '</span>' : '')
            + '<div class="ct">' + (htag ? '<' + htag + '>' + txt + '</' + htag + '>' : txt) + '</div></div>';
          hit = true; break;
        }
      }
      if (hit) continue;
      if ((m = /^####\s+(.*)$/.exec(ln))) { flush(); out += '<h6>' + m[1] + '</h6>'; }
      else if ((m = /^###\s+(.*)$/.exec(ln))) { flush(); out += '<h5>' + m[1] + '</h5>'; }
      else if ((m = /^##\s+(.*)$/.exec(ln))) { flush(); out += '<h4>' + m[1] + '</h4>'; }
      else if ((m = /^#\s+(.*)$/.exec(ln))) { flush(); out += '<h3>' + m[1] + '</h3>'; }
      else if (ln.trim() === '') { flush(); out += '<div style="height:8px"></div>'; }
      else { flush(); out += ln + '<br>'; }
    }
    flush();
    return out;
  }

  window.CPRMarkup = { render: render, esc: esc, inline: inline, listBlock: listBlock,
    cells: cells, LIST_RE: LIST_RE, TABLE_RE: TABLE_RE, TSEP_RE: TSEP_RE, CALLOUTS: CALLOUTS };
})();
