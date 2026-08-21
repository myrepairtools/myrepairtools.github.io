// Reusable spot-check: sign in as a real user, load a page, screenshot it.
//   node shotpage.mjs <page.html> <out.png> [owner|admin] [width]
import pkg from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pkg;
import { execFileSync } from 'child_process';
import fs from 'fs';
const SC='/tmp/claude-0/-home-user-myrepairtools-github-io/8e873401-8f7c-5dc7-b094-a758d730f9fc/scratchpad';
const SB='https://xuvsehrevxackuhmbmry.supabase.co';
const SRK=fs.readFileSync(SC+'/srk.txt','utf8').trim();
const ANON=fs.readFileSync(SC+'/anon.txt','utf8').trim();
const H={apikey:SRK,Authorization:'Bearer '+SRK,'Content-Type':'application/json'};
const [page,out,role='owner',width='1280']=process.argv.slice(2);
const get=async u=>(await (await fetch(SB+'/rest/v1/'+u,{headers:H})).json());
const who=(await get(`staff?select=auth_uid,display_name&role=eq.${role}&active=eq.true&auth_uid=not.is.null&limit=1`))[0];
const u=await (await fetch(SB+'/auth/v1/admin/users/'+who.auth_uid,{headers:H})).json();
const g=await fetch(SB+'/auth/v1/admin/generate_link',{method:'POST',headers:H,body:JSON.stringify({type:'magiclink',email:u.email})});
const s=await (await fetch(SB+'/auth/v1/verify',{method:'POST',headers:{'Content-Type':'application/json',apikey:SRK},body:JSON.stringify({type:'magiclink',token_hash:(await g.json()).hashed_token})})).json();
const store={access_token:s.access_token,refresh_token:s.refresh_token,expires_at:Math.floor(Date.now()/1000)+1800,expires_in:1800,token_type:'bearer',user:s.user};
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const ctx=await b.newContext({viewport:{width:+width,height:900}});
await ctx.route('**xuvsehrevxackuhmbmry.supabase.co/**',async r=>{
  const req=r.request(),url=req.url(),args=['-s','-i','--suppress-connect-headers',url],h=req.headers();
  for(const k of ['authorization','apikey','content-type','prefer','x-client-info','accept','accept-profile'])if(h[k])args.push('-H',`${k}: ${h[k]}`);
  if(req.method()!=='GET'){args.push('-X',req.method());const d=req.postData();if(d)args.push('--data-binary',d);}
  try{const raw=execFileSync('curl',args,{encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});
    const i=raw.indexOf('\r\n\r\n');const st=parseInt((raw.slice(0,i).match(/HTTP\/[\d.]+ (\d+)/)||[])[1]||'200',10);
    await r.fulfill({status:st,contentType:'application/json',body:raw.slice(i+4)});
  }catch(e){await r.fulfill({status:500,body:'{}'});}
});
await ctx.addInitScript(v=>{localStorage.setItem('sb-xuvsehrevxackuhmbmry-auth-token',v);
  localStorage.setItem('cpr_site_unlocked','1');localStorage.setItem('cpr_last_activity',String(Date.now()));},JSON.stringify(store));
const pg=await ctx.newPage(); const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
const fonts=[]; pg.on('request',r=>{ if(/\.(woff2?|ttf|otf)(\?|$)/i.test(r.url())||/fonts\.(googleapis|gstatic)/.test(r.url())) fonts.push(r.url()); });
await pg.goto('http://localhost:8239/'+page); await pg.waitForTimeout(9000);
await pg.evaluate(()=>{const g=document.getElementById('cpr-pingate');if(g)g.remove();});
await pg.waitForTimeout(1200);
const used=await pg.evaluate(()=>{
  const seen={};
  for(const el of [...document.querySelectorAll('h1,h2,h3,button,.fldl,body,p,div')].slice(0,400)){
    const cs=getComputedStyle(el); const k=cs.fontFamily.split(',')[0].replace(/["']/g,'');
    seen[k]=(seen[k]||0)+1;
  }
  return seen;
});
console.log('  page errors:',errs.length?errs.slice(0,2).join(' | '):'none');
console.log('  font/webfont requests:',fonts.length?fonts.join(', '):'NONE (good)');
console.log('  computed first-family tally:',JSON.stringify(used));
await pg.screenshot({path:out,fullPage:false});
await b.close();
