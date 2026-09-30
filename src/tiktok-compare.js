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
    await liveWait(3500);
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
    const hit=candidates.find(([,v])=>Array.isArray(v));if(hit){out.listPath=hit[0];out.itemCount=hit[1].length;out.ids=hit[1].map(x=>String(x?.id||x?.itemId||x?.aweme_id||'')).filter(Boolean);out.items=hit[1].map(x=>{const s=x?.statsV2||x?.stats||{};return{id:String(x?.id||x?.itemId||x?.aweme_id||''),desc:String(x?.desc||x?.description||'').slice(0,160),views:s.playCount??s.viewCount??null,likes:s.diggCount??s.likeCount??null,comments:s.commentCount??null,shares:s.shareCount??null,saves:s.collectCount??s.saveCount??null}})}
    out.cursor=data?.cursor??data?.data?.cursor??null;out.hasMore=data?.hasMore??data?.has_more??data?.data?.hasMore??data?.data?.has_more??null;
  }catch(e){out.error=String(e.message||e)}
  return out;
}
function summarizeProfileDocument(html,env={}) {
  const text=String(html||'');
  const universalMatch=text.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);
  let universal={found:!!universalMatch,bytes:universalMatch?Buffer.byteLength(universalMatch[1]):0,jsonParsed:false,topKeys:[],defaultScopeKeys:[],videoDetailPresent:false,itemStructPresent:false};
  if(universalMatch){
    try{
      const data=JSON.parse(universalMatch[1]);
      universal.jsonParsed=true;
      universal.topKeys=Object.keys(data||{}).slice(0,40);
      universal.defaultScopeKeys=Object.keys(data?.__DEFAULT_SCOPE__||{}).slice(0,80);
      const vd=data?.__DEFAULT_SCOPE__?.['webapp.video-detail'];
      universal.videoDetailPresent=!!vd;
      universal.itemStructPresent=!!vd?.itemInfo?.itemStruct;
    }catch{}
  }
  return {
    htmlBytes:Buffer.byteLength(text),
    universal,
    markers:Object.fromEntries(MARKERS.map(([k,re])=>[k,re.test(text)])),
    environment:env
  };
}

function videoDetailShape(html,targetId){
  const data=parseUniversalObject(html),scope=data?.__DEFAULT_SCOPE__||{},vd=scope['webapp.video-detail'];
  const shape=v=>v&&typeof v==='object'?Object.fromEntries(Object.entries(v).slice(0,80).map(([k,x])=>[k,Array.isArray(x)?'array('+x.length+')':x===null?'null':typeof x==='object'?'object':typeof x])):{};
  const itemInfo=vd?.itemInfo;
  return {targetId,defaultScopeKeys:Object.keys(scope),videoDetailType:vd===null?'null':typeof vd,videoDetailKeys:Object.keys(vd||{}),videoDetailShape:shape(vd),itemInfoType:itemInfo===null?'null':typeof itemInfo,itemInfoKeys:Object.keys(itemInfo||{}),itemInfoShape:shape(itemInfo),itemStructPresent:!!itemInfo?.itemStruct,statusCode:vd?.statusCode??vd?.status_code??null,statusMsg:vd?.statusMsg??vd?.status_msg??null,shareMetaKeys:Object.keys(vd?.shareMeta||{}),seoPropsKeys:Object.keys(vd?.seoProps||{})};
}
export async function compareTikTokVideoDetailShapes(urlA,urlB){
  let browser;try{browser=await chromium.launch({headless:true});const a=await inspectOne(browser,urlA),b=await inspectOne(browser,urlB);const A=videoDetailShape(a.rawHtml,a.id),B=videoDetailShape(b.rawHtml,b.id);const onlyA=A.videoDetailKeys.filter(k=>!B.videoDetailKeys.includes(k)),onlyB=B.videoDetailKeys.filter(k=>!A.videoDetailKeys.includes(k));const itemOnlyA=A.itemInfoKeys.filter(k=>!B.itemInfoKeys.includes(k)),itemOnlyB=B.itemInfoKeys.filter(k=>!A.itemInfoKeys.includes(k));return{kind:'tiktok-video-detail-shape-diff',createdAt:new Date().toISOString(),A:{id:a.id,httpStatus:a.status,htmlBytes:a.htmlBytes,...A},B:{id:b.id,httpStatus:b.status,htmlBytes:b.htmlBytes,...B},diff:{videoDetailOnlyA:onlyA,videoDetailOnlyB:onlyB,itemInfoOnlyA:itemOnlyA,itemInfoOnlyB:itemOnlyB}}}finally{await browser?.close().catch(()=>{})}
}

