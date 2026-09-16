import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const TEXT=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.html','.json','.yml','.yaml','.md']);
const SKIP=new Set(['.git','node_modules','dist','build','.next']);
function walk(root,out=[]){for(const e of fs.readdirSync(root,{withFileTypes:true})){if(SKIP.has(e.name))continue;const p=path.join(root,e.name);if(e.isDirectory())walk(p,out);else if(TEXT.has(path.extname(e.name)))out.push(p)}return out}
function uniq(a){return[...new Set(a.filter(Boolean))]}
function values(text,re){const out=[];let m;re.lastIndex=0;while((m=re.exec(text)))out.push(m[1]);return out}
function discover(root){
  let all='';
  for(const f of walk(root)){try{all+='\n'+fs.readFileSync(f,'utf8')}catch{}}
  const relayUrl=all.match(/wss:\/\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]*)?/i)?.[0]||'';
  const licenseUrl=all.match(/https:\/\/[A-Za-z0-9._:-]+\/api\/licenses\/validate/i)?.[0]||'';
  const discoveredGameIds=uniq(values(all,/(?:GAME_ID|gameId)\s*[:=]\s*['"]([A-Za-z0-9._-]+)['"]/gi));
  const protectedGameIds=uniq([
    ...values(all,/REQUIRE_NOT_LICENSE_SESSION_GAME_IDS\s*[:=]\s*['"]([^'"]+)['"]/gi).flatMap(v=>v.split(/[\s,;]+/)),
    ...values(all,/(?:protectedGameIds|protectedGames|licenseRequiredGameIds)\s*[:=]\s*\[([^\]]+)\]/gi).flatMap(v=>[...v.matchAll(/['"]([A-Za-z0-9._-]+)['"]/g)].map(m=>m[1]))
  ]);
  const gameId=protectedGameIds.length===1?protectedGameIds[0]:'';
  return{relayUrl,licenseUrl,licenseSource:licenseUrl?'repository':'not-found',gameId,protectedGameIds,discoveredGameIds,gameSelectionRequired:protectedGameIds.length!==1};
}
export function resolveSecurityTarget(target,id='target'){
  if(/^https:\/\/github\.com\//i.test(target)){
    const root=path.resolve('.visual-work',`security-${id}`);
    fs.rmSync(root,{recursive:true,force:true});
    execFileSync('git',['clone','--depth=1',target,root],{stdio:'pipe',timeout:60000});
    return{kind:'repo',target,...discover(root)};
  }
  const u=new URL(target);
  if(!['https:','http:'].includes(u.protocol))throw new Error('Somente URLs HTTP/HTTPS são aceitas.');
  const isLicenseEndpoint=/\/api\/licenses\/validate\/?$/i.test(u.pathname);
  if(isLicenseEndpoint)return{kind:'license-api',target,relayUrl:'',licenseUrl:u.href,licenseSource:'direct',gameId:'',protectedGameIds:[],discoveredGameIds:[],gameSelectionRequired:false};
  return{kind:'url',target,relayUrl:'',licenseUrl:'',licenseSource:'not-found',gameId:'',protectedGameIds:[],discoveredGameIds:[],gameSelectionRequired:true};
}
