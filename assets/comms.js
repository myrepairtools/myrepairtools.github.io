/*
 * comms.js — Communications feed client (dashboard widget + communications.html).
 *
 * Team-wide feed: manual posts (managers/owner via RLS) + automated celebrations
 * (milestones cron) + anything routed to the "In-app · Communications" channel in
 * Settings › Notifications. Per-user read/dismiss state + time-on-post lives in
 * communication_reads (RLS: own rows; managers can read all for receipts).
 *
 * window.CPRComms:
 *   list({limit})      -> {items:[{id,kind,title,body,created_at,author,read,dismissed,seconds}], meId, unread}
 *   post({kind,title,body})
 *   markRead(id) / addSeconds(id,sec) / dismiss(id) / undismiss(id)
 *   receipts(commId)   -> {rows:[{staff_id,name,home_store,read_at,seconds,dismissed}], staff:[...all active]}
 *   kindMeta(kind)     -> {icon,label,color}
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  /* Body formatting: posts are stored as plain text with light markup —
     **bold**, *italic*, __underline__, "- " bullets, bare URLs — and rendered
     safely (HTML is escaped first). Shared by the widget and the page. */
  function fmtBody(text){
    var s=String(text==null?'':text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    s=s.replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:#4FB0E3;font-weight:700;word-break:break-all">$1</a>');
    s=s.replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>');
    s=s.replace(/__([^_\n]+)__/g,'<u>$1</u>');
    s=s.replace(/(^|[\s(])\*([^*\n]+)\*/g,'$1<i>$2</i>');
    var out='', inUl=false;
    s.split('\n').forEach(function(ln){
      var m=/^\s*[-•]\s+(.*)$/.exec(ln);
      if(m){ if(!inUl){out+='<ul style="margin:4px 0;padding-left:20px">';inUl=true;} out+='<li>'+m[1]+'</li>'; }
      else{ if(inUl){out+='</ul>';inUl=false;} out+=ln+'<br>'; }
    });
    if(inUl)out+='</ul>';
    return out.replace(/(<br>)+$/,'');
  }
  /* textarea helpers for the compose toolbar */
  function wrapSel(ta,pre,post){
    var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value,sel=v.slice(s,e)||'text';
    ta.value=v.slice(0,s)+pre+sel+post+v.slice(e);
    ta.focus(); ta.selectionStart=s+pre.length; ta.selectionEnd=s+pre.length+sel.length;
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function bulletSel(ta){
    var s=ta.selectionStart,e=ta.selectionEnd,v=ta.value;
    var a=v.lastIndexOf('\n',s-1)+1;                    // expand to whole lines
    var b=v.indexOf('\n',e); if(b<0)b=v.length;
    var block=v.slice(a,b).split('\n').map(function(ln){return /^\s*[-•]\s+/.test(ln)?ln.replace(/^\s*[-•]\s+/,''):('- '+ln);}).join('\n');
    ta.value=v.slice(0,a)+block+v.slice(b);
    ta.focus(); ta.selectionStart=a; ta.selectionEnd=a+block.length;
    ta.dispatchEvent(new Event('input',{bubbles:true}));
  }
  /* one-line toolbar html + wiring (call wireToolbar(container, textarea)) */
  function toolbarHtml(){
    var b=function(k,label,title,extra){return '<button type="button" data-fmt="'+k+'" title="'+title+'" style="min-width:30px;height:28px;border:1px solid #E0E2EA;background:#fff;border-radius:7px;cursor:pointer;font-family:Nunito,sans-serif;font-weight:900;font-size:.78rem;color:#4E4E50;'+(extra||'')+'">'+label+'</button>';};
    return '<div style="display:flex;gap:5px;margin-bottom:7px">'+b('b','B','Bold')+b('i','I','Italic','font-style:italic;font-weight:600')+b('u','U','Underline','text-decoration:underline')+b('ul','•—','Bullet list')+'</div>';
  }
  function wireToolbar(container,ta){
    container.querySelectorAll('[data-fmt]').forEach(function(btn){
      btn.onclick=function(ev){ev.preventDefault();
        var k=btn.getAttribute('data-fmt');
        if(k==='b')wrapSel(ta,'**','**'); else if(k==='i')wrapSel(ta,'*','*');
        else if(k==='u')wrapSel(ta,'__','__'); else bulletSel(ta);
      };
    });
  }

  var KINDS = {
    announcement:{icon:'📢', label:'Announcement', color:'#DC282E'},
    training:    {icon:'📚', label:'Training',     color:'#4FB0E3'},
    schedule:    {icon:'🗓️', label:'Schedule',     color:'#7A6FD0'},
    shoutout:    {icon:'🏅', label:'Shout-out',    color:'#C9820B'},
    birthday:    {icon:'🎂', label:'Birthday',     color:'#C24E8E'},
    anniversary: {icon:'🎉', label:'Anniversary',  color:'#2E9E5B'}
  };
  function kindMeta(k){ return KINDS[k] || KINDS.announcement; }

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('https://esm.sh/@supabase/supabase-js@2').then(function(m){ return m.createClient(SB_URL,ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }
  var meP=null;
  function me(){ if(meP) return meP;
    meP=sb().then(function(client){ if(!client) return null;
      return session(client).then(function(s){ if(!s) return null;
        return client.from('staff').select('id,display_name,role').eq('auth_uid',s.user.id).maybeSingle()
          .then(function(r){ return r.data?{client:client,id:r.data.id,name:r.data.display_name,role:r.data.role}:null; });
      });
    }).catch(function(){ return null; });
    return meP;
  }

  function list(opts){
    var limit=(opts&&opts.limit)||50;
    return me().then(function(m){ if(!m) return null;
      return Promise.all([
        m.client.from('communications').select('id,kind,title,body,created_by,created_at').order('created_at',{ascending:false}).limit(limit),
        m.client.from('communication_reads').select('comm_id,first_read_at,seconds,dismissed_at').eq('staff_id',m.id),
        m.client.from('staff_directory').select('id,display_name')
      ]).then(function(res){
        var reads={};(res[1].data||[]).forEach(function(r){reads[r.comm_id]=r;});
        var names={};(res[2].data||[]).forEach(function(s){names[s.id]=s.display_name;});
        var items=(res[0].data||[]).map(function(c){ var r=reads[c.id];
          return { id:c.id, kind:c.kind, title:c.title, body:c.body, created_at:c.created_at,
            author:c.created_by?(names[c.created_by]||'Manager'):'Automatic',
            read:!!r, dismissed:!!(r&&r.dismissed_at), seconds:r?Number(r.seconds)||0:0 };
        });
        var unread=items.filter(function(i){return !i.read&&!i.dismissed;}).length;
        return { items:items, meId:m.id, myRole:m.role, unread:unread };
      });
    });
  }

  function post(p){
    return me().then(function(m){ if(!m) return {error:'not signed in'};
      return m.client.from('communications').insert({kind:p.kind||'announcement',title:String(p.title||'').trim(),body:String(p.body||'').trim()||null,created_by:m.id})
        .then(function(r){ return r.error?{error:r.error.message}:{ok:true}; });
    });
  }
  function markRead(id){
    return me().then(function(m){ if(!m) return null;
      return m.client.from('communication_reads').upsert({comm_id:id,staff_id:m.id},{onConflict:'comm_id,staff_id',ignoreDuplicates:true});
    });
  }
  function addSeconds(id,sec){
    sec=Math.max(0,Math.min(600,Math.round(sec)));   // cap a single sitting at 10 min (left-open tabs)
    if(!sec) return Promise.resolve();
    return me().then(function(m){ if(!m) return null;
      return m.client.from('communication_reads').select('seconds').eq('comm_id',id).eq('staff_id',m.id).maybeSingle().then(function(r){
        var cur=r.data?Number(r.data.seconds)||0:0;
        return m.client.from('communication_reads').upsert({comm_id:id,staff_id:m.id,seconds:cur+sec},{onConflict:'comm_id,staff_id'});
      });
    });
  }
  function dismiss(id){
    return me().then(function(m){ if(!m) return null;
      return m.client.from('communication_reads').upsert({comm_id:id,staff_id:m.id,dismissed_at:new Date().toISOString()},{onConflict:'comm_id,staff_id'});
    });
  }
  function undismiss(id){
    return me().then(function(m){ if(!m) return null;
      return m.client.from('communication_reads').upsert({comm_id:id,staff_id:m.id,dismissed_at:null},{onConflict:'comm_id,staff_id'});
    });
  }
  /* who read it (managers/owner; RLS returns only own rows for techs) */
  function receipts(commId){
    return me().then(function(m){ if(!m) return null;
      return Promise.all([
        m.client.from('communication_reads').select('staff_id,first_read_at,seconds,dismissed_at').eq('comm_id',commId),
        m.client.from('staff_directory').select('id,display_name,home_store,active').eq('active',true)
      ]).then(function(res){
        var by={};(res[0].data||[]).forEach(function(r){by[r.staff_id]=r;});
        var rows=(res[1].data||[]).map(function(s){ var r=by[s.id];
          return { staff_id:s.id, name:s.display_name, home_store:s.home_store,
            read_at:r?r.first_read_at:null, seconds:r?Number(r.seconds)||0:0, dismissed:!!(r&&r.dismissed_at) };
        });
        return { rows:rows, readCount:rows.filter(function(x){return !!x.read_at;}).length, total:rows.length };
      });
    });
  }

  root.CPRComms = { list:list, post:post, markRead:markRead, addSeconds:addSeconds, dismiss:dismiss, undismiss:undismiss, receipts:receipts, kindMeta:kindMeta,
    fmtBody:fmtBody, toolbarHtml:toolbarHtml, wireToolbar:wireToolbar };
})(typeof window !== 'undefined' ? window : this);
