/*
 * holiday-summary.js — upcoming-holiday checklist for the dashboard.
 *
 * Reads the auto-seeded `holidays` (+ `holiday_catalog.observed`) and returns the
 * near-term holidays that need a manager's attention:
 *   needsHours — store-observed holiday whose hours aren't confirmed yet
 *   bank       — federal/bank holiday (payroll may need to run early)
 *
 * Exposes window.CPRHolidays.forChecklist({days}) ->
 *   Promise<{ items:[{id,name,date,daysAway,is_federal,observed,confirmed,needsHours}], needCount }|null>
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function daysBetween(aISO,bISO){ var a=new Date(aISO+'T00:00:00'), b=new Date(bISO+'T00:00:00'); return Math.round((b-a)/86400000); }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }

  function forChecklist(opts){
    var days=(opts&&opts.days)||60;
    return sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        var today=iso(new Date()), until=iso(new Date(Date.now()+days*86400000));
        return Promise.all([
          client.from('holidays').select('id,name,holiday_date,is_federal,hours_confirmed,catalog_id').gte('holiday_date',today).lte('holiday_date',until).order('holiday_date'),
          client.from('holiday_catalog').select('id,observed')
        ]).then(function(res){
          var hols=(res[0]&&res[0].data)||[], cat=(res[1]&&res[1].data)||[];
          var catObs={}; cat.forEach(function(c){ catObs[c.id]=c.observed!==false; });
          var items=hols.map(function(h){
            var observed = h.catalog_id==null ? true : (catObs[h.catalog_id]!==false);
            var date=String(h.holiday_date).slice(0,10);
            return { id:h.id, name:h.name, date:date, daysAway:daysBetween(today,date),
              is_federal:!!h.is_federal, observed:observed, confirmed:!!h.hours_confirmed,
              needsHours: observed && !h.hours_confirmed };
          });
          var needCount=items.filter(function(i){ return i.needsHours; }).length;
          return { items:items, needCount:needCount };
        });
      });
    }).catch(function(){ return null; });
  }

  root.CPRHolidays = { forChecklist: forChecklist };
})(typeof window !== 'undefined' ? window : this);
