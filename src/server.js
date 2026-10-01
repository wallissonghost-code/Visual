import express from 'express';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {resolveSecurityTarget} from './security-target.js';import {visualBuildInfo} from './version.js';import {mapUrlRuntime} from './network-map.js';import {dumpTikTokItemList,inspectTikTokVideoBatch,compareTikTokVideoDetailShapes,observeTikTokQuietly, freshTikTokScreenshot, captureTikTokReposts } from './tiktok-compare.js';
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
app.get('/api/tiktok/reposts',async(req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await captureTikTokReposts(req.query.username||'notgamesbr'))}catch(e){console.error('[reposts route]',e);res.status(500).json({error:String(e.message||e),build:BUILD_SHA})}});
app.get('/api/tiktok/fresh-shot',async(req,res)=>{try{const img=await freshTikTokScreenshot(req.query.username||'oopedrogames',String(req.query.target||'profile'));res.setHeader('content-type','image/jpeg');res.setHeader('cache-control','no-store');res.end(img)}catch(e){console.error('[fresh-shot route]',e);res.status(500).json({error:String(e.message||e),build:BUILD_SHA})}});
app.get('/api/tiktok/photo-vs-video-flow',async(req,res)=>{res.setHeader('cache-control','no-store');const input=String(req.query.url||'https://vt.tiktok.com/ZSbD7JKH1/').trim();try{
 const rr=await fetch(input,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});
 const finalUrl=String(rr.url||''),m=finalUrl.match(/\/(@[^/?#]+)\/(video|photo)\/(\d{10,})/i);if(!m)throw new Error('Não resolveu @user + tipo + ID: '+finalUrl);
 const username=decodeURIComponent(m[1].slice(1)),realType=m[2].toLowerCase(),id=m[3],photoUrl='https://www.tiktok.com/@'+username+'/photo/'+id,videoUrl='https://www.tiktok.com/@'+username+'/video/'+id;
 const browser=await inspectTikTokVideoBatch([input,photoUrl,videoUrl]);
 async function apiLike(url){const started=Date.now();try{const r=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});const html=await r.text();const um=html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i)||html.match(/<script[^>]+id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i);let item=null,parsed=false;if(um){try{const root=JSON.parse(um[1]);parsed=true;const seen=new Set();const walk=v=>{if(item||!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(!Array.isArray(v)&&String(v.id??v.itemId??'')===id&&(v.video||v.stats||v.statsV2)){item=v;return}for(const x of Object.values(v))walk(x)};walk(root)}catch{}}const st=item?.statsV2??item?.stats??null;return{requestedUrl:url,finalUrl:r.url,httpStatus:r.status,bytes:Buffer.byteLength(html),embeddedPayloadParsed:parsed,itemFound:!!item,metrics:st?{views:Number(st.playCount??st.play_count)||0,likes:Number(st.diggCount??st.digg_count)||0,comments:Number(st.commentCount??st.comment_count)||0,shares:Number(st.shareCount??st.share_count)||0,saves:Number(st.collectCount??st.collect_count)||0}:null,durationMs:Date.now()-started}}catch(e){return{requestedUrl:url,error:String(e.message||e),durationMs:Date.now()-started}}}
 const [nodePhoto,nodeVideo]=await Promise.all([apiLike(photoUrl),apiLike(videoUrl)]);
 res.json({kind:'photo-vs-video-api-flow',createdAt:new Date().toISOString(),input,resolved:{username,id,realType,finalUrl},urls:{photoUrl,videoUrl},apiBehavior:{linkAcceptedByCurrentApi:realType==='video',reason:realType==='video'?'aceito':'provider atual exige /video/; /photo/ é rejeitado antes da coleta',jsonImportedUrl:videoUrl},browser:{short:browser.results?.[0]||null,photo:browser.results?.[1]||null,video:browser.results?.[2]||null},nodeFetch:{photo:nodePhoto,video:nodeVideo},note:'Reprodução diagnóstica. Api não foi alterada. VIDEO FORÇADO representa a URL criada hoje pelo importador JSON da Api.'});
 }catch(e){res.status(400).json({error:String(e.message||e)})}});
