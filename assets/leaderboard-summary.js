/*
 * leaderboard-summary.js — per-store sales leaderboard for the signed-in user.
 *
 * Ranks techs per store for the current month. RLS (can_see_store) scopes
 * commission_sales to stores the user may see, so a single-store tech only
 * pulls their own store, while managers/owner authorized at several locations
 * get every store they can see.
 *
 * Exposes window.CPRLeaderboard:
 *   forStores() -> Promise<{stores, byStore, meId, defaultStore}|null>
 *     stores       = [store names] in CPRLocations priority order
 *     byStore      = { store: [{ id, name, accy, devUnits, devAccy }] } (unsorted; widget ranks)
 *     defaultStore = viewer's home store if it has sales, else the busiest visible store
 *   forStore() -> Promise<{store, meId, rows}|null>   (legacy: the defaultStore slice)
 *     accy     = accessory $ sold (accy_net)
 *     devUnits = device units sold, net of returns
 *     devAccy  = accessories sold on those device tickets, net of returns (units)
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function storeSort(a,b){ try{ var la=root.CPRLocations&&CPRLocations.find&&CPRLocations.find(a), lb=root.CPRLocations&&CPRLocations.find&&CPRLocations.find(b); var oa=la?la.order:99, ob=lb?lb.order:99; return oa-ob||String(a).localeCompare(String(b)); }catch(e){ return String(a).localeCompare(String(b)); } }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL,ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }

  var memo=null;
  function forStores(){
    if(memo) return memo;
    var now=new Date(), start=iso(new Date(now.getFullYear(), now.getMonth(), 1)), end=iso(now);
    memo=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        return client.from('staff').select('id,display_name,home_store,authorized_stores,role').eq('auth_uid',s.user.id).maybeSingle().then(function(meR){
          var me=meR.data; if(!me) return null;
          // staff RLS hides other people's rows from a tech, so the name comes off the
          // sales row itself (commission_sales.employee), which is visible via can_see_store.
          return client.from('commission_sales')
            .select('staff_id,employee,store,accy_net,device_units,device_returns,device_attach,device_attach_return')
            .gte('biz_date',start).lte('biz_date',end).then(function(res){
            var sales=res.data||[];

            // aggregate every visible store in one pass: store -> staff -> totals
            var agg={}, byStoreCount={};
            sales.forEach(function(r){
              if(!r.store) return;
              byStoreCount[r.store]=(byStoreCount[r.store]||0)+1;
              var st=agg[r.store]||(agg[r.store]={});
              var a=st[r.staff_id]||(st[r.staff_id]={id:r.staff_id, name:r.employee||('Staff '+r.staff_id), accy:0, devUnits:0, devAccy:0});
              if(!a.name && r.employee) a.name=r.employee;
              a.accy += Number(r.accy_net)||0;
              a.devUnits += (Number(r.device_units)||0) - (Number(r.device_returns)||0);
              a.devAccy += (Number(r.device_attach)||0) - (Number(r.device_attach_return)||0);
            });
            var stores=Object.keys(agg).sort(storeSort);
            var byStore={};
            stores.forEach(function(st){ byStore[st]=Object.keys(agg[st]).map(function(k){ return agg[st][k]; }); });

            // default: the viewer's home store if it has sales, else the busiest store they can see
            var def=me.home_store;
            if(!def || !byStoreCount[def]){
              def=Object.keys(byStoreCount).sort(function(a,b){ return byStoreCount[b]-byStoreCount[a]; })[0] || me.home_store || null;
            }
            return { stores:stores, byStore:byStore, meId:me.id, defaultStore:def };
          });
        });
      });
    }).catch(function(){ return null; });
    return memo;
  }
  // legacy single-store shape (defaultStore slice)
  function forStore(){
    return forStores().then(function(d){
      if(!d) return null;
      return { store:d.defaultStore, meId:d.meId, rows:(d.defaultStore&&d.byStore[d.defaultStore])||[] };
    });
  }

  root.CPRLeaderboard = { forStores: forStores, forStore: forStore };
})(typeof window !== 'undefined' ? window : this);