export async function inspectTikTokVideoBatch(urls,onProgress=()=>{}){
  const list=[...new Set((urls||[]).map(String).map(x=>x.trim()).filter(Boolean))];
  if(!list.length)throw new Error('Nenhum link informado.');
  if(list.some(x=>!isTikTok(x)))throw new Error('A bateria aceita somente links públicos do TikTok.');
  let browser;try{
    browser=await chromium.launch({headless:true});
    const results=new Array(list.length);
    for(let i=0;i<list.length;i++){
      const input=list[i];onProgress('video','Testando '+(i+1)+'/'+list.length+'…');
      try{
        const timeout=new Promise((_,reject)=>setTimeout(()=>reject(new Error('TIMEOUT_VIDEO_35S')),35000));
        const x=await Promise.race([inspectOne(browser,input),timeout]);
        const data=parseUniversalObject(x.rawHtml),item=findItemStruct(data,x.id),parsed=parserContract(item);
        const videoDetail=!!data?.__DEFAULT_SCOPE__?.['webapp.video-detail'];let classification='VAZIO';
        if(item&&parsed.accepted)classification='COMPLETO';else if(videoDetail||x.markers?.['video-detail']||data)classification='PARCIAL';
        results[i]={index:i+1,input,id:x.id,finalUrl:x.finalUrl,httpStatus:x.status,htmlBytes:x.htmlBytes,universalFound:!!data,videoDetailPresent:videoDetail,itemStructPresent:!!item,parserAccepted:!!parsed.accepted,classification,metrics:parsed.accepted?parsed.fields:null,networkResponsesWithTarget:x.networkEvidence?.length||0};
      }catch(e){results[i]={index:i+1,input,classification:'ERRO',error:String(e.message||e)}}
    }
    const counts=results.reduce((a,x)=>(a[x.classification]=(a[x.classification]||0)+1,a),{});
    return {kind:'tiktok-13-video-battery',createdAt:new Date().toISOString(),count:list.length,counts,results,note:'Cada link é aberto em contexto novo no mesmo Chromium do Visual; classificação baseada somente no conteúdo público realmente recebido.'};
  }finally{await browser?.close().catch(()=>{})}
}

