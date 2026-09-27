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
function inspectHtml(html,finalUrl,status){
  const text=String(html||'');
  const markers=Object.fromEntries(MARKERS.map(([k,re])=>[k,re.test(text)]));
  const identity=videoIdentity(finalUrl,text);
  let canonical=null;
  const m=text.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)||text.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  if(m) canonical=cleanUrl(m[1]);
  return {status,finalUrl:cleanUrl(finalUrl),canonical,htmlBytes:Buffer.byteLength(text),...identity,markers};
}
async function inspectOne(browser,input){
  if(!isTikTok(input))throw new Error('Use somente links públicos do TikTok.');
  const context=await browser.newContext({serviceWorkers:'block'});
  const page=await context.newPage();
  const requests=[];
  page.on('response',r=>{const u=r.url();if(isTikTok(u)){let path='';try{const x=new URL(u);path=x.pathname+x.search}catch{}requests.push({status:r.status(),resourceType:r.request().resourceType(),path:path.slice(0,500)})}});
  try{
    const res=await page.goto(input,{waitUntil:'domcontentloaded',timeout:25000});
    await page.waitForTimeout(3500);
    const html=await page.content();
    return {...inspectHtml(html,page.url(),res?.status()||null),input:cleanUrl(input),requests:requests.slice(0,120)};
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
