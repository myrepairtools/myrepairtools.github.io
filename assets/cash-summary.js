/*
 * cash-summary.js — live store cash position for the dashboard widget.
 *
 * Numbers come from the newest CLOSED cash audit per store (verified counts,
 * per drawer/safe from cash_audit_locations), with a flag when a newer audit
 * is open (count in progress). RLS (is_admin(store)) scopes both tables, so a
 * store manager only pulls their own store(s) and the owner sees all.
 *
 * Exposes window.CPRCashStatus:
 *   forStores() -> Promise<{stores, byStore, defaultStore}|null>
 *     stores       = [store names] in CPRLocations priority order
 *     byStore      = { store: { period, closedAt, daysAgo, inProgress,
 *                       locations:[{location, counted, overShort}],
 *                       total, overShort } }
 *     defaultStore = viewer's home store when visible, else first visible
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function storeSort(a, b) {
    try {
      var la = root.CPRLocations && CPRLocations.find && CPRLocations.find(a),
          lb = root.CPRLocations && CPRLocations.find && CPRLocations.find(b);
      var oa = la ? la.order : 99, ob = lb ? lb.order : 99;
      return oa - ob || String(a).localeCompare(String(b));
    } catch (e) { return String(a).localeCompare(String(b)); }
  }

  var sbP = null;
  function sb() {
    if (sbP) return sbP;
    sbP = import('/assets/supabase-js.js').then(function (m) { return m.createClient(SB_URL, ANON); }).catch(function () { return null; });
    return sbP;
  }
  function session(client) {
    return client.auth.getSession().then(function (r) {
      var s = r.data && r.data.session; if (s) return s;
      try {
        var raw = localStorage.getItem('sb-' + SB_REF + '-auth-token'); if (!raw) return null;
        var o = JSON.parse(raw);
        var at = o.access_token || (o.currentSession && o.currentSession.access_token),
            rt = o.refresh_token || (o.currentSession && o.currentSession.refresh_token);
        if (at && rt) return client.auth.setSession({ access_token: at, refresh_token: rt })
          .then(function () { return client.auth.getSession(); })
          .then(function (r2) { return r2.data && r2.data.session; });
      } catch (e) {}
      return null;
    });
  }

  var memo = null;
  function forStores() {
    if (memo) return memo;
    memo = sb().then(function (client) {
      if (!client) return null;
      return session(client).then(function (s) {
        if (!s) return null;
        return Promise.all([
          client.from('staff').select('home_store').eq('auth_uid', s.user.id).maybeSingle(),
          // last few audits per visible store in one pull (RLS trims to my stores)
          client.from('cash_audits')
            .select('id,store,period,status,closed_at,period_end,over_short')
            .is('deleted_at', null)
            .order('period_end', { ascending: false })
            .limit(24)
        ]).then(function (res) {
          var me = res[0].data, audits = res[1].data || [];
          if (res[1].error) return null;                      // auth/load problem — widget shows a retry message
          if (!audits.length) return { stores: [], byStore: {}, defaultStore: null };  // genuinely no audits

          // newest CLOSED audit per store carries the numbers; a newer open one = counting now
          var pick = {}, inProg = {};
          audits.forEach(function (a) {
            if (a.status === 'closed') { if (!pick[a.store]) pick[a.store] = a; }
            else if (!pick[a.store]) inProg[a.store] = true;   // open & newer than any closed
          });
          var ids = Object.keys(pick).map(function (st) { return pick[st].id; });
          if (!ids.length) return null;

          return client.from('cash_audit_locations')
            .select('audit_id,location,counted,over_short')
            .in('audit_id', ids).then(function (locRes) {
            var locs = locRes.data || [];
            var byStore = {};
            Object.keys(pick).forEach(function (st) {
              var a = pick[st];
              var rows = locs.filter(function (l) { return l.audit_id === a.id; })
                .map(function (l) { return { location: l.location, counted: Number(l.counted) || 0, overShort: Number(l.over_short) || 0 }; })
                .sort(function (x, y) { return String(x.location).localeCompare(String(y.location)); });
              var total = 0; rows.forEach(function (r) { total += r.counted; });
              byStore[st] = {
                period: a.period, closedAt: a.closed_at,
                daysAgo: a.closed_at ? Math.floor((Date.now() - new Date(a.closed_at).getTime()) / 864e5) : null,
                inProgress: !!inProg[st],
                locations: rows, total: total,
                overShort: Number(a.over_short) || 0
              };
            });
            var stores = Object.keys(byStore).sort(storeSort);
            var defaultStore = (me && me.home_store && byStore[me.home_store]) ? me.home_store : stores[0];
            return { stores: stores, byStore: byStore, defaultStore: defaultStore };
          });
        });
      });
    }).catch(function () { return null; });
    return memo;
  }

  root.CPRCashStatus = { forStores: forStores };
})(window);
