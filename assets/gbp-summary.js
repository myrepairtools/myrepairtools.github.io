/*
 * gbp-summary.js — Google Business Profile snapshot for the dashboard widget.
 *
 * One call returning the per-store lifetime rating plus the unanswered-review
 * picture, straight from the gbp_* tables the gbp-sync edge function fills
 * nightly (see docs/GBP_DESIGN_HANDOFF.md). RLS: any signed-in staff can read;
 * the widget itself is manager-gated in index.html.
 *
 * Exposes window.CPRGbp:
 *   snapshot() -> Promise<{stores, unanswered, newest, lastSync}|null>
 *     stores     = [{ store, rating, count, open }] in CPRLocations priority order
 *                  (open = that store's unanswered count — the 60-width
 *                  "waiting on a reply" column)
 *     unanswered = { count, oldestHours }        (live reviews with no reply)
 *     newest     = latest 5★ WITH text { store, stars, comment, reviewer, at } | null
 *     lastSync   = newest gbp_locations.last_sync_at (null → not connected yet)
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function storeSort(a, b){
    try{
      var la = root.CPRLocations && CPRLocations.find && CPRLocations.find(a.store),
          lb = root.CPRLocations && CPRLocations.find && CPRLocations.find(b.store);
      var oa = la ? la.order : 99, ob = lb ? lb.order : 99;
      return oa - ob || String(a.store).localeCompare(String(b.store));
    }catch(e){ return String(a.store).localeCompare(String(b.store)); }
  }

  var sbP = null;
  function sb(){ if (sbP) return sbP; sbP = import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s = r.data && r.data.session; if (s) return s;
      try{ var raw = localStorage.getItem('sb-' + SB_REF + '-auth-token'); if (!raw) return null; var o = JSON.parse(raw);
        var at = o.access_token || (o.currentSession && o.currentSession.access_token), rt = o.refresh_token || (o.currentSession && o.currentSession.refresh_token);
        if (at && rt) return client.auth.setSession({ access_token: at, refresh_token: rt }).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data && r2.data.session; });
      }catch(e){} return null; });
  }

  var memo = null;
  function snapshot(){
    if (memo) return memo;
    memo = sb().then(function(client){
      if (!client) return null;
      return session(client).then(function(s){
        if (!s) return null;
        return Promise.all([
          client.from('gbp_locations').select('store,rating,review_count,last_sync_at'),
          client.from('gbp_reviews').select('id,store,stars,comment,reviewer_name,created_at')
            .is('reply_text', null).is('deleted_at', null).eq('legacy_unanswered', false)
            .order('created_at', { ascending: true }).limit(200),
          client.from('gbp_reviews').select('store,stars,comment,reviewer_name,created_at')
            .is('deleted_at', null).eq('stars', 5).not('comment', 'is', null)
            .order('created_at', { ascending: false }).limit(1),
        ]).then(function(rs){
          var locs = (rs[0].data || []), un = (rs[1].data || []), nw = (rs[2].data || [])[0] || null;
          if (!locs.length) return { stores: [], unanswered: { count: 0, oldestHours: 0 }, newest: null, lastSync: null };
          var openBy = {};
          un.forEach(function(r){ openBy[r.store] = (openBy[r.store] || 0) + 1; });
          var stores = locs.map(function(l){ return { store: l.store, rating: l.rating != null ? Number(l.rating) : null, count: l.review_count != null ? Number(l.review_count) : null, open: openBy[l.store] || 0 }; }).sort(storeSort);
          var lastSync = locs.map(function(l){ return l.last_sync_at; }).filter(Boolean).sort().pop() || null;
          var oldestHours = un.length ? Math.max(0, Math.round((Date.now() - new Date(un[0].created_at).getTime()) / 3600000)) : 0;
          var newest = nw ? { store: nw.store, stars: nw.stars, comment: nw.comment, reviewer: nw.reviewer_name, at: nw.created_at } : null;
          return { stores: stores, unanswered: { count: un.length, oldestHours: oldestHours }, newest: newest, lastSync: lastSync };
        });
      });
    }).catch(function(){ return null; });
    return memo;
  }

  root.CPRGbp = { snapshot: snapshot };
})(typeof window !== 'undefined' ? window : this);
