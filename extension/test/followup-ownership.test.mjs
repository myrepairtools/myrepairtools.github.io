/* Boot the REAL followUp.js against a mock RepairQ ticket page in jsdom and
   assert what reaches contact_set. Static checks can't prove boot() runs at
   all — this does. Mock DOM mirrors RepairQ's real sidebar (CLAUDE.md): a
   `.sub-head h3` reading "Customer" with a sibling `.block-content` carrying a
   phone, narrower than 480px (jsdom reports offsetWidth 0, which passes). */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const SRC = readFileSync('/Users/brittbay/Documents/GitHub/myrepairtools.github.io/extension/scripts/followUp.js', 'utf8');

function ticketPage({ custId, phone }) {
  return `<!doctype html><html><body>
    <div id="summary"><div class="block-content"><span class="fullsize label">New</span></div></div>
    <div class="location tooltip-toggle"><span>CPR Eugene</span></div>
    <div id="user_dropdown">Bay, Britt</div>
    <div class="sub-head"><h3>Customer</h3></div>
    <div class="block-content">
      <a href="/customers/${custId}">Smith, Jane</a><br>${phone}
    </div>
  </body></html>`;
}

async function run(name, { url, custId, phone, stash, checkinTs, expect }) {
  const dom = new JSDOM(ticketPage({ custId, phone }), { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  if (stash) w.sessionStorage.setItem('mrt_fu_pending', JSON.stringify({ p: stash, ts: Date.now() }));
  if (checkinTs) w.sessionStorage.setItem('mrt_fu_checkin', String(Date.now()));

  const sent = [];
  w.chrome = {
    runtime: {
      lastError: null,
      getManifest: () => ({ version: '2.8.3-test' }),
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (typeof cb === 'function') setTimeout(() => cb({ ok: true }), 0);
      },
    },
    storage: { sync: { get: () => Promise.resolve({ sms: { followUp: true }, tt: null }) } },
  };

  // run the IIFE with the jsdom window as its global
  const fn = new w.Function('chrome', 'window', 'document', 'location', 'sessionStorage', 'setTimeout', 'clearTimeout', 'MutationObserver', SRC);
  fn.call(w, w.chrome, w, w.document, w.location, w.sessionStorage, w.setTimeout, w.clearTimeout, w.MutationObserver);

  await new Promise(r => setTimeout(r, 1200));   // let boot's waits settle

  const cs = sent.filter(m => m.type === 'sms:contact_set').map(m => m.payload);
  const got = cs.length ? { number: cs[0].number || '', method: cs[0].method } : null;
  const ok = expect === null ? got === null
           : !!got && got.number === expect.number && got.method === expect.method;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  console.log(`        contact_set -> ${got ? JSON.stringify(got) : 'not called'}   (want ${expect ? JSON.stringify(expect) : 'not called'})`);
  return ok;
}

let pass = 0, total = 0;
const T = async (n, o) => { total++; if (await run(n, o)) pass++; };

// #592: tech typed a number that is NOT on the customer's record. 2.8.2 dropped it.
await T('#592  hand-typed number, own customer -> FLUSHES', {
  url: 'https://cpr.repairq.io/ticket/16254502', custId: '77', phone: '541-111-2222',
  stash: { method: 'text', number: '5419998888', name: 'Jane', cust: '77' },
  checkinTs: true, expect: { number: '5419998888', method: 'text' },
});

// #3106: someone else's check-in must not land here.
await T('#3106 other customer\'s stash        -> HELD ', {
  url: 'https://cpr.repairq.io/ticket/16254502', custId: '88', phone: '541-111-2222',
  stash: { method: 'text', number: '5419998888', name: 'Jane', cust: '77' },
  checkinTs: true, expect: null,
});

// the ordinary case must keep working
await T('normal  number IS on the record       -> FLUSHES', {
  url: 'https://cpr.repairq.io/ticket/16254502', custId: '77', phone: '541-999-8888',
  stash: { method: 'text', number: '5419998888', name: 'Jane', cust: '77' },
  checkinTs: true, expect: { number: '5419998888', method: 'text' },
});

// contact-less skip stash from another customer (the leak still open in 2.8.2)
await T('leak    skip stash, other customer    -> HELD ', {
  url: 'https://cpr.repairq.io/ticket/16254502', custId: '88', phone: '541-111-2222',
  stash: { method: 'skip', cust: '77' }, checkinTs: true, expect: null,
});

console.log(`\n  ${pass}/${total} DOM scenarios passed`);
process.exit(pass === total ? 0 : 1);
