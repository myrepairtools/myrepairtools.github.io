/*
 * checklist-summary.js — one-call "my checklist today" snapshot for the dashboard.
 *
 * Mirrors checklist.html's row semantics (assigned to me, or unassigned where I'm
 * eligible; completion 'each' = my own task_completions row) so the widget can't
 * drift from the page.
 *
 * Exposes window.CPRChecklist:
 *   forMe()            -> Promise<{ tasks:[...], open, done, overdue }|null>
 *     task = { id, name, dueLabel, dueSub, priority, done, overdue, each }
 *   markDone(id, done) -> Promise<boolean>   (any-completion + each both handled)
 * null = not signed in / no staff row.
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  function iso(d){ return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2); }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL,ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }

  var ME=null, CACHE=null;
  function forMe(force){
    if(CACHE&&!force) return CACHE;
    CACHE=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        return client.from('staff').select('id,display_name,home_store').eq('auth_uid',s.user.id).maybeSingle().then(function(meR){
          var me=meR.data; if(!me) return null; ME={client:client,id:me.id};
          var today=iso(new Date());
          return Promise.all([
            client.from('task_instances').select('*').eq('status','open'),
            client.from('task_instances').select('*').eq('status','done').gte('task_date',today)
          ]).then(function(res){
            var rows=[].concat(res[0].data||[],res[1].data||[]).filter(function(i){
              if(i.assigned_staff_id===me.id) return true;
              return i.assigned_staff_id==null && (i.eligible||[]).indexOf(me.id)>-1;
            });
            var eachIds=rows.filter(function(i){return i.completion==='each';}).map(function(i){return i.id;});
            var compsP=eachIds.length?client.from('task_completions').select('instance_id,staff_id').in('instance_id',eachIds):Promise.resolve({data:[]});
            return compsP.then(function(cR){
              var mine={};(cR.data||[]).forEach(function(c){ if(c.staff_id===me.id) mine[c.instance_id]=1; });
              var now=Date.now();
              var tasks=rows.map(function(i){
                var done=i.completion==='each'?!!mine[i.id]:i.status==='done';
                var due=new Date(i.due_at), dueDay=iso(due);
                var overdue=i.status==='open'&&due.getTime()<now;
                var dueLabel, dueSub='';
                if(dueDay===today){ dueLabel=due.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); if(overdue)dueSub='past due'; }
                else{ dueLabel=due.toLocaleDateString('en-US',{month:'short',day:'numeric'});
                  var diff=Math.round((new Date(dueDay)-new Date(today))/86400000);
                  dueSub=diff>0?('in '+diff+(diff===1?' day':' days')):diff<0?((-diff)+(diff===-1?' day late':' days late')):''; }
                return { id:i.id, name:i.name, dueLabel:dueLabel, dueSub:dueSub, priority:i.priority,
                  done:done, overdue:overdue, each:i.completion==='each', due_at:i.due_at, eligible:i.eligible||[] };
              });
              tasks.sort(function(a,b){ if(a.done!==b.done)return a.done?1:-1; if(a.overdue!==b.overdue)return a.overdue?-1:1; return new Date(a.due_at)-new Date(b.due_at); });
              var open=tasks.filter(function(t){return !t.done;}).length;
              return { tasks:tasks, open:open, done:tasks.length-open,
                overdue:tasks.filter(function(t){return t.overdue&&!t.done;}).length };
            });
          });
        });
      });
    }).catch(function(){ return null; });
    return CACHE;
  }

  function markDone(id, done){
    return forMe().then(function(d){
      if(!d||!ME) return false;
      var t=(d.tasks||[]).filter(function(x){return x.id===id;})[0]; if(!t) return false;
      var client=ME.client, now=new Date(), onTime=now.getTime()<=new Date(t.due_at).getTime();
      var p;
      if(t.each){
        p=done?client.from('task_completions').insert({instance_id:id,staff_id:ME.id,on_time:onTime})
              :client.from('task_completions').delete().eq('instance_id',id).eq('staff_id',ME.id);
      }else{
        p=done?client.from('task_instances').update({status:'done',done_by:ME.id,done_at:now.toISOString(),on_time:onTime}).eq('id',id)
              :client.from('task_instances').update({status:'open',done_by:null,done_at:null,on_time:null}).eq('id',id);
      }
      return p.then(function(r){ CACHE=null; return !r.error; });
    });
  }

  root.CPRChecklist = { forMe:forMe, markDone:markDone };
})(typeof window !== 'undefined' ? window : this);
