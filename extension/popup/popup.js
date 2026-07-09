var TIER2_FLOOR = 40.00;
var TIER3_FLOOR = 73.50;
// Pricing model: 'franchise' loads the 5.8% royalty; 'cap' (Eugene — CAP store,
// no royalty) stops at the CC fee. Synced with the tile overlay via
// storage.sync mcpr.priceModel; switchable right in the popup.
var PRICE_MODEL = 'franchise';

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

// CAP rounding: always UP to the next price ending in $4.99 / $9.99
// (franchise rounds to the NEAREST such ending; CAP never rounds down).
function capRoundUp(n) {
  if (n <= 0) return 0;
  return Math.ceil((n + 0.01) / 5) * 5 - 0.01;
}

// model-aware total rounding
function roundTotal(n) {
  return PRICE_MODEL === 'cap' ? capRoundUp(n) : cprRound(n);
}

function applyMarkup(cost) {
  if (cost <= 0)  return { charged: 0, tag: null };
  if (cost <= 20) return { charged: Math.max(cost * 2, 20), tag: '2x' };
  if (cost < 50)  return { charged: Math.max(cost * 1.5, TIER2_FLOOR), tag: '1.5x' };
  return { charged: Math.max(cost + 25, TIER3_FLOOR), tag: '+$25' };
}

function tagClass(tag) {
  if (tag === '2x')   return 'tag-2x';
  if (tag === '1.5x') return 'tag-15x';
  return 'tag-plus25';
}

function tagLabel(tag) {
  if (tag === '2x')   return '2\u00d7';
  if (tag === '1.5x') return '1.5\u00d7';
  return '+$25';
}

function buildPrimaryRow() {
  var row = document.createElement('div');
  row.className = 'part-row';
  row.id = 'primary-row';

  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'p_name';
  nameInput.placeholder = 'e.g. Screen, Battery...';
  nameInput.addEventListener('input', calculate);

  var priceInput = document.createElement('input');
  priceInput.type = 'number';
  priceInput.id = 'p_price';
  priceInput.placeholder = '0.00';
  priceInput.min = '0';
  priceInput.step = '0.01';
  priceInput.addEventListener('input', calculate);

  var chargedDiv = document.createElement('div');
  chargedDiv.className = 'charged-display';
  chargedDiv.id = 'p_charged';
  chargedDiv.innerHTML = '<span style="color:var(--gray-400)">--</span><span class="rule-tag tag-labor">+$100</span>';

  row.appendChild(nameInput);
  row.appendChild(priceInput);
  row.appendChild(chargedDiv);
  document.getElementById('primaryRow').appendChild(row);
}

function addAdditional() {
  var id = 'a_' + Date.now();
  var row = document.createElement('div');
  row.className = 'part-row has-remove additional-row';
  row.id = id;

  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. Adhesive, Bracket...';
  nameInput.addEventListener('input', calculate);

  var priceInput = document.createElement('input');
  priceInput.type = 'number';
  priceInput.placeholder = '0.00';
  priceInput.min = '0';
  priceInput.step = '0.01';
  priceInput.addEventListener('input', calculate);

  var chargedDiv = document.createElement('div');
  chargedDiv.className = 'charged-display';
  chargedDiv.id = 'c_' + id;
  chargedDiv.innerHTML = '<span style="color:var(--gray-400)">--</span>';

  var removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove';
  removeBtn.textContent = '\u00d7';
  removeBtn.addEventListener('click', function() { removeRow(id); });

  row.appendChild(nameInput);
  row.appendChild(priceInput);
  row.appendChild(chargedDiv);
  row.appendChild(removeBtn);

  document.getElementById('additionalRows').appendChild(row);
  nameInput.focus();
  calculate();
}

function removeRow(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.transition = 'all 0.2s ease';
  el.style.opacity = '0';
  setTimeout(function() { el.remove(); calculate(); }, 200);
}

function resetAll() {
  document.getElementById('additionalRows').innerHTML = '';
  document.getElementById('primaryRow').innerHTML = '';
  buildPrimaryRow();
  calculate();
}

