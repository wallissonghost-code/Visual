import { chromium, webkit } from '@playwright/test';
import path from 'node:path';

const profiles=[
  {name:'desktop',engine:chromium,viewport:{width:1440,height:900}},
  {name:'iphone',engine:webkit,viewport:{width:390,height:844},isMobile:true,hasTouch:true},
  {name:'ipad',engine:webkit,viewport:{width:1024,height:1366},isMobile:true,hasTouch:true}
];
export async function runBrowserAudit(url,work){
  const findings=[];
  for(const p of profiles){
    const browser=await p.engine.launch();
    const page=await browser.newPage({viewport:p.viewport,isMobile:p.isMobile,hasTouch:p.hasTouch});
    const errors=[];
    page.on('console',m=>{if(m.type()==='error') errors.push(m.text())});
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url,{waitUntil:'networkidle',timeout:45000});
    await page.screenshot({path:path.join(work,`${p.name}-initial.png`),fullPage:true});
    const candidates=page.locator('button, [role="tab"], nav a, [data-tab], .tab');
    const count=Math.min(await candidates.count(),30);
    for(let i=0;i<count;i++){
      const el=candidates.nth(i); if(!await el.isVisible().catch(()=>false)) continue;
      const before=await el.evaluate(e=>({c:e.className,a:e.getAttribute('aria-selected'),p:e.getAttribute('aria-pressed')})).catch(()=>null);
      await el.click({timeout:3000}).catch(()=>{}); await page.waitForTimeout(120);
      await page.mouse.click(2,2).catch(()=>{}); await page.waitForTimeout(80);
      const after=await el.evaluate(e=>({c:e.className,a:e.getAttribute('aria-selected'),p:e.getAttribute('aria-pressed')})).catch(()=>null);
      if(before&&after&&JSON.stringify(before)!==JSON.stringify(after) && /(active|selected|true)/i.test(JSON.stringify(after))){
        findings.push({severity:'medium',bot:'InteractionBot',rule:'PERSISTENT_CONTROL_STATE',file:p.name,message:`Controle ${i+1} manteve estado visual/ARIA após perder interação. Pode ser legítimo para a aba atual; requer validação.`,recommendation:'Troque para outra aba e confirme que apenas um controle permanece selecionado; em touch, não use hover como estado persistente.'});
      }
    }
    if(errors.length) findings.push({severity:'high',bot:'RuntimeBot',rule:'BROWSER_ERRORS',file:p.name,message:`${errors.length} erro(s) de runtime/console: ${errors.slice(0,3).join(' | ')}`,recommendation:'Corrija erros JS antes de confiar no estado visual da interface.'});
    await page.screenshot({path:path.join(work,`${p.name}-after.png`),fullPage:true});
    await browser.close();
  }
  return findings;
}
