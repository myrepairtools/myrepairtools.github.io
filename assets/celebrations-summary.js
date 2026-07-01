/*
 * celebrations-summary.js — upcoming team birthdays & work anniversaries.
 *
 * Reads staff_directory (start_date + birthday_md, which is month/day only so
 * ages stay private) and returns everything in the next N days, today first.
 * Powers the dashboard's Communications widget — in-app celebrations for the
 * whole team, deliberately NOT email/Teams notifications.
 *
 * Exposes window.CPRCelebrations.upcoming({days}) -> Promise<{items}|null>
 *   items = [{ kind:'birthday'|'anniversary', name, avatar, avatar_color,
 *              home_store, date:'YYYY-MM-DD', daysAway, years? }] sorted soonest first.
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL,ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }
  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }
  function isLeap(y){ return (y%4===0&&y%100!==0)||y%400===0; }
  /* Next occurrence of a MM-DD within [today, today+days]; Feb 29 celebrates Feb 28 off-leap-years. */
  function nextOccurrence(md, today, days){
    var mm=+md.slice(0,3-1), dd=+md.slice(3);
    for(var y=today.getFullYear(); y<=today.getFullYear()+1; y++){
      var d2=dd; if(mm===2&&dd===29&&!isLeap(y)) d2=28;
      var dt=new Date(y, mm-1, d2);
      var away=Math.round((dt-today)/86400000);
      if(away>=0&&away<=days) return {date:dt, daysAway:away, year:y};
    }
    return null;
  }

  var memo={};
  function upcoming(opts){
    var days=(opts&&opts.days)||14;
    var now=new Date(), today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    var key=days+'@'+iso(today);
    if(memo[key]) return memo[key];
    memo[key]=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        return client.from('staff_directory')
          .select('id,display_name,home_store,active,avatar,avatar_color,start_date,birthday_md')
          .eq('active',true).then(function(r){
          var items=[];
          (r.data||[]).forEach(function(p){
            if(p.birthday_md){
              var b=nextOccurrence(p.birthday_md, today, days);
              if(b) items.push({kind:'birthday', name:p.display_name, avatar:p.avatar, avatar_color:p.avatar_color,
                home_store:p.home_store, date:iso(b.date), daysAway:b.daysAway});
            }
            if(p.start_date){
              var sd=String(p.start_date).slice(0,10);
              var a=nextOccurrence(sd.slice(5), today, days);
              if(a){ var years=a.year-(+sd.slice(0,4));
                if(years>=1) items.push({kind:'anniversary', name:p.display_name, avatar:p.avatar, avatar_color:p.avatar_color,
                  home_store:p.home_store, date:iso(a.date), daysAway:a.daysAway, years:years}); }
            }
          });
          items.sort(function(a,b){ return a.daysAway-b.daysAway || (a.name<b.name?-1:1); });
          return { items:items, days:days };
        });
      });
    }).catch(function(){ return null; });
    return memo[key];
  }

  root.CPRCelebrations = { upcoming: upcoming };
})(typeof window !== 'undefined' ? window : this);
