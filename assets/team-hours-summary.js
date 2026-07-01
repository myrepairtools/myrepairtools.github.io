/*
 * team-hours-summary.js — this-week team hours roll-up for managers.
 *
 * For every staff member the viewer can see (RLS-scoped), combines ACTUAL worked
 * hours (qbtime_timesheets) with REMAINING scheduled hours (staff_schedule → shift_hours,
 * same resolution as My Time / Schedule Admin) to project the week:
 *   worked      — hours clocked so far this week (Sun–Sat)
 *   shiftsLeft  — scheduled shifts still to come (today's unworked remainder + future days)
 *   remaining   — hours in those remaining shifts
 *   anticipated — worked + remaining
 *   ot          — max(0, anticipated − 40)      (OT rule: 40/wk, Sun–Sat)
 *
 * Exposes window.CPRTeamHours.forWeek() -> Promise<{ stores:[names], rows:[...] }|null>.
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }

  var SHIFT_BY_ID = {}, HOURS = {};
  function resolve(shiftId, store, wd){
    var h = HOURS[shiftId+'|'+store];
    if (!h || !h.def || !h.def.enabled) return null;
    var d = h.days[wd];
    if (d && d.closed) return null;
    if (d && d.start != null) return { start:d.start, end:d.end };
    if (h.def.closed) return null;
    return { start:h.def.start, end:h.def.end };
  }
  function labelToShift(label){ var n=String(label||'').trim().toLowerCase(); if(!n) return null;
    return Object.keys(SHIFT_BY_ID).map(function(k){return SHIFT_BY_ID[k];}).filter(function(s){return String(s.name||'').trim().toLowerCase()===n;})[0]||null; }
  function parseLabel(label){ var m=String(label||'').split(/\s*[-–]\s*/); if(m.length!==2) return null;
    function t(s){ var x=/(\d+)(?::(\d+))?\s*([AP]M)?/i.exec(String(s).trim()); if(!x) return null; var h=(+x[1])%12; if(/pm/i.test(x[3]||''))h+=12; return h*60+(+(x[2]||0)); }
    var a=t(m[0]),b=t(m[1]); return (a==null||b==null)?null:[a,b]; }
  // scheduled minutes for one staff (sched = their staff_schedule row) on weekday wd
  function schedMinutes(sched, wd){
    var sh=(sched&&sched.shifts)||{}, v=sh[String(wd)];
    if (v==null) return 0;
    if (typeof v==='string') v={ label:v };
    if (v==='off' || v.label==='Off') return 0;
    var sid=v.shift_id, store=v.store||(sched&&sched.store);
    if (sid==null && v.label){ var m=labelToShift(v.label); if(m) sid=m.id; }
    if (sid!=null){ var rd=resolve(sid, store, wd); if(rd&&rd.start!=null) return Math.max(0, rd.end-rd.start); }
    var pm=parseLabel(v.label); if(pm) return Math.max(0, pm[1]-pm[0]);
    return 0;
  }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }
  function storeSort(a,b){ try{ var la=root.CPRLocations&&CPRLocations.find&&CPRLocations.find(a), lb=root.CPRLocations&&CPRLocations.find&&CPRLocations.find(b); var oa=la?la.order:99, ob=lb?lb.order:99; return oa-ob||String(a).localeCompare(String(b)); }catch(e){ return String(a).localeCompare(String(b)); } }

  var memo=null;
  function forWeek(){
    if(memo) return memo;
    memo=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        var now=new Date(), wd0=now.getDay(), todayISO=iso(now);
        var sun=new Date(now.getFullYear(),now.getMonth(),now.getDate()-wd0);
        var wkStart=iso(sun), wkEnd=iso(new Date(sun.getFullYear(),sun.getMonth(),sun.getDate()+6));
        return Promise.all([
          client.from('staff').select('id,display_name,home_store,role,active,wage_type').eq('active',true),
          client.from('shifts').select('id,name,active'),
          client.from('shift_hours').select('shift_id,store,weekday,start_min,end_min,closed,enabled'),
          client.from('staff_schedule').select('staff_id,store,shifts'),
          client.from('qbtime_timesheets').select('staff_id,biz_date,seconds').gte('biz_date',wkStart).lte('biz_date',wkEnd),
          client.from('time_off_requests').select('staff_id,start_date,end_date,status').eq('status','approved').lte('start_date',wkEnd).gte('end_date',wkStart),
          client.from('schedule_overrides').select('staff_id,ovr_date,is_off,store,shift_id').gte('ovr_date',wkStart).lte('ovr_date',wkEnd)
        ]).then(function(res){
          var staff=res[0].data||[], sh=res[1].data||[], hr=res[2].data||[], sc=res[3].data||[], ts=res[4].data||[], off=res[5].data||[], ovr=res[6].data||[];
          var ovrBy={}; ovr.forEach(function(o){ ovrBy[o.staff_id+'|'+String(o.ovr_date).slice(0,10)]=o; });
          // effective scheduled minutes for a staff on a weekday/date: override wins over template
          function effMin(sid, wd, dISO, sched){
            var o=ovrBy[sid+'|'+dISO];
            if(o){ if(o.is_off) return 0; var rd=resolve(o.shift_id, o.store, wd); return (rd&&rd.start!=null)?Math.max(0,rd.end-rd.start):0; }
            return sched?schedMinutes(sched,wd):0;
          }
          // approved time off (paid OR unpaid — both blank the shift) per staff, as date ranges
          var offBy={}; off.forEach(function(o){ (offBy[o.staff_id]||(offBy[o.staff_id]=[])).push([o.start_date,o.end_date]); });
          function isOff(sid,dISO){ var rs=offBy[sid]; if(!rs) return false; for(var i=0;i<rs.length;i++){ if(rs[i][0]<=dISO && rs[i][1]>=dISO) return true; } return false; }
          function dateOfWd(wd){ return iso(new Date(sun.getFullYear(),sun.getMonth(),sun.getDate()+wd)); }
          SHIFT_BY_ID={}; sh.forEach(function(x){ SHIFT_BY_ID[x.id]=x; });
          HOURS={}; hr.forEach(function(r){ var k=r.shift_id+'|'+r.store, h=HOURS[k]||(HOURS[k]={def:null,days:{}}); var row={closed:!!r.closed,start:r.start_min,end:r.end_min,enabled:r.enabled!==false}; if(r.weekday==null)h.def=row; else h.days[r.weekday]=row; });
          var schedBy={}; sc.forEach(function(r){ schedBy[r.staff_id]={shifts:r.shifts||{},store:r.store}; });
          // worked seconds this week + today, per staff
          var workedWk={}, workedToday={};
          ts.forEach(function(r){ if(r.staff_id==null) return; workedWk[r.staff_id]=(workedWk[r.staff_id]||0)+(+r.seconds||0); if(r.biz_date===todayISO) workedToday[r.staff_id]=(workedToday[r.staff_id]||0)+(+r.seconds||0); });

          var rows=staff.map(function(e){
            var sched=schedBy[e.id]||null;
            var workedH=Math.round((workedWk[e.id]||0)/360)/10;
            // remaining = today's unworked scheduled remainder + all future scheduled days,
            // skipping any day the person has approved time off (paid or unpaid).
            var todaySchedMin=(!isOff(e.id,todayISO))?effMin(e.id,wd0,todayISO,sched):0;
            var todayWorkedMin=(workedToday[e.id]||0)/60;
            var todayRemMin=Math.max(0, todaySchedMin-todayWorkedMin);
            var futureMin=0, futureShifts=0;
            for(var wd=wd0+1; wd<=6; wd++){ var dISO=dateOfWd(wd); if(isOff(e.id,dISO)) continue; var m=effMin(e.id,wd,dISO,sched); if(m>0){ futureMin+=m; futureShifts++; } }
            var remMin=todayRemMin+futureMin;
            var remH=Math.round((remMin/60)*10)/10;
            var shiftsLeft=(todayRemMin>0?1:0)+futureShifts;
            var anticipated=Math.round((workedH+remH)*10)/10;
            var salary=(e.wage_type==='salary');
            var ot=salary?0:Math.max(0, Math.round((anticipated-40)*10)/10);   // salaried = OT-exempt
            return { staff_id:e.id, name:e.display_name, store:e.home_store, role:e.role, wageType:e.wage_type||'hourly', salary:salary,
              worked:workedH, shiftsLeft:shiftsLeft, remaining:remH, anticipated:anticipated, ot:ot };
          });
          var stores=[]; rows.forEach(function(r){ if(r.store && stores.indexOf(r.store)<0) stores.push(r.store); });
          stores.sort(storeSort);
          return { weekStart:wkStart, weekEnd:wkEnd, stores:stores, rows:rows };
        });
      });
    }).catch(function(){ return null; });
    return memo;
  }

  root.CPRTeamHours = { forWeek: forWeek };
})(typeof window !== 'undefined' ? window : this);
