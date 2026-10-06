process.env.PLAYWRIGHT_BROWSERS_PATH='0';
const { chromium } = await import('playwright');
import dns from 'node:dns/promises';
import net from 'node:net';

const SERVICE_RULES=[['Supabase',/(?:^|\.)supabase\.(?:co|in)$|(?:^|\.)supabase\.com$/i,'Banco/API'],['Firebase',/(?:^|\.)firebaseio\.com$|(?:^|\.)firebasedatabase\.app$|(?:^|\.)firebaseapp\.com$/i,'Banco/Auth/API'],['Google APIs',/(?:^|\.)googleapis\.com$/i,'API'],['Render',/(?:^|\.)onrender\.com$/i,'Servidor/API'],['Vercel',/(?:^|\.)vercel\.app$|(?:^|\.)vercel-storage\.com$/i,'Hosting/API'],['Cloudflare',/(?:^|\.)workers\.dev$|(?:^|\.)pages\.dev$|(?:^|\.)cloudflare\.com$/i,'Edge/Hosting'],['GitHub',/(?:^|\.)githubusercontent\.com$|(?:^|\.)github\.io$/i,'Código/Hosting'],['MongoDB Atlas',/(?:^|\.)mongodb-api\.com$|(?:^|\.)mongodb\.net$/i,'Banco/API'],['Neon',/(?:^|\.)neon\.tech$/i,'Banco PostgreSQL/API'],['Railway',/(?:^|\.)railway\.app$/i,'Servidor/API']];
const SENSITIVE=/token|key|secret|auth|authorization|password|passwd|session|jwt|credential|api[-_]?key|access[-_]?token|refresh[-_]?token/i;
const TRACKING=/(?:^|\.)(?:analytics\.google\.com|googletagmanager\.com|doubleclick\.net)$/i;
const LIBRARY_SOURCE=/telegram-web-app|cocos2d|cocos-creator|dragonbones|pixi(?:\.min)?\.js|phaser(?:\.min)?\.js|three(?:\.min)?\.js/i;
const DOC_URL=/(?:^|\.)(?:example\.com|game\.com)$|w3\.org|developer\.|\/docs?\/|\/readme|github\.com\/(?:DragonBones|cocos)/i;
const MAX_INSPECT_BYTES=2_000_000,MAX_INSPECTED=40;
const GAME_TERMS=[['RTP',/\b(?:rtp|return[_\s-]?to[_\s-]?player)\b/i],['Paytable',/\b(?:paytable|pay[_\s-]?table|payout[_\s-]?table)\b/i],['Payout',/\b(?:payout|pay[_\s-]?out)\b/i],['Volatilidade',/\b(?:volatility|variance|volatilidade)\b/i],['Provedor',/\b(?:provider|gameProvider|vendor)\b/i],['Game ID',/\b(?:gameId|game_id|gameCode|game_code)\b/i],['Config de aposta',/\b(?:betConfig|bet_config|minBet|maxBet|betLevels?|coinValue)\b/i],['Jackpot',/\bjackpot\b/i],['Regras/Ajuda',/\b(?:gameRules?|gameInfo|helpPage|rulesPage)\b/i]];
const ASSET_RE=/\.(?:png|jpe?g|webp|gif|svg|atlas|plist|spine|skel|json|mp3|ogg|wav|m4a|mp4|webm|bin|wasm|ttf|woff2?)(?:$|[?#])/i;
const dnsCache=new Map();
function clean(raw){try{const u=new URL(raw);for(const k of [...u.searchParams.keys()])if(SENSITIVE.test(k))u.searchParams.set(k,'[REDACTED]');if(u.username)u.username='[REDACTED]';if(u.password)u.password='[REDACTED]';return u.toString()}catch{return String(raw||'').replace(/([?&](?:token|key|secret|auth|password|session|jwt)[^=\s]*=)[^&\s]+/gi,'$1[REDACTED]')}}
function cleanError(raw){return clean(String(raw||'')).slice(0,700)}
function classify(raw){try{const host=new URL(raw).hostname;for(const [name,re,type] of SERVICE_RULES)if(re.test(host))return{name,type,confidence:'Detectado'};}catch{}return null}
function roleFor(url,type,service){if(service)return service.type;let u;try{u=new URL(url)}catch{}if(u&&TRACKING.test(u.hostname))return'Analytics/Tracking';if(/\.json(?:$|\?)/i.test(url))return'Config/JSON';if(/cocos2d|cocos-creator/i.test(url))return'Engine Cocos';if(/physics(?:-min)?[.\-]/i.test(url))return'Engine/Física';if(['xhr','fetch'].includes(type))return /\/api(?:\/|$)|graphql|rpc/i.test(url)?'API/servidor provável':'Endpoint dinâmico provável';return null}
function privateIp(ip){if(net.isIP(ip)===4){const p=ip.split('.').map(Number);return p[0]===10||p[0]===127||p[0]===0||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168;}if(net.isIP(ip)===6){const x=ip.toLowerCase();return x==='::1'||x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe80:')||x.startsWith('::ffff:127.')||x.startsWith('::ffff:10.')||x.startsWith('::ffff:192.168.');}return false}
async function assertPublicTarget(raw){let u;try{u=new URL(raw)}catch{throw new Error('URL inválida.')}if(!['http:','https:'].includes(u.protocol))throw new Error('Use somente http/https.');if(u.username||u.password)throw new Error('Credenciais na URL não são permitidas.');const host=u.hostname.toLowerCase();if(host==='localhost'||host.endsWith('.localhost')||net.isIP(host)&&privateIp(host))throw new Error('Somente destinos públicos são permitidos.');let addresses=dnsCache.get(host);if(!addresses){try{addresses=await dns.lookup(host,{all:true});dnsCache.set(host,addresses)}catch{throw new Error('Não foi possível resolver o domínio.')}}if(!addresses.length||addresses.some(x=>privateIp(x.address)))throw new Error('O destino resolve para rede local/privada e foi bloqueado.');return u.toString()}
function inspectable(url,ct,type){return !TRACKING.test((()=>{try{return new URL(url).hostname}catch{return''}})())&&(/(?:javascript|json|text\/plain)/i.test(ct||'')||['script','xhr','fetch'].includes(type)&&/\.(?:js|json)(?:$|\?)/i.test(url))}
function unique(a,n=25){return[...new Set(a.filter(Boolean))].slice(0,n)}
function safeDiscoveredUrl(raw,base){let s=String(raw||'').trim().replace(/[.,;:]+$/,'');try{const u=new URL(s,base);if(!['http:','https:','ws:','wss:'].includes(u.protocol))return null;return clean(u.toString())}catch{return null}}
function contextAround(text,re,label){const m=re.exec(text);if(!m)return null;const start=Math.max(0,m.index-90),end=Math.min(text.length,m.index+String(m[0]).length+130);return{type:label,match:String(m[0]).slice(0,80),context:text.slice(start,end).replace(/\s+/g,' ').slice(0,280)}}
function gameFindings(text){const out=[];for(const [label,re] of GAME_TERMS){const hit=contextAround(text,re,label);if(hit)out.push(hit)}return out}
function assetKind(url){if(/\.(png|jpe?g|webp|gif|svg)/i.test(url))return'Imagem/Sprite';if(/\.(atlas|plist|spine|skel)/i.test(url))return'Atlas/Animação';if(/\.(mp3|ogg|wav|m4a)/i.test(url))return'Áudio';if(/\.(mp4|webm)/i.test(url))return'Vídeo';if(/\.json/i.test(url))return'Config/Dados';if(/\.(ttf|woff2?)/i.test(url))return'Fonte';return'Binário/Recurso'}
function assetRefs(text,base){const found=[];const re=/["'`]([^"'`\s]{1,240}\.(?:png|jpe?g|webp|gif|svg|atlas|plist|spine|skel|json|mp3|ogg|wav|m4a|mp4|webm|bin|wasm|ttf|woff2?)(?:\?[^"'`\s]{0,120})?)["'`]/gi;for(const m of text.matchAll(re)){if(/^data:/i.test(m[1]))continue;const url=safeDiscoveredUrl(m[1],base);if(url)found.push({url,kind:assetKind(url)})}return [...new Map(found.map(x=>[x.url,x])).values()].slice(0,40)}
function inspectText(text,base){const safe=String(text||'').slice(0,MAX_INSPECT_BYTES);const candidates=safe.match(/(?:https?:\/\/|wss?:\/\/)[^\s"'`<>\\)\]}]+/gi)||[];const urls=unique(candidates.map(x=>safeDiscoveredUrl(x,base)).filter(Boolean),30);const websocket=/(?:new\s+WebSocket\s*\(|\bWebSocket\b|wss?:\/\/)/i.test(safe);const fetchLike=/(?:\bfetch\s*\(|XMLHttpRequest|axios\.|\.ajax\s*\()/i.test(safe);const markers=[];if(/cocos2d|cc\.director|CocosCreator/i.test(safe))markers.push('Cocos/engine');if(/RoomMessageCenter|RoomID|GAME_SERVER|game_ping/i.test(safe))markers.push('Jogo/sala');if(/HallMessageCenter|UIHall/i.test(safe))markers.push('Lobby/Hall');if(/GoogleLogin|SignInWithGoogle|google.*sign.?in/i.test(safe))markers.push('Google Login');if(/legitimuz/i.test(safe))markers.push('KYC/Legitimuz');if(/captcha|recaptcha/i.test(safe))markers.push('Captcha');if(/login|register|visitor_login|third_login/i.test(safe))markers.push('Login/Auth');const paths=unique([...safe.matchAll(/["'`]((?:\/api\/|\/graphql|\/rpc\/)[^"'`\s]{1,180})["'`]/gi)].map(m=>m[1]),25);return{bytesScanned:Math.min(Buffer.byteLength(safe),MAX_INSPECT_BYTES),webSocketCode:websocket,httpClientCode:fetchLike,markers:unique(markers),gameMetadata:gameFindings(safe),assetReferences:assetRefs(safe,base),discoveredUrls:urls,discoveredApiPaths:paths,base:clean(base)}}
function provenance(url,source,targetHost,observed){let host='';try{host=new URL(url).hostname}catch{}if(observed.has(url))return'Observada na rede';if(DOC_URL.test(url))return'Documentação/exemplo';if(LIBRARY_SOURCE.test(source))return'Biblioteca/SDK';if(host===targetHost||host.endsWith('.'+targetHost))return'Referência do app';return'Referência externa no código'}
function urlKind(url){let u;try{u=new URL(url)}catch{return'Indefinido'}if(/^wss?:$/.test(u.protocol))return'WebSocket';if(TRACKING.test(u.hostname))return'Analytics/Tracking';if(/\/api(?:\/|$)|graphql|rpc/i.test(u.pathname))return'API';if(ASSET_RE.test(u.pathname+u.search))return'Asset/Config';if(/share|callback|redirect|returnurl/i.test(u.href))return'Share/Callback';return'Página/URL externa'}
export async function mapUrlRuntime(target,{timeoutMs=20000,observeMs=15000}={}){target=await assertPublicTarget(target);let browser;const requests=[],sockets=[],errors=[],inspectedResources=[],frames=[],pending=new Set(),started=Date.now();try{browser=await chromium.launch({headless:true});const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();await page.route('**/*',async route=>{const req=route.request();if(req.isNavigationRequest()){try{await assertPublicTarget(req.url())}catch{return route.abort('blockedbyclient')}}return route.continue()});const frameId=f=>{let i=frames.findIndex(x=>x._frame===f);if(i<0){frames.push({_frame:f,id:`frame-${frames.length+1}`,url:clean(f.url()||'about:blank'),name:f.name()||'',main:f===page.mainFrame()});i=frames.length-1}return frames[i].id};page.on('frameattached',f=>frameId(f));page.on('framenavigated',f=>{const id=frameId(f),x=frames.find(v=>v.id===id);x.url=clean(f.url());x.name=f.name()||x.name;x.main=f===page.mainFrame()});page.on('request',r=>{const raw=r.url(),u=clean(raw),service=classify(raw);let host='',endpoint='';try{const p=new URL(u);host=p.host;endpoint=p.pathname+p.search}catch{}requests.push({method:r.method(),url:u,host,endpoint,resourceType:r.resourceType(),status:null,service,role:roleFor(u,r.resourceType(),service),frameId:frameId(r.frame())})});page.on('response',r=>{const task=(async()=>{const raw=r.url(),u=clean(raw);let reqItem;for(let i=requests.length-1;i>=0;i--)if(requests[i].url===u&&requests[i].status==null){requests[i].status=r.status();reqItem=requests[i];break}if(inspectedResources.length>=MAX_INSPECTED||!r.ok())return;const ct=r.headers()['content-type']||'',type=r.request().resourceType();if(!inspectable(raw,ct,type))return;try{await assertPublicTarget(raw);const body=await r.body();if(!body||body.length>MAX_INSPECT_BYTES)return;const analysis=inspectText(body.toString('utf8'),raw);const item={url:u,host:reqItem?.host||'',resourceType:type,contentType:ct.split(';')[0],frameId:reqItem?.frameId||null,...analysis};inspectedResources.push(item);if(reqItem)reqItem.inspected=true}catch(e){errors.push({type:'inspect',url:u,error:cleanError(e?.message||e)})}})();pending.add(task);task.finally(()=>pending.delete(task))});page.on('websocket',ws=>{const raw=ws.url(),item={url:clean(raw),host:'',service:classify(raw),state:'open'};try{item.host=new URL(raw).host}catch{}sockets.push(item);ws.on('close',()=>item.state='closed');ws.on('socketerror',e=>errors.push({type:'websocket',url:item.url,error:cleanError(e||'socket error')}))});page.on('requestfailed',r=>errors.push({type:'request',url:clean(r.url()),error:cleanError(r.failure()?.errorText||'failed')}));page.on('pageerror',e=>errors.push({type:'runtime',error:cleanError(e.message||e)}));page.on('console',m=>{if(m.type()==='error')errors.push({type:'console',error:cleanError(m.text())})});let navigation;try{const res=await page.goto(target,{waitUntil:'domcontentloaded',timeout:timeoutMs});navigation={status:res?.status()||null,finalUrl:clean(page.url())};await page.waitForTimeout(observeMs)}catch(e){navigation={status:null,finalUrl:clean(page.url()||target),error:cleanError(e.message||e)}}await Promise.allSettled([...pending]);const hosts=[...new Set(requests.map(x=>x.host).filter(Boolean))],services=[];for(const x of [...requests,...sockets])if(x.service&&!services.some(s=>s.name===x.service.name&&s.host===x.host))services.push({...x.service,host:x.host});const ownApiObserved=requests.some(r=>['xhr','fetch'].includes(r.resourceType)&&!r.service&&!TRACKING.test(r.host));const infrastructure={status:'Não observável',note:ownApiObserved?'A página chamou endpoint(s) sem provedor identificável. O navegador não revela banco, rede ou serviços internos atrás dessa API.':'Infraestrutura interna de backends não pode ser inferida sem evidência direta no tráfego do navegador.'};let targetHost='';try{targetHost=new URL(target).hostname}catch{}const observed=new Set([...requests.map(x=>x.url),...sockets.map(x=>x.url)]);const allRefs=[];for(const x of inspectedResources)for(const u of x.discoveredUrls||[])allRefs.push({url:u,kind:urlKind(u),provenance:provenance(u,x.url,targetHost,observed),source:x.url});const classifiedUrls=[...new Map(allRefs.map(x=>[`${x.url}|${x.source}`,x])).values()].slice(0,100);const gameMetadata=inspectedResources.flatMap(x=>(x.gameMetadata||[]).map(f=>({...f,source:x.url,provenance:LIBRARY_SOURCE.test(x.url)?'Biblioteca/SDK':'Referência pública'}))).slice(0,80);const assets=[];for(const x of inspectedResources)for(const a of x.assetReferences||[])assets.push({...a,source:x.url,provenance:LIBRARY_SOURCE.test(x.url)?'Biblioteca/SDK':'Referência do app'});const assetReferences=[...new Map(assets.map(x=>[x.url,x])).values()].slice(0,120);const exposure={hiddenClientUrls:classifiedUrls.filter(x=>x.provenance==='Observada na rede'||x.provenance==='Referência do app').slice(0,50),gameIds:gameMetadata.filter(x=>x.type==='Game ID').slice(0,20),publicConfigs:requests.filter(x=>x.role==='Config/JSON').map(x=>({url:x.url,frameId:x.frameId})).slice(0,30),note:'Itens visíveis ao navegador/cliente. Não significa que sejam secretos ou que concedam acesso sem autorização.'};const discoveries={urls:unique(classifiedUrls.map(x=>x.url),60),classifiedUrls,apiPaths:unique(inspectedResources.flatMap(x=>x.discoveredApiPaths||[]),50),markers:unique(inspectedResources.flatMap(x=>x.markers||[]),30),webSocketCode:inspectedResources.some(x=>x.webSocketCode),httpClientCode:inspectedResources.some(x=>x.httpClientCode),gameMetadata,assetReferences};return{target,navigation,durationMs:Date.now()-started,observation:{mode:observeMs>=12000?'profunda':'rápida',observeMs},summary:{requests:requests.length,domains:hosts.length,webSockets:sockets.length,frames:frames.length,errors:errors.length,services:services.length,inspectedResources:inspectedResources.length,discoveredUrls:discoveries.urls.length,gameMetadata:gameMetadata.length,assetReferences:assetReferences.length,clientExposures:exposure.hiddenClientUrls.length},services,webSockets:sockets,frames:frames.map(({_frame,...x})=>x),discoveries,exposure,inspectedResources,requests,errors,infrastructure,legend:{detected:'Detectado = evidência direta no tráfego/arquivo público observado.',probable:'Provável = função inferida pelo tipo/caminho, não pelo backend interno.',unobservable:'Não observável = informação escondida atrás de API/servidor.'},limitations:['Somente tráfego e conteúdo público observáveis pelo navegador são mapeados.','Authorization, cookies, request/response bodies genéricos e storage não são coletados.','Conteúdo público JS/JSON observado pode ser inspecionado, limitado a 2 MB por recurso e 40 recursos.','Metadados de jogo são referências públicas; não demonstram RTP efetivo da sessão nem permitem prever resultados.','URLs e assets descobertos são classificados, mas não são abertos automaticamente.','Parâmetros sensíveis da URL são mascarados.','Bancos e serviços atrás de uma API própria não são inferidos.']}}finally{await browser?.close().catch(()=>{})}}


export async function inspectTikTokTreasureDom(username,{observeMs=5000,timeoutMs=12000}={}){
 const user=String(username||'').trim().replace(/^@/,'').replace(/[^A-Za-z0-9._-]/g,'');
 if(!user)throw new Error('Informe o @user.');
 const target='https://www.tiktok.com/@'+user+'/live';
 let browser;const signals=[],resourceSignals=[];
 const hint=/treasure|envelope|lucky|luck.?money|reward|goody.?bag|gift.?bag|lucky.?bag|bag|sacola|chest|ba[uú]|recompensa/i;
 try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',locale:'pt-BR',viewport:{width:1440,height:900},screen:{width:1440,height:900},deviceScaleFactor:1,isMobile:false,hasTouch:false});
  const page=await context.newPage();
  page.on('response',r=>{const u=clean(r.url());if(hint.test(u)&&!SENSITIVE.test(u))resourceSignals.push({type:'resource',url:u,status:r.status()})});
  const res=await page.goto(target,{waitUntil:'domcontentloaded',timeout:timeoutMs}).catch(()=>null);
  await page.waitForTimeout(observeMs);
  for(const frame of page.frames()){
   try{
    const found=await frame.evaluate(()=>{
     const re=/treasure|envelope|lucky|luck.?money|reward|goody.?bag|chest|ba[uú]|recompensa/i,out=[];
     const els=[...document.querySelectorAll('body *')];
     for(const el of els){
      const attrs=[...el.attributes].map(a=>a.name+'='+a.value).join(' ');
      const text=(el.innerText||el.textContent||'').trim();
      const probe=[el.tagName,el.id,el.className,attrs,text].join(' ');
      if(re.test(probe)){
       out.push({tag:el.tagName,id:el.id||null,className:String(el.className||'').slice(0,300),text:text.slice(0,500),attrs:attrs.slice(0,700)});
       if(out.length>=30)break;
      }
     }
     return out;
    });
    if(found.length)signals.push({frameUrl:clean(frame.url()),matches:found});
   }catch{}
  }
  const detected=signals.length>0||resourceSignals.length>0;
  return {kind:'tiktok-treasure-dom',username:user,target,status:res?.status()||null,finalUrl:clean(page.url()),detected,signals,resourceSignals:resourceSignals.slice(0,30),observeMs,note:detected?'Sinal público relacionado a baú/recompensa encontrado na interface ou recursos da LIVE.':'Nenhum sinal de baú/recompensa ficou visível no DOM público desta sessão anônima.'};
 }finally{await browser?.close().catch(()=>{})}
}


export async function discoverTikTokLivesDom({limit=30,observeMs=6000,timeoutMs=15000}={}){
 limit=Math.max(1,Math.min(50,Number(limit)||30));
 let browser;const rooms=new Map(),resources=[],pageDiagnostics=[],responseDiagnostics=[];const targets=['https://www.tiktok.com/live','https://www.tiktok.com/'];
 const addRoom=(room,source='webcast-feed')=>{if(!room||typeof room!=='object'||rooms.size>=limit)return;const data=room.data&&typeof room.data==='object'?room.data:room;const roomId=String(data.id_str||data.room_id_str||data.roomId||data.id||'').match(/^\d{12,24}$/)?.[0]||null;const owner=data.owner||data.user||{};const username=String(owner.unique_id||owner.uniqueId||owner.sec_uid||'').replace(/^@/,'').match(/^[A-Za-z0-9._-]{2,32}$/)?.[0]||null;if(!roomId&&!username)return;const key=roomId?'r:'+roomId:'u:'+username.toLowerCase();if(!rooms.has(key))rooms.set(key,{roomId,username,ownerUserId:data.owner_user_id?String(data.owner_user_id):null,title:String(data.title||'').slice(0,180)||null,viewers:Number(data.user_count||data.viewer_count||0)||null,status:data.status??null,liveUrl:username?'https://www.tiktok.com/@'+username+'/live':null,luckMoney:data.room_auth?.LuckMoney??null,source})};
 const walkRooms=(o,source,depth=0)=>{if(depth>7||!o||typeof o!=='object'||rooms.size>=limit)return;if(Array.isArray(o)){for(const v of o)walkRooms(v,source,depth+1);return}if((o.id_str||o.room_id_str||o.roomId||o.id)&&('status'in o||'owner_user_id'in o||'room_auth'in o||'user_count'in o||'title'in o))addRoom(o,source);for(const v of Object.values(o))if(v&&typeof v==='object')walkRooms(v,source,depth+1)};
 const take=(raw,source='network')=>{try{const s=String(raw||'');let m;const userRe=/tiktok\.com\/@([A-Za-z0-9._-]{2,32})\/live/gi;while((m=userRe.exec(s))&&rooms.size<limit){const username=m[1],key='u:'+username.toLowerCase();if(!rooms.has(key))rooms.set(key,{roomId:null,username,liveUrl:'https://www.tiktok.com/@'+username+'/live',source})}}catch{}};
 try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',locale:'pt-BR',viewport:{width:1440,height:900}});
  const page=await context.newPage();
  page.on('response',async r=>{const type=r.request().resourceType();let url;try{url=new URL(r.url())}catch{return}const isTikTok=/(^|\.)tiktok\.com$/i.test(url.hostname);if(!isTikTok||!(type==='fetch'||type==='xhr'))return;const safeUrl=url.origin+url.pathname;if(/live|room|feed|recommend|webcast/i.test(url.pathname))resources.push({url:safeUrl,status:r.status(),type});try{const ct=String(r.headers()['content-type']||'');if(!/json|text/i.test(ct))return;const len=Number(r.headers()['content-length']||0);if(len>2000000)return;const body=await r.text();take(body,'network-body');let data=null;try{data=JSON.parse(body)}catch{}if(data&&url.pathname==='/webcast/feed/')walkRooms(data,'webcast-feed');const keys=o=>o&&typeof o==='object'&&!Array.isArray(o)?Object.keys(o).slice(0,40):[];responseDiagnostics.push({path:url.pathname,status:r.status(),type,contentType:ct.split(';')[0],bytes:Buffer.byteLength(body),topKeys:data?keys(data):[],roomsFound:rooms.size});if(responseDiagnostics.length>50)responseDiagnostics.shift()}catch{}});
  let navigation=null;
  for(const target of targets){try{const res=await page.goto(target,{waitUntil:'domcontentloaded',timeout:timeoutMs});navigation={target,status:res?.status()||null,finalUrl:clean(page.url())};await page.waitForTimeout(Math.max(observeMs,8000));if(target.includes('/live')){for(let i=0;i<4&&rooms.size<limit;i++){await page.mouse.wheel(0,700).catch(()=>{});await page.waitForTimeout(1200)}await page.waitForTimeout(4000)}const html=await page.content();take(html,'dom-html');const title=await page.title().catch(()=>'');const bodyText=(await page.locator('body').innerText({timeout:3000}).catch(()=>'' )).slice(0,2500);pageDiagnostics.push({target,status:res?.status()||null,finalUrl:clean(page.url()),title,htmlBytes:Buffer.byteLength(html),challenge:/captcha|verify|verification|security check|unusual traffic|access denied/i.test(title+' '+bodyText),bodyPreview:bodyText.slice(0,1200),roomsFound:rooms.size});if(rooms.size)break}catch(e){navigation={target,status:null,finalUrl:clean(page.url()||target),error:String(e.message||e)}}}
  const out=[...rooms.values()].slice(0,limit);
  return {kind:'tiktok-live-dom-discovery',count:out.length,rooms:out,navigation,pageDiagnostics,responseDiagnostics,resourceSignals:resources.slice(-50),observeMs,note:out.length?'Salas LIVE extraídas passivamente das respostas públicas geradas pelo navegador, incluindo /webcast/feed/.':'O navegador público não expôs salas LIVE nesta tentativa.'};
 }finally{await browser?.close().catch(()=>{})}
}={}){
 limit=Math.max(1,Math.min(50,Number(limit)||30));
 let browser;const rooms=new Map(),resources=[],pageDiagnostics=[],responseDiagnostics=[];const targets=['https://www.tiktok.com/live','https://www.tiktok.com/'];
 const take=(raw,source='network')=>{try{
  const s=String(raw||'');let m;
  const userRe=/tiktok\.com\/@([A-Za-z0-9._-]{2,32})\/live/gi;
  while((m=userRe.exec(s))&&rooms.size<limit){const username=m[1],key='u:'+username.toLowerCase();if(!rooms.has(key))rooms.set(key,{roomId:null,username,liveUrl:'https://www.tiktok.com/@'+username+'/live',source})}
  const ridRe=/(?:room[_-]?id|roomId|room_id_str)[^0-9]{0,20}([0-9]{12,24})/gi;
  while((m=ridRe.exec(s))&&rooms.size<limit){const roomId=m[1],key='r:'+roomId;if(!rooms.has(key))rooms.set(key,{roomId,username:null,liveUrl:null,source})}
 }catch{}};
 try{
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',locale:'pt-BR'});
  const page=await context.newPage();
  page.on('request',r=>take(clean(r.url()),'network-request'));
  page.on('response',async r=>{const u=clean(r.url()),type=r.request().resourceType();if(/live|room|feed|recommend|webcast/i.test(u)){let safeUrl=u;try{const x=new URL(r.url());safeUrl=x.origin+x.pathname}catch{}resources.push({url:safeUrl,status:r.status(),type});}take(u,'network-response');
   if((type==='fetch'||type==='xhr')&&/live|room|feed|recommend|webcast/i.test(u)){
    try{
     const ct=String(r.headers()['content-type']||'');
     if(/json|text/i.test(ct)){
      const body=await r.text();
      take(body,'network-body');
      let structure=null;
      try{
       const data=JSON.parse(body);
       const keys=o=>o&&typeof o==='object'&&!Array.isArray(o)?Object.keys(o).slice(0,40):[];
       const findArrays=(o,path='',depth=0,out=[])=>{if(depth>4||!o||typeof o!=='object'||out.length>=20)return out;for(const [k,v] of Object.entries(o)){const p=path?path+'.'+k:k;if(Array.isArray(v)){out.push({path:p,length:v.length,sampleKeys:v[0]&&typeof v[0]==='object'?keys(v[0]):[]});if(v[0]&&typeof v[0]==='object')findArrays(v[0],p+'[0]',depth+1,out)}else if(v&&typeof v==='object')findArrays(v,p,depth+1,out)}return out};
       const findLiveKeys=(o,path='',depth=0,out=[])=>{if(depth>5||!o||typeof o!=='object'||out.length>=40)return out;for(const [k,v] of Object.entries(o)){const p=path?path+'.'+k:k;if(/live|room|webcast|stream/i.test(k))out.push({path:p,type:Array.isArray(v)?'array':typeof v,value:typeof v==='string'||typeof v==='number'||typeof v==='boolean'?String(v).slice(0,100):undefined});if(v&&typeof v==='object')findLiveKeys(v,p,depth+1,out)}return out};
       structure={topKeys:keys(data),arrays:findArrays(data),liveFields:findLiveKeys(data)};
      }catch{}
      responseDiagnostics.push({path:(new URL(r.url())).pathname,status:r.status(),type,contentType:ct.split(';')[0],bytes:Buffer.byteLength(body),roomHints:(body.match(/(?:room[_-]?id|roomId|room_id_str)/gi)||[]).length,liveHints:(body.match(/(?:liveRoom|live_room|is_live|status)/gi)||[]).length,structure});
      if(responseDiagnostics.length>30)responseDiagnostics.shift();
     }
    }catch{}
   }
  });
  let navigation=null;
  for(const target of targets){
   try{
    const res=await page.goto(target,{waitUntil:'domcontentloaded',timeout:timeoutMs});navigation={target,status:res?.status()||null,finalUrl:clean(page.url())};
    await page.waitForTimeout(Math.max(observeMs,8000));
    if(target.includes('/live')){
     for(let i=0;i<4;i++){await page.mouse.wheel(0,700).catch(()=>{});await page.waitForTimeout(1200)}
     await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)).catch(()=>{});
     await page.waitForTimeout(5000);
    }
    const html=await page.content();take(html,'dom-html');
    const links=await page.locator('a[href*="/@"]').evaluateAll(as=>as.map(a=>a.href)).catch(()=>[]);
    links.forEach(x=>take(x,'dom-link'));
    const title=await page.title().catch(()=>'');
    const bodyText=(await page.locator('body').innerText({timeout:3000}).catch(()=>'' )).slice(0,2500);
    const frameUrls=page.frames().map(f=>clean(f.url())).slice(0,30);
    const challenge=/captcha|verify|verification|security check|unusual traffic|access denied|log in|login|sign up/i.test(title+' '+bodyText);
    pageDiagnostics.push({target,status:res?.status()||null,finalUrl:clean(page.url()),title,htmlBytes:Buffer.byteLength(html),linkCount:links.length,frameCount:frameUrls.length,frameUrls,challenge,bodyPreview:bodyText.slice(0,1200)});
    if(rooms.size)break;
   }catch(e){navigation={target,status:null,finalUrl:clean(page.url()||target),error:String(e.message||e)}}
  }
  const merged=[...rooms.values()];
  const byUser=new Map();for(const x of merged){const k=x.username?'u:'+x.username.toLowerCase():'r:'+x.roomId;if(!byUser.has(k))byUser.set(k,x)}
  return {kind:'tiktok-live-dom-discovery',count:Math.min(limit,byUser.size),rooms:[...byUser.values()].slice(0,limit),navigation,pageDiagnostics,responseDiagnostics,resourceSignals:resources.slice(0,80),observeMs,note:byUser.size?'Perfis/salas LIVE encontrados na superfície pública carregada pelo navegador.':'O navegador público não expôs perfis/salas LIVE nesta tentativa.'};
 }finally{await browser?.close().catch(()=>{})}
}
