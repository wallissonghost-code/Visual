import fs from 'node:fs';
import path from 'node:path';
export function writeReport({meta,findings}){
  const dir=path.resolve('reports'); fs.mkdirSync(dir,{recursive:true});
  const score=Math.max(0,100-findings.reduce((n,f)=>n+({critical:30,high:15,medium:7,low:2}[f.severity]||1),0));
  const rows=findings.length?findings.map((f,i)=>`## ${i+1}. [${f.severity.toUpperCase()}] ${f.rule}\n- Bot: ${f.bot}\n- Local: \`${f.file}\`\n- Achado: ${f.message}\n- Recomendação: ${f.recommendation}`).join('\n\n'):'## Nenhum achado pelas regras atuais\nIsso não prova ausência de bugs; significa que os detectores atuais não sinalizaram problemas.';
  const md=`# Visual QA Report\n\n**Alvo:** ${meta.target}\n\n**Modo:** ${meta.mode}\n\n**Score heurístico:** ${score}/100\n\n${meta.note||''}\n\n## Resumo\n- Total: ${findings.length}\n- Críticos: ${findings.filter(f=>f.severity==='critical').length}\n- Altos: ${findings.filter(f=>f.severity==='high').length}\n- Médios: ${findings.filter(f=>f.severity==='medium').length}\n\n${rows}\n`;
  const out=path.join(dir,'latest.md'); fs.writeFileSync(out,md); return out;
}