app.get('/api/tiktok/video-vs-photo-flow',async(req,res)=>{res.setHeader('cache-control','no-store');const input=String(req.query.url||'https://vt.tiktok.com/ZSbyW8Tke/').trim();try{
 const rr=await fetch(input,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});
 const finalUrl=String(rr.url||''),m=finalUrl.match(/\/(@[^/?#]+)\/(video|photo)\/(\d{10,})/i);if(!m)throw new Error('Não resolveu @user + tipo + ID: '+finalUrl);
 const username=decodeURIComponent(m[1].slice(1)),realType=m[2].toLowerCase(),id=m[3],videoUrl='https://www.tiktok.com/@'+username+'/video/'+id,photoUrl='https://www.tiktok.com/@'+username+'/photo/'+id;
 const browser=await inspectTikTokVideoBatch([input,videoUrl,photoUrl]);
 async function apiLike(url){const started=Date.now();try{const r=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});const html=await r.text();const um=html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i)||html.match(/<script[^>]+id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i);let item=null,parsed=false;if(um){try{const root=JSON.parse(um[1]);parsed=true;const seen=new Set();const walk=v=>{if(item||!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(!Array.isArray(v)&&String(v.id??v.itemId??'')===id&&(v.video||v.stats||v.statsV2)){item=v;return}for(const x of Object.values(v))walk(x)};walk(root)}catch{}}const st=item?.statsV2??item?.stats??null;return{requestedUrl:url,finalUrl:r.url,httpStatus:r.status,bytes:Buffer.byteLength(html),embeddedPayloadParsed:parsed,itemFound:!!item,metrics:st?{views:Number(st.playCount??st.play_count)||0,likes:Number(st.diggCount??st.digg_count)||0,comments:Number(st.commentCount??st.comment_count)||0,shares:Number(st.shareCount??st.share_count)||0,saves:Number(st.collectCount??st.collect_count)||0}:null,durationMs:Date.now()-started}}catch(e){return{requestedUrl:url,error:String(e.message||e),durationMs:Date.now()-started}}}
 const [nodeVideo,nodePhoto]=await Promise.all([apiLike(videoUrl),apiLike(photoUrl)]);
 res.json({kind:'video-vs-photo-forced-flow',createdAt:new Date().toISOString(),input,resolved:{username,id,realType,finalUrl},urls:{videoUrl,photoUrl},browser:{short:browser.results?.[0]||null,video:browser.results?.[1]||null,photo:browser.results?.[2]||null},nodeFetch:{video:nodeVideo,photo:nodePhoto},note:'Diagnóstico inverso: VIDEO real versus o mesmo ID forçado em /photo/. Api não foi alterada.'});
 }catch(e){res.status(400).json({error:String(e.message||e)})}});
app.get('/api/tiktok/embed-vs-link',async(req,res)=>{res.setHeader('cache-control','no-store');const input=String(req.query.url||'https://vt.tiktok.com/ZSbD7JKH1/').trim();try{if(!/^https:\/\/(?:www\.)?(?:vt|vm|v)?\.?tiktok\.com\//i.test(input)&&!/^https:\/\/www\.tiktok\.com\//i.test(input))throw new Error('Informe um link público do TikTok.');const direct=await inspectTikTokVideoBatch([input]);const d=direct.results?.[0]||{};let finalUrl=String(d.finalUrl||''),targetId=String(d.id||'').trim(),username='';let postType='video';let m=finalUrl.match(/\/(@[^/?#]+)\/(video|photo)\/(\d{10,})/i);if(m){username=decodeURIComponent(m[1].slice(1));postType=m[2].toLowerCase();targetId=targetId||m[3]}if(!username||!targetId){const rr=await fetch(input,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept-language':'pt-BR,pt;q=0.9,en;q=0.8'}});finalUrl=finalUrl||rr.url;m=String(rr.url||'').match(/\/(@[^/?#]+)\/(video|photo)\/(\d{10,})/i);if(m){username=username||decodeURIComponent(m[1].slice(1));postType=m[2].toLowerCase();targetId=targetId||m[3]}}if(!targetId){const candidates=[finalUrl,input];for(const u of candidates){const x=String(u).match(/(?:(?:video|photo)\/|item_id=)(\d{10,})/i);if(x){targetId=x[1];break}}}if(!username&&targetId){const hs=String(d.rawHtml||d.htmlScan?.sample||'');const um=hs.match(/(?:uniqueId|unique_id)[\"']?\s*[:=]\s*[\"']([^\\"']+)/i);if(um)username=um[1]}if(!username||!targetId)throw new Error('Link abriu, mas não foi possível resolver @user + post ID. finalUrl='+String(finalUrl||'(vazia)'));const embed=await probeTikTokEmbed(username);const embedIds=[...new Set(embed.videoIds||[])],embedFound=embedIds.includes(targetId);let embedReading=null;if(embedFound){const er=await inspectTikTokVideoBatch(['https://www.tiktok.com/@'+username+'/'+postType+'/'+targetId]);const x=er.results?.[0];if(x)embedReading={classification:x.classification,httpStatus:x.httpStatus??null,htmlBytes:x.htmlBytes??0,itemStructPresent:!!x.itemStructPresent,metrics:!!x.metrics}}res.json({kind:'embed-vs-direct-link',createdAt:new Date().toISOString(),input,resolved:{username,targetId,postType,finalUrl},embed:{found:embedFound,discoveredCount:embedIds.length,discoveredIds:embedIds,reading:embedReading},link:{classification:d.classification||null,httpStatus:d.httpStatus??null,htmlBytes:d.htmlBytes??0,itemStructPresent:!!d.itemStructPresent,metrics:!!d.metrics,error:d.error||null,finalUrl:d.finalUrl||null,id:d.id||null},note:'LINK é lido primeiro e serve somente de gabarito. EMBED recebe apenas o username resolvido; JSON não participa.'})}catch(e){res.status(400).json({error:String(e.message||e)})}});
app.get('/api/tiktok/embed-probe',async(req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await probeTikTokEmbed(req.query.username))}catch(e){res.status(400).json({error:String(e.message||e)})}});
const TIKTOK_VIDEO_BATTERY=["https://vt.tiktok.com/ZSbYbPdBX/","https://vt.tiktok.com/ZSbYbXBWd/","https://vt.tiktok.com/ZSbYb4NLm/","https://vt.tiktok.com/ZSbYbwUbH/","https://vt.tiktok.com/ZSbYb9oXj/","https://vt.tiktok.com/ZSbYb36jv/","https://vt.tiktok.com/ZSbYbnoUe/","https://vt.tiktok.com/ZSbYb3tTh/","https://vt.tiktok.com/ZSb22UGrD/","https://vt.tiktok.com/ZSbjf9Ubx/","https://vt.tiktok.com/ZSbj5LE1a/","https://vt.tiktok.com/ZSbhd1fYP/","https://vt.tiktok.com/ZSbhe3Nox/"];
app.get('/api/tiktok/video-detail-diff',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await compareTikTokVideoDetailShapes(TIKTOK_VIDEO_BATTERY[8],TIKTOK_VIDEO_BATTERY[9]))}catch(e){res.status(500).json({error:String(e.message||e)})}});
app.get('/api/tiktok/video-pair',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await inspectTikTokVideoBatch([TIKTOK_VIDEO_BATTERY[8],TIKTOK_VIDEO_BATTERY[9]]))}catch(e){res.status(500).json({ok:false,error:String(e.message||e)})}});
app.get('/api/tiktok/video-battery',async(_req,res)=>{res.setHeader('content-type','application/x-ndjson; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-accel-buffering','no');res.flushHeaders?.();const send=x=>res.write(JSON.stringify(x)+'\n');send({type:'start',count:TIKTOK_VIDEO_BATTERY.length});try{const result=await inspectTikTokVideoBatch(TIKTOK_VIDEO_BATTERY,(stage,message,data)=>send({type:'progress',stage,message,...(data||{})}));send({type:'result',result})}catch(e){send({type:'error',error:String(e.message||e)})}finally{res.end()}});

