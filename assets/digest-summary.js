/*
 * digest-summary.js — Today's Numbers for the dashboard widget.
 *
 * One call returning today's per-store scorecard line (franchise rank, total
 * sales, GP %) from digest_raw (filled every 4h by the daily-digest-sync
 * pg_cron via repairq-query's sync_digest). RLS is manager/owner (is_admin())
 * — non-managers resolve to zero rows and the widget shows nothing sensitive;
 * the widget itself is also rank-gated in index.html.
 *
 * Exposes window.CPRDigest:
 *   forToday() -> Promise<{date, capturedAt, stale, stores}|null>
 *     stores = [{ store, rank, total, gpPct }] in CPRLocations priority order
 *     stale  = true when the newest capture predates today (store time)
 *     null   = no session (or client failed to load)
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';
  var TZ = 'America/Los_Angeles';

  function N(v){ if (v == null || v === '') return null; if (typeof v === 'number') return isFinite(v) ? v : null;
    var n = parseFloat(String(v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; }
  function G(row, key){ if (!row) return null; if (key in row) return row[key];
    var o = row, p = key.split('.'); for (var i = 0; i < p.length; i++){ if (o && typeof o === 'object' && p[i] in o) o = o[p[i]]; else return null; } return o; }
  function storeOf(row){
    var c = G(row, 'location.short_name') || G(row, 'location.name') || G(row, 'store.name');
    if (!c){ var keys = Object.keys(row || {}); for (var i = 0; i < keys.length; i++){
      if (/location|store/i.test(keys[i]) && typeof row[keys[i]] === 'string' && row[keys[i]].trim()){ c = row[keys[i]]; break; } } }
    var L = root.CPRLocations; return c ? (L && L.normalize ? L.normalize(c) : c) : ''; }
  function storeSort(a, b){
    try{ var L = root.CPRLocations, la = L.find(a.store), lb = L.find(b.store);
      return (la ? la.order : 99) - (lb ? lb.order : 99) || String(a.store).localeCompare(String(b.store));
    }catch(e){ return String(a.store).localeCompare(String(b.store)); } }

  var sbP = null;
  function sb(){ if (sbP) return sbP;
    sbP = import('/assets/supabase-js.js').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; });
    return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s = r.data && r.data.session; if (s) return s;
      try{ var raw = localStorage.getItem('sb-' + SB_REF + '-auth-token'); if (!raw) return null; var o = JSON.parse(raw);
        var at = o.access_token || (o.currentSession && o.currentSession.access_token), rt = o.refresh_token || (o.currentSession && o.currentSession.refresh_token);
        if (at && rt) return client.auth.setSession({ access_token: at, refresh_token: rt }).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data && r2.data.session; });
      }catch(e){} return null; });
  }

  var memo = null;
  function forToday(){
    if (memo) return memo;
    memo = sb().then(function(client){
      if (!client) return null;
      return session(client).then(function(s){
        if (!s) return null;
        var since = new Date(Date.now() - 8 * 864e5).toLocaleDateString('en-CA', { timeZone: TZ });
        return client.from('digest_raw').select('capture_date,rows,captured_at')
          .eq('tile_key', 'daily_digest').gte('capture_date', since)
          .order('capture_date', { ascending: false }).limit(1)
          .then(function(q){
            var row = q.data && q.data[0];
            if (q.error || !row) return { date: null, capturedAt: null, stale: false, stores: [] };
            var stores = (Array.isArray(row.rows) ? row.rows : []).map(function(r){
              var total = N(G(r, 'ticket_item.all_net_sale_total')), gp = N(G(r, 'ticket_item.all_net_sale_after_cogs_total'));
              return { store: storeOf(r), rank: N(G(r, 'ranked_net_sales_mtd.rank')),
                total: total, gpPct: (gp == null || !total) ? null : gp / total };
            }).filter(function(x){ return x.store; }).sort(storeSort);
            var today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
            return { date: row.capture_date, capturedAt: row.captured_at, stale: row.capture_date !== today, stores: stores };
          });
      });
    }).catch(function(){ return null; });
    return memo;
  }

  root.CPRDigest = { forToday: forToday };
})(typeof window !== 'undefined' ? window : this);
