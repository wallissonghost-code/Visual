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
    return {...base,input:cleanUrl(input),requests:requests.slice(0,120),networkEvidence,rawHtml:html};
  } finally {await context.close()}
}
function realVideoCard(x){
  const data=parseUniversalObject(x.rawHtml),item=findItemStruct(data,x.id);
  if(!item)return {id:x.id,input:x.input,finalUrl:x.finalUrl,available:false,status:'DADOS_REAIS_NAO_ENCONTRADOS',username:x.username||null};
  const parsed=parserContract(item),s=item.statsV2||item.stats||{},v=item.video||{},author=item.author||{};
  return {id:x.id,input:x.input,finalUrl:x.finalUrl,available:parsed.accepted,status:parsed.accepted?'REAL':'PARCIAL',username:author.uniqueId||x.username||null,nickname:author.nickname||null,avatarUrl:author.avatarLarger||author.avatarMedium||author.avatarThumb||null,description:item.desc??item.description??'',createdAt:item.createTime??null,durationSeconds:v.duration??v.durationSeconds??null,coverUrl:v.cover||v.originCover||v.dynamicCover||null,metrics:{views:s.playCount??s.viewCount??null,likes:s.diggCount??s.likeCount??null,comments:s.commentCount??null,shares:s.shareCount??null,saves:s.collectCount??s.saveCount??null}};
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
    const a=await inspectOne(browser,urlA),b=await inspectOne(browser,urlB);const cards={A:realVideoCard(a),B:realVideoCard(b)};
    return {kind:'tiktok-video-compare',createdAt:new Date().toISOString(),a,b,cards,diff:diff(a,b),note:'Comparação de evidências públicas observadas. Diferenças de payload não indicam, sozinhas, a causa interna no TikTok.'};
  } finally {await browser?.close().catch(()=>{})}
}