export async function dumpTikTokItemList(username,onProgress=()=>{}){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');
  const profiles=[
    {name:'PADRAO',options:{serviceWorkers:'block'},init:null,url:'https://www.tiktok.com/@'+encodeURIComponent(user)},
    {name:'WINDOWS_BR',options:{serviceWorkers:'block',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:900},screen:{width:1600,height:900},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'},init:'win',url:'https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR'},
    {name:'WINDOWS_BR_AQUECIDO',options:{serviceWorkers:'block',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:900},screen:{width:1600,height:900},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'},init:'win',warm:true,url:'https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR'},
    {name:'WINDOWS_BR_REDUCED_AUTOMATION',options:{serviceWorkers:'block',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1600,height:900},screen:{width:1600,height:900},userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'},init:'stealth-basic',warm:true,url:'https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR'}
  ];
  let browser;const dumps=[];
  try{
    browser=await chromium.launch({headless:true});
    for(const profile of profiles){
      const context=await browser.newContext(profile.options);
      if(profile.init)await context.addInitScript((mode)=>{try{Object.defineProperty(navigator,'platform',{get:()=> 'Win32',configurable:true})}catch{}try{Object.defineProperty(navigator,'language',{get:()=> 'pt-BR',configurable:true})}catch{}try{Object.defineProperty(navigator,'languages',{get:()=> ['pt-BR','pt'],configurable:true})}catch{}if(mode==='stealth-basic'){try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true})}catch{}try{delete Object.getPrototypeOf(navigator).webdriver}catch{}try{Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8,configurable:true})}catch{}try{Object.defineProperty(navigator,'deviceMemory',{get:()=>8,configurable:true})}catch{}}},profile.init);
      const page=await context.newPage(),pending=new Set();
      let backendDirectDone=false;
      page.on('response',r=>{if(!/\/api\/post\/item_list\//.test(r.url()))return;const task=(async()=>{const rec={attempt:profile.name,url:cleanUrl(r.url()),status:r.status(),resourceType:r.request().resourceType(),contentType:r.headers()['content-type']||'',bodyRead:false,bodyError:null,summary:null};try{await r.finished();const body=await r.body();rec.bodyRead=true;rec.summary=summarizeItemListBody(body.toString('utf8'))}catch(e){rec.bodyError=String(e.message||e)}dumps.push(rec);onProgress('item-list',profile.name+': HTTP '+rec.status+' · '+(rec.summary?.bytes||0)+' bytes · '+(rec.summary?.itemCount||0)+' itens.');
        if(profile.name==='WINDOWS_BR_REDUCED_AUTOMATION'&&!backendDirectDone){
          backendDirectDone=true;
          const direct={attempt:'BACKEND_DIRECT',sourceAttempt:profile.name,url:cleanUrl(r.url()),status:null,resourceType:'node-fetch',contentType:'',bodyRead:false,bodyError:null,summary:null,responseHeaders:{}};
          try{
            const rr=await fetch(r.url(),{method:'GET',redirect:'follow',headers:{'user-agent':profile.options.userAgent,'accept':'application/json, text/plain, */*','accept-language':'pt-BR,pt;q=0.9,en;q=0.8','referer':'https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR'}});
            direct.status=rr.status;direct.contentType=rr.headers.get('content-type')||'';
            for(const k of ['content-length','server','via','x-cache','x-cache-status','cf-ray']){const v=rr.headers.get(k);if(v)direct.responseHeaders[k]=v}
            const body=await rr.text();direct.bodyRead=true;direct.summary=summarizeItemListBody(body);
          }catch(e){direct.bodyError=String(e.message||e)}
          dumps.push(direct);onProgress('backend-direct','BACKEND_DIRECT: HTTP '+String(direct.status)+' · '+(direct.summary?.bytes||0)+' bytes · '+(direct.summary?.itemCount||0)+' itens.');
        }
      })();pending.add(task);task.finally(()=>pending.delete(task))});
      try{
        onProgress('attempt','Tentativa '+profile.name+'…');
        if(profile.warm){try{await page.goto('https://www.tiktok.com/?lang=pt-BR',{waitUntil:'domcontentloaded',timeout:15000});await page.waitForTimeout(1800)}catch{}}
        try{await page.goto(profile.url,{waitUntil:'domcontentloaded',timeout:20000})}catch(e){onProgress('navigation',profile.name+': '+e.message)}
        for(let i=0;i<6;i++){await page.mouse.wheel(0,1700).catch(()=>{});await page.waitForTimeout(900)}
        await page.waitForTimeout(2200);
        const env=await page.evaluate(()=>({
          userAgent:navigator.userAgent,
          platform:navigator.platform,
          language:navigator.language,
          languages:[...(navigator.languages||[])],
          webdriver:navigator.webdriver,
          hardwareConcurrency:navigator.hardwareConcurrency,
          deviceMemory:navigator.deviceMemory??null,
          timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen:{width:screen.width,height:screen.height,colorDepth:screen.colorDepth,pixelDepth:screen.pixelDepth},
          viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
          cookieNames:document.cookie.split(';').map(x=>x.trim().split('=')[0]).filter(Boolean).slice(0,80),
          cookieCount:document.cookie.split(';').filter(x=>x.trim()).length,
          historyLength:history.length,
          href:location.href
        })).catch(()=>({error:'environment-unavailable'}));
        const html=await page.content().catch(()=>'');
        const documentDiagnostic=summarizeProfileDocument(html,env);
        dumps.push({attempt:profile.name,type:'PROFILE_DOCUMENT',status:null,summary:null,documentDiagnostic});
        onProgress('document',profile.name+': HTML '+documentDiagnostic.htmlBytes+' bytes · Universal '+documentDiagnostic.universal.bytes+' bytes · webdriver '+String(env.webdriver)+'.');
        const deadline=Date.now()+12000;while(pending.size&&Date.now()<deadline){await Promise.race([Promise.allSettled([...pending]),page.waitForTimeout(200)])}
      }finally{await context.close().catch(()=>{})}
      if(dumps.some(x=>x.attempt===profile.name&&x.summary?.itemCount>0)){onProgress('success',profile.name+' encontrou vídeos reais. Encerrando bateria.');break}
    }
    return {kind:'tiktok-item-list-battery',createdAt:new Date().toISOString(),username:user,dumps,pendingAtReturn:0,note:'Bateria automática: inclui controle padrão, Windows/BR, aquecido, sinais triviais de automação reduzidos e BACKEND_DIRECT repetindo no Node a URL pública assinada observada; cada tentativa registra a item_list nativa e o documento/Universal Data realmente recebido. Valores de cookies não são exportados; apenas nomes e contagem.'};
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


