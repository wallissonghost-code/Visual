import express from 'express';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {resolveSecurityTarget} from './security-target.js';import {visualBuildInfo} from './version.js';import {mapUrlRuntime} from './network-map.js';import {dumpTikTokItemList,inspectTikTokVideoBatch,compareTikTokVideoDetailShapes,observeTikTokQuietly, freshTikTokScreenshot} from './tiktok-compare.js';
const app=express(),port=process.env.PORT||3000,jobs=new Map();app.use(express.json({limit:'64kb'}));app.use(express.static(path.resolve('public')));app.get('/health',(_,res)=>res.json({ok:true,service:'visual-qa',jobs:jobs.size,...visualBuildInfo()}));app.get('/api/version',(_,res)=>res.json({...visualBuildInfo(),startedAt:new Date().toISOString()}));

function mapFrontityState(source,username,videoIds){
  const m=source.match(/<script[^>]+id=["']__FRONTITY_CONNECT_STATE__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m)return {found:false,error:'__FRONTITY_CONNECT_STATE__ não encontrado'};
  let root;
  try{root=JSON.parse(m[1])}catch(e){return {found:true,parsed:false,bytes:Buffer.byteLength(m[1]),error:String(e.message||e)}}
  const routeKey='/embed/@'+username,hits=[],arrays=[],routeCandidates=[];
  const wanted=/page|cursor|offset|hasmore|has_more|next|pagination|video|item/i;
  function walk(v,path='$',depth=0){
    if(depth>10||v==null)return;
    if(Array.isArray(v)){
      if(v.length&&v.some(x=>x&&typeof x==='object'&&videoIds.some(id=>JSON.stringify(x).includes(id))))arrays.push({path,length:v.length,itemKeys:Object.keys(v.find(x=>x&&typeof x==='object')||{}).slice(0,80)});
      v.slice(0,30).forEach((x,i)=>walk(x,path+'['+i+']',depth+1));return;
    }
    if(typeof v!=='object')return;
    for(const [k,val] of Object.entries(v)){
      const p=path+'.'+k;
      if(wanted.test(k))hits.push({path:p,type:Array.isArray(val)?'array':typeof val,value:(val==null||typeof val!=='object')?val:Array.isArray(val)?'[array '+val.length+']':'{'+Object.keys(val).slice(0,30).join(', ')+'}'});
      if(k.includes('/embed/@')||k===routeKey)routeCandidates.push({path:p,key:k,type:Array.isArray(val)?'array':typeof val,keys:val&&typeof val==='object'&&!Array.isArray(val)?Object.keys(val):[]});
      walk(val,p,depth+1);
    }
  }
  walk(root);
  return {found:true,parsed:true,bytes:Buffer.byteLength(m[1]),rootKeys:Object.keys(root),routeKey,routeCandidates,videoArrays:arrays,paginationHits:hits.filter(x=>/page|cursor|offset|hasmore|has_more|next|pagination/i.test(x.path)),interestingHits:hits.slice(0,250)};
}
function inspectEmbedStructuredState(source,videoIds){
  const needles=['videoList','common-videoList','userInfo','playCount','diggCount','commentCount','shareCount','collectCount','itemList','itemStruct','proxyApi'];
  const findings={};
  for(const needle of needles){
    const positions=[];let from=0;
    while(positions.length<12){const p=source.indexOf(needle,from);if(p<0)break;positions.push(p);from=p+needle.length}
    findings[needle]={count:positions.length,samples:positions.slice(0,4).map(p=>source.slice(Math.max(0,p-220),Math.min(source.length,p+needle.length+520)).replace(/\s+/g,' '))};
  }
  const scripts=[...source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)].map((m,i)=>{
    const attrs=m[1]||'',body=m[2]||'',matchedIds=videoIds.filter(id=>body.includes(id)),hits=needles.filter(n=>body.includes(n));
    return {index:i,id:(attrs.match(/\bid=["']([^"']+)/i)||[])[1]||null,type:(attrs.match(/\btype=["']([^"']+)/i)||[])[1]||null,bytes:Buffer.byteLength(body),matchedIds,hits,preview:(matchedIds.length||hits.length)?body.slice(0,900):null};
  }).filter(x=>x.matchedIds.length||x.hits.length);
  return {needles:findings,scripts};
}
async function inspectEmbedClientScripts(source){
  const srcs=[...source.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi)].map(m=>m[1].replace(/&amp;/g,'&'));
  const unique=[...new Set(srcs)].slice(0,30), results=[];
  const needles=['autoFetch','videoList','playCount','page','cursor','hasMore','offset','pagination','creator_embed','proxyApi','getProfileItemList','x-tt-webid','/api/post/item_list/','/api/recommend/embed_videos/'];
  for(const raw of unique){
    let url=raw;
    if(url.startsWith('//'))url='https:'+url;
    else if(url.startsWith('/'))url='https://www.tiktok.com'+url;
    if(!/^https?:\/\//i.test(url))continue;
    try{
      const r=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept':'*/*','referer':'https://www.tiktok.com/'}});
      const body=await r.text(),hits=needles.filter(n=>body.includes(n)),contexts=[];
      for(const n of hits){
        let from=0;
        for(let i=0;i<3;i++){const p=body.indexOf(n,from);if(p<0)break;contexts.push({needle:n,context:body.slice(Math.max(0,p-500),Math.min(body.length,p+n.length+900)).replace(/\s+/g,' ')});from=p+n.length}
      }
      const endpoints=[...new Set([...body.matchAll(/["'`](\/[^"'\`]{1,180}(?:video|embed|item|post|list|feed)[^"'\`]{0,180})["'`]/gi)].map(m=>m[1]))].slice(0,60);
      const profileListCalls=[];
      for(const needle of ['getProfileItemList','x-tt-webid','/api/post/item_list/']){
        let from=0;
        for(let i=0;i<12;i++){const p=body.indexOf(needle,from);if(p<0)break;profileListCalls.push({needle,index:p,context:body.slice(Math.max(0,p-1800),Math.min(body.length,p+needle.length+3200)).replace(/\s+/g,' ')});from=p+needle.length}
      }
      if(hits.length||endpoints.length||profileListCalls.length)results.push({url:r.url,status:r.status,bytes:Buffer.byteLength(body),hits,contexts:contexts.slice(0,30),endpointCandidates:endpoints,profileListCalls:profileListCalls.slice(0,30)});
    }catch(e){results.push({url,error:String(e.message||e)})}
  }
  return {scriptCount:unique.length,scripts:results};
}
async function replayEmbedProfileList(source,username){
  const m=source.match(/<script[^>]+id=["']__FRONTITY_CONNECT_STATE__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(!m)return {ok:false,error:'FRONTITY_STATE_NOT_FOUND'};
  let st;try{st=JSON.parse(m[1])}catch(e){return {ok:false,error:'FRONTITY_JSON_INVALID: '+e.message}}
  const route=st?.source?.data?.['/embed/@'+username]||{};
  const userId=route?.userInfo?.id||null,ttwid=st?.user?.ttwid||null;
  const rawEmbedApi=st?.theme?.embedApi??null;
  const prefix=String(rawEmbedApi||'').replace(/\/$/,'');
  const candidates=[];
  if(prefix){
    if(/^https?:\/\//i.test(prefix))candidates.push(prefix);
    else if(prefix.startsWith('//'))candidates.push('https:'+prefix);
    else if(prefix.startsWith('/'))candidates.push('https://www.tiktok.com'+prefix);
  }
  candidates.push('https://www.tiktok.com','https://www.tiktok.com/embed');
  const prefixes=[...new Set(candidates.map(x=>x.replace(/\/$/,'')))];
  if(!userId||!ttwid)return {ok:false,userId,ttwid,error:'MISSING_USERID_OR_TTWID'};
  const tests=[];
  for(const usedPrefix of prefixes)for(const count of [10,20,50]){
    const base=usedPrefix+'/embed/api/profile/getItemList';
    const url=base+'?userId='+encodeURIComponent(userId)+'&count='+count;
    try{
      const r=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept':'application/json, text/plain, */*','accept-language':'pt-BR,pt;q=0.9,en;q=0.8','referer':'https://www.tiktok.com/embed/@'+username,'x-tt-webid':String(ttwid)}});
      const body=await r.text();let j=null;try{j=JSON.parse(body)}catch{}
      const items=Array.isArray(j?.items)?j.items:Array.isArray(j?.itemList)?j.itemList:[];
      tests.push({usedPrefix,url,count,status:r.status,bytes:Buffer.byteLength(body),contentType:r.headers.get('content-type'),itemCount:items.length,ids:items.map(x=>String(x?.id||x?.itemId||'')).filter(Boolean),keys:j&&typeof j==='object'?Object.keys(j):[],cursor:j?.cursor??j?.maxCursor??null,hasMore:j?.hasMore??j?.has_more??null,error:j?.message||j?.statusMsg||(!body?'EMPTY_BODY':null),preview:body.slice(0,500)});
    }catch(e){tests.push({usedPrefix,url,count,error:String(e.message||e)})}
  }
  return {ok:true,rawEmbedApi,themeSiteBaseUrl:st?.theme?.siteBaseUrl??null,prefixes,userId,ttwid,initialEmbedCount:Array.isArray(route?.videoList)?route.videoList.length:0,tests};
}
async function probeTikTokEmbed(username){
  const user=String(username||'').trim().replace(/^@/,'').replace(/[^A-Za-z0-9._-]/g,'');
  if(!user)throw new Error('Informe o @user.');
  const profile='https://www.tiktok.com/@'+user;
  const urls=[
    {name:'OEMBED_OFICIAL',url:'https://www.tiktok.com/oembed?url='+encodeURIComponent(profile)},
    {name:'EMBED_PUBLICO',url:'https://www.tiktok.com/embed/@'+encodeURIComponent(user)}
  ];
  const attempts=[];const ids=new Set(),links=new Set();
  for(const x of urls){
    try{
      const r=await fetch(x.url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});
      const body=await r.text();let source=body;
      if(x.name==='OEMBED_OFICIAL'){try{const j=JSON.parse(body);source=body+'\n'+String(j.html||'')}catch{}}
      for(const m of source.matchAll(/(?:video\/|data-video-id=[\"'])(\d{8,})/g))ids.add(m[1]);
      for(const m of source.matchAll(/https?:\\?\/\\?\/(?:www\\?\.)?tiktok\\?\.com\\?\/@[^\s\"'<>]+?\\?\/video\\?\/(\d{8,})/g)){ids.add(m[1]);links.add('https://www.tiktok.com/@'+user+'/video/'+m[1])}
      const numericMatches=[...source.matchAll(/\b(\d{18,20})\b/g)];
      const numericIds=[...new Set(numericMatches.map(m=>m[1]))];
      const numericContexts=numericIds.map(id=>{
        const positions=numericMatches.filter(m=>m[1]===id).slice(0,4).map(m=>m.index);
        const contexts=positions.map(pos=>source.slice(Math.max(0,pos-180),Math.min(source.length,pos+id.length+260)).replace(/\s+/g,' '));
        const joined=contexts.join(' ');
        const hints=[];
        if(/\/video\/|videoId|itemId|aweme/i.test(joined))hints.push('VIDEO');
        if(/authorId|userId|uid|secUid|uniqueId|author/i.test(joined))hints.push('USER');
        if(/musicId|music/i.test(joined))hints.push('MUSIC');
        return {id,occurrences:positions.length,contexts,hints:[...new Set(hints)]};
      });
      const idDetails=[...ids].map(id=>{
        const pos=source.indexOf(id),chunk=pos>=0?source.slice(Math.max(0,pos-2500),Math.min(source.length,pos+6000)):'';
        const pick=re=>{const m=chunk.match(re);return m?.[1]??null};
        return {id,
          occurrences:(source.match(new RegExp(id,'g'))||[]).length,
          desc:pick(/"(?:desc|description)"\s*:\s*"([^"]*)"/i),
          author:pick(/"(?:uniqueId|unique_id)"\s*:\s*"([^"]+)"/i),
          views:pick(/"(?:playCount|viewCount)"\s*:\s*"?([0-9]+)/i),
          likes:pick(/"(?:diggCount|likeCount)"\s*:\s*"?([0-9]+)/i),
          comments:pick(/"commentCount"\s*:\s*"?([0-9]+)/i),
          shares:pick(/"shareCount"\s*:\s*"?([0-9]+)/i),
          saves:pick(/"(?:collectCount|saveCount)"\s*:\s*"?([0-9]+)/i),
          cover:pick(/"(?:cover|originCover|dynamicCover)"\s*:\s*"([^"]+)"/i)
        };
      });
      attempts.push({name:x.name,status:r.status,finalUrl:r.url,bytes:Buffer.byteLength(body),contentType:r.headers.get('content-type'),ids:[...ids],numericIdCandidates:numericIds.slice(0,120),numericIdCandidateCount:numericIds.length,numericContexts:numericContexts.slice(0,120),idDetails});
    }catch(e){attempts.push({name:x.name,error:String(e.message||e),ids:[]})}
  }
  const embedAttempt=attempts.find(a=>a.name==='EMBED_PUBLICO');
  let structuredState=null;
  try{
    const er=await fetch('https://www.tiktok.com/embed/@'+encodeURIComponent(user),{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});
    const eb=await er.text();
    structuredState=inspectEmbedStructuredState(eb,[...ids]);structuredState.frontity=mapFrontityState(eb,user,[...ids]);structuredState.profileListReplay=await replayEmbedProfileList(eb,user);structuredState.clientScripts=await inspectEmbedClientScripts(eb);
  }catch(e){structuredState={error:String(e.message||e)}}
  const allNumeric=[...new Set(attempts.flatMap(a=>a.numericIdCandidates||[]))];
  const details=attempts.flatMap(a=>a.idDetails||[]).filter((x,i,a)=>a.findIndex(y=>y.id===x.id)===i);
  const numericCandidates=allNumeric.map(id=>{
    const confirmedVideo=ids.has(id);
    const evidence=[];
    const hints=new Set();const contexts=[];
    for(const a of attempts){
      if(!a.numericIdCandidates?.includes(id))continue;
      const ctx=a.numericContexts?.find(x=>x.id===id);
      for(const h of ctx?.hints||[])hints.add(h);
      contexts.push(...(ctx?.contexts||[]).slice(0,2));
      evidence.push({source:a.name,confirmedVideo,hints:ctx?.hints||[]});
    }
    const classification=confirmedVideo?'VIDEO_CONFIRMADO':hints.has('USER')&&!hints.has('VIDEO')?'PROVAVEL_USER_ID':hints.has('MUSIC')&&!hints.has('VIDEO')?'PROVAVEL_MUSIC_ID':hints.has('VIDEO')?'POSSIVEL_VIDEO':'NAO_CLASSIFICADO';
    return {id,classification,hints:[...hints],contexts:contexts.slice(0,3),evidence};
  });
  return {kind:'tiktok-embed-probe',username:user,profile,videoCount:ids.size,videoIds:[...ids],videoLinks:[...ids].map(id=>'https://www.tiktok.com/@'+user+'/video/'+id),details,structuredState,allNumericCandidateCount:allNumeric.length,allNumericCandidates:allNumeric,numericCandidates,attempts,note:'Teste de descoberta via superfícies públicas de embed; não autentica conta nem inventa IDs.'};
}
app.get('/api/tiktok/quiet',async(req,res)=>{
  res.setHeader('cache-control','no-store');
  res.setHeader('content-type','application/x-ndjson; charset=utf-8');
  res.setHeader('x-accel-buffering','no');
  res.flushHeaders?.();
  let closed=false;req.on('close',()=>{closed=true});
  const send=(type,data={})=>{if(closed||res.writableEnded)return false;try{return res.write(JSON.stringify({type,...data})+'\n')}catch{return false}};
  const heartbeat=setInterval(()=>send('heartbeat',{at:Date.now()}),10000);
  try{
    send('progress',{stage:'start',message:'Iniciando navegador…'});
    const result=await observeTikTokQuietly(req.query.username,(stage,message)=>send('progress',{stage,message}));
    send('result',{result});
  }catch(e){send('error',{error:String(e.message||e)})}
  finally{clearInterval(heartbeat);if(!res.writableEnded)res.end()}
});
app.get('/api/tiktok/fresh-shot',async(req,res)=>{try{const img=await freshTikTokScreenshot(req.query.username||'oopedrogames');res.setHeader('content-type','image/jpeg');res.setHeader('cache-control','no-store');res.end(img)}catch(e){res.status(500).json({error:String(e.message||e)})}});
app.get('/api/tiktok/embed-probe',async(req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await probeTikTokEmbed(req.query.username))}catch(e){res.status(400).json({error:String(e.message||e)})}});
const TIKTOK_VIDEO_BATTERY=["https://vt.tiktok.com/ZSbYbPdBX/","https://vt.tiktok.com/ZSbYbXBWd/","https://vt.tiktok.com/ZSbYb4NLm/","https://vt.tiktok.com/ZSbYbwUbH/","https://vt.tiktok.com/ZSbYb9oXj/","https://vt.tiktok.com/ZSbYb36jv/","https://vt.tiktok.com/ZSbYbnoUe/","https://vt.tiktok.com/ZSbYb3tTh/","https://vt.tiktok.com/ZSb22UGrD/","https://vt.tiktok.com/ZSbjf9Ubx/","https://vt.tiktok.com/ZSbj5LE1a/","https://vt.tiktok.com/ZSbhd1fYP/","https://vt.tiktok.com/ZSbhe3Nox/"];
app.get('/api/tiktok/video-detail-diff',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await compareTikTokVideoDetailShapes(TIKTOK_VIDEO_BATTERY[8],TIKTOK_VIDEO_BATTERY[9]))}catch(e){res.status(500).json({error:String(e.message||e)})}});
app.get('/api/tiktok/video-pair',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await inspectTikTokVideoBatch([TIKTOK_VIDEO_BATTERY[8],TIKTOK_VIDEO_BATTERY[9]]))}catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}});
app.get('/api/tiktok/video-battery',async(_req,res)=>{res.setHeader('content-type','application/x-ndjson; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-accel-buffering','no');res.flushHeaders?.();const send=x=>res.write(JSON.stringify(x)+'\n');send({type:'start',count:TIKTOK_VIDEO_BATTERY.length});try{const result=await inspectTikTokVideoBatch(TIKTOK_VIDEO_BATTERY,(stage,message,data)=>send({type:'progress',stage,message,...(data||{})}));send({type:'result',result})}catch(e){send({type:'error',error:String(e.message||e)})}finally{res.end()}});
app.post('/api/tiktok/profile',async(req,res)=>{const username=String(req.body?.username||'').trim();if(!username)return res.status(400).json({error:'Informe o @user.'});res.setHeader('content-type','application/x-ndjson; charset=utf-8');res.setHeader('cache-control','no-store');const send=x=>res.write(JSON.stringify(x)+'\n');try{const raw=await dumpTikTokItemList(username,(stage,message)=>send({type:'progress',stage,message}));const networkDumps=(raw.dumps||[]).filter(x=>x.type!=='PROFILE_DOCUMENT');const documentDiagnostics=(raw.dumps||[]).filter(x=>x.type==='PROFILE_DOCUMENT').map(x=>({attempt:x.attempt,...x.documentDiagnostic}));const attempts=networkDumps.map((x,i)=>({name:x.attempt||('item_list #'+(i+1)),status:x.status,bytes:x.summary?.bytes||0,itemCount:x.summary?.itemCount||0,error:x.bodyError||x.summary?.error||null}));const byId=new Map();for(const x of networkDumps){for(const v of x.summary?.items||[]){if(v.id)byId.set(String(v.id),v)}}const videos=[...byId.values()];const result={kind:'tiktok-profile-battery',createdAt:new Date().toISOString(),username:String(raw.username||username).replace(/^@/,''),result:videos.length?'VIDEOS_FOUND':'NO_VIDEOS_FOUND',videoCount:videos.length,videos,attempts,documentDiagnostics,raw,pendingAtReturn:raw.pendingAtReturn,note:videos.length?'Sucesso: vídeos públicos reais encontrados pela listagem do perfil.':'Nenhuma item_list utilizável retornou vídeos neste ambiente. O relatório bruto permanece anexado para diagnóstico.'};send({type:'result',result})}catch(e){send({type:'error',error:'Falha na análise do perfil: '+e.message})}finally{res.end()}});
app.post('/api/network-map',async(req,res)=>{const target=String(req.body?.target||'').trim();if(!/^https?:\/\//i.test(target))return res.status(400).json({error:'Informe uma URL pública http/https.'});const deep=req.body?.deep!==false;try{res.json(await mapUrlRuntime(target,{observeMs:deep?15000:5000,timeoutMs:deep?20000:15000}))}catch(e){res.status(500).json({error:`Falha ao mapear a página: ${e.message}`})}});
app.post('/api/security/resolve',(req,res)=>{try{const target=String(req.body?.target||'').trim();if(!/^https?:\/\//i.test(target))return res.status(400).json({error:'Informe uma URL pública ou URL do GitHub.'});const data=resolveSecurityTarget(target,crypto.randomUUID());res.json(data)}catch(e){res.status(422).json({error:`Não foi possível preparar o alvo: ${e.message}`})}});
app.post('/api/audits',(req,res)=>{const{target,mode='repo',profile='visual'}=req.body||{};if(!target||!['repo','url'].includes(mode)||!['visual','security'].includes(profile))return res.status(400).json({error:'target, mode ou profile inválido'});if(mode==='repo'&&!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(target))return res.status(400).json({error:'No modo repo use uma URL de repositório GitHub.'});if(mode==='url'&&!/^https?:\/\//.test(target))return res.status(400).json({error:'No modo url use http/https.'});const id=crypto.randomUUID(),job={id,target,mode,profile,status:'queued',createdAt:new Date().toISOString(),output:'',...visualBuildInfo()};jobs.set(id,job);res.status(202).json(job);setImmediate(()=>run(job))});
app.get('/api/audits/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'análise não encontrada'});res.json(j)});
function run(job){job.status='running';job.startedAt=new Date().toISOString();const report=path.resolve('reports',`${job.id}.md`),jsonReport=path.resolve('reports',`${job.id}.json`),args=['src/cli.js','--mode',job.mode,'--target',job.target,'--profile',job.profile,'--job',job.id,'--report',report,'--json-report',jsonReport];const child=execFile(process.execPath,args,{timeout:180000,maxBuffer:2*1024*1024},(err,stdout,stderr)=>{job.finishedAt=new Date().toISOString();job.output=(stdout||'')+(stderr||'');if(fs.existsSync(report)){job.report=fs.readFileSync(report,'utf8');if(fs.existsSync(jsonReport)){try{job.reportJson=JSON.parse(fs.readFileSync(jsonReport,'utf8'))}catch{job.reportJson=null}}job.status='completed'}else{job.report='';job.status='failed';job.error=err?.message||'O processo terminou sem criar o arquivo de relatório.'}});child.on('error',e=>{job.status='failed';job.error=e.message;job.output=e.message})}
app.listen(port,'0.0.0.0',()=>console.log(`Visual QA v${visualBuildInfo().version} build ${visualBuildInfo().build} em :${port}`));