function normalizeUser(raw){return String(raw||'').trim().replace(/^https?:\/\/(?:www\.)?tiktok\.com\/@/i,'').replace(/^@/,'').split(/[/?#]/)[0]}
function collectProfileVideos(html,username){
  const text=String(html||''),ids=new Set(),links=new Set(),re=/\/@([A-Za-z0-9._-]+)\/video\/(\d{8,})/g;let m;
  while((m=re.exec(text))){if(!username||m[1].toLowerCase()===username.toLowerCase()){ids.add(m[2]);links.add('https://www.tiktok.com/@'+m[1]+'/video/'+m[2])}}
  return {ids:[...ids],links:[...links]};
}

function parseUniversalObject(html){
  const m=String(html||'').match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m)return null;try{return JSON.parse(m[1])}catch{return null}
}
function findItemStruct(value,targetId,depth=0){
  if(!value||typeof value!=='object'||depth>14)return null;
  if(value.itemStruct&&typeof value.itemStruct==='object'&&(!targetId||String(value.itemStruct.id||'')===String(targetId)))return value.itemStruct;
  if(String(value.id||'')===String(targetId)&&(value.stats||value.statsV2||value.video||value.author))return value;
  for(const v of Object.values(value)){const hit=findItemStruct(v,targetId,depth+1);if(hit)return hit}return null;
}
function parserContract(item){
  if(!item||typeof item!=='object')return {accepted:false,reason:'sem itemStruct'};
  const stats=item.statsV2||item.stats||{};
  const fields={id:item.id??null,description:item.desc??item.description??null,createdAt:item.createTime??null,duration:item.video?.duration??item.video?.durationSeconds??null,views:stats.playCount??stats.viewCount??null,likes:stats.diggCount??stats.likeCount??null,comments:stats.commentCount??null,shares:stats.shareCount??null,saves:stats.collectCount??stats.saveCount??null};
  const required=['id','views','likes','comments','shares'],missing=required.filter(k=>fields[k]==null);
  return {accepted:missing.length===0,missing,fields};
}
function minimalClone(item){
  const stats=item?.statsV2||item?.stats||{};
  return {id:item?.id,desc:item?.desc??item?.description??'',createTime:item?.createTime??null,author:item?.author??{},video:item?.video??{},stats:{playCount:stats.playCount??stats.viewCount??null,diggCount:stats.diggCount??stats.likeCount??null,commentCount:stats.commentCount??null,shareCount:stats.shareCount??null,collectCount:stats.collectCount??stats.saveCount??null}};
}
function reconstructionLab(aDirect,bDirect){
  const aData=parseUniversalObject(aDirect.rawHtml),bData=parseUniversalObject(bDirect.rawHtml);
  const aItem=findItemStruct(aData,aDirect.id),bItem=findItemStruct(bData,bDirect.id);
  const aOriginal=parserContract(aItem),aMinimalItem=aItem?minimalClone(aItem):null,aMinimal=parserContract(aMinimalItem);
  const syntheticB=aMinimalItem?JSON.parse(JSON.stringify(aMinimalItem)):null;
  if(syntheticB)syntheticB.id=bDirect.id;
  const bSynthetic=parserContract(syntheticB);
  return {controlA:{itemStructFound:!!aItem,original:aOriginal,minimal:aMinimal,minimalItem:aMinimalItem},targetB:{itemStructFound:!!bItem,original:parserContract(bItem),syntheticFromA:bSynthetic,syntheticNotice:'Estrutura sintética apenas para validar o parser. Métricas permanecem as do molde A e NÃO representam o vídeo B.'},conclusion:aMinimal.accepted&&bSynthetic.accepted?'PARSER_ACEITA_MOLDE_RECONSTRUIDO':'MOLDE_NAO_VALIDADO'};
}
function extractFieldsFromParent(raw){
  try{
    const o=typeof raw==='string'?JSON.parse(raw):raw;
    const stats=o?.statsV2||o?.stats||o?.itemStruct?.statsV2||o?.itemStruct?.stats||o?.itemInfo?.itemStruct?.statsV2||o?.itemInfo?.itemStruct?.stats||{};
    const pick=(...keys)=>{for(const k of keys)if(stats?.[k]!=null)return stats[k];return null};
    return {views:pick('playCount','viewCount'),likes:pick('diggCount','likeCount'),comments:pick('commentCount'),shares:pick('shareCount'),saves:pick('collectCount','saveCount')};
  }catch{return {views:null,likes:null,comments:null,shares:null,saves:null}}
}
function recoveryFromEvidence(id,evidence=[]){
  const sources=[];for(const e of evidence){for(const m of e.matches||[]){const fields=extractFieldsFromParent(m.parent);sources.push({path:e.path||e.url||'',jsonPath:m.path,fields})}}
  const recovered={};for(const k of ['views','likes','comments','shares','saves']){const hit=sources.find(s=>s.fields[k]!=null);recovered[k]=hit?{value:hit.fields[k],source:hit.path,jsonPath:hit.jsonPath}:null}
  const count=Object.values(recovered).filter(Boolean).length;
  return {id,status:count===5?'RECUPERADO':count?'PARCIAL':'NÃO ENCONTRADO',recovered,sourcesChecked:sources.length};
}
async function resolveTarget(browser,raw){
  const x=await inspectOne(browser,raw);return {raw,id:x.id,username:x.username,finalUrl:x.finalUrl,direct:x};
}
async function captureProfileSession(browser,user,targetIds,onProgress){
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage(),responses=[];
  page.on('response',async r=>{if(!isTikTok(r.url()))return;const type=r.request().resourceType();if(!['xhr','fetch','document'].includes(type))return;try{const body=(await r.text()).slice(0,1500000);responses.push({status:r.status(),resourceType:type,url:cleanUrl(r.url()),body})}catch{}});
  try{
    onProgress('profile','Abrindo @'+user+' e capturando a navegação interna…');
    try{await page.goto('https://www.tiktok.com/@'+encodeURIComponent(user),{waitUntil:'domcontentloaded',timeout:15000})}catch{}
    for(let i=0;i<4;i++){await page.mouse.wheel(0,1600).catch(()=>{});await page.waitForTimeout(1200)}
    const hits={};for(const id of targetIds)hits[id]=[];
    for(const r of responses){for(const id of targetIds){if(!id||!r.body.includes(id))continue;const p=parseJsonEvidence(r.body,id);hits[id].push({status:r.status,url:r.url,resourceType:r.resourceType,topKeys:p.topKeys,matches:p.matches})}}
    return {hits,requests:responses.map(r=>({status:r.status,resourceType:r.resourceType,url:r.url})).slice(0,180)};
  }finally{await context.close().catch(()=>{})}
}
export async function runTikTokHypotheses(username,urlA,urlB,onProgress=()=>{}){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');
  let browser;
  try{
    browser=await chromium.launch({headless:true});onProgress('resolve','Resolvendo os dois links e identificando os Video IDs…');
    const a=await resolveTarget(browser,urlA),b=await resolveTarget(browser,urlB),ids=[a.id,b.id].filter(Boolean);
    onProgress('internal','HIPÓTESE CHAT: entrando pelo perfil e observando item_list/navegação interna…');
    const profile=await captureProfileSession(browser,user,ids,onProgress);onProgress('lab','HIPÓTESE USUÁRIO: desmontando A, criando molde mínimo e validando reconstrução do B…');const lab=reconstructionLab(a.direct,b.direct);
    const result={};
    for(const [label,x] of [['A',a],['B',b]]){
      const profileEvidence=profile.hits[x.id]||[];
      const all=[...(x.direct.networkEvidence||[]),...profileEvidence];
      result[label]={id:x.id,input:x.raw,directMarkers:x.direct.markers,profileEvidence,recovery:recoveryFromEvidence(x.id,all)};
      onProgress('target',label+' '+x.id+': '+profileEvidence.length+' resposta(s) do perfil com o ID; recuperação '+result[label].recovery.status+'.');
    }
    return {kind:'tiktok-two-hypotheses',createdAt:new Date().toISOString(),username:user,reconstructionLab:lab,hypothesisChat:{name:'Navegação interna TikTok',description:'Perfil → item_list → procurar A/B no tráfego do próprio TikTok.',targets:{A:{id:a.id,evidence:result.A.profileEvidence},B:{id:b.id,evidence:result.B.profileEvidence}}},hypothesisUser:{name:'Reconstruir dados reais',description:'Combina somente campos reais encontrados nas respostas observadas; nenhum valor é inventado.',targets:{A:result.A.recovery,B:result.B.recovery}},observedRequests:profile.requests,note:'Resultado experimental. O laboratório sintético valida somente a compatibilidade estrutural do parser; nunca trata métricas copiadas de A como dados reais de B.'};
  }finally{await browser?.close().catch(()=>{})}
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