const MEDIA_ROUTE_PROBE_VERSION='media-route-v3';
const MEDIA_ROUTE_VIDEO_10={itemId:'7690154508063690036',videoId:'v14044g50000dasejm7og65ko2o76l6g'};
async function probeMediaRoute10(){
 const itemId=MEDIA_ROUTE_VIDEO_10.itemId, videoId=MEDIA_ROUTE_VIDEO_10.videoId, amp=String.fromCharCode(38);
 const base='https://www.tiktok.com/aweme/v1/play/?';
 const tests=[
  {name:'PAGINA_ITEM',url:'https://www.tiktok.com/@oopedrogames/video/'+itemId},
  {name:'AWEME_ITEM_VIDEO',url:base+'item_id='+encodeURIComponent(itemId)+amp+'video_id='+encodeURIComponent(videoId)+amp+'is_play_url=1'},
  {name:'AWEME_VIDEO_ONLY',url:base+'video_id='+encodeURIComponent(videoId)+amp+'is_play_url=1'},
  {name:'AWEME_ITEM_ONLY',url:base+'item_id='+encodeURIComponent(itemId)+amp+'is_play_url=1'}
 ];
 const results=[];
 for(const t of tests){try{const resp=await fetch(t.url,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept':'*/*','accept-language':'pt-BR,pt;q=0.9,en;q=0.8','referer':'https://www.tiktok.com/'}});const ct=resp.headers.get('content-type')||'',loc=resp.headers.get('location')||null,cl=resp.headers.get('content-length');let bytes=0,bodyKind='NAO_LIDO';if(!loc){const ab=await resp.arrayBuffer();bytes=ab.byteLength;bodyKind=ct.includes('video')?'VIDEO':ct.includes('json')?'JSON':ct.includes('html')?'HTML':'OUTRO'}results.push({name:t.name,status:resp.status,contentType:ct,contentLength:cl?Number(cl):null,bytes,redirect:!!loc,redirectHost:loc?(()=>{try{return new URL(loc,t.url).host}catch{return null}})():null,bodyKind})}catch(e){results.push({name:t.name,error:String(e.message||e)})}}
 return {kind:'tiktok-media-route-probe',version:MEDIA_ROUTE_PROBE_VERSION,createdAt:new Date().toISOString(),identifiers:{itemId,videoId},results};
}
app.get('/api/tiktok/indexed-video-10/media-routes',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await probeMediaRoute10())}catch(e){res.status(500).json({error:String(e.message||e)})}});

const GOLD_PLAY_PARAMS_10={faid:'1988',file_id:'fb4055c07b444668baec6a3c538a12f7',item_id:'7690154508063690036',line:'0',ply_type:'2',video_id:'v14044g50000dasejm7og65ko2o76l6g'};
async function probeGoldPlayParams10(){
 const amp=String.fromCharCode(38), base='https://www.tiktok.com/aweme/v1/play/?';
 const variants=[
  ['BASE_IDS',['item_id','video_id','is_play_url']],
  ['PLUS_FAID',['faid','item_id','video_id','is_play_url']],
  ['PLUS_FILE',['faid','file_id','item_id','video_id','is_play_url']],
  ['PLUS_LINE_PLY',['faid','file_id','item_id','line','ply_type','video_id','is_play_url']]
 ];
 const val=k=>k==='is_play_url'?'1':GOLD_PLAY_PARAMS_10[k]; const results=[];
 for(const [name,keys] of variants){const url=base+keys.map(k=>encodeURIComponent(k)+'='+encodeURIComponent(val(k))).join(amp);try{const resp=await fetch(url,{redirect:'manual',headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','accept':'*/*','accept-language':'pt-BR,pt;q=0.9,en;q=0.8','referer':'https://www.tiktok.com/'}});const ct=resp.headers.get('content-type')||'',loc=resp.headers.get('location')||null;let bytes=0;if(!loc)bytes=(await resp.arrayBuffer()).byteLength;results.push({name,keys,status:resp.status,contentType:ct,bytes,redirect:!!loc,redirectHost:loc?(()=>{try{return new URL(loc,url).host}catch{return null}})():null})}catch(e){results.push({name,keys,error:String(e.message||e)})}}
 return {kind:'tiktok-gold-play-param-probe',createdAt:new Date().toISOString(),note:'Static identity/routing params only; old signed/token params intentionally excluded',results};
}
app.get('/api/tiktok/indexed-video-10/gold-play-params',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await probeGoldPlayParams10())}catch(e){res.status(500).json({error:String(e.message||e)})}});