export async function observeTikTokQuietly(username,onProgress=()=>{}){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');
  let browser;
  try{
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({serviceWorkers:'allow',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',locale:'pt-BR',timezoneId:'America/Sao_Paulo',viewport:{width:1365,height:768},screen:{width:1365,height:768},deviceScaleFactor:1,colorScheme:'light',hasTouch:false,isMobile:false});
    await context.addInitScript(()=>{try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true})}catch{};try{Object.defineProperty(navigator,'platform',{get:()=> 'Win32',configurable:true})}catch{};try{Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8,configurable:true})}catch{};try{Object.defineProperty(navigator,'deviceMemory',{get:()=>8,configurable:true})}catch{}});
    const page=await context.newPage(),profileUrl='https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR',screenshots=[],events=[],actions=[],f12Matches=[];
    const safeShot=async(label,store=true)=>{try{const b=await Promise.race([page.screenshot({type:'jpeg',quality:store?65:38,fullPage:false,timeout:1800}),new Promise((_,rej)=>setTimeout(()=>rej(new Error('frame-timeout')),2200))]);const data='data:image/jpeg;base64,'+b.toString('base64');if(store)screenshots.push({label,mime:'image/jpeg',data,url:cleanUrl(page.url()),at:new Date().toISOString()});else onProgress('frame',data);return true}catch{return false}};
    const liveWait=async(ms)=>{const end=Date.now()+ms;while(Date.now()<end){await safeShot('AO VIVO',false);await page.waitForTimeout(Math.min(1000,Math.max(0,end-Date.now())))}};    
    const clickText=async(name,re,wait=4000)=>{const rec={name,found:false,clicked:false,error:null,at:new Date().toISOString()};try{const t=await page.locator('button,[role=tab],a,div,span').evaluateAll((els,src)=>{const r=new RegExp(src,'i');const e=els.find(x=>{const v=(x.innerText||x.textContent||'').trim();const q=x.getBoundingClientRect();return r.test(v)&&q.width>0&&q.height>0});if(!e)return null;e.setAttribute('data-visual-fast-click','1');return (e.innerText||e.textContent||'').trim()},re.source).catch(()=>null);if(t){rec.found=true;const z=page.locator('[data-visual-fast-click="1"]').first();try{await z.click({force:true,timeout:1800})}catch{await z.evaluate(el=>el.click())}rec.clicked=true;await liveWait(wait)}}catch(e){rec.error=String(e.message||e)}actions.push(rec);onProgress(name,rec.clicked?name+' clicado; observando…':name+' não clicou'+(rec.error?' · '+rec.error:''));await safeShot('PRINT · '+name);return rec};
    page.on('response',async r=>{if(!isTikTok(r.url()))return;const type=r.request().resourceType();if(!['document','xhr','fetch'].includes(type))return;let body='',bufferBytes=null,responseHeaders={};try{responseHeaders=await r.allHeaders()}catch{}try{const buf=await r.body();bufferBytes=buf.length;body=buf.toString('utf8')}catch{}const headers={};for(const k of ['content-length','content-type','content-encoding','server','x-cache','location'])if(responseHeaders?.[k]!=null)headers[k]=responseHeaders[k];events.push({at:Date.now(),status:r.status(),type,url:cleanUrl(r.url()),bytes:Buffer.byteLength(body),bufferBytes,headers,body:body.slice(0,1000000)});
      if(['xhr','fetch'].includes(type)&&body){let path='';try{path=new URL(r.url()).pathname}catch{}const terms=[user,'7069159333586846725','itemList','itemStruct','videoList','aweme','secUid'];const hits=terms.filter(v=>body.includes(v));if(hits.length)f12Matches.push({path,status:r.status(),bytes:Buffer.byteLength(body),hits})}});
    onProgress('open','Abrindo perfil e iniciando bateria visual rápida…');
    const nav=await page.goto(profileUrl,{waitUntil:'domcontentloaded',timeout:30000});await liveWait(6000);await safeShot('PRINT 1 · perfil inicial');
    await page.bringToFront().catch(()=>{});
    const env=await page.evaluate(()=>({hasFocus:document.hasFocus(),visibilityState:document.visibilityState,hidden:document.hidden,webdriver:navigator.webdriver,platform:navigator.platform,userAgent:navigator.userAgent}));
    actions.push({name:'AMBIENTE',...env});onProgress('environment','Foco '+env.hasFocus+' · visibility '+env.visibilityState+' · webdriver '+String(env.webdriver));
    await page.mouse.move(620,360,{steps:8}).catch(()=>{});await page.mouse.wheel(0,120).catch(()=>{});await liveWait(3000);
    await clickText('ATUALIZAR',/^(atualizar|refresh|retry|tentar novamente)$/i,5000);
    await clickText('REPUBLICAÇÕES',/^(republicações|republicacoes|reposts?)$/i,6000);
    await clickText('VÍDEOS',/^(vídeos|videos)$/i,5000);
    await clickText('CURTIDOS',/^(curtido|curtidos|liked)$/i,5000);
    await clickText('VÍDEOS 2',/^(vídeos|videos)$/i,4000);
    await clickText('ENTRAR/LOGAR',/^(entrar|logar|log in|sign in)$/i,6000);
    await safeShot('PRINT · tela após Entrar/Logar');
    onProgress('reload','Voltando ao perfil e fazendo reload final…');
    await page.goto(profileUrl,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});await page.reload({waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});await liveWait(8000);await safeShot('PRINT FINAL · perfil após bateria');
    const endedAt=Date.now(),html=await page.content(),found=collectProfileVideos(html,user);for(const e of events){const z=collectProfileVideos(e.body,user);found.ids.push(...z.ids);found.links.push(...z.links)}found.ids=[...new Set(found.ids)];found.links=[...new Set(found.links)];
    const postEvents=events.filter(e=>{try{return new URL(e.url).pathname==='/api/post/item_list/'}catch{return false}}),repostEvents=events.filter(e=>{try{return new URL(e.url).pathname.includes('/api/repost/item_list')}catch{return false}});
    const summarize=e=>({status:e.status,bytes:e.bytes,bufferBytes:e.bufferBytes,headers:e.headers,path:(()=>{try{return new URL(e.url).pathname}catch{return''}})()});
    const cookies=await context.cookies('https://www.tiktok.com');
    onProgress('done','Bateria visual completa finalizada.');
    return {kind:'tiktok-visual-full-battery',createdAt:new Date().toISOString(),username:user,profileUrl,status:nav?.status()||null,finalUrl:cleanUrl(page.url()),environment:env,actions,screenshots,visible:{htmlBytes:Buffer.byteLength(html),videoIds:found.ids,videoCount:found.ids.length},networkSummary:{total:events.length,postItemList:postEvents.map(summarize),repostItemList:repostEvents.map(summarize)},f12Search:{matchCount:f12Matches.length,matches:f12Matches.slice(0,200)},network:events.map(({body,...x})=>x),session:{cookieNames:[...new Set(cookies.map(c=>c.name))],cookieCount:cookies.length},note:'Bateria visual: perfil, foco/visibilidade, interação leve, Atualizar, Republicações, Vídeos, Curtidos, retorno a Vídeos, abertura de Entrar/Logar sem fornecer credenciais, reload final. Frames ao vivo são descartáveis e falhas de screenshot não encerram o teste.'};
  }finally{await browser?.close().catch(()=>{})}
}

