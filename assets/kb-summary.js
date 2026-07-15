/*
 * kb-summary.js — one-call Knowledge Base snapshot for the dashboard widget.
 *
 * Exposes window.CPRKnowledge:
 *   forMe() -> Promise<{ required:[{id,slug,title}],        // published require_ack I haven't acknowledged
 *                        fresh:[{id,slug,title,updated_at}], // recently published/updated (unread first)
 *                        unread }|null>
 * null = not signed in / no staff row. Mirrors knowledge.html's visibility
 * rules (RLS does the role filtering server-side).
 */
(function (root) {
  'use strict';
  var SB_REF = 'xuvsehrevxackuhmbmry';
  var SB_URL = 'https://' + SB_REF + '.supabase.co';
  var ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dnNlaHJldnhhY2t1aG1ibXJ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE2OTY4NjEsImV4cCI6MjA5NzI3Mjg2MX0.pURipAPZoVKFe3wdMQHBsw4Bd2mgG8OdzxaCJKGIqyY';

  var sbP=null;
  function sb(){ if(sbP) return sbP; sbP=import('/assets/supabase-js.js').then(function(m){ return m.createClient(SB_URL,ANON); }).catch(function(){ return null; }); return sbP; }
  function session(client){
    return client.auth.getSession().then(function(r){ var s=r.data&&r.data.session; if(s) return s;
      try{ var raw=localStorage.getItem('sb-'+SB_REF+'-auth-token'); if(!raw) return null; var o=JSON.parse(raw);
        var at=o.access_token||(o.currentSession&&o.currentSession.access_token), rt=o.refresh_token||(o.currentSession&&o.currentSession.refresh_token);
        if(at&&rt) return client.auth.setSession({access_token:at,refresh_token:rt}).then(function(){ return client.auth.getSession(); }).then(function(r2){ return r2.data&&r2.data.session; });
      }catch(e){} return null; });
  }

  var CACHE=null;
  function forMe(force){
    if(CACHE&&!force) return CACHE;
    CACHE=sb().then(function(client){
      if(!client) return null;
      return session(client).then(function(s){
        if(!s) return null;
        return client.from('staff').select('id').eq('auth_uid',s.user.id).maybeSingle().then(function(meR){
          var me=meR.data; if(!me) return null;
          return Promise.all([
            client.from('kb_articles').select('id,slug,title,require_ack,updated_at,status').eq('status','published').order('updated_at',{ascending:false}).limit(60),
            client.from('kb_reads').select('article_id,acknowledged_at').eq('staff_id',me.id)
          ]).then(function(res){
            var arts=res[0].data||[], reads={};
            (res[1].data||[]).forEach(function(r){ reads[r.article_id]=r; });
            var required=arts.filter(function(a){ return a.require_ack && !(reads[a.id]&&reads[a.id].acknowledged_at); })
              .map(function(a){ return {id:a.id,slug:a.slug,title:a.title}; });
            var unreadArr=arts.filter(function(a){ return !reads[a.id]; });
            var fresh=unreadArr.concat(arts.filter(function(a){ return reads[a.id]; })).slice(0,5)
              .map(function(a){ return {id:a.id,slug:a.slug,title:a.title,updated_at:a.updated_at,unread:!reads[a.id]}; });
            return { required:required, fresh:fresh, unread:unreadArr.length };
          });
        });
      });
    }).catch(function(){ return null; });
    return CACHE;
  }

  root.CPRKnowledge = { forMe: forMe };
})(window);