function calculate() {
  var priceEl = document.getElementById('p_price');
  var primaryCost = priceEl ? (parseFloat(priceEl.value) || 0) : 0;
  var hasPrimary = primaryCost > 0;
  var labor = hasPrimary ? 100 : 0;

  var rows = document.querySelectorAll('.additional-row');
  var additionalItems = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var cost = parseFloat(row.querySelector('input[type=number]').value) || 0;
    var result = applyMarkup(cost);
    additionalItems.push({ row: row, cost: cost, charged: result.charged, tag: result.tag });
  }

  var additionalTotal = additionalItems.reduce(function(s, x) { return s + x.charged; }, 0);
  var base    = labor + primaryCost + additionalTotal;
  var afterCC = base * 1.0186;
  var total   = afterCC * (PRICE_MODEL === 'cap' ? 1 : 1.058);
  var ccFee   = afterCC - base;
  var royalty = total - afterCC;
  var rounded = roundTotal(total);
  var feeMultiplier = base > 0 ? (total / base) : 1;

  var pCharged = document.getElementById('p_charged');
  var remainderForAdd = rounded;
  if (hasPrimary && pCharged) {
    var primaryFinal = roundTotal((primaryCost + labor) * feeMultiplier);
    remainderForAdd = rounded - primaryFinal;
    pCharged.className = 'charged-display has-value';
    pCharged.innerHTML = '<span class="line-total">' + fmt(primaryFinal) + '</span><span class="rule-tag tag-labor">+$100</span>';
  } else if (pCharged) {
    pCharged.className = 'charged-display';
    pCharged.innerHTML = '<span style="color:var(--gray-400)">--</span><span class="rule-tag tag-labor">+$100</span>';
  }

  var activeAdditional = additionalItems.filter(function(x) { return x.cost > 0; }).length;
  var addLoadedTotal = additionalItems.reduce(function(s, x) { return s + (x.cost > 0 ? x.charged * feeMultiplier : 0); }, 0);
  var addRoundingPer = activeAdditional > 0 ? (remainderForAdd - addLoadedTotal) / activeAdditional : 0;

  for (var j = 0; j < additionalItems.length; j++) {
    var item = additionalItems[j];
    var disp = document.getElementById('c_' + item.row.id);
    if (item.cost > 0 && disp) {
      disp.className = 'charged-display has-value';
      disp.innerHTML = '<span class="line-total">' + fmt(item.charged * feeMultiplier + addRoundingPer) + '</span><span class="rule-tag ' + tagClass(item.tag) + '">' + tagLabel(item.tag) + '</span>';
    } else if (disp) {
      disp.className = 'charged-display';
      disp.innerHTML = '<span style="color:var(--gray-400)">--</span>';
    }
  }

  var set = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
  set('fPrimaryCost', hasPrimary ? fmt(primaryCost) : '--');
  set('fLabor',       hasPrimary ? fmt(labor) : '--');
  set('fAdditional',  additionalTotal > 0 ? fmt(additionalTotal) : '--');
  set('fBase',        base > 0 ? fmt(base) : '--');
  set('fCC',          base > 0 ? '+' + fmt(ccFee) : '--');
  set('fAfterCC',     base > 0 ? fmt(afterCC) : '--');
  set('fRoyalty',     PRICE_MODEL === 'cap' ? 'none (CAP)' : (base > 0 ? '+' + fmt(royalty) : '--'));
  set('totalDisplay', base > 0 ? fmt(rounded) : '--');
}

// keep the model pill + royalty label in sync with the active model
function renderModel() {
  var sel = document.getElementById('modelSelect');
  if (sel && sel.value !== PRICE_MODEL) sel.value = PRICE_MODEL;
  var lbl = document.getElementById('fRoyaltyLbl');
  if (lbl) lbl.textContent = PRICE_MODEL === 'cap' ? 'Royalty' : 'Royalty (5.8%)';
  calculate();
}

document.addEventListener('DOMContentLoaded', function() {
  buildPrimaryRow();
  // load the shared pricing model, then wire the switcher
  try {
    chrome.storage.sync.get(['mcpr']).then(function (res) {
      PRICE_MODEL = (res && res.mcpr && res.mcpr.priceModel) === 'cap' ? 'cap' : 'franchise';
      renderModel();
    }).catch(calculate);
  } catch (e) { /* not in an extension context (fullview file://) */ }
  var sel = document.getElementById('modelSelect');
  if (sel) sel.addEventListener('change', function () {
    PRICE_MODEL = sel.value === 'cap' ? 'cap' : 'franchise';
    try {
      chrome.storage.sync.get(['mcpr']).then(function (res) {
        var m = (res && res.mcpr) || {};
        m.priceModel = PRICE_MODEL;
        chrome.storage.sync.set({ mcpr: m });
      });
    } catch (e) { /* best effort */ }
    renderModel();
  });
  calculate();

  document.getElementById('addPartBtn').addEventListener('click', addAdditional);
  document.getElementById('resetBtn').addEventListener('click', resetAll);
  document.getElementById('popoutBtn').addEventListener('click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/fullview.html') });
  });
  document.getElementById('copyTotalBtn').addEventListener('click', function() {
    var val = document.getElementById('totalDisplay').textContent;
    if (val === '--' || !val) return;
    navigator.clipboard.writeText(val).then(function() {
      var btn = document.getElementById('copyTotalBtn');
      btn.classList.add('copied');
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(function() {
        btn.classList.remove('copied');
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    });
  });
});