async function captureNaturalPlay10(){
 const { chromium }=await import('playwright'); const target='7690154508063690036', hits=[]; let browser;
 try{browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1365,height:768},locale:'pt-BR',timezoneId:'America/Sao_Paulo',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});const page=await ctx.newPage();
 const record=u=>{try{const x=new URL(u);if(!x.pathname.includes('/aweme/v1/play'))return;const sensitive=/token|signature|verify|bogus|gnarly|dynosaur|ttwid/i;hits.push({path:x.pathname,paramNames:[...x.searchParams.keys()],safeParams:Object.fromEntries([...x.searchParams.entries()].filter(([k])=>!sensitive.test(k)).map(([k,v])=>[k,v.length>100?'[LONG]':v])),hasTarget:x.searchParams.get('item_id')===target||u.includes(target)})}catch{}};
 page.on('request',q=>record(q.url()));page.on('response',q=>record(q.url()));await page.goto('https://www.tiktok.com/@oopedrogames/video/'+target,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(7000);await page.mouse.click(680,380).catch(()=>{});await page.waitForTimeout(5000);await page.mouse.wheel(0,400).catch(()=>{});await page.waitForTimeout(3000);await ctx.close();
 return {kind:'tiktok-natural-play-capture',createdAt:new Date().toISOString(),targetId:target,hitCount:hits.length,hits:[...new Map(hits.map(x=>[x.path+'?'+x.paramNames.join(','),x])).values()]};}finally{if(browser)await browser.close().catch(()=>{})}
}
app.get('/api/tiktok/indexed-video-10/natural-play',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await captureNaturalPlay10())}catch(e){res.status(500).json({error:String(e.message||e)})}});

async function compareGoldTree10(){const id='7690154508063690036';const batch=await inspectTikTokVideoBatch(['https://www.tiktok.com/@oopedrogames/video/'+id]);const live=batch?.results?.[0]||null;if(!live)return{kind:'tiktok-gold-tree-compare',createdAt:new Date().toISOString(),targetId:id,validLive:false,error:'NO_LIVE_RESULT',gold:{source:'PC_GOLD_JSON',known:{universal:true,videoDetail:true,itemInfo:true,itemStruct:true,stats:true,playAddr:true}},render:null,stages:[],firstMissing:null,note:'No valid live row was returned; no structural conclusion made.'};const markers=live.markers||live.sources?.html?.markers||{};const has=(k,fallback)=>typeof fallback==='boolean'?fallback:!!markers[k];const universal=has('UNIVERSAL_DATA',live.universalFound),videoDetail=has('video-detail',live.videoDetailPresent),itemInfo=has('itemInfo',live.itemInfoPresent),itemStruct=has('itemStruct',live.itemStructPresent),stats=!!live.metrics||has('statsV2')||has('playCount'),playAddr=!!live.playAddrPresent||!!live.playAddr;const stages=[['UNIVERSAL_DATA',universal,true],['VIDEO_DETAIL',videoDetail,true],['ITEM_INFO',itemInfo,true],['ITEM_STRUCT',itemStruct,true],['STATS',stats,true],['PLAY_ADDR',playAddr,true]];const first=stages.find(x=>x[2]&&!x[1]);return{kind:'tiktok-gold-tree-compare',createdAt:new Date().toISOString(),targetId:id,validLive:true,gold:{source:'PC_GOLD_JSON',known:{universal:true,videoDetail:true,itemInfo:true,itemStruct:true,stats:true,playAddr:true}},render:{httpStatus:live.httpStatus??live.http??null,htmlBytes:live.htmlBytes??null,classification:live.classification??null,universal,videoDetail,itemInfo,itemStruct,stats,playAddr},stages:stages.map(([stage,render,gold])=>({stage,gold,render,match:gold===render})),firstMissing:first?first[0]:null,note:'Fresh Render row validated before structural comparison.'}}
app.get('/api/tiktok/indexed-video-10/gold-tree',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await compareGoldTree10())}catch(e){res.status(500).json({error:String(e.message||e)})}});

