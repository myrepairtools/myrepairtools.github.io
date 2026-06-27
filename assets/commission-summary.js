/*
 * commission-summary.js — one-call commission snapshot for the signed-in user.
 *
 * Returns the current-month { commission, tips, total, goal } for whoever is
 * logged in, reusing the SAME math as the full Commission Dashboard (the shared
 * commission-engine.js) so the dashboard widget and the full page never drift.
 *
 * Requires window.CommissionEngine (load assets/commission-engine.js first).
 * Exposes window.CPRCommissionSummary.forMe() -> Promise<summary|null>.
 *   summary = { commission, tips, total, goal, goalCurrent, goalLabel, name }
 *   null    = not signed in / no staff row / owner (doesn't earn commission).
 */
(function (root) {
  'use strict';

  var SB_URL = 'https://xuvsehrevxackuhmbmry.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  var ROLE_ALIAS = { owner:'owner', admin:'admin', manager:'admin', employee:'team_member', team_member:'team_member' };
  function normRole(r){ return ROLE_ALIAS[r] || r; }
  function EXCLUDE(s){ return /^\s*britt\s+bay\s*$/i.test((s && s.display_name) || ''); }   // owner doesn't earn

  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function monthInfo(){ var n=new Date(), y=n.getFullYear(), m=n.getMonth();
    return { start:iso(new Date(y,m,1)), end:iso(n), period:y+'-'+('0'+(m+1)).slice(-2) }; }

  function blankTotals(){ return { Tickets:0,AccyUnits:0,NetAccySales:0,AccyGP:0,DeviceUnits:0,DeviceReturns:0,DeviceRev:0,DeviceGP:0,DeviceAttach:0,ServiceNet:0,services:{} }; }
  function addInto(t,r){
    t.Tickets+=Number(r.tickets)||0; t.AccyUnits+=Number(r.accy_units)||0; t.NetAccySales+=Number(r.accy_net)||0; t.AccyGP+=Number(r.accy_gp)||0;
    t.DeviceUnits+=Number(r.device_units)||0; t.DeviceReturns+=Number(r.device_returns)||0;
    t.DeviceRev+=(Number(r.device_net)||0)+(Number(r.device_return_net)||0);
    t.DeviceGP+=(Number(r.device_gp)||0)+(Number(r.device_return_gp)||0);
    t.DeviceAttach+=(Number(r.device_attach)||0)-(Number(r.device_attach_return)||0);
    t.ServiceNet+=Number(r.service_net)||0;
    var sv=r.services||{}; for(var k in sv){ t.services[k]=(t.services[k]||0)+(Number(sv[k])||0); }
  }

  /* tip share for a name: hours/total * pool, summed over stores (mirrors the dashboard) */
  function tipFor(name, tips){ var total=0; for(var store in tips){ var d=tips[store]||{}, pool=+d.pool||0, hrs=d.hours||{}; if(!pool) continue;
    var totHrs=0; for(var nm in hrs){ var h=hrs[nm]||{}; totHrs+=(+h.pp1||0)+(+h.pp2||0); }
    var hh=hrs[name]||{}, my=(+hh.pp1||0)+(+hh.pp2||0); if(totHrs>0&&my>0) total+=(my/totHrs)*pool; }
    return total; }

  var sbP = null;
  function sb(){ if(sbP) return sbP; sbP = import('https://esm.sh/@supabase/supabase-js@2')
      .then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }

  function session(client){
    return client.auth.getSession().then(function(r){
      var s = r.data && r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-xuvsehrevxackuhmbmry-auth-token'); if(!raw) return null;
        var o=JSON.parse(raw); var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){}
      return null;
    });
  }

  var memo = null;
  function forMe(){
    if (memo) return memo;
    memo = (function(){
      var E = root.CommissionEngine; if(!E) return Promise.resolve(null);
      var mi = monthInfo();
      return sb().then(function(client){
        if(!client) return null;
        return session(client).then(function(s){
          if(!s) return null;
          return client.from('staff').select('id,display_name,role,home_store').eq('auth_uid', s.user.id).maybeSingle().then(function(meR){
            var me = meR.data; if(!me || EXCLUDE(me)) return null;
            return Promise.all([
              client.from('commission_rates').select('*').order('sort'),
              client.from('commission_rules').select('*'),
              client.from('commission_roster').select('*').eq('staff_id', me.id),
              client.from('roles').select('id,key'),
              client.from('permissions').select('id,key').like('key','commission.earn.%'),
              client.from('role_permissions').select('role_id,permission_id'),
              client.from('commission_role_overrides').select('*'),
              client.from('commission_sales').select('*').eq('staff_id', me.id).gte('biz_date', mi.start).lte('biz_date', mi.end),
              client.from('commission_tips').select('*').eq('period', mi.period)
            ]).then(function(res){
              var rt=res[0], rl=res[1], rs=res[2], rr=res[3], pm=res[4], rp=res[5], ro=res[6], sales=res[7], tp=res[8];

              var rates={}, rateLabels={}; (rt.data||[]).forEach(function(r){
                rates[r.sku]=(r.tiers&&r.tiers.goal)?{goal:Number(r.tiers.goal)||0,lo:Number(r.tiers.lo)||0,hi:Number(r.tiers.hi)||0}:(Number(r.amount)||0); rateLabels[r.sku]=r.label||r.sku; });
              var rules={}, storeRates={}; (rl.data||[]).forEach(function(r){ rules[r.store]=r.rules||{}; storeRates[r.store]=r.rates||{}; });
              var roleKeyById={}; (rr.data||[]).forEach(function(r){ roleKeyById[r.id]=r.key; });
              var permStream={}; (pm.data||[]).forEach(function(p){ permStream[p.id]=p.key.split('.').pop(); });
              var roleEarns={}; (rr.data||[]).forEach(function(r){ roleEarns[r.key]={accessory:false,device:false,services:false}; });
              (rp.data||[]).forEach(function(x){ var rk=roleKeyById[x.role_id], st=permStream[x.permission_id]; if(rk&&st&&roleEarns[rk]) roleEarns[rk][st]=true; });
              var roleOver={}; (ro.data||[]).forEach(function(x){ var rk=roleKeyById[x.role_id]; if(rk) roleOver[rk]={rules:x.rules||{},rates:x.rates||{}}; });
              var ros=(rs.data&&rs.data[0])||null;

              // effective config for me: Store(home) -> Role -> Person
              var roleKey=normRole(me.role);
              var roleE=roleEarns[roleKey]||{accessory:true,device:true,services:true};
              var earns=E.resolveEarns(roleE, ros&&ros.earns_override);
              var rov=roleOver[roleKey]||null;
              var home=me.home_store;
              var effRules=E.mergeRules(rules[home], rov&&rov.rules, ros&&ros.rules_override);
              var effRates=E.mergeRates(rates, storeRates[home], rov&&rov.rates, ros&&ros.rates_override);
              var goal=ros?Number(ros.accy_goal)||0:0;

              var totals=blankTotals(); (sales.data||[]).forEach(function(r){ addInto(totals,r); });
              var c=E.computeCommission(totals,{ accessoryGoal:goal, accDeviceUnits:totals.DeviceAttach, rates:effRates, earns:earns, rules:effRules });

              var tips={}; (tp.data||[]).forEach(function(x){ tips[x.store]={hours:x.hours||{},pool:Number(x.pool)||0}; });
              var tip=tipFor(me.display_name, tips);

              return {
                name: me.display_name,
                commission: c.total,
                tips: tip,
                total: c.total + tip,
                goal: goal,
                goalCurrent: totals.NetAccySales,
                goalLabel: 'Accessory goal'
              };
            });
          });
        });
      }).catch(function(){ return null; });
    })();
    return memo;
  }

  root.CPRCommissionSummary = { forMe: forMe };
})(typeof window !== 'undefined' ? window : this);
