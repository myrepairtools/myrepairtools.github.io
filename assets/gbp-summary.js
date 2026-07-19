/*
 * gbp-summary.js — Google Reviews snapshot for the dashboard widget.
 *
 * Reads the gbp_review_stats view + the newest review (RLS: any signed-in
 * staff — the widget is a motivation surface, the full Google Traffic page
 * stays manager-only). Data lands nightly via the gbp-sync edge function.
 *
 * Exposes window.CPRGbp:
 *   summary() -> Promise<{stores, unanswered, oldestUnansweredAt, newest}|null>
 *     stores  = [{ store, rating, total, unanswered }] in CPRLocations order
 *     newest  = { store, stars, comment, reviewer_name, created_at } | null
 *   null = signed out, no data yet, or GBP not deployed — widget shows empty state.
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  var sbP = null;
  function sb(){ if (sbP) return sbP; sbP = import('/assets/supabase-js.js').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s = r.data && r.data.session; if (s) return s;
      try{ var raw = localStorage.getItem('sb-' + SB_REF + '-auth-token'); if (!raw) return null; var o = JSON.parse(raw);
        var at = o.access_token || (o.currentSession && o.currentSession.access_token), rt = o.refresh_token || (o.currentSession && o.currentSession.refresh_token);
        if (at && rt) return client.auth.setSession({ access_token: at, refresh_token: rt }).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data && r2.data.session; });
      }catch(e){} return null; });
  }
  function storeSort(a, b){
    try{ var la = root.CPRLocations && CPRLocations.find(a.store), lb = root.CPRLocations && CPRLocations.find(b.store);
      return (la ? la.order : 99) - (lb ? lb.order : 99) || String(a.store).localeCompare(String(b.store)); }
    catch(e){ return 0; }
  }

  var memo = null;
  function summary(){
    if (memo) return memo;
    memo = sb().then(function(client){
      if (!client) return null;
      return session(client).then(function(s){
        if (!s) return null;
        return Promise.all([
          client.from('gbp_review_stats').select('*'),
          client.from('gbp_reviews').select('store,stars,comment,reviewer_name,created_at')
            .is('deleted_at', null).order('created_at', { ascending: false }).limit(1)
        ]).then(function(r){
          var stats = (r[0].data || []), newest = (r[1].data || [])[0] || null;
          if (!stats.length) return null;
          var stores = stats.map(function(x){
            return { store: x.store, rating: x.avg_rating != null ? Number(x.avg_rating) : null,
              total: Number(x.total) || 0, unanswered: Number(x.unanswered) || 0,
              oldestUnansweredAt: x.oldest_unanswered_at || null };
          }).sort(storeSort);
          var un = 0, oldest = null;
          stores.forEach(function(x){ un += x.unanswered;
            if (x.oldestUnansweredAt && (!oldest || x.oldestUnansweredAt < oldest)) oldest = x.oldestUnansweredAt; });
          return { stores: stores, unanswered: un, oldestUnansweredAt: oldest, newest: newest };
        });
      });
    }).catch(function(){ return null; });
    return memo;
  }

  root.CPRGbp = { summary: summary };
})(typeof window !== 'undefined' ? window : this);
