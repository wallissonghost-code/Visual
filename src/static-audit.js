import fs from 'node:fs';
import path from 'node:path';

const exts = new Set(['.html','.css','.js','.jsx','.ts','.tsx','.vue','.svelte']);
const skip = new Set(['node_modules','.git','dist','build','.next','coverage']);
function files(root, out=[]) {
  for (const e of fs.readdirSync(root,{withFileTypes:true})) {
    if (skip.has(e.name)) continue;
    const p=path.join(root,e.name);
    if(e.isDirectory()) files(p,out); else if(exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}
export function runStaticAudit(root){
  const findings=[];
  for(const file of files(root)){
    const text=fs.readFileSync(file,'utf8');
    const rel=path.relative(root,file);
    const add=(severity,bot,rule,message,recommendation)=>findings.push({severity,bot,rule,file:rel,message,recommendation});
    if(/\.active\b|\.selected\b|aria-selected|data-active|classList\.add\(['"](?:active|selected)/i.test(text) && !/classList\.remove|classList\.toggle|aria-selected[^\n]{0,80}false|set[A-Z]\w*\([^)]*false/i.test(text))
      add('high','StateBot','STICKY_SELECTED_STATE','Há lógica/estilo de estado selecionado, mas não encontrei uma limpeza/toggle próxima no arquivo. Isso é compatível com aba que fica selecionada permanentemente.','Centralize o estado ativo, remova o estado anterior antes de selecionar outro e teste clique repetido + troca de aba.');
    if(/:hover/.test(text) && !/@media\s*\([^)]*hover\s*:\s*hover/i.test(text))
      add('medium','TouchBot','UNGUARDED_HOVER','Encontrado :hover sem proteção por capacidade de hover. Safari/iPad pode manter estado visual após toque.','Coloque hover dentro de @media (hover:hover) and (pointer:fine) e defina estados touch por :active/focus-visible.');
    if(/position\s*:\s*fixed/i.test(text) && !/safe-area-inset|100dvh|dvh/i.test(text))
      add('medium','ViewportBot','FIXED_IOS_VIEWPORT','Elemento fixed sem sinais de tratamento de viewport/safe-area para iOS/iPadOS.','Validar 100dvh e env(safe-area-inset-*), especialmente barras inferiores e overlays.');
    if(/100vh/.test(text))
      add('medium','ViewportBot','LEGACY_100VH','Uso de 100vh pode gerar corte/salto com barras do Safari móvel.','Prefira 100dvh com fallback controlado.');
    if(/outline\s*:\s*none|outline\s*:\s*0/i.test(text) && !/:focus-visible/i.test(text))
      add('medium','FocusBot','FOCUS_REMOVED','Outline removido sem focus-visible detectado.','Mantenha indicação de foco por teclado e evite confundir foco persistente com seleção.');
    if(/touchstart|pointerdown/i.test(text) && !/touchend|pointerup|pointercancel/i.test(text))
      add('high','TouchBot','INCOMPLETE_POINTER_LIFECYCLE','Há início de interação touch/pointer sem finalização/cancelamento no mesmo arquivo.','Trate pointerup/pointercancel e limpe classes/flags transitórias.');
  }
  return findings;
}