function videoDetailShapeFromHtml(html){const m=String(html||'').match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\s\S]*?)<\/script>/i);if(!m)return{universal:false};try{const root=JSON.parse(m[1]);const scope=root?.__DEFAULT_SCOPE__||{};const key=Object.keys(scope).find(k=>k==='webapp.video-detail'||k.includes('video-detail'));const detail=key?scope[key]:null;return{universal:true,key:key||null,detailType:Array.isArray(detail)?'array':typeof detail,detailKeys:detail&&typeof detail==='object'?Object.keys(detail).slice(0,80):[],hasItemInfo:!!detail?.itemInfo,itemInfoKeys:detail?.itemInfo&&typeof detail.itemInfo==='object'?Object.keys(detail.itemInfo).slice(0,80):[],statusCode:detail?.statusCode??detail?.status_code??null,statusMsg:detail?.statusMsg??detail?.status_msg??null}}catch(e){return{universal:true,parseError:String(e.message||e)}}}
async function inspectDevice10(mode){const {chromium}=await import('playwright');let browser;try{browser=await chromium.launch({headless:true});const mobile=mode==='mobile';const ctx=await browser.newContext(mobile?{viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,locale:'pt-BR',timezoneId:'America/Sao_Paulo',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'}:{viewport:{width:1365,height:768},locale:'pt-BR',timezoneId:'America/Sao_Paulo',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36'});const page=await ctx.newPage();const url='https://www.tiktok.com/@oopedrogames/video/7690154508063690036';const res=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(5000);const html=await page.content();const shape=videoDetailShapeFromHtml(html);await ctx.close();return{mode,httpStatus:res?.status()??null,finalUrl:page.url?.()||url,htmlBytes:Buffer.byteLength(html),...shape}}finally{if(browser)await browser.close().catch(()=>{})}}
app.get('/api/tiktok/indexed-video-10/device-tree',async(_req,res)=>{res.setHeader('cache-control','no-store');try{const desktop=await inspectDevice10('desktop');const mobile=await inspectDevice10('mobile');res.json({kind:'tiktok-device-tree-compare',createdAt:new Date().toISOString(),targetId:'7690154508063690036',desktop,mobile,mobileChangedDelivery:JSON.stringify(desktop.detailKeys)!==JSON.stringify(mobile.detailKeys)||desktop.hasItemInfo!==mobile.hasItemInfo})}catch(e){res.status(500).json({error:String(e.message||e)})}});