async function freshShotTarget(target){
  let browser,context,page,stage='launch';
  try{
    browser=await chromium.launch({headless:true});
    stage='context';
    context=await browser.newContext({serviceWorkers:'block',locale:'pt-BR'});
    stage='clearCookies';await context.clearCookies();
    stage='page';page=await context.newPage();
    stage='goto';await page.goto(target,{waitUntil:'domcontentloaded',timeout:20000}).catch(e=>{console.log('[fresh-shot] goto warning',String(e.message||e));return null});
    stage='wait';await page.waitForTimeout(5000);
    stage='screenshot';
    const shot=await Promise.race([page.screenshot({type:'jpeg',quality:65,fullPage:false,timeout:1800}).catch(e=>{console.error('[fresh-shot] screenshot',e);return null}),new Promise(resolve=>setTimeout(()=>resolve(null),2200))]);
    if(!shot)throw new Error('SCREENSHOT_TIMEOUT');
    console.log('[fresh-shot] ok',target,'url=',page.url(),'bytes=',shot.length);
    return shot;
  }catch(e){
    console.error('[fresh-shot] failed stage='+stage+' target='+target, e);
    throw new Error('FRESH_SHOT_'+stage.toUpperCase()+': '+String(e.message||e));
  }finally{await context?.close().catch(()=>{});await browser?.close().catch(()=>{})}
}
export async function freshTikTokScreenshot(username,target='profile'){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');
  const targets={
    profile:'https://www.tiktok.com/@'+encodeURIComponent(user),
    a:'https://www.tiktok.com/@'+encodeURIComponent(user)+'/video/7689954489733778709',
    b:'https://www.tiktok.com/@'+encodeURIComponent(user)+'/video/7690154508063690036'
  };
  if(!targets[target])throw new Error('Target inválido.');
  return freshShotTarget(targets[target]);
}

