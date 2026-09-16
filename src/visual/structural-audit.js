import fs from 'node:fs';
import path from 'node:path';

const EXT=new Set(['.html','.css','.js','.jsx','.ts','.tsx']);
const SKIP=new Set(['node_modules','.git','dist','build','.next','coverage','.visual-work']);
function walk(root,out=[]){for(const e of fs.readdirSync(root,{withFileTypes:true})){if(SKIP.has(e.name))continue;const p=path.join(root,e.name);if(e.isDirectory())walk(p,out);else if(EXT.has(path.extname(e.name)))out.push(p)}return out}
function lineOf(text,index){return text.slice(0,index).split(/\r?\n/).length}
function finding(rule,file,line,message,recommendation,confidence=75,severity='low',category='Estrutura',snippet=''){return{severity,bot:'StructureBot',rule,file,line,confidence,category,message,recommendation,snippet,evidenceLevel:confidence>=90?'confirmado':confidence>=75?'forte':'suspeita'}}
function escapeRegExp(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}
function countWord(all,name){const re=new RegExp(`\\b${escapeRegExp(name)}\\b`,'g');let n=0;for(const x of all)n+=(x.text.match(re)||[]).length;return n}
function namedDeclarations(d){const out=[];const patterns=[
 {kind:'function',re:/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g},
 {kind:'class',re:/\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g},
 {kind:'export',re:/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g}
];for(const p of patterns){let m;while((m=p.re.exec(d.text)))out.push({name:m[1],kind:p.kind,file:d.file,line:lineOf(d.text,m.index),index:m.index})}return out}
export function runStructuralAudit(root){
 const docs=walk(root).map(file=>({file:path.relative(root,file),text:fs.readFileSync(file,'utf8'),ext:path.extname(file)}));
 const jsDocs=docs.filter(x=>/\.[jt]sx?$/.test(x.ext)),out=[];
 // Dead-code candidates: named functions/classes and exported bindings only. Local variables are intentionally excluded.
 for(const d of jsDocs)for(const decl of namedDeclarations(d)){const{name}=decl;if(name.length<3||/^(_|module|exports)$/.test(name))continue;const refs=countWord(docs,name);if(refs===1)out.push(finding('UNUSED_DECLARATION',d.file,decl.line,`Declaração ${decl.kind} \`${name}\` não possui outra referência textual no projeto.`,`Confirme exports, registro por nome e chamadas dinâmicas antes de remover \`${name}\`.`,82,'low','Código morto'))}
 // Duplicate declarations are meaningful only for module-level named functions/classes/exports. Common local variable names are not duplication.
 const declarations=new Map();for(const d of jsDocs)for(const decl of namedDeclarations(d)){const a=declarations.get(decl.name)||[];a.push(decl);declarations.set(decl.name,a)}for(const[name,locs]of declarations){const files=[...new Set(locs.map(x=>x.file))];if(files.length<2)continue;const kinds=[...new Set(locs.map(x=>x.kind))];out.push(finding('DUPLICATE_NAMED_API',locs[0].file,locs[0].line,`Símbolo nomeado \`${name}\` (${kinds.join('/')}) existe em ${files.length} arquivos: ${locs.map(x=>`${x.file}:${x.line}`).join(', ')}.`,`Compare responsabilidade, imports e consumidores antes de consolidar; nomes iguais em módulos diferentes ainda podem ser intencionais.`,72,'low','Duplicação'))}
 // CSS selector overlap across files. This is potential cascade overlap, not a confirmed duplicate.
 const selectors=new Map();for(const d of docs.filter(x=>x.ext==='.css')){const re=/(^|})\s*([^@}{][^{}]{0,180})\{/gm;let m;while((m=re.exec(d.text))){for(const raw of m[2].split(',')){const s=raw.trim();if(!s||s.length<2||s.includes('%'))continue;const a=selectors.get(s)||[];a.push({file:d.file,line:lineOf(d.text,m.index)});selectors.set(s,a)}}}for(const[s,locs]of selectors)if(new Set(locs.map(x=>x.file)).size>1)out.push(finding('CSS_SELECTOR_OVERLAP',locs[0].file,locs[0].line,`Seletor \`${s}\` aparece em múltiplos arquivos: ${[...new Set(locs.map(x=>x.file))].join(', ')}.`,`Confira a ordem de carregamento e se alguma regra é legado/sobrescrita desnecessária.`,68,'low','CSS sobreposto'));
 // Exact duplicate non-trivial lines. Ignore imports/exports, comments and obvious declarations/config to reduce boilerplate noise.
 const lines=new Map();for(const d of docs){d.text.split(/\r?\n/).forEach((raw,i)=>{const s=raw.trim();if(s.length<100||/^[{});]+$/.test(s)||/^(?:\/\/|\/\*|\*|import\b|export\b|(?:const|let|var)\s+[\w$]+\s*=)/.test(s))return;const a=lines.get(s)||[];a.push({file:d.file,line:i+1});lines.set(s,a)})}let dupCount=0;for(const[s,locs]of lines){if(locs.length<2||new Set(locs.map(x=>x.file)).size<2)continue;if(dupCount++>=20)break;out.push(finding('DUPLICATE_CODE_LINE',locs[0].file,locs[0].line,`Trecho idêntico encontrado em ${locs.length} locais (${locs.slice(0,4).map(x=>`${x.file}:${x.line}`).join(', ')}).`,'Avalie se o trecho representa lógica repetida antes de extrair para uma fonte única.',72,'low','Duplicação',s.slice(0,300)))}
 return out;
}
