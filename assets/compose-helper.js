/*
    Compose Helper (myRepairTools) — a guided "help me write a customer text"
    modal for the SITE side (the RingCentral panel in the extension has its
    own copy of this flow). Same brain: the `ai-compose` edge function with
    owner-configurable scenario templates + AI follow-up questions.

    window.CPRCompose.open(opts?)
      opts.store   — store name for context (optional)
      opts.name    — customer name for context (optional)
      opts.onPick(message)  — callback with the composed text; if omitted the
                    modal shows a Copy button.

    Injected site-wide by nav.js; launched from the CPR Assistant panel.
*/
(function () {
  'use strict';
  if (window.self !== window.top) return;
  if (window.CPRCompose) return;

  var FN = 'https://xuvsehrevxackuhmbmry.supabase.co/functions/v1/ai-compose';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  var templatesCache = null;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function call(payload) {
    return fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON, 'apikey': ANON },
      body: JSON.stringify(payload || {}),
    }).then(function (r) { return r.json(); }).catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function injectStyles() {
    if (document.getElementById('cprComposeStyles')) return;
    var s = document.createElement('style'); s.id = 'cprComposeStyles';
    s.textContent =
      '.cprc-ov{position:fixed;inset:0;z-index:5000;background:rgba(45,45,59,.5);display:flex;align-items:flex-start;justify-content:center;font-family:"Nunito Sans","Segoe UI",sans-serif}' +
      '.cprc-card{width:440px;max-width:calc(100vw - 28px);margin-top:8vh;background:#fff;border-radius:14px;box-shadow:0 20px 60px rgba(45,45,59,.4);overflow:hidden;max-height:84vh;display:flex;flex-direction:column}' +
      '.cprc-hd{display:flex;align-items:center;gap:8px;background:#2D2D3B;color:#fff;padding:12px 16px}' +
      '.cprc-hd h3{margin:0;font-family:Nunito,sans-serif;font-weight:800;font-size:16px;flex:1}' +
      '.cprc-x{background:none;border:none;color:#B9BDCB;font-size:18px;cursor:pointer}.cprc-x:hover{color:#fff}' +
      '.cprc-bd{padding:14px 16px;overflow-y:auto}' +
      '.cprc-sub{color:#8A8FA3;font-size:12.5px;margin-bottom:12px}' +
      '.cprc-scn{display:block;width:100%;text-align:left;cursor:pointer;background:#F6F7F9;border:1.5px solid #E0E2EA;border-radius:10px;padding:12px 14px;margin-bottom:8px;font-family:inherit;font-size:14px;font-weight:700;color:#2D2D3B}' +
      '.cprc-scn:hover{border-color:#4FB0E3;background:#EAF6FD}' +
      '.cprc-scn span{display:block;font-weight:600;font-size:12px;color:#8A8FA3;margin-top:2px}' +
      '.cprc-q{margin-bottom:13px}' +
      '.cprc-q label{display:block;font-family:Nunito,sans-serif;font-weight:800;font-size:12.5px;color:#4E4E50;margin-bottom:4px}' +
      '.cprc-q label .opt{color:#B9BDCB;font-weight:600}.cprc-q label .ai{color:#C98A00}' +
      '.cprc-in{width:100%;box-sizing:border-box;border:1.5px solid #E0E2EA;border-radius:8px;padding:9px 11px;font-family:inherit;font-size:14px;color:#2D2D3B}' +
      '.cprc-in:focus{outline:none;border-color:#4FB0E3}' +
      '.cprc-chips{display:flex;flex-wrap:wrap;gap:6px}' +
      '.cprc-chip{cursor:pointer;font-family:inherit;font-size:13px;font-weight:700;color:#2D2D3B;background:#F6F7F9;border:1.5px solid #E0E2EA;border-radius:16px;padding:6px 13px}' +
      '.cprc-chip:hover{border-color:#4FB0E3}.cprc-chip.on{background:#4FB0E3;border-color:#4FB0E3;color:#fff}' +
      '.cprc-ft{padding:12px 16px;border-top:1px solid #F3F2F2;display:flex;gap:8px;align-items:center}' +
      '.cprc-btn{cursor:pointer;font-family:Nunito,sans-serif;font-weight:800;font-size:13.5px;border-radius:9px;padding:9px 18px;border:none}' +
      '.cprc-go{background:#DC282E;color:#fff}.cprc-go:hover{background:#c02329}.cprc-go:disabled{opacity:.6;cursor:default}' +
      '.cprc-ghost{background:#fff;border:1.5px solid #E0E2EA;color:#4E4E50}.cprc-ghost:hover{border-color:#B9BDCB}' +
      '.cprc-out{width:100%;box-sizing:border-box;border:1.5px solid #E0E2EA;border-radius:10px;padding:12px;font-family:inherit;font-size:14px;color:#2D2D3B;min-height:96px;resize:vertical;line-height:1.4}' +
      '.cprc-status{font-size:12px;color:#8A8FA3;margin-left:auto}';
    document.head.appendChild(s);
  }

  var ov, opts = {};
  function close() { if (ov) { ov.remove(); ov = null; } }
  function shell(title, bodyHtml, footHtml) {
    if (!ov) {
      ov = document.createElement('div'); ov.className = 'cprc-ov';
      ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
      document.body.appendChild(ov);
    }
    ov.innerHTML = '<div class="cprc-card"><div class="cprc-hd"><h3>' + esc(title) + '</h3><button class="cprc-x">✕</button></div>' +
      '<div class="cprc-bd">' + bodyHtml + '</div>' + (footHtml ? '<div class="cprc-ft">' + footHtml + '</div>' : '') + '</div>';
    ov.querySelector('.cprc-x').addEventListener('click', close);
    return ov.querySelector('.cprc-card');
  }

  function open(o) {
    opts = o || {};
    injectStyles();
    shell('✍️ Help Me Write a Text', '<div class="cprc-sub">Loading scenarios…</div>');
    (templatesCache ? Promise.resolve(templatesCache) : call({ action: 'templates' }).then(function (r) { templatesCache = (r && r.ok && r.templates) || []; return templatesCache; }))
      .then(renderPicker);
  }

  function renderPicker(tpls) {
    var html = '<div class="cprc-sub">Pick what you’re writing about — answer a couple quick questions and we’ll draft it.</div>';
    html += (tpls || []).map(function (t) {
      return '<button class="cprc-scn" data-id="' + t.id + '" data-name="' + esc(t.name) + '">' + esc((t.icon || '✍️') + ' ' + t.name) +
        (t.description ? '<span>' + esc(t.description) + '</span>' : '') + '</button>';
    }).join('') || '<div class="cprc-sub">No scenarios set up yet.</div>';
    var card = shell('✍️ Help Me Write a Text', html);
    card.querySelectorAll('.cprc-scn').forEach(function (b) {
      b.addEventListener('click', function () { renderQuestions(b.getAttribute('data-id'), b.getAttribute('data-name')); });
    });
  }

  function renderQuestions(id, name) {
    shell(name, '<div class="cprc-sub">✨ Preparing questions…</div>');
    call({ action: 'guided_questions', scenario_id: Number(id), customer_name: opts.name || '' }).then(function (r) {
      if (!r || !r.ok) { renderPicker(templatesCache); return; }
      var qs = r.questions || [];
      var body = qs.map(function (qq) {
        var h = '<div class="cprc-q"><label>' + esc(qq.label) +
          (qq.optional ? ' <span class="opt">(optional)</span>' : '') + (qq.ai ? ' <span class="ai">✨</span>' : '') + '</label>';
        if (qq.type === 'choice') {
          h += '<div class="cprc-chips" data-key="' + esc(qq.key) + '">' + (qq.options || []).map(function (o2) {
            return '<button type="button" class="cprc-chip" data-val="' + esc(o2) + '">' + esc(o2) + '</button>';
          }).join('') + '</div>';
        } else {
          h += '<input class="cprc-in cprc-tin" data-key="' + esc(qq.key) + '" placeholder="' + esc(qq.placeholder || '') + '">';
        }
        return h + '</div>';
      }).join('');
      var card = shell(name, body, '<button class="cprc-btn cprc-ghost" id="cprcBack">Back</button><button class="cprc-btn cprc-go" id="cprcWrite">✨ Write it</button><span class="cprc-status" id="cprcStatus"></span>');
      card.querySelectorAll('.cprc-chips').forEach(function (grp) {
        grp.querySelectorAll('.cprc-chip').forEach(function (c) {
          c.addEventListener('click', function () {
            grp.querySelectorAll('.cprc-chip').forEach(function (x) { x.classList.remove('on'); });
            c.classList.add('on'); grp.setAttribute('data-val', c.getAttribute('data-val'));
          });
        });
      });
      card.querySelector('#cprcBack').addEventListener('click', function () { renderPicker(templatesCache); });
      card.querySelector('#cprcWrite').addEventListener('click', function () { submit(id, name); });
    });
  }

  function submit(id, name) {
    var answers = {};
    ov.querySelectorAll('.cprc-tin').forEach(function (i) { if (i.value.trim()) answers[i.getAttribute('data-key')] = i.value.trim(); });
    ov.querySelectorAll('.cprc-chips').forEach(function (g) { var v = g.getAttribute('data-val'); if (v) answers[g.getAttribute('data-key')] = v; });
    var btn = ov.querySelector('#cprcWrite'); var st = ov.querySelector('#cprcStatus');
    btn.disabled = true; st.textContent = '✨ Writing…';
    call({ action: 'guided_compose', scenario_id: Number(id), answers: answers, customer_name: opts.name || '', store: opts.store || (window.CPRNavStore || '') }).then(function (r) {
      btn.disabled = false;
      if (!r || !r.ok) { st.textContent = (r && r.error) || 'Failed'; return; }
      renderResult(r.message || '', id, name);
    });
  }

  function renderResult(msg, id, name) {
    var body = '<div class="cprc-sub">Here’s your draft — edit it, then copy.</div><textarea class="cprc-out" id="cprcOut">' + esc(msg) + '</textarea>';
    var foot = '<button class="cprc-btn cprc-ghost" id="cprcRedo">← Change answers</button>' +
      (opts.onPick ? '<button class="cprc-btn cprc-go" id="cprcUse">Use this</button>' : '<button class="cprc-btn cprc-go" id="cprcCopy">Copy</button>') +
      '<span class="cprc-status" id="cprcStatus"></span>';
    var card = shell(name, body, foot);
    card.querySelector('#cprcRedo').addEventListener('click', function () { renderQuestions(id, name); });
    if (opts.onPick) {
      card.querySelector('#cprcUse').addEventListener('click', function () { try { opts.onPick(ov.querySelector('#cprcOut').value); } catch (e) {} close(); });
    } else {
      card.querySelector('#cprcCopy').addEventListener('click', function () {
        var t = ov.querySelector('#cprcOut').value, st = ov.querySelector('#cprcStatus');
        var done = function (ok) { st.textContent = ok ? '✓ Copied' : 'Copy failed'; };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(function () { done(true); }).catch(function () { done(false); });
        else { var ta = ov.querySelector('#cprcOut'); ta.select(); try { done(document.execCommand('copy')); } catch (e) { done(false); } }
      });
    }
  }

  window.CPRCompose = { open: open, close: close };
})();