export async function captureTikTokReposts(username){
  const user=normalizeUser(username);if(!user)throw new Error('Informe o @user.');
  let browser,context;
  try{
    browser=await chromium.launch({headless:true});
    context=await browser.newContext({serviceWorkers:'block',locale:'pt-BR'});
    const page=await context.newPage(),captures=[];
    page.on('response',async r=>{try{
      const u=new URL(r.url());if(!u.pathname.includes('/api/repost/item_list'))return;
      const body=await r.body();let json=null;try{json=JSON.parse(body.toString('utf8'))}catch{}
      captures.push({status:r.status(),bytes:body.length,json});
    }catch{}});
    await page.goto('https://www.tiktok.com/@'+encodeURIComponent(user)+'?lang=pt-BR',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
    await page.waitForTimeout(6000);await page.bringToFront().catch(()=>{});
    const click=await page.locator('button,[role=tab],a,div,span').evaluateAll((els)=>{
      const exact=/^(republicações|republicacoes|reposts?)$/i;
      const candidates=els.filter(x=>{const v=(x.innerText||x.textContent||'').trim(),q=x.getBoundingClientRect();return exact.test(v)&&q.width>0&&q.height>0});
      if(!candidates.length)return null;
      const e=candidates.sort((a,b)=>a.children.length-b.children.length)[0];e.setAttribute('data-repost-capture','1');
      return {text:(e.innerText||e.textContent||'').trim(),tag:e.tagName,role:e.getAttribute('role')};
    }).catch(()=>null);
    let clicked=false;
    if(click){const z=page.locator('[data-repost-capture="1"]').first();try{await z.click({force:true,timeout:1800});clicked=true}catch{clicked=await z.evaluate(el=>{el.click();return true}).catch(()=>false)}}
    await page.waitForTimeout(6000);
    // Same fallback used by the old visual battery: inspect the visible tab strip and click by order/label.
    if(!captures.length){
      const tabs=page.locator('[role=tab],button');
      const n=await tabs.count().catch(()=>0);
      for(let i=0;i<n&&!captures.length;i++){const t=tabs.nth(i),txt=((await t.innerText().catch(()=>''))||'').trim();if(/repost|republic/i.test(txt)){await t.click({force:true,timeout:1800}).catch(()=>{});clicked=true;await page.waitForTimeout(5000)}}
    }
    const items=[],seen=new Set();
    for(const c of captures)for(const it of c.json?.itemList||[]){const id=String(it?.id||'');if(!id||seen.has(id))continue;seen.add(id);const st=it.stats||{};items.push({id,author:it.author?.uniqueId||null,desc:it.desc||'',views:st.playCount??null,likes:st.diggCount??null,comments:st.commentCount??null,shares:st.shareCount??null,saves:st.collectCount??null})}
    return {kind:'tiktok-repost-capture',createdAt:new Date().toISOString(),username:user,clickedReposts:clicked,clickTarget:click,captureCount:captures.length,captures:captures.map(x=>({status:x.status,bytes:x.bytes,itemCount:x.json?.itemList?.length??0})),itemCount:items.length,items};
  }finally{await context?.close().catch(()=>{});await browser?.close().catch(()=>{})}
}
