/*
 * schedule-summary.js — one-call schedule snapshot for the signed-in user.
 *
 * Returns today's shift + scheduled hours this week, using the SAME resolution
 * logic as my-schedule.html (shifts -> shift_hours, named-shift + label
 * fallbacks) so the dashboard widget can't drift from the schedule page.
 *
 * Exposes window.CPRScheduleSummary.forMe() -> Promise<summary|null>.
 *   summary = { name, today:{kind:'shift'|'off'|'timeoff', name?, time?, store?, hours?, type?},
 *               weekHours,            // SCHEDULED hours this week (weekly template)
 *               workedHours, otHours, // ACTUAL worked hours from QB Time this week (Sun–Sat) + OT over 40
 *               onClock }             // currently clocked in per QB Time
 *   null    = not signed in / no staff row.
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function fmt12(m){ if(m==null) return ''; var h=Math.floor(m/60), mm=m%60, ap=h<12?'AM':'PM', h12=h%12; if(h12===0)h12=12; return h12+(mm?(':'+('0'+mm).slice(-2)):'')+' '+ap; }
  function range12(s,e){ return fmt12(s)+' – '+fmt12(e); }
  function shortStore(s){ return root.CPRLocations ? root.CPRLocations.display(s) : String(s||'').replace(/^CPR\s*/,''); }

  var SHIFT_BY_ID={}, HOURS={}, SCHED=null, REQS=[];

  function resolve(shiftId,store,wd){
    var h=HOURS[shiftId+'|'+store];
    if(!h||!h.def||!h.def.enabled) return {offered:false};
    var d=h.days[wd];
    if(d&&d.closed) return {closed:true};
    if(d&&d.start!=null) return {start:d.start,end:d.end};
    if(h.def.closed) return {closed:true};
    return {start:h.def.start,end:h.def.end};
  }
  function dayRec(wd){
    var sh=(SCHED&&SCHED.shifts)||{}, v=sh[String(wd)];
    if(v==null) return {none:true};
    if(typeof v==='string') v={label:v};
    if(v==='off'||v.label==='Off') return {off:true};
    var sid=v.shift_id;
    if(sid==null&&v.label){ var m=Object.keys(SHIFT_BY_ID).map(function(k){return SHIFT_BY_ID[k];}).filter(function(s){return s.name===v.label;})[0]; if(m) sid=m.id; }
    if(sid==null&&!v.label) return {none:true};
    return {shift_id:sid,store:v.store||(SCHED&&SCHED.store),label:v.label};
  }
  function parseLabel(label){ var m=String(label||'').split(/\s*[-–]\s*/); if(m.length!==2) return null;
    function t(s){ var x=/(\d+)(?::(\d+))?\s*([AP]M)?/i.exec(String(s).trim()); if(!x) return null; var h=(+x[1])%12; if(/pm/i.test(x[3]||''))h+=12; return h*60+(+(x[2]||0)); }
    var a=t(m[0]),b=t(m[1]); return (a==null||b==null)?null:[a,b]; }
  function labelToShift(label){ var n=String(label||'').trim().toLowerCase(); if(!n) return null;
    return Object.keys(SHIFT_BY_ID).map(function(k){return SHIFT_BY_ID[k];}).filter(function(s){return String(s.name||'').trim().toLowerCase()===n;})[0]||null; }
  function shiftMinutes(r,wd){
    var s=SHIFT_BY_ID[r.shift_id]||labelToShift(r.label);
    if(s){ var rd=resolve(s.id,r.store,wd); if(rd.start!=null) return {start:rd.start,end:rd.end,name:s.name};
      var pm0=parseLabel(r.label); if(pm0) return {start:pm0[0],end:pm0[1],name:s.name}; return {name:s.name}; }
    var pm=parseLabel(r.label); if(pm) return {start:pm[0],end:pm[1],name:range12(pm[0],pm[1])};
    if(r.label&&r.label!=='Off') return {name:r.label};
    return {name:'Scheduled'};
  }
  function approvedToday(staffId, todayISO){ return REQS.filter(function(r){ return r.staff_id===staffId && r.status==='approved' && r.start_date<=todayISO && r.end_date>=todayISO; })[0]||null; }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('/assets/supabase-js.js').then(function(m){ return m.createClient(SB_URL,ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }

  var memo=null;
  function forMe(){
    if(memo) return memo;
    memo=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        return client.from('staff').select('id,display_name,home_store,authorized_stores,role').eq('auth_uid',s.user.id).maybeSingle().then(function(meR){
          var me=meR.data; if(!me) return null;
          // current week, Sunday–Saturday (matches the QB Time OT week)
          var nowW=new Date(), wkStart=iso(new Date(nowW.getFullYear(),nowW.getMonth(),nowW.getDate()-nowW.getDay())),
              wkEnd=iso(new Date(nowW.getFullYear(),nowW.getMonth(),nowW.getDate()+(6-nowW.getDay())));
          return Promise.all([
            client.from('shifts').select('id,name,color,active'),
            client.from('shift_hours').select('shift_id,store,weekday,start_min,end_min,closed,enabled'),
            client.from('staff_schedule').select('staff_id,store,shifts').eq('staff_id',me.id),
            client.from('time_off_requests').select('staff_id,type,start_date,end_date,status').eq('staff_id',me.id).eq('status','approved'),
            client.from('qbtime_timesheets').select('seconds,off_seconds,on_the_clock,biz_date').eq('staff_id',me.id).gte('biz_date',wkStart).lte('biz_date',wkEnd)
          ]).then(function(res){
            var sh=res[0], hr=res[1], sc=res[2], rq=res[3], ts=res[4];
            SHIFT_BY_ID={}; (sh.data||[]).forEach(function(x){ SHIFT_BY_ID[x.id]=x; });
            HOURS={}; (hr.data||[]).forEach(function(r){ var k=r.shift_id+'|'+r.store, h=HOURS[k]||(HOURS[k]={def:null,days:{}}); var row={closed:!!r.closed,start:r.start_min,end:r.end_min,enabled:r.enabled!==false}; if(r.weekday==null)h.def=row; else h.days[r.weekday]=row; });
            var myRow=(sc.data&&sc.data[0])||null; SCHED=myRow?{shifts:myRow.shifts||{},store:myRow.store}:{shifts:{},store:me.home_store};
            REQS=(rq.data||[]);

            // week hours: sum the weekly template across all 7 weekdays
            var weekMin=0;
            for(var wd=0; wd<7; wd++){ var r=dayRec(wd); if(r.none||r.off) continue; var sm=shiftMinutes(r,wd); if(sm && sm.start!=null && sm.end!=null) weekMin+=(sm.end-sm.start); }

            // today
            var now=new Date(), twd=now.getDay(), todayISO=iso(now), today;
            var ap=approvedToday(me.id, todayISO);
            if(ap){ today={kind:'timeoff', type:ap.type}; }
            else { var rr=dayRec(twd);
              if(rr.none||rr.off){ today={kind:'off'}; }
              else { var sm2=shiftMinutes(rr,twd); var hrs=(sm2.start!=null&&sm2.end!=null)?((sm2.end-sm2.start)/60):null;
                today={kind:'shift', name:sm2.name, time:(sm2.start!=null?range12(sm2.start,sm2.end):''), store:shortStore(rr.store), hours:hrs}; }
            }
            // actual worked hours this week (Sun–Sat) from QB Time + OT over 40
            var workedSec=0, onClock=false;
            (ts&&ts.data||[]).forEach(function(r){ workedSec+=Math.max(0,(+r.seconds||0)-(+r.off_seconds||0)); if(r.on_the_clock) onClock=true; });
            var workedHours=Math.round((workedSec/3600)*10)/10, otHours=Math.round(Math.max(0,workedHours-40)*10)/10;

            return { name:me.display_name, today:today, weekHours:Math.round((weekMin/60)*10)/10,
              workedHours:workedHours, otHours:otHours, onClock:onClock };
          });
        });
      });
    }).catch(function(){ return null; });
    return memo;
  }

  root.CPRScheduleSummary = { forMe: forMe };
})(typeof window !== 'undefined' ? window : this);
