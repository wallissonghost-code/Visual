const $=s=>document.querySelector(s);
function yn(v){return v?'SIM':'não'}
function fmt(d){
 const o=[],one=(x,n)=>{o.push(n);o.push('Entrada: '+x.input);o.push('Final: '+x.finalUrl);o.push('HTTP: '+(x.status??'-')+' | HTML: '+x.htmlBytes+' bytes');o.push('Perfil: @'+(x.username||'-')+' | Video ID: '+(x.id||'-')+' | ID no HTML: '+x.idOccurrences+'x');o.push('Canonical: '+(x.canonical||'-'));o.push('Marcadores: '+Object.entries(x.markers).filter(([,v])=>v).map(([k])=>k).join(', ')||'nenhum');o.push('')};
 one(d.a,'A · CONTROLE');one(d.b,'B · INVESTIGADO');
 o.push('COMPARAÇÃO');o.push('Mesmo HTTP: '+yn(d.diff.sameHttpStatus));o.push('Ambos resolveram Video ID: '+yn(d.diff.bothHaveVideoId));o.push('Mesmo perfil: '+yn(d.diff.sameUsername));o.push('Delta HTML B-A: '+d.diff.htmlSizeDelta+' bytes');o.push('Delta ocorrências do ID B-A: '+d.diff.idOccurrenceDelta);o.push('');
 o.push('MARCADORES');for(const [k,v] of Object.entries(d.diff.markerDiff))o.push((v.same?'= ':'≠ ')+k+'  A:'+yn(v.a)+'  B:'+yn(v.b));
 o.push('');o.push('Nota: '+d.note);return o.join('\n')
}
$('#run').onclick=async()=>{const a=$('#a').value.trim(),b=$('#b').value.trim();if(!a||!b)return alert('Cole os dois links do TikTok.');$('#run').disabled=true;$('#status').classList.remove('hidden');$('#result').classList.add('hidden');try{const r=await fetch('/api/tiktok/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({a,b})});const d=await r.json();if(!r.ok)throw Error(d.error||'Falha');$('#report').textContent=fmt(d);$('#badge').textContent='CONCLUÍDO';$('#result').classList.remove('hidden')}catch(e){$('#report').textContent='Falha: '+e.message;$('#badge').textContent='FALHOU';$('#result').classList.remove('hidden')}finally{$('#run').disabled=false;$('#status').classList.add('hidden')}};
