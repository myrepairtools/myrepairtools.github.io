/*
 * pto-summary.js — one-call PTO snapshot for the signed-in user.
 *
 * Reads the user's QuickBooks Time PTO balances (qbtime_users.raw.pto_balances,
 * labeled via qbtime_jobcodes) so My Time and the My Hub widget share one source.
 *
 * Exposes window.CPRPTO.forMe() -> Promise<summary|null>.
 *   summary = { balances:[{name, hours}], totalHours }   (sorted, hours>0-first)
 *   null    = not signed in / not linked to QuickBooks Time / no balances.
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  var sbP = null;
  function sb(){ if(sbP) return sbP; sbP = import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }

  var memo = null;
  function forMe(){
    if(memo) return memo;
    memo = sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        return client.from('staff').select('id').eq('auth_uid', s.user.id).maybeSingle().then(function(meR){
          var me = meR.data; if(!me) return null;
          return Promise.all([
            client.from('qbtime_users').select('raw').eq('staff_id', me.id).maybeSingle(),
            client.from('qbtime_jobcodes').select('qbt_id,name,type').eq('type','pto')
          ]).then(function(res){
            var u = res[0].data, jc = res[1].data || [];
            var bal = (u && u.raw && u.raw.pto_balances) || null;
            if(!bal || typeof bal !== 'object') return null;
            var names = {}; jc.forEach(function(j){ names[String(j.qbt_id)] = j.name; });
            var balances = [];
            Object.keys(bal).forEach(function(k){ if(!names[k]) return;   // pto jobcodes only
              balances.push({ name: names[k], hours: Math.round((Number(bal[k])/3600) * 10) / 10 }); });
            if(!balances.length) return null;
            balances.sort(function(a,b){ return b.hours - a.hours; });
            var total = Math.round(balances.reduce(function(s2,b2){ return s2 + b2.hours; }, 0) * 10) / 10;
            return { balances: balances, totalHours: total };
          });
        });
      });
    }).catch(function(){ return null; });
    return memo;
  }

  root.CPRPTO = { forMe: forMe };
})(typeof window !== 'undefined' ? window : this);
