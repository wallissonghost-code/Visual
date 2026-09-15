import fs from 'node:fs';
import path from 'node:path';

const exts = new Set(['.html','.css','.js','.jsx','.ts','.tsx','.vue','.svelte']);
const skip = new Set(['node_modules','.git','dist','build','.next','coverage','.visual-work']);

function files(root,out=[]){
  for(const e of fs.readdirSync(root,{withFileTypes:true})){
    if(skip.has(e.name)) continue;
    const p=path.join(root,e.name);
    if(e.isDirectory()) files(p,out);
    else if(exts.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

function evidence(text,re){
  const lines=text.split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    re.lastIndex=0;
    if(re.test(lines[i])){
      const start=Math.max(0,i-1);
      const end=Math.min(lines.length,i+2);
      return {
        line:i+1,
        snippet:lines.slice(start,end).map((x,n)=>`${start+n+1}: ${x.trim()}`).join('\n').slice(0,650)
      };
    }
  }
  return null;
}

export function runStaticAudit(root){
  const findings=[];
  for(const file of files(root)){
    const text=fs.readFileSync(file,'utf8');
    const rel=path.relative(root,file);
    const add=(severity,bot,rule,re,message,recommendation,confidence=75,category='Visual')=>{
      const ev=evidence(text,re)||{};
      findings.push({severity,bot,rule,file:rel,line:ev.line||null,snippet:ev.snippet||'',confidence,category,message,recommendation});
    };

    if(/\.active\b|\.selected\b|aria-selected|data-active|classList\.add\(['"](?:active|selected)/i.test(text)&&!/classList\.remove|classList\.toggle|aria-selected[^\n]{0,80}false|set[A-Z]\w*\([^)]*false/i.test(text)) add('high','StateBot','STICKY_SELECTED_STATE',/\.active\b|\.selected\b|aria-selected|data-active|classList\.add\(['"](?:active|selected)/i,'Estado selecionado detectado sem limpeza/toggle evidente no arquivo. Compatível com aba que permanece marcada.','Centralize o estado ativo e remova explicitamente o anterior antes de selecionar outro.',88,'Estado/Interação');
    if(/:hover/.test(text)&&!/@media\s*\([^)]*hover\s*:\s*hover/i.test(text)) add('medium','TouchBot','UNGUARDED_HOVER',/:hover/,'Existe :hover sem proteção de capacidade. Safari touch pode manter aparência de hover após toque.','Restrinja hover com @media (hover:hover) and (pointer:fine).',90,'Touch/iOS');
    if(/position\s*:\s*fixed/i.test(text)&&!/safe-area-inset|100dvh|dvh/i.test(text)) add('medium','ViewportBot','FIXED_IOS_VIEWPORT',/position\s*:\s*fixed/i,'Elemento fixed sem tratamento de viewport/safe-area detectado.','Validar 100dvh e env(safe-area-inset-*).',72,'Responsividade');
    if(/100vh/.test(text)) add('medium','ViewportBot','LEGACY_100VH',/100vh/,'100vh pode gerar corte ou salto com barras do Safari móvel.','Use fallback com 100dvh.',85,'Responsividade');
    if(/outline\s*:\s*(?:none|0)/i.test(text)&&!/:focus-visible/i.test(text)) add('medium','FocusBot','FOCUS_REMOVED',/outline\s*:\s*(?:none|0)/i,'Indicação de foco removida sem focus-visible detectado.','Adicione um estado :focus-visible perceptível.',82,'Acessibilidade/Estado');
    if(/touchstart|pointerdown/i.test(text)&&!/touchend|pointerup|pointercancel/i.test(text)) add('high','TouchBot','INCOMPLETE_POINTER_LIFECYCLE',/touchstart|pointerdown/i,'Interação touch/pointer inicia sem finalização/cancelamento evidente no arquivo.','Trate pointerup/pointercancel e limpe flags/classes transitórias.',86,'Touch/iOS');
    if(/overflow\s*:\s*hidden/i.test(text)) add('low','LayoutBot','OVERFLOW_HIDDEN',/overflow\s*:\s*hidden/i,'overflow:hidden pode esconder conteúdo em telas menores se aplicado a contêiner estrutural.','Confirme que conteúdo importante não é cortado em 320/390/768/1024px.',58,'Layout');
    if(/z-index\s*:\s*\d{4,}/i.test(text)) add('low','LayerBot','EXTREME_Z_INDEX',/z-index\s*:\s*\d{4,}/i,'z-index muito alto pode indicar disputa de camadas/overlays.','Defina uma escala de camadas consistente.',60,'Camadas');
    if(/min-width\s*:\s*(?:[5-9]\d\d|\d{4,})px/i.test(text)) add('medium','ResponsiveBot','LARGE_MIN_WIDTH',/min-width\s*:\s*(?:[5-9]\d\d|\d{4,})px/i,'min-width grande pode causar overflow horizontal em mobile/tablet.','Use largura fluida e breakpoint quando necessário.',80,'Responsividade');
    if(/font-size\s*:\s*(?:[0-9]|1[0-1])px/i.test(text)) add('low','ReadabilityBot','TINY_TEXT',/font-size\s*:\s*(?:[0-9]|1[0-1])px/i,'Texto muito pequeno detectado; pode prejudicar leitura em mobile.','Revise legibilidade e escala tipográfica.',65,'Legibilidade');
  }
  return findings;
}
