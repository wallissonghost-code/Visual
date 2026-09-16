import fs from 'node:fs';
import path from 'node:path';

const EXT=new Set(['.html','.css','.js','.jsx','.ts','.tsx']);
const SKIP=new Set(['node_modules','.git','dist','build','.next','coverage','.visual-work']);
function walk(root,out=[]){for(const e of fs.readdirSync(root,{withFileTypes:true})){if(SKIP.has(e.name))continue;const p=path.join(root,e.name);if(e.isDirectory())walk(p,out);else if(EXT.has(path.extname(e.name)))out.push(p)}return out}
function lineOf(text,index){return text.slice(0,index).split(/\r?\n/).length}
function finding(rule,file,line,message,recommendation,confidence=75,severity='low',category='Estrutura',snippet=''){return{severity,bot:'StructureBot',rule,file,line,confidence,category,message,recommendation,snippet,evidenceLevel:confidence>=90?'confirmado':confidence>=75?'forte':'suspeita'}}
function countWord(all,name){const re=new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}\\b`,'g');let n=0;for(const x of all)n+=(x.text.match(re)||[]).length;return n}
export function runStructuralAudit(root){
 const docs=walk(root).map(file=>({file:path.relative(root,file),text:fs.readFileSync(file,'utf8'),ext:path.extname(file)}));
 const out=[];
 // JS/TS declarations referenced only at their declaration are strong dead-code candidates.
 for(const d of docs.filter(x=>/\.[jt]sx?$/.test(x.ext))){const re=/\b(?:function\s+|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g;let m;while((m=re.exec(d.text))){const name=m[1];if(name.length<3||/^(_|module|exports)$/.test(name))continue;const refs=countWord(docs,name);if(refs===1)out.push(finding('UNUSED_DECLARATION',d.file,lineOf(d.text,m.index),`Declaração \`${name}\` não possui outra referência textual no projeto.`,`Confirme chamadas dinâmicas antes de remover \`${name}\`.`,84,'low','Código morto'))}}
 // Duplicate named declarations are much stronger evidence than visual regex matches.
 const declarations=new Map();for(const d of docs.filter(x=>/\.[jt]sx?$/.test(x.ext))){const re=/\b(?:function\s+|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g;let m;while((m=re.exec(d.text))){const a=declarations.get(m[1])||[];a.push({file:d.file,line:lineOf(d.text,m.index)});declarations.set(m[1],a)}}for(const[name,locs]of declarations)if(locs.length>1){const unique=new Set(locs.map(x=>x.file));if(unique.size>1)out.push(finding('DUPLICATE_DECLARATION',locs[0].file,locs[0].line,`\`${name}\` é declarado em ${locs.length} locais: ${locs.map(x=>`${x.file}:${x.line}`).join(', ')}.`,`Verifique se são implementações concorrentes/legadas e mantenha uma única fonte de verdade.`,78,'medium','Duplicação'))}
 // CSS selector overlap across files. Report once per selector, not once per file.
 const selectors=new Map();for(const d of docs.filter(x=>x.ext==='.css')){const re=/(^|})\s*([^@}{][^{}]{0,180})\{/gm;let m;while((m=re.exec(d.text))){for(const raw of m[2].split(',')){const s=raw.trim();if(!s||s.length<2||s.includes('%'))continue;const a=selectors.get(s)||[];a.push({file:d.file,line:lineOf(d.text,m.index)});selectors.set(s,a)}}}for(const[s,locs]of selectors)if(new Set(locs.map(x=>x.file)).size>1)out.push(finding('CSS_SELECTOR_OVERLAP',locs[0].file,locs[0].line,`Seletor \`${s}\` aparece em múltiplos arquivos: ${[...new Set(locs.map(x=>x.file))].join(', ')}.`,`Confira a ordem de carregamento e se alguma regra é legado/sobrescrita desnecessária.`,72,'low','CSS sobreposto'));
 // Exact duplicate non-trivial lines, grouped to avoid report spam.
 const lines=new Map();for(const d of docs){d.text.split(/\r?\n/).forEach((raw,i)=>{const s=raw.trim();if(s.length<80||/^[{});]+$/.test(s))return;const a=lines.get(s)||[];a.push({file:d.file,line:i+1});lines.set(s,a)})}let dupCount=0;for(const[s,locs]of lines){if(locs.length<2||new Set(locs.map(x=>x.file)).size<2)continue;if(dupCount++>=20)break;out.push(finding('DUPLICATE_CODE_LINE',locs[0].file,locs[0].line,`Trecho idêntico encontrado em ${locs.length} locais (${locs.slice(0,4).map(x=>`${x.file}:${x.line}`).join(', ')}).`,'Avalie extrair a lógica/regra para um módulo ou fonte única.',76,'low','Duplicação',s.slice(0,300)))}
 return out;
}
