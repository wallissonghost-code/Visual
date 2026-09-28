process.env.PLAYWRIGHT_BROWSERS_PATH='0';
const { chromium } = await import('playwright');

const MARKERS=[
  ['itemStruct',/itemStruct/i],['itemInfo',/itemInfo/i],['statsV2',/statsV2/i],
  ['playCount',/playCount/i],['diggCount',/diggCount/i],['commentCount',/commentCount/i],
  ['shareCount',/shareCount/i],['collectCount',/collectCount/i],
  ['SIGI_STATE',/SIGI_STATE/i],['UNIVERSAL_DATA',/__UNIVERSAL_DATA_FOR_REHYDRATION__/i],
  ['video-detail',/video-detail/i]
];
function isTikTok(raw){try{const h=new URL(raw).hostname.toLowerCase();return h==='tiktok.com'||h.endsWith('.tiktok.com')}catch{return false}}
function cleanUrl(raw){try{const u=new URL(raw);u.hash='';return u.toString()}catch{return String(raw||'')}}
function videoIdentity(url,html=''){
  const fromUrl=String(url).match(/\/video\/(\d{8,})/);
  const id=fromUrl?.[1]||null;
  const user=String(url).match(/tiktok\.com\/@([^/?#]+)/i)?.[1]||null;
  const idOccurrences=id?(String(html).match(new RegExp(id,'g'))||[]).length:0;
  return {id,username:user,idOccurrences};
}
function contexts(text,needle,radius=260,limit=8){
  const src=String(text||''),low=src.toLowerCase(),q=String(needle).toLowerCase(),out=[];let at=0;
  while(out.length<limit&&(at=low.indexOf(q,at))>=0){const start=Math.max(0,at-radius),end=Math.min(src.length,at+q.length+radius);out.push({offset:at,context:src.slice(start,end).replace(/\s+/g,' ')});at+=q.length}
  return out
}
function universalData(html){
  const text=String(html||''),m=text.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m)return {found:false,parsed:false,paths:[],videoIdPaths:[],topKeys:[]};
  try{
    const data=JSON.parse(m[1]),paths=[],videoIdPaths=[];
    const walk=(v,path,depth=0)=>{if(depth>8||paths.length>=500)return;if(v&&typeof v==='object'){for(const [k,x] of Object.entries(v)){const p=path?path+'.'+k:k;paths.push(p);if(typeof x==='string'&&/^\d{8,}$/.test(x)&&/video|item|id/i.test(p))videoIdPaths.push({path:p,value:x});walk(x,p,depth+1)}}};
    walk(data,'');
    return {found:true,parsed:true,topKeys:Object.keys(data),paths:paths.filter(p=>/video|item|detail|stats|scope|webapp/i.test(p)).slice(0,120),videoIdPaths:videoIdPaths.slice(0,30)};
  }catch(e){return {found:true,parsed:false,error:String(e.message||e),paths:[],videoIdPaths:[],topKeys:[]}}
}
function findIdEvidence(value,targetId,path='$',out=[],depth=0){
  if(!targetId||depth>12||out.length>=40)return out;
  if(value&&typeof value==='object'){for(const [k,v] of Object.entries(value)){const p=path+'.'+k;if(String(v)===String(targetId))out.push({path:p,parent:JSON.stringify(value).slice(0,6000)});findIdEvidence(v,targetId,p,out,depth+1)}}
  return out;
}
function parseJsonEvidence(body,targetId){try{const data=JSON.parse(String(body||''));return {parsed:true,matches:findIdEvidence(data,targetId),topKeys:data&&typeof data==='object'?Object.keys(data).slice(0,40):[]}}catch(e){return {parsed:false,error:e.message,matches:[],topKeys:[]}}}
function inspectHtml(html,finalUrl,status){
  const text=String(html||'');
  const markers=Object.fromEntries(MARKERS.map(([k,re])=>[k,re.test(text)]));
  const identity=videoIdentity(finalUrl,text);
  let canonical=null;
  const m=text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)||text.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if(m) canonical=cleanUrl(m[1]);
  const detailContexts=contexts(text,'video-detail');
  const idContexts=identity.id?contexts(text,identity.id,220,6):[];
  const universal=universalData(text);
  return {status,finalUrl:cleanUrl(finalUrl),canonical,htmlBytes:Buffer.byteLength(text),...identity,markers,diagnostics:{videoDetail:{occurrences:detailContexts.length,contexts:detailContexts},videoId:{occurrences:idContexts.length,contexts:idContexts},universal}};
}
async function inspectOne(browser,input){
  if(!isTikTok(input))throw new Error('Use somente links públicos do TikTok.');
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  const requests=[],responseEvidence=[];
  page.on('response',async r=>{const u=r.url();if(!isTikTok(u))return;let path='';try{const x=new URL(u);path=x.pathname+x.search}catch{}const entry={status:r.status(),resourceType:r.request().resourceType(),path:path.slice(0,500)};requests.push(entry);if(['xhr','fetch'].includes(entry.resourceType)){try{const body=(await r.text()).slice(0,1200000);responseEvidence.push({status:entry.status,path:entry.path,bytes:Buffer.byteLength(body),body})}catch{}}});
  try{
    const res=await page.goto(input,{waitUntil:'domcontentloaded',timeout:25000});
    await page.waitForTimeout(3500);
    const html=await page.content();const base=inspectHtml(html,page.url(),res?.status()||null),targetId=base.id;
    const networkEvidence=responseEvidence.map(x=>{const parsed=parseJsonEvidence(x.body,targetId);return {status:x.status,path:x.path,bytes:x.bytes,containsTarget:targetId?x.body.includes(targetId):false,jsonParsed:parsed.parsed,topKeys:parsed.topKeys,matches:parsed.matches}}).filter(x=>x.containsTarget||x.matches.length);
    return {...base,input:cleanUrl(input),requests:requests.slice(0,120),networkEvidence};
  } finally {await context.close()}
}
function diff(a,b){
  const markerDiff={};
  for(const [k] of MARKERS)markerDiff[k]={a:!!a.markers[k],b:!!b.markers[k],same:!!a.markers[k]===!!b.markers[k]};
  return {
    sameShortTokenLength:(new URL(a.input).pathname.replace(/\//g,'').length)===(new URL(b.input).pathname.replace(/\//g,'').length),
    sameHttpStatus:a.status===b.status,
    sameHtmlSize:a.htmlBytes===b.htmlBytes,
    htmlSizeDelta:b.htmlBytes-a.htmlBytes,
    bothHaveVideoId:!!a.id&&!!b.id,
    sameUsername:a.username===b.username,
    idOccurrenceDelta:b.idOccurrences-a.idOccurrences,
    markerDiff
  };
}
export async function compareTikTokVideos(urlA,urlB){
  if(!isTikTok(urlA)||!isTikTok(urlB))throw new Error('Os dois campos precisam ser URLs públicas do TikTok.');
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const a=await inspectOne(browser,urlA),b=await inspectOne(browser,urlB);
    return {kind:'tiktok-video-compare',createdAt:new Date().toISOString(),a,b,diff:diff(a,b),note:'Comparação de evidências públicas observadas. Diferenças de payload não indicam, sozinhas, a causa interna no TikTok.'};
  } finally {await browser?.close().catch(()=>{})}
}

function normalizeUser(raw){return String(raw||'').trim().replace(/^https?:\/\/(?:www\.)?tiktok\.com\/@/i,'').replace(/^@/,'').split(/[/?#]/)[0]}
function collectProfileVideos(html,username){
  const text=String(html||''),ids=new Set(),links=new Set(),re=/\/@([A-Za-z0-9._-]+)\/video\/(\d{8,})/g;let m;
  while((m=re.exec(text))){if(!username||m[1].toLowerCase()===username.toLowerCase()){ids.add(m[2]);links.add('https://www.tiktok.com/@'+m[1]+'/video/'+m[2])}}
  return {ids:[...ids],links:[...links]};
}
export async function inspectTikTokProfile(username,urlA,urlB,onProgress=()=>{}){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');onProgress('start','Iniciando busca por @'+user+'…');
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    onProgress('browser','Navegador iniciado. Abrindo perfil…');const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),responses=[];
    page.on('response',async r=>{if(!isTikTok(r.url()))return;let body='';const type=r.request().resourceType();if(['xhr','fetch','document'].includes(type)){try{body=(await r.text()).slice(0,1000000)}catch{}}responses.push({status:r.status(),resourceType:type,url:cleanUrl(r.url()),body})});
    const profileUrl='https://www.tiktok.com/@'+encodeURIComponent(user);
    let res=null,html='',profileError=null;
    try{
      res=await page.goto(profileUrl,{waitUntil:'domcontentloaded',timeout:15000});
      onProgress('profile','Perfil respondeu HTTP '+(res?.status()||'-')+'. Observando carregamento…');
      await page.waitForTimeout(3000);
      html=await page.content();
      onProgress('html','Perfil carregado: '+Buffer.byteLength(html)+' bytes. Procurando evidências dos 2 vídeos…');
    }catch(e){
      profileError=e.message;
      onProgress('profile-skip','Perfil auxiliar falhou/expirou. Continuando normalmente com os 2 links…');
      try{html=await page.content()}catch{}
    }
    const found=collectProfileVideos(html,user);for(const x of responses){const more=collectProfileVideos(x.body,user);more.ids.forEach(v=>found.ids.push(v));more.links.forEach(v=>found.links.push(v))}
    found.ids=[...new Set(found.ids)];found.links=[...new Set(found.links)];onProgress('videos',found.ids.length+' vídeo(s) público(s) encontrado(s) pelo perfil.');
    const probes=[];let probeIndex=0;for(const raw of [urlA,urlB].filter(Boolean)){probeIndex++;onProgress('probe','Verificando link '+probeIndex+'/2 com diagnóstico de rede…');try{const x=await inspectOne(browser,raw);const profileEvidence=[];for(const r of responses){if(!x.id||!r.body||!r.body.includes(x.id))continue;const parsed=parseJsonEvidence(r.body,x.id);profileEvidence.push({status:r.status(),url:r.url,resourceType:r.resourceType,jsonParsed:parsed.parsed,topKeys:parsed.topKeys,matches:parsed.matches})}probes.push({input:raw,id:x.id,finalUrl:x.finalUrl,foundInProfile:x.id?found.ids.includes(x.id):false,markers:x.markers,videoPage:{idOccurrences:x.idOccurrences,diagnostics:x.diagnostics,networkEvidence:x.networkEvidence},profileEvidence});onProgress('evidence','Link '+probeIndex+': '+x.networkEvidence.length+' resposta(s) da página e '+profileEvidence.length+' resposta(s) do perfil contêm o ID '+(x.id||'-')+'.')}catch(e){probes.push({input:raw,error:e.message})}}
    onProgress('done','Finalizando relatório…');return {kind:'tiktok-profile-route-inspect',createdAt:new Date().toISOString(),username:user,profileUrl,status:res?.status()||null,profileError,finalUrl:cleanUrl(page.url()),htmlBytes:Buffer.byteLength(html),discoveredVideoIds:found.ids,discoveredVideoLinks:found.links,probes,observedRequests:responses.map(x=>({status:x.status,resourceType:x.resourceType,url:x.url})).slice(0,120),note:'Busca somente evidências públicas observáveis no perfil e nas respostas carregadas pelo navegador.'};
  }finally{await browser?.close().catch(()=>{})}
}
