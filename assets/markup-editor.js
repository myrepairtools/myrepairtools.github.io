/* Shared light-markup WYSIWYG editor (assets/markup-editor.js)
   ------------------------------------------------------------
   The KB article editor, lifted out so every surface that stores the same
   light markup edits it the same way — knowledge.html and communications.html
   today. What you see IS what readers see: assets/kb-markup.js renders the
   stored text, this edits it, and the two agree by construction.

   Usage:
     const ed = CPRMarkupEditor.mount(hostEl, {
       value:   '…markup…',
       upload:  async file => publicUrl,   // omit to hide the image button
       source:  true,                      // </> raw-markup toggle
       minHeight: '420px',
       toast:   (msg, isErr) => {}
     });
     ed.getMarkup();  ed.setMarkup(md);  ed.focus();

   Storage never changes: mdToEditor() renders markup into editable HTML on
   open, editorToMd() serialises it back. No library — contenteditable and
   execCommand, which is all this needs. Requires kb-markup.js (regexes). */
(function(){
  if(window.CPRMarkupEditor)return;
  if(!window.CPRMarkup){ console.warn('markup-editor.js needs kb-markup.js'); return; }

  /* structural CSS travels with the editor (same pattern as kb-markup.js and
     pickers.js) so any page gets the real thing by loading one script */
  var CSS='.edtools{display:flex;align-items:center;gap:4px;flex-wrap:wrap;border-top:1px solid var(--row,#F0F1F4);border-bottom:1px solid var(--row,#F0F1F4);padding:8px 28px;margin-top:16px; background:#fff}'
    + '.ed-rich{border-bottom-left-radius:12px;border-bottom-right-radius:12px}'
    + '.edtools button{font-family:var(--font-sans);font-weight:600;font-size:.74rem;border:1px solid transparent;border-radius:7px;background:none;color:var(--dark-grey);padding:5px 9px;cursor:pointer;white-space:nowrap}'
    + '.edtools button:hover{background:var(--light-grey);border-color:var(--border)}'
    + '.ed-rich{min-height:420px;padding:20px 28px 40px;font-family:var(--font-sans);font-size:.95rem;line-height:1.75;color:#3A3A45;outline:none}'
    + '.ed-rich:focus{outline:none}'
    + '.ed-rich h3{font-family:var(--font-sans);font-weight:700;font-size:1.05rem;color:var(--dark);margin:22px 0 10px}'
    + '.ed-rich h4{font-family:var(--font-sans);font-weight:700;font-size:.95rem;color:var(--dark);margin:18px 0 8px}'
    + '.ed-rich p{margin:0 0 14px}'
    + '.ed-rich ul,.ed-rich ol{margin:0 0 16px;padding-left:22px}'
    + '.ed-rich li{margin:4px 0}'
    + '.ed-rich img{max-width:100%;border-radius:12px;border:1px solid var(--border);margin:10px 0;display:block}'
    + '.ed-rich a{color:#1E7AA8;font-weight:500}'
    + '.ed-rich hr{border:none;border-top:1.5px solid var(--border);margin:18px 0}'
    + '.ed-rich code{background:var(--row,#F0F1F4);border-radius:5px;padding:1px 6px;font-size:.86em}'
    + '.ed-rich .ed-callout{background:#FDF6E7;border:1.5px solid #F2DFAE;border-radius:10px;padding:13px 16px;margin:0 0 16px;font-size:.85rem;font-weight:500;color:#7A5A08;line-height:1.55}'
    + '.ed-rich:empty:before{content:\'Write it how you\\\'d explain it to a new hire…\';color:var(--grey)}'
    + '.edtools button.on{background:#EAF6FD;border-color:#CDE8F7;color:#1E7AA8}'
    + '.edtools button{display:inline-flex;align-items:center;gap:2px;line-height:0}'
    + '.edtools button svg{display:block}'
    + '.edtools select{font-family:var(--font-sans);font-weight:600;font-size:.74rem;border:1px solid var(--border);border-radius:7px;background:#fff;color:var(--dark-grey);padding:5px 7px;cursor:pointer}'
    + '.edtools select:focus{outline:none;border-color:var(--blue)}'
    + '.edmenu{position:absolute;z-index:3000;background:#fff;border:1px solid var(--border);border-radius:10px;box-shadow:0 10px 30px rgba(45,45,59,.18);padding:5px;min-width:186px}'
    + '.edmenu button{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;font-family:var(--font-sans);font-weight:600;font-size:.78rem; border:none;background:none;color:var(--dark);padding:7px 10px;border-radius:7px;cursor:pointer;text-align:left;line-height:1.2}'
    + '.edmenu button:hover{background:var(--light-grey)}'
    + '.edmenu .sep{height:1px;background:var(--row,#F0F1F4);margin:4px 2px}'
    + '.edmenu .mic{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center}'
    + '.edmenu .mic svg{display:block}'
    + '.edmenu .lbl{flex:1;min-width:0;text-align:left}'
    + '.edmenu .sw{width:15px;height:15px;border-radius:5px;border:1.5px solid}'
    + '.edmenu.cust{padding:11px;min-width:212px;display:flex;flex-direction:column;gap:8px}'
    + '.edmenu.cust .curow{display:flex;align-items:center;gap:9px;font-family:var(--font-sans);font-weight:600;font-size:.76rem;color:var(--dark-grey)}'
    + '.edmenu.cust .curow span{flex:1}'
    + '.edmenu.cust .curow.end{justify-content:space-between;gap:8px;margin-top:2px}'
    + '.edmenu.cust input[type=color]{width:44px;height:26px;padding:0;border:1.5px solid var(--border);border-radius:7px;background:none;cursor:pointer}'
    + '.edmenu.cust .cupv{border:1.5px solid;border-radius:10px;padding:10px 12px;font-family:var(--font-sans);font-weight:600;font-size:.82rem}'
    + '.edmenu.pal.more{flex-wrap:wrap;max-width:238px}'
    + '.edmenu.pal button.plus{background:#fff;color:var(--dark-grey);border-style:dashed}'
    + '.edmenu.pal button.plus svg{display:block}'
    + '.edmenu.pal{display:flex;gap:6px;padding:8px;min-width:0}'
    + '.edmenu.pal button{width:28px;height:28px;padding:0;border:1.5px solid;border-radius:8px;flex:none;justify-content:center;align-items:center;gap:0}'
    + '.edmenu.pal button:hover{background-clip:padding-box;box-shadow:0 0 0 2px rgba(79,176,227,.45)}'
    + '.edmenu.pal button.none{background:#fff;position:relative;overflow:hidden}'
    + '.edmenu.pal button.none::after{content:\'\';position:absolute;inset:0; background:linear-gradient(to top right,transparent 44%,var(--red) 44%,var(--red) 56%,transparent 56%)}'
    + '.ed-rich table{border-collapse:collapse;width:100%;margin:12px 0;font-size:.86rem}'
    + '.ed-rich th,.ed-rich td{border:1px solid var(--border);padding:8px 11px;text-align:left;vertical-align:top;line-height:1.5;min-width:44px}'
    + '.ed-rich th{background:#F3F6FA;font-family:var(--font-sans);font-weight:600;color:var(--dark)}'
    + '.ed-rich td:focus,.ed-rich th:focus{outline:2px solid var(--blue);outline-offset:-2px}'
    + '.ed-rich .ed-callout.c-red{background:#FDEBEC;border-color:#F2C4C6;color:#93262B}'
    + '.ed-rich .ed-callout.c-green{background:#E6F6EE;border-color:#B7E2CC;color:#1B6844}'
    + '.ed-rich .ed-callout.c-blue{background:#EAF6FD;border-color:#BFE2F5;color:#175E82}'
    + '.ed-rich .ed-callout.c-plain{background:#F8F8FA;border-color:#E0E2EA;color:#4E4E50}'
    + '.ed-rich .ed-callout.c-dark{background:#2D2D3B;border-color:#2D2D3B;color:#fff}'
    + '.ed-rich .ed-callout h3,.ed-rich .ed-callout h4,.ed-rich .ed-callout h5,.ed-rich .ed-callout h6{margin:0;color:inherit}'
    + '.ed-rich .ed-callout h3{font-size:1.05rem}.ed-rich .ed-callout h4{font-size:.95rem}'
    + '.ed-rich .ed-callout h5{font-size:.88rem}.ed-rich .ed-callout h6{font-size:.8rem}'
    + '.ed-rich h5{font-family:var(--font-sans);font-weight:600;font-size:.86rem;color:var(--dark);margin:12px 0 4px}'
    + '.ed-rich h6{font-family:var(--font-sans);font-weight:600;font-size:.79rem;color:var(--dark-grey);margin:10px 0 4px}'
    + '.edtools .edsep{width:1px;height:20px;background:var(--border);margin:0 4px}'
    + '.edsrc{width:100%;border:none;resize:vertical;min-height:420px;padding:20px 28px 26px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.82rem;line-height:1.7;color:#3A3A45}'
    + '.edsrc:focus{outline:none}';
  (function(){ var s=document.createElement('style'); s.textContent=CSS;
    /* first in <head> so a page's own typography (e.g. the KB's .artbody rules)
       overrides these defaults instead of losing to them */
    document.head.insertBefore(s, document.head.firstChild); })();

  const LIST_RE=window.CPRMarkup.LIST_RE, TABLE_RE=window.CPRMarkup.TABLE_RE,
        TSEP_RE=window.CPRMarkup.TSEP_RE, listBlock=window.CPRMarkup.listBlock, mkCells=window.CPRMarkup.cells;
  function esc(s){ return String(s==null?'':s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function escAttr(v){ return String(v==null?'':v).replace(/"/g,'&quot;'); }
  function inlineToHtml(t){
    let s=esc(t);
    s=s.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g,(m,a,u)=>'<img src="'+escAttr(u)+'" alt="'+escAttr(a)+'">');
    s=s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,(m,tx,u)=>'<a href="'+escAttr(u)+'">'+tx+'</a>');
    s=s.replace(/`([^`\n]+)`/g,'<code>$1</code>');
    s=s.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
    s=s.replace(/__([^_\n]+)__/g,'<u>$1</u>');
    s=s.replace(/(^|[\s(>])\*([^*\n]+)\*/g,'$1<em>$2</em>');
    return s;
  }
  function edTableHtml(rows){
    const head=(rows.length>1&&TSEP_RE.test(rows[1])&&/-/.test(rows[1]))?mkCells(rows[0]):null;
    const body=head?rows.slice(2):rows;
    const cols=Math.max(head?head.length:0,...body.map(r=>mkCells(r).length));
    const pad=a=>{ while(a.length<cols)a.push(''); return a; };
    let h='<table>';
    if(head)h+='<thead><tr>'+pad(head).map(c=>'<th>'+(inlineToHtml(c)||'<br>')+'</th>').join('')+'</tr></thead>';
    h+='<tbody>';
    body.forEach(r=>{ if(TSEP_RE.test(r)&&/-/.test(r))return;
      h+='<tr>'+pad(mkCells(r)).map(c=>'<td>'+(inlineToHtml(c)||'<br>')+'</td>').join('')+'</tr>'; });
    return h+'</tbody></table>';
  }
  function mdToEditor(md){
    const lines=String(md||'').split('\n');
    let out='',buf=[],tbl=[];
    const close=()=>{
      if(buf.length){ out+=listBlock(buf,inlineToHtml); buf=[]; }
      if(tbl.length){ out+=edTableHtml(tbl); tbl=[]; }
    };
    for(const raw of lines){
      let m;
      if(TABLE_RE.test(raw)&&!/^\s*---+\s*$/.test(raw)){
        if(buf.length){ out+=listBlock(buf,inlineToHtml); buf=[]; } tbl.push(raw); continue; }
      if((m=LIST_RE.exec(raw))&&!/^\s*---+\s*$/.test(raw)){
        if(tbl.length){ out+=edTableHtml(tbl); tbl=[]; }
        buf.push({indent:m[1].replace(/\t/g,'  ').length,tag:/^\d/.test(m[2])?'ol':'ul',text:m[3]}); continue; }
      if(/^\s*---+\s*$/.test(raw)){ close(); out+='<hr>'; continue; }
      const cm=CO_CUSTOM_RE.exec(raw);
      if(cm){ close();
        let ctxt=cm[4], chm=/^(#{1,4})\s+([\s\S]*)$/.exec(ctxt), cht='';
        if(chm){ cht={1:'h3',2:'h4',3:'h5',4:'h6'}[chm[1].length]; ctxt=chm[2]; }
        const cinner=inlineToHtml(ctxt)||'<br>';
        out+='<div class="ed-callout c-custom" data-bg="'+cm[1]+'" data-bd="'+cm[2]+'" data-fg="'+cm[3]+'"'
          +' style="background:#'+cm[1]+';border-color:#'+cm[2]+';color:#'+cm[3]+'">'
          +(cht?'<'+cht+'>'+cinner+'</'+cht+'>':cinner)+'</div>'; continue; }
      const co=CO_KINDS.map(k=>({k,m:k.re.exec(raw)})).find(x=>x.m);
      if(co){ close();
        /* a box can carry a heading: "!> ## Title" */
        let ctxt=co.m[1], hm=/^(#{1,4})\s+([\s\S]*)$/.exec(ctxt), ht='';
        if(hm){ ht={1:'h3',2:'h4',3:'h5',4:'h6'}[hm[1].length]; ctxt=hm[2]; }
        const inner=inlineToHtml(ctxt)||'<br>';
        out+='<div class="ed-callout'+(co.k.cls?' '+co.k.cls:'')+'">'+(ht?'<'+ht+'>'+inner+'</'+ht+'>':inner)+'</div>'; continue; }
      if((m=/^####\s+(.*)$/.exec(raw))){ close(); out+='<h6>'+inlineToHtml(m[1])+'</h6>'; }
      else if((m=/^###\s+(.*)$/.exec(raw))){ close(); out+='<h5>'+inlineToHtml(m[1])+'</h5>'; }
      else if((m=/^##\s+(.*)$/.exec(raw))){ close(); out+='<h4>'+inlineToHtml(m[1])+'</h4>'; }
      else if((m=/^#\s+(.*)$/.exec(raw))){ close(); out+='<h3>'+inlineToHtml(m[1])+'</h3>'; }
      else if(raw.trim()===''){ close(); }
      else { close(); out+='<p>'+inlineToHtml(raw)+'</p>'; }
    }
    close();
    return out||'<p><br></p>';
  }
  function inlineToMd(node){
    let s='';
    node.childNodes.forEach(n=>{
      if(n.nodeType===3){ s+=n.nodeValue.replace(/ /g,' '); return; }
      if(n.nodeType!==1)return;
      const tag=n.tagName.toLowerCase();
      if(tag==='br'){ s+=' '; return; }
      if(tag==='img'){ s+='!['+(n.getAttribute('alt')||'image')+']('+n.getAttribute('src')+')'; return; }
      const inner=inlineToMd(n);
      if(!inner.trim()&&tag!=='a'){ s+=inner; return; }
      if(tag==='strong'||tag==='b')s+='**'+inner+'**';
      else if(tag==='em'||tag==='i')s+='*'+inner+'*';
      else if(tag==='u')s+='__'+inner+'__';
      else if(tag==='code')s+='`'+inner+'`';
      else if(tag==='a')s+='['+inner+']('+(n.getAttribute('href')||'')+')';
      else s+=inner;
    });
    return s;
  }
  const ED_BLOCK=/^(P|DIV|H1|H2|H3|H4|H5|H6|UL|OL|HR|BLOCKQUOTE|SECTION|ARTICLE|TABLE)$/;
  /* callout colors ride as a prefix letter: !r> red, !g> green, !b> blue,
     !n> plain box, bare !> amber (what every existing article already uses) */
  const CO_KINDS=[
    {key:'amber',cls:'',       prefix:'!> ', re:/^!>\s+(.*)$/,  label:'Amber — heads up',      bg:'#FDF6E7', bd:'#F2DFAE'},
    {key:'red',  cls:'c-red',  prefix:'!r> ',re:/^!r>\s+(.*)$/, label:'Red — do not do this',  bg:'#FDEBEC', bd:'#F2C4C6'},
    {key:'green',cls:'c-green',prefix:'!g> ',re:/^!g>\s+(.*)$/, label:'Green — best practice', bg:'#E6F6EE', bd:'#B7E2CC'},
    {key:'blue', cls:'c-blue', prefix:'!b> ',re:/^!b>\s+(.*)$/, label:'Blue — good to know',   bg:'#EAF6FD', bd:'#BFE2F5'},
    {key:'plain',cls:'c-plain',prefix:'!n> ',re:/^!n>\s+(.*)$/, label:'Grey — plain box',       bg:'#F8F8FA', bd:'#E0E2EA'},
    {key:'dark', cls:'c-dark', prefix:'!d> ',re:/^!d>\s+(.*)$/, label:'Dark blue',              bg:'#2D2D3B', bd:'#2D2D3B'}
  ];
  /* custom-coloured box: !#fill|#outline|#text> — the colours live in the stored
     markup, so a custom box survives the PDF, search and every reading surface */
  /* the second shelf, behind "+": ready-made colours (brand + a broader set).
     They store as custom colours, so they need no new markup of their own. */
  const CO_MORE=[
    {label:'Purple',      bg:'f3edfb', bd:'d9c7f0', fg:'5b3a96'},
    {label:'Indigo',      bg:'eceefb', bd:'c9cff2', fg:'3b45a3'},
    {label:'Teal',        bg:'e4f5f3', bd:'b4e2dc', fg:'146b62'},
    {label:'Sky',         bg:'e6f4fb', bd:'bbdff0', fg:'14657f'},
    {label:'Lime',        bg:'eef7e1', bd:'d3e8b5', fg:'4e7a15'},
    {label:'Orange',      bg:'fdf0e4', bd:'f5d6b5', fg:'9a5416'},
    {label:'Rose',        bg:'fdecf3', bd:'f5c8dc', fg:'9c2f63'},
    {label:'Light grey',  bg:'f0f1f4', bd:'dddfe6', fg:'4e4e50'},
    {label:'Slate',       bg:'e9edf2', bd:'c8d2de', fg:'3a4a5c'},
    {label:'Forest — solid', bg:'1f5e45', bd:'1f5e45', fg:'ffffff'},
    {label:'CPR red — solid',  bg:'dc282e', bd:'dc282e', fg:'ffffff'},
    {label:'CPR blue — solid', bg:'4fb0e3', bd:'4fb0e3', fg:'ffffff'}
  ];
  const CO_CUSTOM_RE=/^!#([0-9a-fA-F]{6})\|#([0-9a-fA-F]{6})\|#([0-9a-fA-F]{6})>\s+([\s\S]*)$/;
  function calloutPrefix(el){
    if(el.classList&&el.classList.contains('c-custom')&&el.dataset.bg)
      return '!#'+el.dataset.bg+'|#'+el.dataset.bd+'|#'+el.dataset.fg+'> ';
    const k=CO_KINDS.find(x=>x.cls&&el.classList.contains(x.cls));
    return k?k.prefix:'!> ';
  }
  const hex6=v=>String(v||'').replace('#','').slice(0,6).toLowerCase();
  /* a readable text colour for a given fill, and a slightly deeper outline */
  function lum(h){ h=hex6(h); const r=parseInt(h.slice(0,2),16)/255,g=parseInt(h.slice(2,4),16)/255,b=parseInt(h.slice(4,6),16)/255;
    const f=c=>c<=.03928?c/12.92:Math.pow((c+.055)/1.055,2.4);
    return .2126*f(r)+.7152*f(g)+.0722*f(b); }
  function readableOn(bg){ return lum(bg)>.5?'2d2d3b':'ffffff'; }
  function deepen(h,pct){ h=hex6(h); const p=pct==null?.18:pct;
    const ch=i=>{ const v=parseInt(h.slice(i,i+2),16); return ('0'+Math.max(0,Math.round(v*(1-p))).toString(16)).slice(-2); };
    return ch(0)+ch(2)+ch(4); }
  function editorToMd(root){
    const out=[];
    const push=t=>{ out.push(t); };
    /* nested lists serialize as two spaces per level. A sub-list can sit inside
       its parent <li> (what we render) or as a sibling list (what Chrome's
       indent command sometimes leaves behind) — both mean "one level deeper". */
    const listToMd=(el,depth)=>{
      const tag=el.tagName.toLowerCase();
      let i=1;
      [...el.children].forEach(ch=>{
        const ct=ch.tagName;
        if(ct==='UL'||ct==='OL'){ listToMd(ch,depth+1); return; }
        if(ct!=='LI')return;
        const clone=ch.cloneNode(true);
        [...clone.children].forEach(c=>{ if(c.tagName==='UL'||c.tagName==='OL')c.remove(); });
        push('  '.repeat(depth)+(tag==='ul'?'- ':(i++)+'. ')+inlineToMd(clone).trim());
        [...ch.children].forEach(c=>{ if(c.tagName==='UL'||c.tagName==='OL')listToMd(c,depth+1); });
      });
    };
    /* tables serialize as pipe rows; a header row gets the |---|---| separator
       under it so the renderer knows to bold+shade it */
    const tableToMd=el=>{
      const rowMd=tr=>'| '+[...tr.children].map(c=>inlineToMd(c).trim().replace(/\|/g,'\\|')||' ').join(' | ')+' |';
      const rows=[...el.querySelectorAll('tr')];
      if(!rows.length)return;
      const first=rows[0], isHead=[...first.children].some(c=>c.tagName==='TH');
      push(rowMd(first));
      if(isHead)push('|'+[...first.children].map(()=>'---').join('|')+'|');
      rows.slice(1).forEach(tr=>push(rowMd(tr)));
    };
    const blockOf=el=>{
      const tag=el.tagName.toLowerCase();
      /* contenteditable happily nests blocks (Chrome puts <ul> INSIDE the <p>
         it was invoked from) — walk into those instead of flattening to text */
      const isWrapper=(tag==='p'||tag==='div'||tag==='section'||tag==='article')
        && !(el.classList&&el.classList.contains('ed-callout'))
        && [...el.children].some(c=>ED_BLOCK.test(c.tagName));
      if(isWrapper){
        el.childNodes.forEach(n=>{
          if(n.nodeType===3){ const t=n.nodeValue.trim(); if(t){ push(t); push(''); } return; }
          if(n.nodeType===1)blockOf(n);
        });
        return;
      }
      if(tag==='h1'||tag==='h3'){ push('# '+inlineToMd(el).trim()); push(''); return; }
      if(tag==='h2'||tag==='h4'){ push('## '+inlineToMd(el).trim()); push(''); return; }
      if(tag==='h5'){ push('### '+inlineToMd(el).trim()); push(''); return; }
      if(tag==='h6'){ push('#### '+inlineToMd(el).trim()); push(''); return; }
      if(tag==='hr'){ push('---'); push(''); return; }
      if(tag==='ul'||tag==='ol'){ listToMd(el,0); push(''); return; }
      if(tag==='table'){ tableToMd(el); push(''); return; }
      if(el.classList&&el.classList.contains('ed-callout')){
        const bh=el.querySelector('h3,h4,h5,h6');
        const lvl=bh?({h3:'# ',h4:'## ',h5:'### ',h6:'#### '})[bh.tagName.toLowerCase()]:'';
        push(calloutPrefix(el)+lvl+inlineToMd(el).trim()); push(''); return; }
      if(tag==='blockquote'){ push('!> '+inlineToMd(el).trim()); push(''); return; }
      /* p / div / anything else = a paragraph; a lone <br> is a blank line */
      const txt=inlineToMd(el).trim();
      if(txt){ push(txt); push(''); }
      return;
    };
    root.childNodes.forEach(n=>{
      if(n.nodeType===3){ const t=n.nodeValue.trim(); if(t){ push(t); push(''); } return; }
      if(n.nodeType===1)blockOf(n);
    });
    return out.join('\n').replace(/\n{3,}/g,'\n\n').trim();
  }
  /* paste: keep basic formatting, drop everything else (SharePoint/Word HTML is
     a swamp — this is what stops pasted articles from carrying junk styling) */
  function cleanPaste(html){
    const box=document.createElement('div');
    box.innerHTML=String(html||'');
    box.querySelectorAll('style,script,meta,link,o\\:p').forEach(el=>el.remove());
    const ALLOW={P:1,DIV:1,BR:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,UL:1,OL:1,LI:1,STRONG:1,B:1,EM:1,I:1,U:1,A:1,CODE:1,HR:1,IMG:1,SPAN:1,TABLE:1,TR:1,TD:1,TH:1,TBODY:1,THEAD:1,TFOOT:1};
    const walk=el=>{
      [...el.children].forEach(c=>{
        walk(c);
        if(!ALLOW[c.tagName]){ c.replaceWith(...c.childNodes); return; }
        [...c.attributes].forEach(a=>{
          const keep=(c.tagName==='A'&&a.name==='href')||(c.tagName==='IMG'&&(a.name==='src'||a.name==='alt'));
          if(!keep)c.removeAttribute(a.name);
        });
        if(c.tagName==='SPAN')c.replaceWith(...c.childNodes);
        /* Word/SharePoint bullet paragraphs come through as plain <p>· text */
        if(c.tagName==='P'&&/^\s*[·•]\s+/.test(c.textContent)){
          const li=document.createElement('li');
          li.innerHTML=c.innerHTML.replace(/^\s*[·•]\s+/,'');
          const ul=document.createElement('ul'); ul.appendChild(li); c.replaceWith(ul);
        }
        /* tables ARE supported now, so a pasted table stays a table — we only
           strip its styling (the cells were already cleaned on the way down) */
      });
    };
    walk(box);
    return box.innerHTML;
  }


  function ic(n,s){ return window.CPRNavIcon?window.CPRNavIcon(n,s||15):''; }
  function toolbarHtml(opts){
    let h=''
        +'<select data-ed="eBlock" title="Text size">'
          +'<option value="p">Normal text</option>'
          +'<option value="h3">Heading 1</option>'
          +'<option value="h4">Heading 2</option>'
          +'<option value="h5">Heading 3</option>'
          +'<option value="h6">Heading 4</option></select>'
        +'<span class="edsep"></span>'
        +'<button data-cmd="bold" title="Bold (Ctrl+B)">'+ic('bold')+'</button>'
        +'<button data-cmd="italic" title="Italic (Ctrl+I)">'+ic('italic')+'</button>'
        +'<button data-cmd="underline" title="Underline (Ctrl+U)">'+ic('underline')+'</button>'
        +'<span class="edsep"></span>'
        +'<button data-cmd="insertUnorderedList" title="Bulleted list">'+ic('list')+'</button>'
        +'<button data-cmd="insertOrderedList" title="Numbered list">'+ic('list-ordered')+'</button>'
        +'<button data-cmd="indent" title="Make it a sub-item (Tab)">'+ic('indent-increase')+'</button>'
        +'<button data-cmd="outdent" title="Pull it back out (Shift+Tab)">'+ic('indent-decrease')+'</button>'
        +'<span class="edsep"></span>'
        +'<button data-do="link" title="Add a link">'+ic('link')+'</button>'
        +'<button data-ed="edImg" title="Upload an image">'+ic('image')+'</button>'
        +'<button class="hasmenu" data-ed="edTblBtn" title="Table">'+ic('table')+ic('chevron-down',12)+'</button>'
        +'<button class="hasmenu" data-ed="edCoBtn" title="Note box">'+ic('triangle-alert')+ic('chevron-down',12)+'</button>'
        +'<button data-do="hr" title="Divider line">'+ic('minus')+'</button>'
        +'<span class="edsep"></span>'
        +'<button data-do="clear" title="Strip formatting from the selection">'+ic('eraser')+'</button>'
        +'<span style="flex:1"></span>'
        +'<button data-ed="edSrc" title="Edit the raw markup (advanced)">'+ic('code')+'</button>'
        +'<input type="file" data-ed="edImgFile" accept="image/*" hidden>';
    if(!opts.upload)h=h.replace(/<button data-ed="edImg"[^>]*>[\s\S]*?<\/button>/,'');
    if(!opts.source)h=h.replace(/<button data-ed="edSrc"[^>]*>[\s\S]*?<\/button>/,'');
    return h;
  }
  function mount(host,options){
    const opts=options||{};
    const toast=opts.toast||function(){};
    let SRCMODE=false;
    host.innerHTML='<div class="edtools">'+toolbarHtml(opts)+'</div>'
      +'<div class="ed-rich" data-ed-rich contenteditable="true" spellcheck="true"'
      +(opts.minHeight?' style="min-height:'+opts.minHeight+'"':'')+'>'+mdToEditor(opts.value||'')+'</div>'
      +'<textarea class="edsrc" data-ed-src style="display:none" spellcheck="false">'+esc(opts.value||'')+'</textarea>';

    const rich=host.querySelector('[data-ed-rich]'), src=host.querySelector('[data-ed-src]');
    try{ document.execCommand('defaultParagraphSeparator',false,'p'); }catch(e){}
    /* Chrome's list commands leave <p><ul>…</ul></p>; unwrap so the document
       stays flat blocks (the serializer copes either way, this keeps it tidy) */
    function normalize(){
      rich.querySelectorAll('p > ul, p > ol, div > ul, div > ol').forEach(list=>{
        const par=list.parentElement;
        if(par===rich||!par)return;
        if(par.classList&&par.classList.contains('ed-callout'))return;
        par.replaceWith(...par.childNodes);
      });
      /* Outdent leaves the pulled-out <li> parked INSIDE its old parent <li>,
         which breaks the numbering on screen and merges the two items on save.
         Lift it (and anything after it) out to sit after that parent item. */
      let guard=0;
      while(guard++<40){
        const inner=rich.querySelector('li > li');
        if(!inner)break;
        const outer=inner.parentElement, list=outer.parentElement;
        if(!list||!/^(UL|OL)$/.test(list.tagName)){ inner.replaceWith(...inner.childNodes); continue; }
        const move=[]; for(let n=inner;n;n=n.nextSibling)move.push(n);
        const ref=outer.nextSibling;
        move.forEach(node=>list.insertBefore(node,ref));
      }
      /* a sub-list left as a sibling belongs to the item just above it */
      rich.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol').forEach(sub=>{
        const prev=sub.previousElementSibling;
        if(prev&&prev.tagName==='LI')prev.appendChild(sub);
      });
      /* A table (or list) pasted while the caret sits in a heading lands INSIDE
         that heading, and a heading serializes to a single line — so the
         table's text gets concatenated onto the title and the grid is lost.
         Lift any block back out to sit after the heading. */
      rich.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h=>{
        [...h.children].forEach(c=>{ if(/^(TABLE|UL|OL|HR)$/.test(c.tagName))h.after(c); });
      });
      /* Indenting into an existing group leaves a SECOND list next to the first,
         so the numbering restarts at 1. Same kind + adjacent = one list. */
      for(let pass=0;pass<10;pass++){
        let merged=false;
        rich.querySelectorAll('ul,ol').forEach(list=>{
          const prev=list.previousElementSibling;
          if(!prev||prev.tagName!==list.tagName)return;
          while(list.firstChild)prev.appendChild(list.firstChild);
          list.remove(); merged=true;
        });
        if(!merged)break;
      }
    }
    const exec=(c,v)=>{ rich.focus(); document.execCommand(c,false,v||null); normalize(); syncTools(); };
    function syncTools(){
      host.querySelectorAll('[data-cmd]').forEach(b=>{
        const c=b.dataset.cmd;
        let on=false;
        try{
          if(c==='formatBlock'){
            const blk=(document.queryCommandValue('formatBlock')||'').toLowerCase().replace(/[<>]/g,'');
            on=(blk===b.dataset.val)||(b.dataset.val==='p'&&(blk===''||blk==='div'));
          } else on=document.queryCommandState(c);
        }catch(e){}
        b.classList.toggle('on',!!on);
      });
      /* the size dropdown shows what the caret is sitting in */
      const sel=host.querySelector('[data-ed="eBlock"]');
      if(sel){
        const cur=currentBlock();
        if(cur&&cur.classList&&cur.classList.contains('ed-callout')){
          const bh=cur.querySelector('h3,h4,h5,h6');
          sel.value=bh?bh.tagName.toLowerCase():'p';
        }else{
          let blk='';
          try{ blk=(document.queryCommandValue('formatBlock')||'').toLowerCase().replace(/[<>]/g,''); }catch(e){}
          if(blk==='h1')blk='h3'; if(blk==='h2')blk='h4';
          sel.value=['h3','h4','h5','h6'].indexOf(blk)>-1?blk:'p';
        }
      }
    }
    /* Inside a note box, formatBlock would convert the BOX itself and the box
       would vanish — so size the box's own text instead. */
    function setBoxHeading(box,tag){
      const h=box.querySelector('h3,h4,h5,h6');
      if(tag==='p'){ if(h)h.replaceWith(...h.childNodes); }
      else if(h){ const n=document.createElement(tag); n.innerHTML=h.innerHTML; h.replaceWith(n); }
      else{ const n=document.createElement(tag); n.innerHTML=box.innerHTML||'<br>'; box.innerHTML=''; box.appendChild(n); }
      placeCaret(box.querySelector('h3,h4,h5,h6')||box);
      syncTools();
    }
    host.querySelector('[data-ed="eBlock"]').addEventListener('change',()=>{
      const v=host.querySelector('[data-ed="eBlock"]').value;
      rich.focus();
      const blk=currentBlock();
      if(blk&&blk.classList&&blk.classList.contains('ed-callout')){ setBoxHeading(blk,v); return; }
      exec('formatBlock','<'+v+'>');
    });
    const holdCaret=b=>{ ['mouseup','click'].forEach(ev=>b.addEventListener(ev,e=>e.preventDefault())); };
    host.querySelectorAll('[data-cmd]').forEach(b=>{
      holdCaret(b);
      b.addEventListener('mousedown',e=>{
        e.preventDefault();
        exec(b.dataset.cmd, b.dataset.val?('<'+b.dataset.val+'>'):null);
      });
    });
    ['keyup','mouseup','focus'].forEach(ev=>rich.addEventListener(ev,syncTools));
    /* block-level helpers the browser has no command for */
    function currentBlock(){
      const sel=window.getSelection(); if(!sel.rangeCount)return null;
      let n=sel.getRangeAt(0).startContainer;
      while(n&&n!==rich&&!(n.parentNode===rich))n=n.parentNode;
      return (n&&n!==rich)?n:null;
    }
    host.querySelectorAll('[data-do]').forEach(b=>{ holdCaret(b); b.addEventListener('mousedown',async e=>{
      e.preventDefault();
      const k=b.dataset.do;
      rich.focus();
      if(k==='link'){
        const sel=window.getSelection();
        const had=sel&&String(sel).trim();
        const u=prompt('Link URL:','https://');
        if(!u)return;
        if(had)document.execCommand('createLink',false,u);
        else document.execCommand('insertHTML',false,'<a href="'+escAttr(u)+'">'+esc(u)+'</a>');
      }
      else if(k==='hr')document.execCommand('insertHTML',false,'<hr><p><br></p>');
      else if(k==='clear')document.execCommand('removeFormat');
      syncTools();
    }); });
    /* ---- note boxes: pick a color, or turn one back into plain text ---- */
    function setCallout(kind){
      rich.focus();
      const blk=currentBlock();
      if(kind===null){   // "remove box"
        if(blk&&blk.classList&&blk.classList.contains('ed-callout')){
          const p=document.createElement('p'); p.innerHTML=blk.innerHTML; blk.replaceWith(p); placeCaret(p);
        }
        syncTools(); return;
      }
      const k=CO_KINDS.find(x=>x.key===kind)||CO_KINDS[0];
      if(blk&&blk.classList&&blk.classList.contains('ed-callout')){
        blk.className='ed-callout'+(k.cls?' '+k.cls:'');   // recolor in place
        blk.removeAttribute('style');                       // drop any custom colours
        delete blk.dataset.bg; delete blk.dataset.bd; delete blk.dataset.fg;
      }else if(blk){
        const d=document.createElement('div');
        d.className='ed-callout'+(k.cls?' '+k.cls:'');
        d.innerHTML=blk.innerHTML||'<br>';
        blk.replaceWith(d); placeCaret(d);
      }else{
        document.execCommand('insertHTML',false,'<div class="ed-callout'+(k.cls?' '+k.cls:'')+'">Note</div><p><br></p>');
      }
      syncTools();
    }
    function placeCaret(el){
      const r=document.createRange(); r.selectNodeContents(el); r.collapse(false);
      const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    /* one little dropdown used by both the note-box and table buttons */
    function openMenu(btn,items){
      document.querySelectorAll('.edmenu').forEach(m=>m.remove());
      const m=document.createElement('div'); m.className='edmenu';
      m.innerHTML=items.map((it,i)=>it.sep?'<div class="sep"></div>'
        :'<button type="button" data-i="'+i+'">'
          +'<span class="mic">'
          +(it.swatch?'<span class="sw" style="background:'+it.swatch[0]+';border-color:'+it.swatch[1]+'"></span>':'')
          +(it.icon?ic(it.icon,15):'')+'</span>'
          +'<span class="lbl">'+esc(it.label)+'</span></button>').join('');
      document.body.appendChild(m);
      const r=btn.getBoundingClientRect();
      m.style.top=(r.bottom+window.scrollY+5)+'px';
      m.style.left=Math.min(r.left+window.scrollX,window.innerWidth-m.offsetWidth-12)+'px';
      m.querySelectorAll('[data-i]').forEach(b=>b.addEventListener('click',()=>{
        const it=items[+b.dataset.i]; m.remove(); if(it&&it.run)it.run();
      }));
      setTimeout(()=>document.addEventListener('mousedown',function off(e){
        if(!m.contains(e.target)){ m.remove(); document.removeEventListener('mousedown',off); }
      }),0);
    }
    function setCustomCallout(bg,bd,fg){
      rich.focus();
      const blk=currentBlock();
      const style='background:#'+bg+';border-color:#'+bd+';color:#'+fg;
      const stamp=d=>{ d.className='ed-callout c-custom'; d.dataset.bg=bg; d.dataset.bd=bd; d.dataset.fg=fg;
        d.setAttribute('style',style); };
      if(blk&&blk.classList&&blk.classList.contains('ed-callout')){ stamp(blk); }
      else if(blk){ const d=document.createElement('div'); d.innerHTML=blk.innerHTML||'<br>'; stamp(d);
        blk.replaceWith(d); placeCaret(d); }
      else{ document.execCommand('insertHTML',false,
        '<div class="ed-callout c-custom" data-bg="'+bg+'" data-bd="'+bd+'" data-fg="'+fg+'" style="'+style+'">Note</div><p><br></p>'); }
      syncTools();
    }
    /* colors pop down as swatches — no labels, like Word's color picker */
    function openPalette(btn,items,extra){
      document.querySelectorAll('.edmenu').forEach(m=>m.remove());
      const m=document.createElement('div'); m.className='edmenu pal'+(extra?' '+extra:'');
      m.innerHTML=items.map((it,i)=>'<button type="button" data-i="'+i+'" title="'+escAttr(it.label)+'"'
        +(it.none?' class="none"':it.plus?' class="plus"':'')+' style="background:'+it.bg+';border-color:'+it.bd+'">'
        +(it.plus?ic('plus',15):'')+'</button>').join('');
      document.body.appendChild(m);
      const r=btn.getBoundingClientRect();
      m.style.top=(r.bottom+window.scrollY+5)+'px';
      m.style.left=Math.min(r.left+window.scrollX,window.innerWidth-m.offsetWidth-12)+'px';
      m.querySelectorAll('[data-i]').forEach(b=>b.addEventListener('click',()=>{
        const it=items[+b.dataset.i]; m.remove(); if(it&&it.run)it.run(); }));
      setTimeout(()=>document.addEventListener('mousedown',function off(e){
        if(!m.contains(e.target)){ m.remove(); document.removeEventListener('mousedown',off); }
      }),0);
    }
    /* the presets, then "+" for any colour you like */
    function openCustomPanel(btn){
      document.querySelectorAll('.edmenu').forEach(m=>m.remove());
      const cur=currentBlock();
      const inBox=cur&&cur.classList&&cur.classList.contains('ed-callout');
      const isCust=inBox&&cur.classList.contains('c-custom')&&cur.dataset.bg;
      let bg=isCust?cur.dataset.bg:'eaf6fd', bd=isCust?cur.dataset.bd:'bfe2f5', fg=isCust?cur.dataset.fg:'175e82';
      const m=document.createElement('div'); m.className='edmenu cust';
      m.innerHTML='<div class="curow"><span>Fill</span><input type="color" id="cuBg" value="#'+bg+'"></div>'
        +'<div class="curow"><span>Outline</span><input type="color" id="cuBd" value="#'+bd+'"></div>'
        +'<div class="curow"><span>Text</span><input type="color" id="cuFg" value="#'+fg+'"></div>'
        +'<div class="cupv" id="cuPv">Sample text</div>'
        +'<div class="curow end"><button type="button" class="btn sm" id="cuBack">‹ Colors</button>'
        +'<button type="button" class="btn pri sm" id="cuGo">Apply</button></div>';
      document.body.appendChild(m);
      const r=btn.getBoundingClientRect();
      m.style.top=(r.bottom+window.scrollY+5)+'px';
      m.style.left=Math.min(r.left+window.scrollX,window.innerWidth-m.offsetWidth-12)+'px';
      const $$=id=>m.querySelector('#'+id);
      let fgTouched=!!isCust, bdTouched=!!isCust;
      const paint=()=>{ const pv=$$('cuPv');
        pv.style.background=$$('cuBg').value; pv.style.borderColor=$$('cuBd').value; pv.style.color=$$('cuFg').value; };
      $$('cuBg').addEventListener('input',()=>{
        /* until you pick your own, outline and text follow the fill so it stays readable */
        if(!bdTouched)$$('cuBd').value='#'+deepen(hex6($$('cuBg').value),.18);
        if(!fgTouched)$$('cuFg').value='#'+readableOn($$('cuBg').value);
        paint(); });
      $$('cuBd').addEventListener('input',()=>{ bdTouched=true; paint(); });
      $$('cuFg').addEventListener('input',()=>{ fgTouched=true; paint(); });
      paint();
      $$('cuGo').addEventListener('click',()=>{ const b=hex6($$('cuBg').value),o=hex6($$('cuBd').value),f=hex6($$('cuFg').value);
        m.remove(); setCustomCallout(b,o,f); });
      $$('cuBack').addEventListener('click',()=>{ m.remove(); openMoreColors(); });
      setTimeout(()=>document.addEventListener('mousedown',function off(e){
        if(!m.contains(e.target)){ m.remove(); document.removeEventListener('mousedown',off); }
      }),0);
    }
    function openMoreColors(){
      openPalette(host.querySelector('[data-ed="edCoBtn"]'),CO_MORE.map(c=>({label:c.label,bg:'#'+c.bg,bd:'#'+c.bd,
          run:()=>setCustomCallout(c.bg,c.bd,c.fg)}))
        .concat([{label:'Pick your own…',bg:'#fff',bd:'#C7CAD4',plus:true,run:()=>openCustomPanel(host.querySelector('[data-ed="edCoBtn"]'))}]),
        'more');
    }
    function openCoMenu(){
      openPalette(host.querySelector('[data-ed="edCoBtn"]'),CO_KINDS.map(k=>({label:k.label,bg:k.bg,bd:k.bd,run:()=>setCallout(k.key)}))
        .concat([{label:'More colors…',bg:'#fff',bd:'#C7CAD4',plus:true,run:()=>openMoreColors()},
                 {label:'Remove box',bg:'#fff',bd:'#E0E2EA',none:true,run:()=>setCallout(null)}]));
    }
    host.querySelector('[data-ed="edCoBtn"]').addEventListener('mousedown',e=>{ e.preventDefault(); openCoMenu(); });
    /* ---- tables ---- */
    function caretCell(){
      const sel=window.getSelection(); if(!sel.rangeCount)return null;
      let n=sel.getRangeAt(0).startContainer;
      if(n.nodeType===3)n=n.parentNode;
      while(n&&n!==rich){ if(n.tagName==='TD'||n.tagName==='TH')return n; n=n.parentNode; }
      return null;
    }
    function insertTable(cols,rows){
      let h='<table><thead><tr>';
      for(let c=0;c<cols;c++)h+='<th>Column '+(c+1)+'</th>';
      h+='</tr></thead><tbody>';
      for(let r=0;r<rows;r++){ h+='<tr>'; for(let c=0;c<cols;c++)h+='<td><br></td>'; h+='</tr>'; }
      h+='</tbody></table><p><br></p>';
      rich.focus(); document.execCommand('insertHTML',false,h); normalize();
    }
    function tableOp(op){
      const cell=caretCell();
      if(!cell){ toast('Put the cursor inside a table first.',true); return; }
      const tr=cell.parentElement, table=cell.closest('table'), idx=[...tr.children].indexOf(cell);
      if(op==='row'){
        const nr=document.createElement('tr');
        [...tr.children].forEach(()=>{ const td=document.createElement('td'); td.innerHTML='<br>'; nr.appendChild(td); });
        (tr.parentElement.tagName==='THEAD'?table.tBodies[0]:tr.parentElement)
          .insertBefore(nr, tr.parentElement.tagName==='THEAD'?table.tBodies[0].firstChild:tr.nextSibling);
        placeCaret(nr.firstChild);
      }else if(op==='col'){
        [...table.querySelectorAll('tr')].forEach(r=>{
          const src=r.children[idx]||r.lastElementChild;
          const c=document.createElement(src&&src.tagName==='TH'?'th':'td');
          c.innerHTML=src&&src.tagName==='TH'?'Column':'<br>';
          r.insertBefore(c,(r.children[idx]||null)&&r.children[idx].nextSibling);
        });
      }else if(op==='delrow'){
        if(table.querySelectorAll('tr').length<2){ toast('That is the last row — delete the table instead.',true); return; }
        tr.remove();
      }else if(op==='delcol'){
        if(tr.children.length<2){ toast('That is the last column — delete the table instead.',true); return; }
        [...table.querySelectorAll('tr')].forEach(r=>{ if(r.children[idx])r.children[idx].remove(); });
      }else if(op==='del'){
        const p=document.createElement('p'); p.innerHTML='<br>'; table.replaceWith(p); placeCaret(p);
      }
      syncTools();
    }
    host.querySelector('[data-ed="edTblBtn"]').addEventListener('mousedown',e=>{ e.preventDefault();
      openMenu(host.querySelector('[data-ed="edTblBtn"]'),[
        {label:'Insert table (3 × 3)',icon:'table',run:()=>insertTable(3,3)},
        {sep:true},
        {label:'Add row below',icon:'plus',run:()=>tableOp('row')},
        {label:'Add column right',icon:'plus',run:()=>tableOp('col')},
        {label:'Delete row',icon:'trash-2',run:()=>tableOp('delrow')},
        {label:'Delete column',icon:'trash-2',run:()=>tableOp('delcol')},
        {sep:true},
        {label:'Delete table',icon:'trash-2',run:()=>tableOp('del')}
      ]);
    });
    /* Enter inside a note box should LEAVE the box (the browser's default is to
       clone it forever); Enter elsewhere makes a clean <p> */
    /* Tab inside a list makes a sub-item (Shift+Tab pulls it back out) — the
       thing everyone expects from Word. Outside a list Tab still moves focus. */
    rich.addEventListener('keydown',e=>{
      if(e.key!=='Tab')return;
      /* in a table Tab walks cells (and adds a row off the last one, like Word) */
      const cell=caretCell();
      if(cell){
        e.preventDefault();
        const cells=[...cell.closest('table').querySelectorAll('th,td')];
        const i=cells.indexOf(cell)+(e.shiftKey?-1:1);
        if(i>=0&&i<cells.length)placeCaret(cells[i]);
        else if(!e.shiftKey){ tableOp('row'); }
        return;
      }
      const sel=window.getSelection(); if(!sel.rangeCount)return;
      let n=sel.getRangeAt(0).startContainer;
      if(n.nodeType===3)n=n.parentNode;
      let li=null;
      while(n&&n!==rich){ if(n.tagName==='LI'){ li=n; break; } n=n.parentNode; }
      if(!li)return;
      e.preventDefault();
      exec(e.shiftKey?'outdent':'indent');
    });
    rich.addEventListener('keydown',e=>{
      if(e.key!=='Enter'||e.shiftKey)return;
      const blk=currentBlock();
      if(blk&&blk.classList&&blk.classList.contains('ed-callout')){
        e.preventDefault();
        const p=document.createElement('p'); p.innerHTML='<br>';
        blk.after(p);
        const r=document.createRange(); r.setStart(p,0); r.collapse(true);
        const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
        syncTools();
      }
    });
    /* paste: keep basic formatting, strip Word/SharePoint junk */
    rich.addEventListener('paste',e=>{
      const html=e.clipboardData&&e.clipboardData.getData('text/html');
      const text=e.clipboardData&&e.clipboardData.getData('text/plain');
      e.preventDefault();
      if(html)document.execCommand('insertHTML',false,cleanPaste(html));
      else if(text)document.execCommand('insertText',false,text);
    });
    const imgBtn=host.querySelector('[data-ed="edImg"]');
  if(imgBtn)imgBtn.addEventListener('click',()=>host.querySelector('[data-ed="edImgFile"]').click());
    const imgFile=host.querySelector('[data-ed="edImgFile"]');
  if(imgFile)imgFile.addEventListener('change',async()=>{
      const f=host.querySelector('[data-ed="edImgFile"]').files[0]; if(!f)return;
      if(!opts.upload){ toast('Images are not enabled here.',true); return; }
      toast('Uploading image…');
      try{
        const url=await opts.upload(f);
        if(!url)throw new Error('upload failed');
        rich.focus();
        document.execCommand('insertHTML',false,'<img src="'+escAttr(url)+'" alt="image"><p><br></p>');
        toast('Image added.');
      }catch(e){ toast('Upload failed: '+(e.message||e),true); }
    });

    /* advanced escape hatch: edit the raw markup */
    const srcBtn=host.querySelector('[data-ed="edSrc"]');
  if(srcBtn)srcBtn.addEventListener('click',()=>{
      if(!SRCMODE){ src.value=editorToMd(rich); rich.style.display='none'; src.style.display='block'; SRCMODE=true; srcBtn.classList.add('on'); }
      else{ rich.innerHTML=mdToEditor(src.value); src.style.display='none'; rich.style.display='block'; SRCMODE=false; srcBtn.classList.remove('on'); }
    });

    if(opts.onInput)rich.addEventListener('input',()=>opts.onInput());
    return {
      getMarkup:()=>SRCMODE?src.value:editorToMd(rich),
      setMarkup:md=>{ SRCMODE=false; src.style.display='none'; rich.style.display='block';
        rich.innerHTML=mdToEditor(md||''); },
      focus:()=>rich.focus(),
      el:rich
    };
  }
  window.CPRMarkupEditor={ mount:mount, mdToEditor:mdToEditor, editorToMd:editorToMd };
})();
