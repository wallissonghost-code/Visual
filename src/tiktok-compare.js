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

function summarizeItemListBody(body){
  const out={bytes:Buffer.byteLength(String(body||'')),jsonParsed:false,topKeys:[],listPath:null,itemCount:0,ids:[],cursor:null,hasMore:null,error:null,items:[]};
  try{
    const data=JSON.parse(String(body||''));out.jsonParsed=true;out.topKeys=data&&typeof data==='object'?Object.keys(data).slice(0,40):[];
    const candidates=[['itemList',data?.itemList],['item_list',data?.item_list],['items',data?.items],['data.itemList',data?.data?.itemList],['data.item_list',data?.data?.item_list],['data.items',data?.data?.items]];
    const hit=candidates.find(([,v])=>Array.isArray(v));if(hit){out.listPath=hit[0];out.itemCount=hit[1].length;out.ids=hit[1].map(x=>String(x?.id||x?.itemId||x?.aweme_id||'')).filter(Boolean);out.items=hit[1].slice(0,5).map(x=>{const s=x?.statsV2||x?.stats||{};return{id:String(x?.id||x?.itemId||x?.aweme_id||''),desc:String(x?.desc||x?.description||'').slice(0,160),views:s.playCount??s.viewCount??null,likes:s.diggCount??s.likeCount??null,comments:s.commentCount??null,shares:s.shareCount??null,saves:s.collectCount??s.saveCount??null}})}
    out.cursor=data?.cursor??data?.data?.cursor??null;out.hasMore=data?.hasMore??data?.has_more??data?.data?.hasMore??data?.data?.has_more??null;
  }catch(e){out.error=String(e.message||e)}
  return out;
}
export async function dumpTikTokItemList(username,onProgress=()=>{}){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');
  const profiles=[
    {name:'PADRAO',options:{serviceWorkers:'block'},init:null,url:'https://www.tiktok.com/@'+encodeURIComponent(user)},
    {name:'WINDOWS_BR',options:{serviceWorkers:'block',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:900},screen:{width:1600,height:900},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'},init:'win',url:'https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR'},
    {name:'WINDOWS_BR_AQUECIDO',options:{serviceWorkers:'block',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:900},screen:{width:1600,height:900},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'},init:'win',warm:true,url:'https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR'}
  ];
  let browser;const dumps=[];
  try{
    browser=await chromium.launch({headless:true});
    for(const profile of profiles){
      const context=await browser.newContext(profile.options);
      if(profile.init)await context.addInitScript(()=>{try{Object.defineProperty(navigator,'platform',{get:()=> 'Win32',configurable:true})}catch{}try{Object.defineProperty(navigator,'language',{get:()=> 'pt-BR',configurable:true})}catch{}try{Object.defineProperty(navigator,'languages',{get:()=> ['pt-BR','pt'],configurable:true})}catch{}});
      const page=await context.newPage(),pending=new Set();
      page.on('response',r=>{if(!/\/api\/post\/item_list\//.test(r.url()))return;const task=(async()=>{const rec={attempt:profile.name,url:cleanUrl(r.url()),status:r.status(),resourceType:r.request().resourceType(),contentType:r.headers()['content-type']||'',bodyRead:false,bodyError:null,summary:null};try{await r.finished();const body=await r.body();rec.bodyRead=true;rec.summary=summarizeItemListBody(body.toString('utf8'))}catch(e){rec.bodyError=String(e.message||e)}dumps.push(rec);onProgress('item-list',profile.name+': HTTP '+rec.status+' · '+(rec.summary?.bytes||0)+' bytes · '+(rec.summary?.itemCount||0)+' itens.')})();pending.add(task);task.finally(()=>pending.delete(task))});
      try{
        onProgress('attempt','Tentativa '+profile.name+'…');
        if(profile.warm){try{await page.goto('https://www.tiktok.com/?lang=pt-BR',{waitUntil:'domcontentloaded',timeout:15000});await page.waitForTimeout(1800)}catch{}}
        try{await page.goto(profile.url,{waitUntil:'domcontentloaded',timeout:20000})}catch(e){onProgress('navigation',profile.name+': '+e.message)}
        for(let i=0;i<6;i++){await page.mouse.wheel(0,1700).catch(()=>{});await page.waitForTimeout(900)}
        await page.waitForTimeout(2200);
        const deadline=Date.now()+12000;while(pending.size&&Date.now()<deadline){await Promise.race([Promise.allSettled([...pending]),page.waitForTimeout(200)])}
      }finally{await context.close().catch(()=>{})}
      if(dumps.some(x=>x.attempt===profile.name&&x.summary?.itemCount>0)){onProgress('success',profile.name+' encontrou vídeos reais. Encerrando bateria.');break}
    }
    return {kind:'tiktok-item-list-battery',createdAt:new Date().toISOString(),username:user,dumps,pendingAtReturn:0,note:'Bateria automática: padrão, Windows/BR e Windows/BR com navegação aquecida. Cada tentativa observa apenas item_list gerada pelo próprio TikTok.'};
  }finally{await browser?.close().catch(()=>{})}
}
function sourceSnapshot(label,x){
  const data=parseUniversalObject(x.rawHtml),item=findItemStruct(data,x.id),parsed=parserContract(item);
  return {label,id:x.id,finalUrl:x.finalUrl,http:x.status,htmlBytes:x.htmlBytes,idOccurrences:x.idOccurrences,
    sources:{html:{universalFound:!!data,itemStructFound:!!item,parserAccepted:!!parsed.accepted,metrics:parsed.fields||null,markers:x.markers},
      network:{responsesWithTarget:x.networkEvidence?.length||0,evidence:(x.networkEvidence||[]).map(e=>({status:e.status,path:e.path,bytes:e.bytes,jsonParsed:e.jsonParsed,topKeys:e.topKeys,matchPaths:(e.matches||[]).map(m=>m.path)}))}},
    requests:(x.requests||[]).map(r=>({status:r.status,resourceType:r.resourceType,path:r.path})).slice(0,120)};
}
function firstDivergence(a,b){
  const checks=[
    ['HTTP_DOCUMENTO',a.http===b.http,{a:a.http,b:b.http}],
    ['UNIVERSAL_DATA',a.sources.html.universalFound===b.sources.html.universalFound,{a:a.sources.html.universalFound,b:b.sources.html.universalFound}],
    ['ITEM_STRUCT',a.sources.html.itemStructFound===b.sources.html.itemStructFound,{a:a.sources.html.itemStructFound,b:b.sources.html.itemStructFound}],
    ['PARSER_METRICAS',a.sources.html.parserAccepted===b.sources.html.parserAccepted,{a:a.sources.html.parserAccepted,b:b.sources.html.parserAccepted}],
    ['REDE_COM_VIDEO_ID',a.sources.network.responsesWithTarget===b.sources.network.responsesWithTarget,{a:a.sources.network.responsesWithTarget,b:b.sources.network.responsesWithTarget}]
  ];
  const hit=checks.find(x=>!x[1]);return hit?{stage:hit[0],...hit[2]}:{stage:'SEM_DIVERGENCIA_NOS_ESTAGIOS_MEDIDOS'};
}
const PC_LOGGED_OUT_BASELINE={user_is_login:'false',count:'16',cursor:'0',region:'BR',priorityRegion:'',language:'pt-BR',appLanguage:'pt-BR',timezone:'America/Sao_Paulo',browserPlatform:'Win32',os:'windows',screenWidth:'1600',screenHeight:'900',verifyFpPresent:false,msTokenPresent:true,xBogusPresent:true,xGnarlyPresent:true,xDynosaurPresent:true};
function compareWithPcBaseline(query){
  const fields=Object.keys(PC_LOGGED_OUT_BASELINE);
  const differences=fields.filter(k=>String(query?.[k])!==String(PC_LOGGED_OUT_BASELINE[k])).map(k=>({field:k,pc:PC_LOGGED_OUT_BASELINE[k],render:query?.[k]??null}));
  return {source:'previously captured successful logged-out Windows request; secret values excluded',matches:fields.length-differences.length,total:fields.length,differences};
}
async function traceNativePostItemList(browser,user,targetIds,onProgress=()=>{}){
  const context=await browser.newContext({serviceWorkers:'block',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:900},screen:{width:1600,height:900},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'});
  await context.addInitScript(() => {
    try{Object.defineProperty(navigator,'platform',{get:()=> 'Win32',configurable:true})}catch{}
    try{Object.defineProperty(navigator,'language',{get:()=> 'pt-BR',configurable:true})}catch{}
    try{Object.defineProperty(navigator,'languages',{get:()=> ['pt-BR','pt'],configurable:true})}catch{}
  });
  const page=await context.newPage(),captures=[],pending=new Set(),regionProbeUrls=new Set(),fallbackEvidence=[];
  const summarizeRequest=(raw)=>{
    try{const u=new URL(raw),q=u.searchParams;return {path:u.pathname,method:'GET',query:{user_is_login:q.get('user_is_login'),secUidPresent:q.has('secUid'),deviceIdPresent:q.has('device_id'),odinIdPresent:q.has('odinId'),verifyFpPresent:q.has('verifyFp'),msTokenPresent:q.has('msToken'),xBogusPresent:q.has('X-Bogus'),xGnarlyPresent:q.has('X-Gnarly'),xDynosaurPresent:q.has('X-Dynosaur'),count:q.get('count'),cursor:q.get('cursor'),region:q.get('region'),priorityRegion:q.get('priority_region'),language:q.get('language'),appLanguage:q.get('app_language'),timezone:q.get('tz_name'),browserPlatform:q.get('browser_platform'),os:q.get('os'),screenWidth:q.get('screen_width'),screenHeight:q.get('screen_height'),rootReferer:q.get('root_referer')}}}catch{return {path:String(raw||'').slice(0,240),method:'GET',query:{}}}
  };
  page.on('response',r=>{
    let u;try{u=new URL(r.url())}catch{return}
    if(u.hostname!=='www.tiktok.com'||u.pathname!=='/api/post/item_list/')return;
    if(regionProbeUrls.has(r.url()))return;
    const task=(async()=>{
      const reqSummary=summarizeRequest(r.url());
      const reqHeaders=r.request().headers();
      const rec={...reqSummary,pcBaselineComparison:compareWithPcBaseline(reqSummary.query),requestContext:{referer:reqHeaders.referer||null,cookiePresent:Boolean(reqHeaders.cookie),origin:reqHeaders.origin||null},status:r.status(),resourceType:r.request().resourceType(),contentType:r.headers()['content-type']||'',bodyRead:false,bodyError:null,summary:null,targets:{}};
      try{await r.finished();const body=await r.body();rec.bodyRead=true;rec.summary=summarizeItemListBody(body.toString('utf8'));for(const id of targetIds)rec.targets[id]={present:rec.summary.ids.includes(String(id)),item:rec.summary.items.find(x=>x.id===String(id))||null}}catch(e){rec.bodyError=String(e.message||e)}
      // Controle permanece intacto. Depois dele, repetimos uma única vez a mesma
      // requisição alterando somente region=BR para medir se esse atalho muda a resposta.
      if(u.searchParams.get('region')!=='BR'){
        try{
          const probeUrl=new URL(r.url());
          probeUrl.searchParams.set('region','BR');
          regionProbeUrls.add(probeUrl.toString());
          const probe=await page.evaluate(async url=>{
            try{
              const res=await fetch(url,{method:'GET',credentials:'include'});
              const text=await res.text();
              return {status:res.status,contentType:res.headers.get('content-type')||'',body:text};
            }catch(e){return {error:String(e?.message||e)}}
          },probeUrl.toString());
          rec.regionBrProbe={attempted:true,changedOnly:'region US→BR',signatureReused:true,status:probe.status??null,contentType:probe.contentType||'',summary:probe.body!==undefined?summarizeItemListBody(probe.body):null,error:probe.error||null};
          onProgress('profile-region-br','Teste BR adulterado: HTTP '+(rec.regionBrProbe.status??'erro')+' · '+(rec.regionBrProbe.summary?.bytes??0)+' bytes · '+(rec.regionBrProbe.summary?.itemCount??0)+' itens.');
        }catch(e){rec.regionBrProbe={attempted:true,error:String(e.message||e)}}
      }
      captures.push(rec);onProgress('profile-item-list','/api/post/item_list/ HTTP '+rec.status+' · '+(rec.summary?.bytes??0)+' bytes · '+(rec.summary?.itemCount??0)+' itens · '+rec.pcBaselineComparison.differences.length+' diferença(s) públicas vs PC.');
    })();pending.add(task);task.finally(()=>pending.delete(task));
  });
  try{
    onProgress('profile','Abrindo @'+user+' normalmente; o Visual só observará a /api/post/item_list/ criada pelo próprio TikTok…');
    let navigationError=null,interactionErrors=[];
    try{
      await page.goto('https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR',{waitUntil:'domcontentloaded',timeout:20000});
      await page.evaluate(()=>{try{localStorage.setItem('region','BR')}catch{}});
    }catch(e){navigationError=String(e.message||e);onProgress('profile','Navegação do perfil falhou: '+navigationError+' · continuando a observação da rede…')}
    onProgress('profile-passive','Modo passivo: sem clique, sem scroll e sem fechar o login wall; apenas observando a rede inicial.');
    try{await page.waitForTimeout(10000)}catch(e){interactionErrors.push('passive-wait: '+String(e.message||e))}
    let deadline=Date.now()+15000;
    while(pending.size&&Date.now()<deadline){try{await Promise.race([Promise.allSettled([...pending]),page.waitForTimeout(250)])}catch(e){interactionErrors.push('pending-wait: '+String(e.message||e));break}}

    const firstAttemptCount=captures.length;
    const firstAttemptEmpty=firstAttemptCount>0&&captures.slice(0,firstAttemptCount).every(x=>!x.summary||x.summary.bytes===0);
    const retry={triggered:false,reason:null,newNativeResponses:0,usableNativeResponse:false,error:null};
    if(firstAttemptEmpty){
      retry.triggered=true;
      retry.reason='HTTP 200/body vazio na item_list inicial';
      onProgress('fallback-retry','item_list respondeu vazia. Fazendo uma nova navegação limpa para o TikTok gerar outra requisição e novos parâmetros…');
      try{
        await page.goto('about:blank',{waitUntil:'load',timeout:5000}).catch(()=>{});
        await page.waitForTimeout(500);
        await page.goto('https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR&visual_retry='+Date.now(),{waitUntil:'domcontentloaded',timeout:20000});
        await page.waitForTimeout(10000);
        deadline=Date.now()+15000;
        while(pending.size&&Date.now()<deadline){try{await Promise.race([Promise.allSettled([...pending]),page.waitForTimeout(250)])}catch(e){interactionErrors.push('retry-pending-wait: '+String(e.message||e));break}}
        const retryCaptures=captures.slice(firstAttemptCount);
        retry.newNativeResponses=retryCaptures.length;
        retry.usableNativeResponse=retryCaptures.some(x=>x.summary?.bytes>0&&x.summary?.jsonParsed);
        onProgress('fallback-retry','Nova tentativa: '+retry.newNativeResponses+' item_list · resposta utilizável '+(retry.usableNativeResponse?'SIM':'não')+'.');
      }catch(e){
        retry.error=String(e.message||e);
        onProgress('fallback-retry','Nova tentativa falhou: '+retry.error);
      }
    }

    const alternativeSources=fallbackEvidence.map(e=>({
      url:e.url,status:e.status,resourceType:e.resourceType,bytes:e.bytes,matchedIds:e.matchedIds,
      targets:Object.fromEntries(Object.entries(e.targets||{}).map(([id,p])=>[id,{jsonParsed:p.parsed,topKeys:p.topKeys,matchPaths:(p.matches||[]).map(m=>m.path)}]))
    })).slice(0,40);
    const fallback={retry,alternativeSources,alternativeSourceCount:alternativeSources.length,
      result:retry.usableNativeResponse?'ITEM_LIST_RECOVERED':alternativeSources.length?'ALTERNATIVE_PUBLIC_SOURCE_FOUND':firstAttemptEmpty?'NO_PUBLIC_FALLBACK_FOUND':'NOT_NEEDED'};
    if(firstAttemptEmpty&&!retry.usableNativeResponse)onProgress('fallback-route',alternativeSources.length?'item_list continuou vazia, mas outra resposta pública contém A/B.':'item_list continuou vazia e nenhuma outra resposta pública com A/B apareceu.');

    return {username:user,emulatedContext:{ua:'Windows Chrome 153',navigatorPlatform:'Win32',locale:'pt-BR',timezone:'America/Sao_Paulo',viewport:'1600x900',profileLang:'pt-BR',interaction:'passive-no-click-no-scroll'},navigationError,interactionErrors:[...new Set(interactionErrors)].slice(0,8),generated:captures.length>0,captures,fallback,pendingAtReturn:pending.size};
  }finally{await context.close().catch(()=>{})}
}

async function runWarmNavigationExperiment(browser,user,urlA,urlB,targetA,targetB,onProgress=()=>{}){
  async function measure(page,label){
    let html='';try{html=await page.content()}catch{}
    const data=parseUniversalObject(html);
    const item=targetB?findItemStruct(data,targetB):null;
    const parsed=parserContract(item);
    return {label,finalUrl:cleanUrl(page.url()),htmlBytes:Buffer.byteLength(html),targetId:targetB,
      targetIdOccurrences:targetB?(html.match(new RegExp(String(targetB),'g'))||[]).length:0,
      universalFound:!!data,itemStructFound:!!item,parserAccepted:!!parsed.accepted,metrics:parsed.fields||null};
  }
  async function visit(page,url,wait=3000){
    let status=null,error=null;
    try{const res=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});status=res?.status()||null;await page.waitForTimeout(wait)}
    catch(e){error=String(e.message||e)}
    return {status,error};
  }
  const cold=await browser.newContext({serviceWorkers:'block'});
  let coldB;
  try{
    const page=await cold.newPage();onProgress('state-cold','Abrindo B em contexto frio…');
    const nav=await visit(page,urlB,3500);coldB=await measure(page,'B_COLD');coldB.httpStatus=nav.status;coldB.navigationError=nav.error;
  }finally{await cold.close().catch(()=>{})}
  const warm=await browser.newContext({serviceWorkers:'block'});
  const page=await warm.newPage(),timeline=[];
  try{
    for(const step of [
      ['HOME','https://www.tiktok.com/',2500],
      ['PROFILE','https://www.tiktok.com/@'+encodeURIComponent(user),3000],
      ['A_WARMUP',urlA,3000],
      ['B_AFTER_WARMUP',urlB,4000]
    ]){
      onProgress('state-warm','Abrindo '+step[0]+' no mesmo contexto…');
      const nav=await visit(page,step[1],step[2]),snap=await measure(page,step[0]);snap.httpStatus=nav.status;snap.navigationError=nav.error;timeline.push(snap);
    }
    const warmB=timeline[timeline.length-1];
    const result=warmB.itemStructFound||warmB.parserAccepted?'B_APPEARED_AFTER_WARMUP':'B_STILL_MISSING_AFTER_WARMUP';
    onProgress('state-result',result+' · itemStruct '+(warmB.itemStructFound?'SIM':'não')+'.');
    return {kind:'tiktok-warm-navigation',coldB,warmTimeline:timeline,warmB,result};
  }finally{await warm.close().catch(()=>{})}
}

export async function traceTikTokAB(urlA,urlB,onProgress=()=>{}){
  if(!isTikTok(urlA)||!isTikTok(urlB))throw new Error('Informe dois links públicos do TikTok.');let browser;
  try{
    browser=await chromium.launch({headless:true});
    onProgress('A','Abrindo A e rastreando a origem das métricas reais…');const rawA=await inspectOne(browser,urlA),a=sourceSnapshot('A',rawA);
    onProgress('A','A: itemStruct '+(a.sources.html.itemStructFound?'SIM':'não')+' · parser '+(a.sources.html.parserAccepted?'ACEITOU':'não aceitou')+' · rede com ID '+a.sources.network.responsesWithTarget+'.');
    onProgress('B','Abrindo B no mesmo navegador e repetindo exatamente a coleta…');const rawB=await inspectOne(browser,urlB),b=sourceSnapshot('B',rawB);
    onProgress('B','B: itemStruct '+(b.sources.html.itemStructFound?'SIM':'não')+' · parser '+(b.sources.html.parserAccepted?'ACEITOU':'não aceitou')+' · rede com ID '+b.sources.network.responsesWithTarget+'.');
    const divergence=firstDivergence(a,b);onProgress('diff','Primeira divergência medida: '+divergence.stage+'.');
    const user=rawB.username||rawA.username||null;
    let warmNavigation={kind:'tiktok-warm-navigation',result:'NOT_RUN',error:null};
    if(user){try{warmNavigation=await runWarmNavigationExperiment(browser,user,urlA,urlB,a.id,b.id,onProgress)}catch(e){warmNavigation={kind:'tiktok-warm-navigation',result:'ERROR',error:String(e.message||e)}}}
    let nativePostItemList={username:user||null,generated:false,captures:[],pendingAtReturn:0,error:null};
    if(user){try{nativePostItemList=await traceNativePostItemList(browser,user,[a.id,b.id].filter(Boolean),onProgress)}catch(e){nativePostItemList.error=String(e.message||e)}}
    onProgress('profile-item-list','Fluxo nativo: '+nativePostItemList.captures.length+' resposta(s) /api/post/item_list/ observada(s).');
    return {kind:'tiktok-ab-trace',createdAt:new Date().toISOString(),a,b,firstDivergence:divergence,warmNavigation,nativePostItemList,note:'Rastreamento observacional A→B. O teste de perfil apenas observa /api/post/item_list/ gerada naturalmente pelo TikTok; não fabrica a chamada, não reutiliza sessão e não inventa métricas.'};
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
