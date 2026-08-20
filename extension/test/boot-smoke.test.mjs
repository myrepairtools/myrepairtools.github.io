/* Load-smoke: does each changed content script BOOT without throwing against a
   RepairQ-shaped page? Catches the class of error a syntax check cannot — a
   ReferenceError at boot leaves the feature silently dead (v2.5.73 shipped
   exactly that). Not a behaviour test; a "does it come up" test. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const BASE = '/Users/brittbay/Documents/GitHub/myrepairtools.github.io/extension/scripts/';

const PAGE = `<!doctype html><html><body>
  <div id="summary"><div class="block-content"><span class="fullsize label">New</span></div></div>
  <div class="location tooltip-toggle"><span>CPR Eugene</span></div>
  <div id="user_dropdown">Bay, Britt</div>
  <div class="sub-head"><h3>Customer</h3></div>
  <div class="block-content"><a href="/customers/77">Smith, Jane</a><br>541-999-8888</div>
  <div id="globalSearches"><div id="quickSearch"></div></div>
  <input name="YII_CSRF_TOKEN" value="tok">
  <table><tr class="ticket-item-row"><td>iPhone 15 Screen Repair</td></tr></table>
  <div class="nav"></div>
</body></html>`;

let pass = 0, total = 0;
for (const [file, url] of [
  ['followUp.js',    'https://cpr.repairq.io/ticket/16254502'],
  ['readyText.js',   'https://cpr.repairq.io/ticket/16254502'],
  ['lcdCapture.js',  'https://cpr.repairq.io/ticket/16254502'],
  ['ringCentral.js', 'https://cpr.repairq.io/ticket/16254502'],
]) {
  total++;
  const dom = new JSDOM(PAGE, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const errs = [];
  w.addEventListener('error', e => errs.push(String(e.error || e.message)));
  w.chrome = {
    runtime: { lastError: null, getManifest: () => ({ version: '2.8.3-test' }),
               sendMessage: (m, cb) => { if (typeof cb === 'function') setTimeout(() => cb({ ok: true, messages: [], conversations: [] }), 0); },
               onMessage: { addListener() {} } },
    storage: { sync:  { get: () => Promise.resolve({ sms: { followUp: true, readyText: true }, mcpr: {}, wn: {} }) },
               local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
  };
  w.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }), text: () => Promise.resolve('') });
  let err = null;
  try {
    const src = readFileSync(BASE + file, 'utf8');
    const fn = new w.Function('chrome', 'window', 'document', 'location', 'fetch', 'sessionStorage', 'localStorage', 'setTimeout', 'clearTimeout', 'setInterval', 'MutationObserver', src);
    fn.call(w, w.chrome, w, w.document, w.location, w.fetch, w.sessionStorage, w.localStorage, w.setTimeout, w.clearTimeout, w.setInterval, w.MutationObserver);
    await new Promise(r => setTimeout(r, 900));
  } catch (e) { err = e; }
  const bad = err || errs.length;
  if (!bad) pass++;
  console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${file.padEnd(18)} ${bad ? (err ? String(err.message || err) : errs[0]) : 'boots clean'}`);
}
console.log(`\n  ${pass}/${total} scripts boot without throwing`);
process.exit(pass === total ? 0 : 1);