async function deepProfileMobile10(){const {chromium}=await import('playwright');let browser;try{browser=await chromium.launch({headless:true});const configs=[{name:'BR_MOBILE',locale:'pt-BR',headers:{'accept-language':'pt-BR,pt;q=0.9,en;q=0.8','sec-ch-ua-mobile':'?1','x-country-code':'BR'}},{name:'US_MOBILE',locale:'en-US',headers:{'accept-language':'en-US,en;q=0.9','sec-ch-ua-mobile':'?1','x-country-code':'US'}}];const out=[];for(const cfg of configs){const ctx=await browser.newContext({viewport:{width:390,height:844},screen:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3,locale:cfg.locale,timezoneId:'America/Sao_Paulo',userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',extraHTTPHeaders:cfg.headers});const page=await ctx.newPage();const requests=[];const responses=[];page.on('request',q=>{const u=q.url();if(/tiktok\.com/i.test(u))requests.push({method:q.method(),url:u.replace(/([?&](?:ttwid|msToken|X-Bogus|X-Gnarly|verifyFp|signaturev3|token)=[^&]*)/ig,'$1=[REDACTED]')})});page.on('response',async q=>{const u=q.url();if(!/tiktok\.com/i.test(u))return;const ct=q.headers()['content-type']||'';if(/json|javascript|html/i.test(ct))responses.push({status:q.status(),type:q.request().resourceType(),url:u.replace(/([?&](?:ttwid|msToken|X-Bogus|X-Gnarly|verifyFp|signaturev3|token)=[^&]*)/ig,'$1=[REDACTED]'),contentType:ct})});const profile='https://www.tiktok.com/@oopedrogames';const res=await page.goto(profile,{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(7000);for(let n=0;n<4;n++){await page.mouse.wheel(0,Math.round(900*(n+1)));await page.waitForTimeout(1500)}const html=await page.content();const text=String(html);const videoIds=[...new Set([...text.matchAll(/(?:\/video\/|itemId["']?\s*[:=]\s*["'])(\d{18,})/g)].map(m=>m[1]))];const hrefs=[...new Set([...text.matchAll(/https?:\\?\/\\?\/www\\?\.tiktok\\?\.com\\?\/@[^"'\\s<>]+\\?\/video\\?\/\\?\d+/gi)].map(m=>m[0].replace(/\\\\/g,'')))].slice(0,50);const markerNames=['itemList','itemStruct','videoList','videoData','post','posts','video','aweme','SIGI_STATE','UNIVERSAL_DATA_FOR_REHYDRATION'];const markers=Object.fromEntries(markerNames.map(k=>[k,text.includes(k)]));out.push({name:cfg.name,httpStatus:res?.status()??null,htmlBytes:Buffer.byteLength(text),videoIdCount:videoIds.length,videoIds:videoIds.slice(0,30),videoHrefCount:hrefs.length,videoHrefs:hrefs,markers,requestCount:requests.length,responseCount:responses.length,playOrItemRequests:requests.filter(x=>/item_list|post|feed|video|aweme/i.test(x.url)).slice(0,80),jsonResponses:responses.filter(x=>/json/i.test(x.contentType)).slice(0,80)});await ctx.close()}return{kind:'tiktok-mobile-profile-deep-scan',createdAt:new Date().toISOString(),profile:'@oopedrogames',modes:out,note:'Public profile scan; sensitive query values redacted. Compares mobile BR vs mobile US context and inspects profile page/network for video references.'}}finally{if(browser)await browser.close().catch(()=>{})}}
async function regionCrossBorderProbe10(){const {chromium}=await import('playwright');let browser;try{browser=await chromium.launch({headless:true});const cfgs=[{name:'BR',locale:'pt-BR',headers:{'accept-language':'pt-BR,pt;q=0.9,en;q=0.8','x-country-code':'BR'}},{name:'US',locale:'en-US',headers:{'accept-language':'en-US,en;q=0.9','x-country-code':'US'}},{name:'GB',locale:'en-GB',headers:{'accept-language':'en-GB,en;q=0.9','x-country-code':'GB'}}];const out=[];for(const cfg of cfgs){const ctx=await browser.newContext({viewport:{width:1365,height:768},locale:cfg.locale,timezoneId:'America/Sao_Paulo',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',extraHTTPHeaders:cfg.headers});const page=await ctx.newPage();const res=await page.goto('https://www.tiktok.com/@oopedrogames/video/7690154508063690036',{waitUntil:'domcontentloaded',timeout:30000});await page.waitForTimeout(4500);const html=await page.content();const m=html.match(/<script[^>]+id=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>([\\s\\S]*?)<\/script>/i);let detail=null;try{const root=JSON.parse(m?.[1]||'{}');const scope=root?.__DEFAULT_SCOPE__||{};const key=Object.keys(scope).find(k=>k==='webapp.video-detail'||k.includes('video-detail'));const d=key?scope[key]:null;detail={key:key||null,keys:d&&typeof d==='object'?Object.keys(d).slice(0,60):[],statusCode:d?.statusCode??null,statusMsg:d?.statusMsg??null,hasItemInfo:!!d?.itemInfo}}catch(e){detail={parseError:String(e.message||e)}}out.push({name:cfg.name,httpStatus:res?.status()??null,htmlBytes:Buffer.byteLength(html),detail});await ctx.close()}return{kind:'tiktok-cross-border-matrix',createdAt:new Date().toISOString(),targetId:'7690154508063690036',results:out,note:'Context matrix only; no old signatures/tokens reused.'}}finally{if(browser)await browser.close().catch(()=>{})}}
app.get('/api/tiktok/indexed-video-10/deep-mobile-profile',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await deepProfileMobile10())}catch(e){res.status(500).json({error:String(e.message||e)})}});
app.get('/api/tiktok/indexed-video-10/cross-border',async(_req,res)=>{res.setHeader('cache-control','no-store');try{res.json(await regionCrossBorderProbe10())}catch(e){res.status(500).json({error:String(e.message||e)})}});

const INDEXED_SCAN_VERSION='indexed-html-scan-v2';
const INDEXED_VIDEO_10={id:'7690154508063690036',source:'PC_GOLD_JSON',metrics:{views:128,likes:3,comments:3,shares:0,saves:0}};
app.get('/api/tiktok/indexed-video-10',async(_req,res)=>{res.setHeader('cache-control','no-store');try{const live=await inspectTikTokVideoBatch(['https://www.tiktok.com/@oopedrogames/video/'+INDEXED_VIDEO_10.id]);const row=live.results?.[0]||null;res.json({kind:'indexed-video-refresh-test',scanVersion:INDEXED_SCAN_VERSION,createdAt:new Date().toISOString(),indexed:INDEXED_VIDEO_10,live:row?{...row,htmlScan:row.htmlScan||null}:row,refreshSucceeded:!!(row?.classification==='COMPLETO'&&row?.metrics),effectiveMetrics:(row?.classification==='COMPLETO'&&row?.metrics)?row.metrics:INDEXED_VIDEO_10.metrics,note:(row?.classification==='COMPLETO'&&row?.metrics)?'Atualização ao vivo substituiu o snapshot indexado.':'Atualização ao vivo não trouxe métricas completas; snapshot indexado preservado.'})}catch(e){res.status(500).json({error:String(e.message||e)})}});
app.get('/api/tiktok/indexed-video-10/raw',async(_req,res)=>{res.setHeader('cache-control','no-store');res.setHeader('content-type','text/html; charset=utf-8');try{const live=await inspectTikTokVideoBatch(['https://www.tiktok.com/@oopedrogames/video/'+INDEXED_VIDEO_10.id]);const raw=live.results?.[0]?.rawHtml;if(!raw)return res.status(502).send('RAW_HTML_NAO_DISPONIVEL');res.send(raw)}catch(e){res.status(500).send('RAW_HTML_ERRO: '+String(e.message||e))}});
const PC_GOLD_OOPEDROGAMES_IDS=['7688324270203653397','7688516965945707797','7688711000870096148','7688936418894302485','7689110871531982100','7689246080659115285','7689543057015901460','7689675000466509077','7689954489733778709','7690154508063690036','7690326883975597332','7690570795143171349','7691065530429492500'];
const pcGoldJobs=new Map();
function pcGoldJobPublic(job){return {id:job.id,status:job.status,startedAt:job.startedAt,elapsedMs:Date.now()-job.startedAt,events:job.events.slice(-20),result:job.result||null,error:job.error||null}}
async function runPcGoldJob(job,username,targetId){const gold=username.toLowerCase()==='oopedrogames'?PC_GOLD_OOPEDROGAMES_IDS:[],timeout=(ms,label)=>new Promise((_,reject)=>setTimeout(()=>reject(new Error(label)),ms)),progress=(stage,message)=>job.events.push({stage,message,elapsedMs:Date.now()-job.startedAt}),methods=[],found=new Set(),add=(name,ids,extra={})=>{ids=[...new Set((ids||[]).map(String).filter(x=>/^\d{10,}$/.test(x)))];ids.forEach(x=>found.add(x));const hit=ids.includes(String(targetId));methods.push({name,itemCount:ids.length,targetFound:hit,...extra});progress(name,hit?'🎯 '+name+': ALVO ENCONTRADO ✓':name+': '+ids.length+' ID(s), alvo ainda não apareceu.');return hit};try{job.status='running';progress('start','Entrada única: @'+username);progress('target','Procurando '+targetId+' sem abrir o link do alvo.');let targetFound=false,targetFoundIn=null,discoveryError=null;
progress('embed','1/3 · Testando superfícies públicas Embed pelo username…');try{const e=await Promise.race([probeTikTokEmbed(username),timeout(30000,'EMBED_TIMEOUT_30S')]);const ids=[...(e.videoIds||[]),...(e.numericCandidates||[]).filter(x=>x.classification==='VIDEO_CONFIRMADO'||x.classification==='POSSIVEL_VIDEO').map(x=>x.id)];if(add('EMBED',ids,{videoCount:e.videoCount||0}))targetFound=true,targetFoundIn='EMBED'}catch(e){methods.push({name:'EMBED',error:String(e.message||e)});progress('embed-error','EMBED falhou: '+String(e.message||e))}
if(!targetFound){progress('browser','2/3 · Abrindo perfil real no navegador e observando HTML/rede…');try{const q=await Promise.race([observeTikTokQuietly(username,(stage,message)=>progress('BROWSER_'+stage,message)),timeout(65000,'BROWSER_TIMEOUT_65S')]);const ids=q?.visible?.videoIds||[];if(add('BROWSER_PROFILE',ids,{networkTotal:q?.networkSummary?.total||0,postItemList:(q?.networkSummary?.postItemList||[]).map(x=>({status:x.status,bytes:x.bytes}))}))targetFound=true,targetFoundIn='BROWSER_PROFILE'}catch(e){methods.push({name:'BROWSER_PROFILE',error:String(e.message||e)});progress('browser-error','Navegador terminou sem alvo: '+String(e.message||e))}}
if(!targetFound){progress('item-list','3/3 · Última tentativa: item_list nativa gerada pelo perfil…');try{const raw=await Promise.race([dumpTikTokItemList(username,(stage,message)=>progress('ITEM_'+stage,message),{maxProfiles:1}),timeout(45000,'ITEM_LIST_TIMEOUT_45S')]);const dumps=(raw.dumps||[]).filter(x=>x.type!=='PROFILE_DOCUMENT'),ids=[];for(const d of dumps)for(const v of d.summary?.items||[])if(v.id)ids.push(String(v.id));if(add('ITEM_LIST',ids,{attempts:dumps.map(d=>({name:d.attempt,status:d.status,bytes:d.summary?.bytes||0,itemCount:d.summary?.itemCount||0}))}))targetFound=true,targetFoundIn='ITEM_LIST'}catch(e){discoveryError=String(e.message||e);methods.push({name:'ITEM_LIST',error:discoveryError});progress('item-error','item_list terminou sem alvo: '+discoveryError)}}
const discovered=[...found],knownSet=new Set(gold),foundSet=new Set(discovered),newIds=discovered.filter(id=>!knownSet.has(id)),missingGold=gold.filter(id=>!foundSet.has(id));progress('target-check',targetFound?'🎯 ALVO ENCONTRADO ✓ via '+targetFoundIn:'🎯 ALVO NÃO ENCONTRADO ✕ após '+methods.length+' métodos.');let targetReading=null;if(targetFound){progress('validate-target','Descoberta provada. Agora lendo métricas do alvo descoberto…');try{const live=await Promise.race([inspectTikTokVideoBatch(['https://www.tiktok.com/@'+username+'/video/'+targetId]),timeout(30000,'TARGET_VALIDATION_TIMEOUT_30S')]);const x=(live.results||[])[0];if(x)targetReading={id:String(targetId),classification:x.classification||null,httpStatus:x.httpStatus??null,htmlBytes:x.htmlBytes??0,itemStructPresent:!!x.itemStructPresent,metrics:!!x.metrics};progress('validated-target',targetReading?.metrics?'Métricas do alvo encontradas ✓':'ID descoberto; leitura individual sem métricas.')}catch(e){progress('validation-error','Falha ao validar métricas: '+String(e.message||e))}}job.result={kind:'username-target-discovery-battery',createdAt:new Date().toISOString(),username,targetId:String(targetId),targetFound,targetFoundIn,discoveredCount:discovered.length,discoveredIds:discovered,newIds,missingGold,goldCount:gold.length,methods,targetReading,discoveryError,timedOut:false};job.status='done'}catch(e){job.error=String(e.message||e);job.status='error'}}
app.post('/api/tiktok/pc-gold-server/start',(req,res)=>{res.setHeader('cache-control','no-store');const username=String(req.query.username||req.body?.username||'oopedrogames').trim().replace(/^@/,'');const targetId=String(req.query.targetId||req.body?.targetId||'7691328584602029332').trim();const id=Date.now().toString(36)+Math.random().toString(36).slice(2,8),job={id,status:'queued',startedAt:Date.now(),events:[],result:null,error:null};pcGoldJobs.set(id,job);runPcGoldJob(job,username,targetId);setTimeout(()=>pcGoldJobs.delete(id),10*60*1000);res.json({ok:true,jobId:id})});
app.get('/api/tiktok/pc-gold-server/status',(req,res)=>{res.setHeader('cache-control','no-store');const job=pcGoldJobs.get(String(req.query.jobId||''));if(!job)return res.status(404).json({error:'JOB_NOT_FOUND'});res.json(pcGoldJobPublic(job))});
app.post('/api/tiktok/profile',async(req,res)=>{const username=String(req.body?.username||'').trim();if(!username)return res.status(400).json({error:'Informe o @user.'});res.setHeader('content-type','application/x-ndjson; charset=utf-8');res.setHeader('cache-control','no-store');const send=x=>res.write(JSON.stringify(x)+'\n');try{const raw=await dumpTikTokItemList(username,(stage,message)=>send({type:'progress',stage,message}));const networkDumps=(raw.dumps||[]).filter(x=>x.type!=='PROFILE_DOCUMENT');const documentDiagnostics=(raw.dumps||[]).filter(x=>x.type==='PROFILE_DOCUMENT').map(x=>({attempt:x.attempt,...x.documentDiagnostic}));const attempts=networkDumps.map((x,i)=>({name:x.attempt||('item_list #'+(i+1)),status:x.status,bytes:x.summary?.bytes||0,itemCount:x.summary?.itemCount||0,error:x.bodyError||x.summary?.error||null}));const byId=new Map();for(const x of networkDumps){for(const v of x.summary?.items||[]){if(v.id)byId.set(String(v.id),v)}}const videos=[...byId.values()];const result={kind:'tiktok-profile-battery',createdAt:new Date().toISOString(),username:String(raw.username||username).replace(/^@/,''),result:videos.length?'VIDEOS_FOUND':'NO_VIDEOS_FOUND',videoCount:videos.length,videos,attempts,documentDiagnostics,raw,pendingAtReturn:raw.pendingAtReturn,note:videos.length?'Sucesso: vídeos públicos reais encontrados pela listagem do perfil.':'Nenhuma item_list utilizável retornou vídeos neste ambiente. O relatório bruto permanece anexado para diagnóstico.'};send({type:'result',result})}catch(e){send({type:'error',error:'Falha na análise do perfil: '+e.message})}finally{res.end()}});
app.post('/api/network-map',async(req,res)=>{const target=String(req.body?.target||'').trim();if(!/^https?:\/\//i.test(target))return res.status(400).json({error:'Informe uma URL pública http/https.'});const deep=req.body?.deep!==false;try{res.json(await mapUrlRuntime(target,{observeMs:deep?15000:5000,timeoutMs:deep?20000:15000}))}catch(e){res.status(500).json({error:`Falha ao mapear a página: ${e.message}`})}});
app.post('/api/security/resolve',(req,res)=>{try{const target=String(req.body?.target||'').trim();if(!/^https?:\/\//i.test(target))return res.status(400).json({error:'Informe uma URL pública ou URL do GitHub.'});const data=resolveSecurityTarget(target,crypto.randomUUID());res.json(data)}catch(e){res.status(422).json({error:`Não foi possível preparar o alvo: ${e.message}`})}});
app.post('/api/audits',(req,res)=>{const{target,mode='repo',profile='visual'}=req.body||{};if(!target||!['repo','url'].includes(mode)||!['visual','security'].includes(profile))return res.status(400).json({error:'target, mode ou profile inválido'});if(mode==='repo'&&!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(target))return res.status(400).json({error:'No modo repo use uma URL de repositório GitHub.'});if(mode==='url'&&!/^https?:\/\//.test(target))return res.status(400).json({error:'No modo url use http/https.'});const id=crypto.randomUUID(),job={id,target,mode,profile,status:'queued',createdAt:new Date().toISOString(),output:'',...visualBuildInfo()};jobs.set(id,job);res.status(202).json(job);setImmediate(()=>run(job))});
app.get('/api/audits/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:'análise não encontrada'});res.json(j)});
function run(job){job.status='running';job.startedAt=new Date().toISOString();const report=path.resolve('reports',`${job.id}.md`),jsonReport=path.resolve('reports',`${job.id}.json`),args=['src/cli.js','--mode',job.mode,'--target',job.target,'--profile',job.profile,'--job',job.id,'--report',report,'--json-report',jsonReport];const child=execFile(process.execPath,args,{timeout:180000,maxBuffer:2*1024*1024},(err,stdout,stderr)=>{job.finishedAt=new Date().toISOString();job.output=(stdout||'')+(stderr||'');if(fs.existsSync(report)){job.report=fs.readFileSync(report,'utf8');if(fs.existsSync(jsonReport)){try{job.reportJson=JSON.parse(fs.readFileSync(jsonReport,'utf8'))}catch{job.reportJson=null}}job.status='completed'}else{job.report='';job.status='failed';job.error=err?.message||'O processo terminou sem criar o arquivo de relatório.'}});child.on('error',e=>{job.status='failed';job.error=e.message;job.output=e.message})}
app.listen(port,'0.0.0.0',()=>console.log(`Visual QA v${visualBuildInfo().version} build ${visualBuildInfo().build} em :${port}`));
