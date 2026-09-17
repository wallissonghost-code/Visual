import { chromium } from 'playwright';

const SERVICE_RULES=[
  ['Supabase',/supabase\.(co|in)|supabase\.com/i,'Banco/API'],
  ['Firebase',/firebaseio\.com|firebasedatabase\.app|googleapis\.com\/identitytoolkit|firebaseapp\.com/i,'Banco/Auth/API'],
  ['Render',/onrender\.com/i,'Servidor/API'],
  ['Vercel',/vercel\.app|vercel-storage\.com/i,'Hosting/API'],
  ['Cloudflare',/workers\.dev|pages\.dev|cloudflare\.com/i,'Edge/Hosting'],
  ['GitHub',/githubusercontent\.com|github\.io/i,'Código/Hosting'],
  ['MongoDB Atlas',/mongodb-api\.com|mongodb\.net/i,'Banco/API'],
  ['Neon',/neon\.tech/i,'Banco PostgreSQL/API'],
  ['Railway',/railway\.app/i,'Servidor/API']
];
function clean(raw){try{const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(/token|key|secret|auth|password|session|jwt/i.test(k))u.searchParams.set(k,'[REDACTED]');return u.toString()}catch{return raw}}
function classify(url){for(const [name,re,type] of SERVICE_RULES)if(re.test(url))return{name,type,confidence:'detectado'};return null}
export async function mapUrlRuntime(target,{timeoutMs=15000}={}){
 const browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();
 const requests=[],sockets=[],errors=[];const started=Date.now();
 page.on('request',r=>{const u=clean(r.url());requests.push({method:r.method(),url:u,host:(()=>{try{return new URL(u).host}catch{return''}})(),resourceType:r.resourceType(),service:classify(u)})});
 page.on('response',r=>{const u=clean(r.url());for(let i=requests.length-1;i>=0;i--)if(requests[i].url===u&&requests[i].status==null){requests[i].status=r.status();break}});
 page.on('websocket',ws=>{const item={url:clean(ws.url()),service:classify(ws.url()),state:'open'};sockets.push(item);ws.on('close',()=>item.state='closed')});
 page.on('requestfailed',r=>errors.push({type:'request',url:clean(r.url()),error:r.failure()?.errorText||'failed'}));page.on('pageerror',e=>errors.push({type:'page',error:String(e.message||e)}));
 let navigation=null;try{const res=await page.goto(target,{waitUntil:'domcontentloaded',timeout:timeoutMs});navigation={status:res?.status()||null,finalUrl:clean(page.url())};await page.waitForTimeout(5000)}catch(e){navigation={status:null,finalUrl:clean(page.url()||target),error:e.message}}
 await browser.close();
 const hosts=[...new Set(requests.map(x=>x.host).filter(Boolean))];const services=[];for(const x of [...requests,...sockets])if(x.service&&!services.some(s=>s.name===x.service.name&&s.host===x.host)){let host='';try{host=new URL(x.url).host}catch{}services.push({...x.service,host})}
 return{target,navigation,durationMs:Date.now()-started,summary:{requests:requests.length,domains:hosts.length,webSockets:sockets.length,errors:errors.length,services:services.length},services,webSockets:sockets,requests,errors,limitations:['Somente tráfego observável pelo navegador é mapeado.','Bancos e serviços atrás de uma API própria não são visíveis diretamente.','Parâmetros com nomes sensíveis são ocultados no relatório.']};
}
