import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
function gitSha(){try{return execFileSync('git',['rev-parse','--short=8','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{return process.env.RENDER_GIT_COMMIT?.slice(0,8)||process.env.GIT_COMMIT?.slice(0,8)||'unknown'}}
export const VISUAL_VERSION=pkg.version;
export const VISUAL_BUILD=gitSha();
export function visualBuildInfo(){return{module:'Visual Bot',version:VISUAL_VERSION,build:VISUAL_BUILD}}
