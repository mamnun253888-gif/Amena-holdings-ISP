// AMENA HOLDINGS (ISP) — MikroTik Bridge (RouterOS v6 API, zero dependencies, Node 18+)
const net=require('net'),http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
try{fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/).forEach(l=>{const m=l.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/^["']|["']$/g,'')})}catch(e){}
const E=process.env,CFG={host:E.ROUTER_HOST||'192.168.88.1',port:+E.ROUTER_PORT||8728,user:E.ROUTER_USER||'amena-api',pass:E.ROUTER_PASS||'',key:E.API_KEY||'',web:+E.PORT||3000,local:E.PPP_LOCAL_ADDRESS||'',pool:E.PPP_REMOTE_POOL||''};
if(!CFG.key||CFG.key.length<12){console.error('Set a strong API_KEY (12+ chars) in .env');process.exit(1)}
// ---- RouterOS API protocol ----
const enc=w=>{const b=Buffer.from(w,'utf8'),n=b.length;let h;if(n<0x80)h=Buffer.from([n]);else if(n<0x4000)h=Buffer.from([(n>>8)|0x80,n&255]);else if(n<0x200000)h=Buffer.from([(n>>16)|0xC0,(n>>8)&255,n&255]);else h=Buffer.from([(n>>24)|0xE0,(n>>16)&255,(n>>8)&255,n&255]);return Buffer.concat([h,b])};
const sentence=ws=>Buffer.concat([...ws.map(enc),Buffer.from([0])]);
function rd(b,p){if(p>=b.length)return null;const c=b[p];let n;if(c<0x80){n=c;p+=1}else if(c<0xC0){if(p+2>b.length)return null;n=((c&0x3F)<<8)|b[p+1];p+=2}else if(c<0xE0){if(p+3>b.length)return null;n=((c&0x1F)<<16)|(b[p+1]<<8)|b[p+2];p+=3}else if(c<0xF0){if(p+4>b.length)return null;n=((c&0x0F)<<24)|(b[p+1]<<16)|(b[p+2]<<8)|b[p+3];p+=4}else{if(p+5>b.length)return null;n=b.readUInt32BE(p+1);p+=5}if(p+n>b.length)return null;return[b.toString('utf8',p,p+n),p+n]}
class RB{
 constructor(c){this.c=c;this.buf=Buffer.alloc(0);this.cur=[];this.q=null}
 connect(){return new Promise((res,rej)=>{const s=this.s=net.connect(this.c.port,this.c.host);s.setTimeout(10000,()=>s.destroy(new Error('Router timeout')));s.once('error',rej);s.once('connect',()=>{s.removeListener('error',rej);s.on('error',e=>this.fail(e));res()});s.on('data',d=>{this.buf=Buffer.concat([this.buf,d]);this.pump()});s.on('close',()=>this.fail(new Error('Router closed the connection')))})}
 fail(e){if(this.q){const q=this.q;this.q=null;q.rej(e)}}
 pump(){for(;;){const r=rd(this.buf,0);if(!r)return;this.buf=this.buf.subarray(r[1]);if(r[0]===''){const s=this.cur;this.cur=[];this.onS(s)}else this.cur.push(r[0])}}
 onS(s){const t=s[0],a={};s.slice(1).forEach(w=>{if(w[0]=='='){const i=w.indexOf('=',1);a[w.slice(1,i)]=w.slice(i+1)}});
  if(t=='!re')this.rows.push(a);else if(t=='!trap')this.err=a.message||'trap';else if(t=='!fatal')this.fail(new Error(a.message||'fatal'));
  else if(t=='!done'&&this.q){const q=this.q;this.q=null;this.err?q.rej(new Error(this.err)):q.res({rows:this.rows,ret:a.ret})}}
 run(ws){return new Promise((res,rej)=>{this.q={res,rej};this.rows=[];this.err=null;this.s.write(sentence(ws))})}
 async login(){const u=this.c.user,p=this.c.pass,r=await this.run(['/login','=name='+u,'=password='+p]);
  if(r.ret){const md=crypto.createHash('md5').update(Buffer.concat([Buffer.from([0]),Buffer.from(p),Buffer.from(r.ret,'hex')])).digest('hex');await this.run(['/login','=name='+u,'=response=00'+md])}}
 close(){try{this.s.end()}catch(e){}}
}
async function withRB(fn){const rb=new RB(CFG);await rb.connect();try{await rb.login();return await fn(rb)}finally{rb.close()}}
// ---- helpers ----
const okU=u=>/^[A-Za-z0-9._@-]{1,64}$/.test(u||''),okP=p=>/^[A-Za-z0-9._ -]{1,64}$/.test(p||''),okW=w=>typeof w=='string'&&w.length>=1&&w.length<=64&&!/[\x00-\x1f]/.test(w);
async function kick(rb,u){const a=await rb.run(['/ppp/active/print','?name='+u]);for(const x of a.rows)await rb.run(['/ppp/active/remove','=.id='+x['.id']])}
async function upsert(rb,c,map){if(!okU(c.user)||!okP(c.profile)||!okW(c.pass))throw new Error('Invalid data for '+c.user);const dis=c.disabled?'yes':'no',ex=map?map[c.user]:(await rb.run(['/ppp/secret/print','?name='+c.user])).rows[0];
 if(!ex)await rb.run(['/ppp/secret/add','=name='+c.user,'=password='+c.pass,'=service=pppoe','=profile='+c.profile,'=disabled='+dis]);
 else if(ex.password!==c.pass||ex.profile!==c.profile||ex.disabled!==(c.disabled?'true':'false'))await rb.run(['/ppp/secret/set','=.id='+ex['.id'],'=password='+c.pass,'=profile='+c.profile,'=disabled='+dis]);
 if(c.disabled)await kick(rb,c.user)}
const H={
 '/mt/test':()=>withRB(async rb=>{const i=(await rb.run(['/system/identity/print'])).rows[0]||{},r=(await rb.run(['/system/resource/print'])).rows[0]||{};return{identity:i.name,version:r.version,board:r['board-name']}}),
 '/mt/monitor':()=>withRB(async rb=>{const i=(await rb.run(['/system/identity/print'])).rows[0]||{},r=(await rb.run(['/system/resource/print'])).rows[0]||{},n=(await rb.run(['/ppp/active/print','=.proplist=name'])).rows.length,t=+r['total-memory']||1,f=+r['free-memory']||0;return{identity:i.name,version:r.version,board:r['board-name'],cpu:r['cpu-load'],uptime:r.uptime,mem:Math.round((t-f)/t*100),active:n}}),
 '/mt/usage':()=>({usage:Object.fromEntries(Object.entries(U).map(([u,d])=>[u,Object.fromEntries(Object.entries(d).map(([k,v])=>[k,[v[0]/1048576,v[1]/1048576]]))]))}),
 '/mt/kick':b=>withRB(async rb=>{if(!okU(b.user))throw new Error('Bad user');await kick(rb,b.user);return{ok:true}}),
 '/mt/ping':b=>withRB(async rb=>{if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(b.address||''))throw new Error('Bad address');const r=(await rb.run(['/ping','=address='+b.address,'=count=3'])).rows,l=r[r.length-1]||{};return{sent:+l.sent||0,received:+l.received||0,avg:l['avg-rtt']||''}}),
 '/mt/active':()=>withRB(async rb=>({active:(await rb.run(['/ppp/active/print'])).rows.map(x=>({name:x.name,address:x.address,uptime:x.uptime,caller:x['caller-id']}))})),
 '/mt/secret':b=>withRB(async rb=>{await upsert(rb,b);return{ok:true}}),
 '/mt/sync':b=>withRB(async rb=>{const map={};(await rb.run(['/ppp/secret/print'])).rows.forEach(x=>map[x.name]=x);let ok=0;const failed=[];for(const c of(b.clients||[]).slice(0,5000)){try{await upsert(rb,c,map);ok++}catch(e){failed.push(c.user+': '+e.message)}}return{ok,failed}}),
 '/mt/profiles':b=>withRB(async rb=>{const have=new Set((await rb.run(['/ppp/profile/print'])).rows.map(x=>x.name)),created=[],existing=[];for(const p of b.profiles||[]){if(!okP(p.name)||!/^\d{1,4}M\/\d{1,4}M$/.test(p.rate||''))continue;if(have.has(p.name)){existing.push(p.name);continue}const w=['/ppp/profile/add','=name='+p.name,'=rate-limit='+p.rate];if(CFG.local)w.push('=local-address='+CFG.local);if(CFG.pool)w.push('=remote-address='+CFG.pool);await rb.run(w);created.push(p.name)}return{created,existing}})
};
// ---- usage collector: every 60s read PPPoE interface counters, store per user per day (survives restarts) ----
const UF=path.join(__dirname,'usage.json');let U={},last={};try{U=JSON.parse(fs.readFileSync(UF,'utf8'))}catch(e){}
const day=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
async function poll(){try{await withRB(async rb=>{const rows=(await rb.run(['/interface/print'])).rows,d=day(),seen=new Set();for(const x of rows){const m=/^<pppoe-(.+)>$/.exec(x.name||'');if(!m)continue;const u=m[1],rx=+x['rx-byte']||0,tx=+x['tx-byte']||0,l=last[u];seen.add(u);last[u]=[rx,tx];if(!l)continue;const dr=rx>=l[0]?rx-l[0]:rx,dt=tx>=l[1]?tx-l[1]:tx;if(dr||dt){const a=((U[u]=U[u]||{})[d]=U[u][d]||[0,0]);a[0]+=dt;a[1]+=dr}}for(const u in last)if(!seen.has(u))delete last[u]});const cut=new Date(Date.now()-4e10).toISOString().slice(0,10);for(const u in U)for(const k in U[u])if(k<cut)delete U[u][k];fs.writeFileSync(UF,JSON.stringify(U))}catch(e){}}
if(!E.NO_POLL){setInterval(poll,60000);poll()}
// ---- HTTP ----
const fails={};const send=(res,c,o)=>{res.writeHead(c,{'content-type':'application/json'});res.end(JSON.stringify(o))};
http.createServer((req,res)=>{const ip=req.socket.remoteAddress,u=req.url.split('?')[0];
 const ST={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/manifest.json':['manifest.json','application/manifest+json'],'/sw.js':['sw.js','application/javascript'],'/icon-192.png':['icon-192.png','image/png'],'/icon-512.png':['icon-512.png','image/png']};
 if(req.method=='GET'&&ST[u])return fs.readFile(path.join(__dirname,'public',ST[u][0]),(e,d)=>{if(e){res.writeHead(404);return res.end('missing')}res.writeHead(200,{'content-type':ST[u][1],'x-content-type-options':'nosniff'});res.end(d)});
 if(u=='/mt/health')return send(res,200,{ok:true});
 if(!H[u])return send(res,404,{error:'Not found'});
 const f=fails[ip]||{n:0,t:0};if(f.n>=10&&Date.now()-f.t<600000)return send(res,429,{error:'Too many wrong keys, wait 10 minutes'});
 const a=Buffer.from(req.headers['x-api-key']||''),b=Buffer.from(CFG.key);
 if(a.length!=b.length||!crypto.timingSafeEqual(a,b)){fails[ip]={n:f.n+1,t:Date.now()};return send(res,401,{error:'Wrong API key'})}
 fails[ip]={n:0,t:0};let body='';req.on('data',d=>{body+=d;if(body.length>2e6)req.destroy()});
 req.on('end',async()=>{let j={};try{j=body?JSON.parse(body):{}}catch(e){return send(res,400,{error:'Bad JSON'})}try{send(res,200,await H[u](j))}catch(e){send(res,502,{error:e.message})}})
}).listen(CFG.web,()=>console.log('AMENA bridge on http://0.0.0.0:'+CFG.web+' → router '+CFG.host+':'+CFG.port));
module.exports={enc,rd};
