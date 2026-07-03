/* ===========================================================================
 * CPR Assistant — site-wide AI chat widget (Phase 1).
 * Floating button + slide-up panel, injected on every page by nav.js.
 *
 * Talks ONLY to the cpr-assistant Supabase edge function, which holds the
 * Anthropic API key server-side and streams Claude's reply back as SSE. The
 * key is never present in this file. Auth reuses the shared PIN session.
 *
 * Phase 1 = chat only (paste text). Phase 2 will add live data tools.
 * ========================================================================= */
(function () {
  'use strict';
  var EMBED = window.CPR_ASSISTANT_EMBED === true;   // assistant.html (RepairQ overlay iframe)
  if (window.self !== window.top && !EMBED) return;   // never inside an iframe unless embedding
  if (window.__cprAssistantLoaded) return;
  window.__cprAssistantLoaded = true;

  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var FN = SB_URL + '/functions/v1/cpr-assistant';
  var MODEL = 'claude-opus-4-8';

  function token() {
    try {
      var raw = localStorage.getItem('sb-' + SB_REF + '-auth-token');
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && (o.access_token || (o.currentSession && o.currentSession.access_token))) || null;
    } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* Tiny, safe markdown → HTML (bold, inline code, bullet lists, paragraphs). */
  function md(t) {
    var lines = String(t).split('\n'), out = [], inList = false;
    function inline(s) {
      return esc(s)
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
          '<a href="$2" target="_blank" rel="noopener" style="color:#4FB0E3;font-weight:700">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\s*[-*]\s+/.test(ln)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(ln.replace(/^\s*[-*]\s+/, '')) + '</li>');
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (ln.trim() === '') out.push('');
        else out.push('<p>' + inline(ln) + '</p>');
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  var STYLE = '' +
    '.cpra-fab{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;background:#DC282E;color:#fff;box-shadow:0 6px 20px rgba(45,45,59,.28);z-index:4000;display:flex;align-items:center;justify-content:center;font-size:24px;transition:transform .12s}' +
    '.cpra-fab:hover{transform:translateY(-2px)}' +
    '.cpra-panel{position:fixed;right:20px;bottom:20px;width:380px;max-width:calc(100vw - 32px);height:min(620px,80vh);background:#fff;border:1px solid #E0E2EA;border-radius:16px;box-shadow:0 18px 50px rgba(45,45,59,.30);z-index:4001;display:none;flex-direction:column;overflow:hidden;font-family:"Nunito Sans",system-ui,sans-serif;color:#2D2D3B}' +
    '.cpra-panel.open{display:flex}' +
    '.cpra-hd{display:flex;align-items:center;gap:10px;padding:13px 15px;background:#2D2D3B;color:#fff;flex:none}' +
    '.cpra-hd .ic{width:30px;height:30px;border-radius:8px;background:#DC282E;display:flex;align-items:center;justify-content:center;font-size:16px;flex:none}' +
    '.cpra-hd .t{font-family:"Nunito",system-ui,sans-serif;font-weight:900;font-size:.95rem;line-height:1.1}' +
    '.cpra-hd .s{font-size:.62rem;color:rgba(255,255,255,.6);font-weight:700;margin-top:1px}' +
    '.cpra-hd .x{margin-left:auto;background:rgba(255,255,255,.12);border:none;color:#fff;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:15px;font-weight:800}' +
    '.cpra-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;background:#F7F7F9}' +
    '.cpra-msg{max-width:88%;padding:9px 12px;border-radius:13px;font-size:.86rem;line-height:1.45}' +
    '.cpra-msg p{margin:0 0 6px}.cpra-msg p:last-child{margin:0}.cpra-msg ul{margin:4px 0 6px;padding-left:18px}.cpra-msg li{margin:1px 0}' +
    '.cpra-msg code{background:rgba(45,45,59,.08);border-radius:4px;padding:1px 4px;font-size:.8em}' +
    '.cpra-user{align-self:flex-end;background:#4FB0E3;color:#fff;border-bottom-right-radius:4px}' +
    '.cpra-user code{background:rgba(255,255,255,.2)}' +
    '.cpra-bot{align-self:flex-start;background:#fff;border:1px solid #E8E8EE;border-bottom-left-radius:4px}' +
    '.cpra-bot.err{background:#FBE9EA;border-color:#F0C9C9;color:#8A1F22}' +
    '.cpra-hint{align-self:center;text-align:center;font-size:.78rem;color:#9aa0b0;font-weight:600;padding:6px 10px;line-height:1.4}' +
    '.cpra-dots{display:inline-block}.cpra-dots span{display:inline-block;width:6px;height:6px;margin:0 1px;border-radius:50%;background:#B9BDCB;animation:cpra-b 1s infinite}' +
    '.cpra-dots span:nth-child(2){animation-delay:.15s}.cpra-dots span:nth-child(3){animation-delay:.3s}' +
    '@keyframes cpra-b{0%,60%,100%{opacity:.3}30%{opacity:1}}' +
    '.cpra-foot{flex:none;border-top:1px solid #EEF0F4;padding:10px;display:flex;gap:8px;align-items:flex-end;background:#fff}' +
    '.cpra-foot textarea{flex:1;resize:none;border:1.5px solid #E0E2EA;border-radius:11px;padding:9px 11px;font-family:inherit;font-size:.86rem;max-height:120px;outline:none}' +
    '.cpra-foot textarea:focus{border-color:#4FB0E3}' +
    '.cpra-send{flex:none;width:40px;height:40px;border:none;border-radius:11px;background:#DC282E;color:#fff;cursor:pointer;font-size:17px;font-weight:800}' +
    '.cpra-send:disabled{background:#E4A6A8;cursor:default}' +
    '@media(max-width:520px){.cpra-panel{right:0;bottom:0;width:100vw;height:88vh;border-radius:16px 16px 0 0}.cpra-fab{right:16px;bottom:16px}}' +
    /* embed mode: the panel IS the page (RepairQ overlay hosts us in an iframe) */
    'body.cpra-embed .cpra-fab{display:none!important}' +
    'body.cpra-embed .cpra-panel{right:0;bottom:0;top:0;left:0;width:100%;height:100%;max-width:none;border:none;border-radius:0;box-shadow:none}' +
    'body.cpra-embed .cpra-panel .x{display:none}' +
    'body.cpra-embed .cpra-hd{display:none}' +
    '.cpra-ctx{margin:8px 12px 0;padding:7px 11px;background:#EAF6FD;border:1px solid #CDEAF8;border-radius:9px;font-size:.74rem;font-weight:700;color:#1E7AA8}';

  var MSGS = [];        // {role, content}
  var CTX = null, CTX_SENT = false;   // RepairQ page context (embed mode)
  var busy = false;
  var els = {};

  function build() {
    var st = document.createElement('style'); st.textContent = STYLE; document.head.appendChild(st);

    var fab = document.createElement('button');
    fab.className = 'cpra-fab'; fab.title = 'CPR Assistant'; fab.setAttribute('aria-label', 'Open CPR Assistant');
    fab.innerHTML = '✨';

    var panel = document.createElement('div');
    panel.className = 'cpra-panel';
    panel.innerHTML =
      '<div class="cpra-hd"><div class="ic">✨</div><div><div class="t">CPR Assistant</div><div class="s">AI helper · ' + esc(MODEL.indexOf('haiku') >= 0 ? 'fast' : 'Opus') + '</div></div><button class="x" title="Close">✕</button></div>' +
      '<div class="cpra-body"></div>' +
      '<div class="cpra-foot"><textarea rows="1" placeholder="Ask anything — customer replies, panic logs, repairs…"></textarea><button class="cpra-send" title="Send">↑</button></div>';

    document.body.appendChild(fab);
    document.body.appendChild(panel);

    els.fab = fab; els.panel = panel;
    els.body = panel.querySelector('.cpra-body');
    els.ta = panel.querySelector('textarea');
    els.send = panel.querySelector('.cpra-send');

    function open() { panel.classList.add('open'); fab.style.display = 'none'; els.ta.focus(); if (!MSGS.length) greet(); }
    function close() { panel.classList.remove('open'); fab.style.display = 'flex'; }
    fab.onclick = open;
    panel.querySelector('.x').onclick = close;
    // expose so other UI (e.g. the dashboard "Ask AI" button) can open the panel
    window.CPRAssistant = { open: open, close: close };
    if (EMBED) {
      document.body.classList.add('cpra-embed');
      open();
      // the RepairQ overlay posts page context (ticket #, device, store, tech)
      window.addEventListener('message', function (ev) {
        var d = ev.data;
        if (!d || d.type !== 'cpr-ctx' || typeof d.text !== 'string') return;
        CTX = String(d.text).slice(0, 600); CTX_SENT = false;
        if (els.ctx) { els.ctx.textContent = '📎 ' + CTX; }
        else {
          els.ctx = document.createElement('div');
          els.ctx.className = 'cpra-ctx';
          els.ctx.textContent = '📎 ' + CTX;
          els.panel.insertBefore(els.ctx, els.body);
        }
      });
    }
    els.send.onclick = onSend;
    els.ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });
    els.ta.addEventListener('input', function () { els.ta.style.height = 'auto'; els.ta.style.height = Math.min(els.ta.scrollHeight, 120) + 'px'; });
  }

  function greet() {
    addHint('Hi! Ask me anything — I answer from our Knowledge Base (policies, repair guides, SOPs) with links, plus customer replies and panic logs. (Live store data is coming soon.)');
  }
  function scroll() { els.body.scrollTop = els.body.scrollHeight; }
  function addHint(t) { var d = document.createElement('div'); d.className = 'cpra-hint'; d.textContent = t; els.body.appendChild(d); scroll(); }
  function addMsg(role, html) {
    var d = document.createElement('div');
    d.className = 'cpra-msg ' + (role === 'user' ? 'cpra-user' : 'cpra-bot');
    d.innerHTML = html;
    els.body.appendChild(d); scroll(); return d;
  }

  function onSend() {
    if (busy) return;
    var text = els.ta.value.trim();
    if (!text) return;
    var tok = token();
    if (!tok) { addHint('Please unlock the site with your PIN first, then try again.'); return; }

    els.ta.value = ''; els.ta.style.height = 'auto';
    var outgoing = text;
    if (CTX && !CTX_SENT) { outgoing = '[Where I am in RepairQ right now: ' + CTX + ']\n\n' + text; CTX_SENT = true; }
    MSGS.push({ role: 'user', content: outgoing });
    addMsg('user', md(text));

    var bot = addMsg('assistant', '<span class="cpra-dots"><span></span><span></span><span></span></span>');
    busy = true; els.send.disabled = true;
    stream(tok, bot);
  }

  function stream(tok, bot) {
    var acc = '';
    fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok, 'apikey': ANON },
      body: JSON.stringify({ model: MODEL, messages: MSGS })
    }).then(function (r) {
      if (!r.ok || !r.body) {
        return r.json().then(function (j) { throw new Error(friendly(r.status, j)); },
          function () { throw new Error('Something went wrong (' + r.status + ').'); });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return finish();
          buf += dec.decode(res.value, { stream: true });
          var parts = buf.split('\n\n'); buf = parts.pop();
          parts.forEach(function (evt) {
            evt.split('\n').forEach(function (line) {
              line = line.trim();
              if (line.indexOf('data:') !== 0) return;
              var payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') return;
              try {
                var j = JSON.parse(payload);
                if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
                  acc += j.delta.text; bot.innerHTML = md(acc); scroll();
                } else if (j.type === 'error') {
                  throw new Error((j.error && j.error.message) || 'stream error');
                }
              } catch (e) { /* ignore non-JSON keepalive lines */ }
            });
          });
          return pump();
        });
      }
      function finish() {
        if (acc) { MSGS.push({ role: 'assistant', content: acc }); bot.innerHTML = md(acc); }
        else { bot.classList.add('err'); bot.textContent = 'No response received. Please try again.'; }
        busy = false; els.send.disabled = false; scroll();
      }
      return pump();
    }).catch(function (e) {
      bot.classList.add('err'); bot.textContent = e.message || 'Network error. Please try again.';
      busy = false; els.send.disabled = false; scroll();
    });
  }

  function friendly(status, j) {
    var err = j && j.error;
    if (status === 401) return 'Please unlock the site with your PIN first.';
    if (err === 'not_configured') return 'The assistant isn’t switched on yet (missing API key). Ask an admin.';
    if (status === 429) return 'Busy right now — please wait a moment and try again.';
    return 'Something went wrong (' + status + '). Please try again.';
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();
