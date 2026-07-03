var TIER2_FLOOR = 40.00;
var TIER3_FLOOR = 73.50;

function fmt(n) {
  return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function cprRound(n) {
  if (n <= 0) return 0;
  var lower = Math.floor(n / 5) * 5 - 0.01;
  if (lower >= n) lower -= 5;
  var upper = lower + 5;
  return (n - lower < upper - n) ? lower : upper;
}

function applyMarkup(cost) {
  if (cost <= 0)  return { charged: 0, tag: null };
  if (cost <= 20) return { charged: Math.max(cost * 2, 20), tag: '2x' };
  if (cost < 50)  return { charged: Math.max(cost * 1.5, TIER2_FLOOR), tag: '1.5x' };
  return { charged: Math.max(cost + 25, TIER3_FLOOR), tag: '+$25' };
}

function tagClass(t) {
  if (t === '2x')   return 'tag-2x';
  if (t === '1.5x') return 'tag-15x';
  return 'tag-plus25';
}

function tagLabel(t) {
  if (t === '2x')   return '2\u00d7';
  if (t === '1.5x') return '1.5\u00d7';
  return '+$25';
}

function makeRow(nameId, priceId, chargedId, calcFn, extraClass, rowId) {
  var row = document.createElement('div');
  row.className = 'part-row' + (rowId ? ' has-remove' + (extraClass ? ' ' + extraClass : '') : (extraClass ? ' ' + extraClass : ''));
  if (rowId) row.id = rowId;

  var ni = document.createElement('input');
  ni.type = 'text';
  if (nameId) ni.id = nameId;
  ni.placeholder = nameId ? 'e.g. Screen, Battery, Charging Port...' : 'e.g. Adhesive, Bracket...';
  ni.addEventListener('input', calcFn);

  var pi = document.createElement('input');
  pi.type = 'number';
  if (priceId) pi.id = priceId;
  pi.placeholder = '0.00'; pi.min = '0'; pi.step = '0.01';
  pi.addEventListener('input', calcFn);

  var cd = document.createElement('div');
  cd.className = 'charged-display';
  cd.id = chargedId;
  cd.innerHTML = rowId
    ? '<span style="color:var(--gray-400)">--</span>'
    : '<span style="color:var(--gray-400)">--</span><span class="rule-tag tag-labor">+$100 Labor</span>';

  row.appendChild(ni); row.appendChild(pi); row.appendChild(cd);

  if (rowId) {
    var rb = document.createElement('button');
    rb.className = 'btn-remove';
    rb.textContent = '\u00d7';
    (function(id, fn) {
      rb.addEventListener('click', function() {
        var el = document.getElementById(id);
        if (el) { el.style.opacity = '0'; setTimeout(function() { el.remove(); fn(); }, 200); }
      });
    })(rowId, calcFn);
    row.appendChild(rb);
  }
  return row;
}

function buildPrimaryRow() {
  var c = document.getElementById('primaryRow'); c.innerHTML = '';
  c.appendChild(makeRow('p_name', 'p_price', 'p_charged', calculate, 'primary-row', null));
}

function addAdditional() {
  var id = 'a_' + Date.now();
  var row = makeRow(null, null, 'c_' + id, calculate, 'additional-row', id);
  document.getElementById('additionalRows').appendChild(row);
  row.querySelector('input[type=text]').focus();
  calculate();
}

function resetAll() {
  document.getElementById('additionalRows').innerHTML = '';
  buildPrimaryRow(); calculate();
}

function calculate() {
  var priceEl = document.getElementById('p_price');
  var primaryCost = priceEl ? (parseFloat(priceEl.value) || 0) : 0;
  var hasPrimary = primaryCost > 0;
  var labor = hasPrimary ? 100 : 0;

  var addRows = document.querySelectorAll('.additional-row');
  var additionalItems = [];
  for (var i = 0; i < addRows.length; i++) {
    var r = addRows[i];
    var cost = parseFloat(r.querySelector('input[type=number]').value) || 0;
    var res = applyMarkup(cost);
    additionalItems.push({ row: r, cost: cost, charged: res.charged, tag: res.tag });
  }

  var additionalTotal = additionalItems.reduce(function(a, x) { return a + x.charged; }, 0);
  var base    = labor + primaryCost + additionalTotal;
  var afterCC = base * 1.0186;
  var total   = afterCC * 1.058;
  var ccFee   = afterCC - base;
  var royalty = total - afterCC;
  var rounded = cprRound(total);
  var fm      = base > 0 ? (total / base) : 1;

  var pc = document.getElementById('p_charged');
  var rem = rounded;
  if (hasPrimary && pc) {
    var pf = cprRound((primaryCost + labor) * fm);
    rem = rounded - pf;
    pc.className = 'charged-display has-value';
    pc.innerHTML = '<span class="line-total">' + fmt(pf) + '</span><span class="rule-tag tag-labor">+$100 Labor</span>';
  } else if (pc) {
    pc.className = 'charged-display';
    pc.innerHTML = '<span style="color:var(--gray-400)">--</span><span class="rule-tag tag-labor">+$100 Labor</span>';
  }

  var activeAdd  = additionalItems.filter(function(x) { return x.cost > 0; }).length;
  var addLoaded  = additionalItems.reduce(function(a, x) { return a + (x.cost > 0 ? x.charged * fm : 0); }, 0);
  var addPer     = activeAdd > 0 ? (rem - addLoaded) / activeAdd : 0;

  additionalItems.forEach(function(item) {
    var d = document.getElementById('c_' + item.row.id);
    if (item.cost > 0 && d) {
      d.className = 'charged-display has-value';
      d.innerHTML = '<span class="line-total">' + fmt(item.charged * fm + addPer) + '</span><span class="rule-tag ' + tagClass(item.tag) + '">' + tagLabel(item.tag) + '</span>';
    } else if (d) {
      d.className = 'charged-display';
      d.innerHTML = '<span style="color:var(--gray-400)">--</span>';
    }
  });

  var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('fPrimaryCost', hasPrimary ? fmt(primaryCost) : '--');
  set('fLabor',       hasPrimary ? fmt(labor) : '--');
  set('fAdditional',  additionalTotal > 0 ? fmt(additionalTotal) : '--');
  set('fBase',        base > 0 ? fmt(base) : '--');
  set('fCC',          base > 0 ? '+' + fmt(ccFee) : '--');
  set('fAfterCC',     base > 0 ? fmt(afterCC) : '--');
  set('fRoyalty',     base > 0 ? '+' + fmt(royalty) : '--');
  set('totalDisplay', base > 0 ? fmt(rounded) : '--');
}

document.addEventListener('DOMContentLoaded', function() {
  buildPrimaryRow();
  calculate();
  document.getElementById('addPartBtn').addEventListener('click', addAdditional);
  document.getElementById('resetBtn').addEventListener('click', resetAll);
  document.getElementById('tab-calc').addEventListener('click',  function() { showTab('calc'); });
  document.getElementById('tab-guide').addEventListener('click', function() { showTab('guide'); });
  document.getElementById('copyTotalBtn').addEventListener('click', function() {
    var val = document.getElementById('totalDisplay').textContent;
    if (val === '--' || !val) return;
    navigator.clipboard.writeText(val).then(function() {
      var btn = document.getElementById('copyTotalBtn');
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(function() {
        btn.classList.remove('copied');
        btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    });
  });
});

function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.panel').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('panel-' + tab).classList.add('active');
}
