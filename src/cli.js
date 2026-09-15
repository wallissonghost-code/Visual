import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runStaticAudit } from './static-audit.js';
import { runBrowserAudit } from './browser-audit.js';
import { writeReport } from './report.js';

const args = Object.fromEntries(process.argv.slice(2).map((v,i,a)=>v.startsWith('--') ? [v.slice(2), a[i+1]?.startsWith('--') ? true : a[i+1]] : null).filter(Boolean));
const target = args.target || process.env.VISUAL_TARGET;
const mode = args.mode || (target?.startsWith('http') && !target.includes('github.com') ? 'url' : 'repo');
if (!target) {
  console.error('Uso: npm run audit -- --target <repo GitHub | pasta local | URL> [--mode repo|url]');
  process.exit(2);
}

const work = path.resolve('.visual-work');
fs.mkdirSync(work, { recursive: true });
let findings = [];
let meta = { target, mode, startedAt: new Date().toISOString() };

try {
  if (mode === 'repo') {
    let root = target;
    if (/^https?:\/\/github\.com\//.test(target)) {
      root = path.join(work, 'target');
      fs.rmSync(root, { recursive: true, force: true });
      execFileSync('git', ['clone', '--depth=1', target, root], { stdio: 'inherit' });
    }
    findings.push(...runStaticAudit(root));
    meta.note = 'Auditoria por código: funciona mesmo quando a página publicada exige autenticação.';
  } else {
    findings.push(...await runBrowserAudit(target, work));
    meta.note = 'Auditoria dinâmica: navega, clica, compara estados e testa viewports.';
  }
} catch (error) {
  findings.push({ severity:'critical', bot:'runner', rule:'AUDIT_CRASH', file:'-', message:error.message, recommendation:'Verifique acesso, dependências e configuração do alvo.' });
}

const out = writeReport({ meta, findings });
console.log(`Relatório: ${out}`);
process.exit(findings.some(f=>f.severity==='critical') ? 1 : 0);
