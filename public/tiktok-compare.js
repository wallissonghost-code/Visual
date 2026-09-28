const $=s=>document.querySelector(s);
const SAVED_LINKS_KEY='visual:tiktok-compare-links:v1';
function loadSavedLinks(){try{const v=JSON.parse(localStorage.getItem(SAVED_LINKS_KEY)||'{}');if(v.a)$('#a').value=v.a;if(v.b)$('#b').value=v.b}catch{}}
function saveLinks(){localStorage.setItem(SAVED_LINKS_KEY,JSON.stringify({a:$('#a').value.trim(),b:$('#b').value.trim()}))}
loadSavedLinks();
$('#a').addEventListener('input',saveLinks);
$('#b').addEventListener('input',saveLinks);
function yn(v){return v?'SIM':'não'}
function fmt(d){
 const o=[],one=(x,n)=>{o.push(n);o.push('Entrada: '+x.input);o.push('Final: '+x.finalUrl);o.push('HTTP: '+(x.status??'-')+' | HTML: '+x.htmlBytes+' bytes');o.push('Perfil: @'+(x.username||'-')+' | Video ID: '+(x.id||'-')+' | ID no HTML: '+x.idOccurrences+'x');o.push('Canonical: '+(x.canonical||'-'));o.push('Marcadores: '+Object.entries(x.markers).filter(([,v])=>v).map(([k])=>k).join(', ')||'nenhum');o.push('')};
 one(d.a,'A · CONTROLE');one(d.b,'B · INVESTIGADO');
 o.push('COMPARAÇÃO');o.push('Mesmo HTTP: '+yn(d.diff.sameHttpStatus));o.push('Ambos resolveram Video ID: '+yn(d.diff.bothHaveVideoId));o.push('Mesmo perfil: '+yn(d.diff.sameUsername));o.push('Delta HTML B-A: '+d.diff.htmlSizeDelta+' bytes');o.push('Delta ocorrências do ID B-A: '+d.diff.idOccurrenceDelta);o.push('');
 o.push('MARCADORES');for(const [k,v] of Object.entries(d.diff.markerDiff))o.push((v.same?'= ':'≠ ')+k+'  A:'+yn(v.a)+'  B:'+yn(v.b));
 o.push('');
 const diag=(x,label)=>{const q=x.diagnostics;if(!q)return;o.push(label+' · DIAGNÓSTICO PROFUNDO');o.push('video-detail ocorrências: '+(q.videoDetail?.occurrences||0));for(const hit of q.videoDetail?.contexts||[]){o.push('• offset '+hit.offset);o.push('  '+hit.context)}o.push('UNIVERSAL_DATA: '+(q.universal?.found?'encontrado':'não')+' | JSON: '+(q.universal?.parsed?'válido':'não analisado'));if(q.universal?.topKeys?.length)o.push('Top keys: '+q.universal.topKeys.join(', '));if(q.universal?.paths?.length){o.push('Paths relacionados:');for(const p of q.universal.paths)o.push('  ↳ '+p)}if(q.universal?.videoIdPaths?.length){o.push('IDs de vídeo encontrados no JSON:');for(const v of q.universal.videoIdPaths)o.push('  ↳ '+v.path+' = '+v.value)}if(q.videoId?.contexts?.length){o.push('Contexto do Video ID:');for(const hit of q.videoId.contexts)o.push('  • '+hit.context)}o.push('')};
 diag(d.a,'A');diag(d.b,'B');
 o.push('Nota: '+d.note);return o.join('\n')
}
$('#run').onclick=async()=>{const a=$('#a').value.trim(),b=$('#b').value.trim();if(!a||!b)return alert('Cole os dois links do TikTok.');$('#run').disabled=true;$('#status').classList.remove('hidden');$('#result').classList.add('hidden');try{const r=await fetch('/api/tiktok/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a,b})});const d=await r.json();if(!r.ok)throw Error(d.error||'Falha');$('#report').textContent=fmt(d);$('#badge').textContent='CONCLUÍDO';$('#result').classList.remove('hidden')}catch(e){$('#report').textContent='Falha: '+e.message;$('#badge').textContent='FALHOU';$('#result').classList.remove('hidden')}finally{$('#run').disabled=false;$('#status').classList.add('hidden')}};
