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
    var w=schedWindow(sched, wd); return w?Math.max(0, w.end-w.start):0;
  }
  // resolved [start,end] window (+ store) for a staff's scheduled shift on weekday wd; null if off/none
  function schedWindow(sched, wd){
    var sh=(sched&&sched.shifts)||{}, v=sh[String(wd)];
    if (v==null) return null;
    if (typeof v==='string') v={ label:v };
    if (v==='off' || v.label==='Off') return null;
    var sid=v.shift_id, store=v.store||(sched&&sched.store);
    if (sid==null && v.label){ var m=labelToShift(v.label); if(m) sid=m.id; }
    if (sid!=null){ var rd=resolve(sid, store, wd); if(rd&&rd.start!=null) return { start:rd.start, end:rd.end, store:store }; }
    var pm=parseLabel(v.label); if(pm) return { start:pm[0], end:pm[1], store:store };
    return null;
  }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('/assets/supabase-js.js').then(function(m){ return m.createClient(SB_URL, ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }
  function storeSort(a,b){ try{ var la=root.CPRLocations&&CPRLocations.find&&CPRLocations.find(a), lb=root.CPRLocations&&CPRLocations.find&&CPRLocations.find(b); var oa=la?la.order:99, ob=lb?lb.order:99; return oa-ob||String(a).localeCompare(String(b)); }catch(e){ return String(a).localeCompare(String(b)); } }

  // memoized per week-start ('_this' = current week). forWeek(weekStartISO) lets the
  // Overtime Report page through any week; the dashboard widget calls forWeek() (this week).
  var memo={};
  function forWeek(weekStartISO){
    // Key by today's date too: "shifts left" and worked-vs-scheduled split at `today`,
    // so a tab left open across midnight must recompute instead of serving a stale count.
    var key=(weekStartISO||'_this')+'@'+iso(new Date());
    if(memo[key]) return memo[key];
    memo[key]=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        var todayISO=iso(new Date()), sun;
        if(weekStartISO){ var p=String(weekStartISO).split('-').map(Number); sun=new Date(p[0],p[1]-1,p[2]); }
        else { var now=new Date(); sun=new Date(now.getFullYear(),now.getMonth(),now.getDate()-now.getDay()); }
        var wkStart=iso(sun), wkEnd=iso(new Date(sun.getFullYear(),sun.getMonth(),sun.getDate()+6));
        return Promise.all([
          client.from('staff').select('id,display_name,home_store,role,active,wage_type').eq('active',true),
          client.from('shifts').select('id,name,active'),
          client.from('shift_hours').select('shift_id,store,weekday,start_min,end_min,closed,enabled'),
          client.from('staff_schedule').select('staff_id,store,shifts'),
          client.from('qbtime_timesheets').select('staff_id,biz_date,seconds,off_seconds,on_the_clock').gte('biz_date',wkStart).lte('biz_date',wkEnd),
          client.from('time_off_requests').select('staff_id,start_date,end_date,status').eq('status','approved').lte('start_date',wkEnd).gte('end_date',wkStart),
          client.from('schedule_overrides').select('staff_id,ovr_date,is_off,store,shift_id').gte('ovr_date',wkStart).lte('ovr_date',wkEnd),
          client.from('holidays').select('id,holiday_date').gte('holiday_date',wkStart).lte('holiday_date',wkEnd),
          client.from('holiday_hours').select('holiday_id,store,closed,open_min,close_min')
        ]).then(function(res){
          var staff=res[0].data||[], sh=res[1].data||[], hr=res[2].data||[], sc=res[3].data||[], ts=res[4].data||[], off=res[5].data||[], ovr=res[6].data||[], hols=(res[7]&&res[7].data)||[], holh=(res[8]&&res[8].data)||[];
          var ovrBy={}; ovr.forEach(function(o){ ovrBy[o.staff_id+'|'+String(o.ovr_date).slice(0,10)]=o; });
          // holiday effect: date -> holiday_id, then holiday_id|store -> {closed,open_min,close_min}
          var holByDate={}; hols.forEach(function(h){ holByDate[String(h.holiday_date).slice(0,10)]=h.id; });
          var holhBy={}; holh.forEach(function(r){ holhBy[r.holiday_id+'|'+r.store]=r; });
          function holEffect(store, dISO){ var hid=holByDate[dISO]; if(hid==null) return null; return holhBy[hid+'|'+store]||null; }
          // clamp a resolved window to a holiday (closed -> 0), else full duration
          function clampHol(win, store, dISO){ if(!win) return 0; var hh=holEffect(store, dISO);
            if(hh){ if(hh.closed) return 0; return Math.max(0, Math.min(win.end, hh.close_min)-Math.max(win.start, hh.open_min)); }
            return Math.max(0, win.end-win.start); }
          // effective scheduled minutes for a staff on a weekday/date: override wins over template, holiday clamps
          function effMin(sid, wd, dISO, sched){
            var o=ovrBy[sid+'|'+dISO];
            if(o){ if(o.is_off) return 0; var rd=resolve(o.shift_id, o.store, wd); return (rd&&rd.start!=null)?clampHol({start:rd.start,end:rd.end}, o.store, dISO):0; }
            return sched?clampHol(schedWindow(sched,wd), (schedWindow(sched,wd)||{}).store, dISO):0;
          }
          // approved time off (paid OR unpaid — both blank the shift) per staff, as date ranges
          var offBy={}; off.forEach(function(o){ (offBy[o.staff_id]||(offBy[o.staff_id]=[])).push([o.start_date,o.end_date]); });
          function isOff(sid,dISO){ var rs=offBy[sid]; if(!rs) return false; for(var i=0;i<rs.length;i++){ if(rs[i][0]<=dISO && rs[i][1]>=dISO) return true; } return false; }
          function dateOfWd(wd){ return iso(new Date(sun.getFullYear(),sun.getMonth(),sun.getDate()+wd)); }
          SHIFT_BY_ID={}; sh.forEach(function(x){ SHIFT_BY_ID[x.id]=x; });
          HOURS={}; hr.forEach(function(r){ var k=r.shift_id+'|'+r.store, h=HOURS[k]||(HOURS[k]={def:null,days:{}}); var row={closed:!!r.closed,start:r.start_min,end:r.end_min,enabled:r.enabled!==false}; if(r.weekday==null)h.def=row; else h.days[r.weekday]=row; });
          var schedBy={}; sc.forEach(function(r){ schedBy[r.staff_id]={shifts:r.shifts||{},store:r.store}; });
          // worked seconds this week (total) + per date, and whether they're on the clock now
          var workedWk={}, workedByDate={}, onClock={};
          ts.forEach(function(r){ if(r.staff_id==null) return;
            var w=Math.max(0,(+r.seconds||0)-(+r.off_seconds||0));   // PTO/unpaid time off isn't worked time
            workedWk[r.staff_id]=(workedWk[r.staff_id]||0)+w;
            if(r.biz_date){ (workedByDate[r.staff_id]||(workedByDate[r.staff_id]={}))[r.biz_date]=(workedByDate[r.staff_id][r.biz_date]||0)+w; }
            if(r.on_the_clock) onClock[r.staff_id]=true; });

          var rows=staff.map(function(e){
            var sched=schedBy[e.id]||null;
            var workedH=Math.round((workedWk[e.id]||0)/360)/10;   // whole-week worked (minute-accurate)
            // Per-day grid + minute-accurate projection:
            //   past day  -> counts actual worked ; today -> max(worked, scheduled) ; future -> scheduled
            var days=[], expMin=0, shiftsLeft=0;
            for(var wd=0; wd<=6; wd++){
              var dISO=dateOfWd(wd);
              var timeoff=isOff(e.id,dISO);
              var schedMin=timeoff?0:effMin(e.id,wd,dISO,sched);
              var workedMin=((workedByDate[e.id]&&workedByDate[e.id][dISO])||0)/60;
              var exp = (dISO<todayISO) ? workedMin : (dISO===todayISO ? Math.max(workedMin,schedMin) : schedMin);
              expMin+=exp;
              if(dISO>=todayISO && schedMin>0 && exp>workedMin) shiftsLeft++;
              days.push({ date:dISO, wd:wd,
                worked:Math.round((workedMin/60)*100)/100, sched:Math.round((schedMin/60)*100)/100,
                off:(schedMin===0), timeoff:timeoff,
                isToday:(dISO===todayISO), isPast:(dISO<todayISO), isFuture:(dISO>todayISO) });
            }
            var anticipated=Math.round((expMin/60)*10)/10;
            var remH=Math.max(0, Math.round((anticipated-workedH)*10)/10);
            var salary=(e.wage_type==='salary');
            var ot=salary?0:Math.max(0, Math.round((anticipated-40)*10)/10);   // salaried = OT-exempt
            return { staff_id:e.id, name:e.display_name, store:e.home_store, role:e.role, wageType:e.wage_type||'hourly', salary:salary,
              worked:workedH, shiftsLeft:shiftsLeft, remaining:remH, anticipated:anticipated, ot:ot, onClock:!!onClock[e.id], days:days };
          });
          var stores=[]; rows.forEach(function(r){ if(r.store && stores.indexOf(r.store)<0) stores.push(r.store); });
          stores.sort(storeSort);
          return { weekStart:wkStart, weekEnd:wkEnd, today:todayISO, stores:stores, rows:rows };
        });
      });
    }).catch(function(){ return null; });
    return memo[key];
  }

  root.CPRTeamHours = { forWeek: forWeek };
})(typeof window !== 'undefined' ? window : this);
