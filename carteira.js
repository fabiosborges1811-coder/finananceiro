// Carteira: posições manuais por usuário e exercício, sem movimentar o fluxo de caixa.
let carteira=[],cartEdit=null,cartSeq=0,cartBusy=false,cartLoaded=false,cartMovimentos=[],movLimite=100,movBusy=false,movChave=null;
let carteiraVisual='cards';
const cartCategorias={banco:'Banco',poupanca:'Poupança',acoes:'Ações',fiis:'FIIs',cripto:'Criptomoedas',renda_fixa:'Renda Fixa',fundos:'Fundos',outros:'Outros'};
function cartMensagem(msg){g('cartStatus').textContent=msg;}
function limparCarteira(){cartSeq++;carteira=[];cartMovimentos=[];cartLoaded=false;cancelarAtivo();renderCarteira();}
function cancelarAtivo(){cartEdit=null;g('cartForm').reset();g('cartCancel').hidden=true;g('cartSave').textContent='+ Adicionar';if(g('cartEditor'))g('cartEditor').open=false;if(g('cartEditorTitle'))g('cartEditorTitle').textContent='Adicionar uma aplicação';}
async function loadCarteira(){
  const seq=++cartSeq,uid=currentUser?.id,ano=anoAtual;
  carteira=[];cartMovimentos=[];cartLoaded=false;renderCarteira();
  if(!sb||!uid){cartMensagem('Entre na sua conta para carregar a carteira.');return;}
  cartMensagem('Carregando carteira…');
  try{
    const {data,error}=await sb.rpc('consultar_carteira',{p_ano:ano});
    if(seq!==cartSeq||uid!==currentUser?.id||ano!==anoAtual)return;
    if(error)throw error;
    carteira=data?.ativos||[];cartMovimentos=data?.movimentos||[];cartLoaded=true;cartMensagem('');renderCarteira();
  }catch(e){if(seq!==cartSeq)return;console.error('Carteira',e);cartMensagem('Não foi possível carregar. Confira a conexão e execute carteira-movimentacoes.sql (após as migrações anteriores) no SQL Editor do Supabase. Depois clique em Atualizar dados.');}
}
function renderCarteira(){
  if(typeof atualizarOrigemRendimento==='function')atualizarOrigemRendimento();
  g('cartAno').textContent='Exercício '+anoAtual;
  const base=carteira.reduce((s,a)=>s+Number(a.investido),0),atual=carteira.reduce((s,a)=>s+Number(a.atual),0),dif=atual-base;
  g('cartTotalInvestido').textContent=cartLoaded?fmt(base):'—';
  g('cartTotalAtual').textContent=cartLoaded?fmt(atual):'—';
  g('cartRendimento').textContent=cartLoaded?fmt(dif)+(base>0?' · '+((dif/base)*100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%':' · % indisponível'):'—';
  g('tbCarteira').innerHTML=carteira.map((a,i)=>{
    const b=Number(a.investido),v=Number(a.atual),pct=b>0?((v-b)/b*100).toLocaleString('pt-BR',{maximumFractionDigits:2})+'%':'—';
    return `<tr><td>${escHtml(a.nome)}<small class="cart-kind">${a.tipo==='conta'?'Conta / Caixa':'Investimento'}</small></td><td>${escHtml(cartCategorias[a.categoria]||a.categoria)}</td><td class="priv">${fmt(b)}</td><td class="priv">${fmt(v)}</td><td class="priv">${pct}</td><td><button class="btn-ghost" onclick="verHistoricoAtivo(${i})">Histórico</button> <button class="btn-ghost" onclick="editarAtivo(${i})">Editar</button> <button class="btn-ghost danger" onclick="excluirAtivo(${i})">Excluir</button></td></tr>`;
  }).join('')||`<tr><td colspan="6">${cartLoaded?'Nenhum ativo cadastrado neste exercício.':'Carteira não carregada.'}</td></tr>`;
  g('tfCarteira').innerHTML='';renderCarteiraVisual();renderMovimentacoes();renderDistribuicaoCarteira();applyPrivacy();
}
function editarAtivo(i){
  if(cartBusy)return;
  document.querySelectorAll('.asset-menu[open]').forEach(e=>e.open=false);
  const a=carteira[i];if(!a)return;
  cartEdit={id:a.id,uid:currentUser.id,ano:anoAtual,updated_at:a.updated_at};
  g('cartNome').value=a.nome;g('cartTipo').value=a.tipo;g('cartCategoria').value=a.categoria;
  g('cartInvestido').value=a.investido;g('cartAtual').value=a.atual;
  g('cartEditor').open=true;g('cartEditorTitle').textContent='Editar aplicação';g('cartEditor').scrollIntoView({behavior:'smooth',block:'start'});g('cartSave').textContent='Salvar alterações';g('cartCancel').hidden=false;g('cartNome').focus();
}
async function salvarAtivo(){
  if(cartBusy)return;
  if(!sb||!currentUser||!cartLoaded){toast('Carregue a carteira antes de salvar');return;}
  if(!g('cartForm').reportValidity())return;
  const nome=g('cartNome').value.trim(),investido=Number(g('cartInvestido').value),atual=Number(g('cartAtual').value);
  if(!nome||![investido,atual].every(v=>Number.isFinite(v)&&v>=0)){toast('Informe nome e valores válidos');return;}
  const uid=currentUser.id,ano=anoAtual,edit=cartEdit;
  if(edit&&(edit.uid!==uid||edit.ano!==ano)){cancelarAtivo();return;}
  const payload={user_id:uid,ano,nome,tipo:g('cartTipo').value,categoria:g('cartCategoria').value,investido,atual,updated_at:new Date().toISOString()};
  cartBusy=true;g('cartSave').disabled=true;
  try{
    const query=edit?sb.from('cap_carteira').update(payload).eq('id',edit.id).eq('user_id',uid).eq('ano',ano).eq('updated_at',edit.updated_at):sb.from('cap_carteira').insert(payload);
    const {data,error}=await query.select('id');if(error)throw error;if(!data?.length)throw new Error('O saldo mudou em outra operação. Atualize os dados e tente novamente.');
    if(uid===currentUser?.id&&ano===anoAtual){cancelarAtivo();await loadCarteira();toast('Ativo salvo');}
  }catch(e){console.error(e);toast(e.message||'Erro ao salvar. Os dados do formulário foram mantidos.');}
  finally{cartBusy=false;g('cartSave').disabled=false;}
}
async function excluirAtivo(i){
  if(cartBusy)return;const a=carteira[i];if(!a||!currentUser)return;
  if(Number(a.atual)!==0||Number(a.investido)!==0){toast('Transfira ou resgate todo o saldo antes de excluir a aplicação.');return;}if(!confirm('Excluir “'+a.nome+'”? O histórico será preservado.'))return;
  const uid=currentUser.id,ano=anoAtual;cartBusy=true;
  try{
    const {data,error}=await sb.from('cap_carteira').delete().eq('id',a.id).eq('user_id',uid).eq('ano',ano).select('id');
    if(error)throw error;if(!data?.length)throw new Error('Registro não excluído');
    if(uid===currentUser?.id&&ano===anoAtual){if(cartEdit?.id===a.id)cancelarAtivo();await loadCarteira();toast('Ativo excluído');}
  }catch(e){console.error(e);toast(e.message||'Não foi possível excluir o ativo');}finally{cartBusy=false;}
}
let moreFocus=null;
function abrirMais(){moreFocus=document.activeElement;g('moreOverlay').classList.add('open');g('moreOverlay').querySelector('button').focus();}
function fecharMais(){g('moreOverlay').classList.remove('open');moreFocus?.focus();}
function fecharMaisFora(e){if(e.target===g('moreOverlay'))fecharMais();}
document.addEventListener('keydown',e=>{if(!g('moreOverlay').classList.contains('open'))return;if(e.key==='Escape')fecharMais();if(e.key==='Tab'){const b=[...g('moreOverlay').querySelectorAll('button')],first=b[0],last=b[b.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});

// Gráfico SVG sem dependências de rede. Cores consistentes com a legenda.
function renderDistribuicaoCarteira(){
  const el=g('cartDistribuicao');if(!el)return;
  if(!cartLoaded){el.innerHTML='<p class="field-help">Carregue a carteira para ver a distribuição.</p>';return;}
  const items=carteira.filter(a=>Number(a.atual)>0).slice().sort((a,b)=>Number(b.atual)-Number(a.atual));
  const total=items.reduce((s,a)=>s+Number(a.atual),0);
  if(!total){el.innerHTML='<p class="field-help">O gráfico aparece quando uma aplicação tiver saldo maior que zero. Cadastre um saldo ou vincule uma receita à carteira.</p>';return;}
  const colors=['#228b4f','#4a70c8','#c89428','#8250d2','#c04b4b','#239b9b','#db7093','#6a7a8a'];
  const circumference=2*Math.PI*76;let offset=0;
  const arcs=items.map((a,i)=>{const length=Number(a.atual)/total*circumference;const svg=`<circle cx="110" cy="110" r="76" fill="none" stroke="${colors[i%colors.length]}" stroke-width="28" stroke-dasharray="${length} ${circumference}" stroke-dashoffset="${-offset}" transform="rotate(-90 110 110)"/>`;offset+=length;return svg;}).join('');
  el.innerHTML=`<div class="cart-donut priv"><svg viewBox="0 0 220 220" role="img" aria-label="Distribuição dos saldos por aplicação. Valores detalhados na legenda.">${arcs}<text x="110" y="101" text-anchor="middle" class="cart-chart-label">Total na carteira</text><text x="110" y="126" text-anchor="middle" class="cart-chart-total">${escHtml(fmt(total))}</text></svg></div><ul class="cart-chart-legend">${items.map((a,i)=>{const pct=(Number(a.atual)/total*100).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1});return `<li><span class="cart-color" style="background:${colors[i%colors.length]}"></span><span class="cart-chart-name">${escHtml(a.nome)}</span><strong class="priv">${escHtml(fmt(Number(a.atual)))}</strong><span class="priv cart-chart-pct">${pct}%</span></li>`;}).join('')}</ul>`;
}

const movNomes={abertura:'Posição inicial',aporte:'Aporte / estorno',rendimento:'Rendimento / estorno',retirada:'Retirada externa',resgate:'Resgate externo',transferencia:'Transferência',ajuste:'Ajuste manual'};
function cartOpcao(el,lista,placeholder){
  const value=el.value;el.innerHTML=`<option value="">${placeholder}</option>`+lista.map(a=>`<option value="${escHtml(a.id)}">${escHtml(a.nome)}</option>`).join('');
  if(lista.some(a=>a.id===value))el.value=value;
}
function renderMovimentacoes(){
  // At render inicial o arquivo ainda está executando: nomes são resolvidos no uso posterior.
  cartOpcao(g('movOrigem'),carteira,'Selecione uma aplicação');
  cartOpcao(g('movDestino'),carteira,g('movTipo').value==='resgate'?'Fora da carteira':'Selecione o destino');
  const nomes=new Map(carteira.map(a=>[a.id,a.nome]));
  cartMovimentos.forEach(m=>{if(!nomes.has(m.carteira_id||m.carteira_nome))nomes.set(m.carteira_id||m.carteira_nome,m.carteira_nome+' (histórico)');});
  cartOpcao(g('movFiltroAtivo'),[...nomes].map(([id,nome])=>({id,nome})),'Todas as aplicações');
  const data=g('movData'),ano=String(anoAtual);
  data.min=ano+'-01-01';data.max=ano+'-12-31';
  if(!data.value||!data.value.startsWith(ano+'-')){const hoje=new Date();data.value=hoje.getFullYear()===anoAtual?`${ano}-${String(hoje.getMonth()+1).padStart(2,'0')}-${String(hoje.getDate()).padStart(2,'0')}`:ano+'-01-01';}
  g('movSave').disabled=!cartLoaded||movBusy;
  atualizarFormMovimento();renderResumoMovimentos();filtrarMovimentos();
}
function atualizarFormMovimento(){
  const t=g('movTipo').value,d=g('movDestino');g('movDestinoField').hidden=!['transferencia','resgate'].includes(t);d.required=t==='transferencia';
  if(d.options?.length)d.options[0].textContent=t==='resgate'?'Fora da carteira':'Selecione o destino';
  g('movOrigemLabel').textContent=['aporte','rendimento'].includes(t)?'Em qual aplicação?':'De qual aplicação?';
  const msgs={transferencia:'Move saldo e base proporcional entre duas aplicações. Não cria receita nem despesa e não altera o total da carteira.',retirada:'Sai dinheiro para fora da carteira. Não registra uma despesa automaticamente; você pode registrá-la separadamente se houve um gasto.',resgate:'Escolha outra conta da carteira para um resgate interno ou “Fora da carteira” para uma saída externa. Resgatar não é uma nova receita.',aporte:'Entrada manual de dinheiro: aumenta saldo e valor colocado. Se já registrou uma receita vinculada, não registre este aporte novamente.',rendimento:'Aumenta somente o saldo e os rendimentos registrados. Se já lançou uma receita vinculada, não repita aqui.'};
  g('movAjuda').textContent=msgs[t]||'';atualizarPreviaMovimento();
}
function renderResumoMovimentos(){
  const sum=(k,f)=>cartMovimentos.filter(m=>k.includes(m.tipo)).reduce((s,m)=>s+f(m),0);
  const initial=sum(['abertura'],m=>Number(m.delta_saldo));
  const deposits=sum(['aporte'],m=>Number(m.delta_base));
  const yields=sum(['rendimento','aporte'],m=>Number(m.delta_saldo)-Number(m.delta_base));
  const withdrawals=-sum(['retirada','resgate'],m=>Number(m.delta_saldo));
  const adjustments=sum(['ajuste'],m=>Number(m.delta_saldo));
  const realized=sum(['retirada','resgate'],m=>Number(m.delta_base)-Number(m.delta_saldo));
  const fields=[['Posição inicial',initial],['Aportes líquidos de estornos',deposits],['Rendimentos registrados',yields],['Retiradas e resgates externos',withdrawals],['Ajustes no saldo',adjustments],['Resultado realizado em saídas¹',realized]];
  g('cartAportesVis').textContent=cartLoaded?fmt(deposits):'—';g('cartRendVis').textContent=cartLoaded?fmt(yields):'—';g('cartSaidasVis').textContent=cartLoaded?fmt(withdrawals):'—';
  g('movResumo').innerHTML=fields.map(([n,v])=>`<div class="mov-num"><span>${n}</span><strong class="priv">${cartLoaded?escHtml(fmt(v)):'—'}</strong></div>`).join('')+'<p class="field-help mov-formula">Saldo = posição inicial + aportes + rendimentos − saídas + ajustes.<br>¹Diferença entre o valor retirado e a base proporcional retirada, já embutida na saída. Não some novamente ao saldo. Não é apuração fiscal.</p>';
}
function filtrarMovimentos(){
  const ativo=g('movFiltroAtivo').value,tipo=g('movFiltroTipo').value;
  const rows=cartMovimentos.filter(m=>(!ativo||(m.carteira_id||m.carteira_nome)===ativo)&&(!tipo||m.tipo===tipo));
  g('movHistorico').innerHTML=rows.slice(0,movLimite).map(m=>{
    const delta=Number(m.delta_saldo),date=m.data?m.data.split('-').reverse().join('/'):'—';
    const cls=m.tipo==='transferencia'?'transfer':m.tipo==='ajuste'?'adjust':delta>0?'in':delta<0?'out':'neutral';
    const icon=m.tipo==='transferencia'?'⇄':m.tipo==='ajuste'?'≈':delta>0?'↙':delta<0?'↗':'•';
    const amount=(delta>0?'+ ':delta<0?'− ':'')+fmt(Math.abs(delta));
    return `<tr><td class="history-date">${escHtml(date)}</td><td><span class="movement-badge movement-${cls}"><span aria-hidden="true">${icon}</span> ${escHtml(movNomes[m.tipo]||m.tipo)}</span></td><td class="history-asset">${escHtml(m.carteira_nome)}</td><td class="priv history-amount movement-text-${cls}">${escHtml(amount)}</td><td class="priv history-balance">${escHtml(fmt(Number(m.saldo_apos)))}</td><td><details class="movement-details"><summary>${escHtml(m.descricao||'Ver detalhes')}</summary><p>Código ${escHtml(m.grupo)}<br><span class="priv">Variação da base: ${escHtml(fmt(Number(m.delta_base)))}</span></p></details></td></tr>`;
  }).join('')||`<tr><td colspan="6">${cartLoaded?'Nenhuma movimentação neste filtro.':'Carregue a carteira para consultar o histórico.'}</td></tr>`;
  g('movMais').hidden=rows.length<=movLimite;applyPrivacy();
}
function maisMovimentos(){movLimite+=100;filtrarMovimentos();}
function verHistoricoAtivo(i){const a=carteira[i];if(!a)return;g('movFiltroAtivo').value=a.id;g('movFiltroTipo').value='';movLimite=100;filtrarMovimentos();g('movHistorico').closest('.card').scrollIntoView({behavior:'smooth'});}
async function salvarMovimento(){
  if(movBusy||!sb||!currentUser||!cartLoaded)return;
  if(!g('movForm').reportValidity())return;
  const origem=carteira.find(a=>a.id===g('movOrigem').value),t=g('movTipo').value,valor=Number(g('movValor').value),destino=g('movDestino').value;
  if(!origem||!Number.isFinite(valor)||valor<=0||Math.abs(valor*100-Math.round(valor*100))>0.00001){toast('Informe aplicação e valor válido com até duas casas decimais');return;}
  const tipo=t==='resgate'&&destino?'transferencia':t;
  if(tipo==='transferencia'&&(!destino||destino===origem.id)){toast('Escolha uma aplicação de destino diferente');return;}
  if(['retirada','resgate','transferencia'].includes(tipo)&&valor>Number(origem.atual)){toast('Saldo insuficiente na aplicação de origem');return;}
  const uid=currentUser.id,ano=anoAtual;
  const descricao=(t==='resgate'&&destino?'Resgate interno: ':'')+g('movDescricao').value.trim();
  if(descricao.length>240){toast('Reduza a descrição para até 220 caracteres');return;}
  const payload={p_tipo:tipo,p_origem:origem.id,p_destino:tipo==='transferencia'?destino:null,p_valor:valor,p_data:g('movData').value,p_descricao:descricao};
  if(!confirm(`${movNomes[t]||t}: ${fmt(valor)} em ${origem.nome}${tipo==='transferencia'?' → '+(carteira.find(a=>a.id===destino)?.nome||''):''}. Confirmar?`))return;
  // Mesma chave em repetição idêntica após erro de rede: evita repetir o débito.
  const assinatura=JSON.stringify({uid,...payload});
  if(movChave?.assinatura!==assinatura)movChave={assinatura,id:crypto.randomUUID()};
  movBusy=true;g('movSave').disabled=true;g('movStatus').textContent='Salvando movimentação…';
  try{
    const {error}=await sb.rpc('movimentar_carteira',{...payload,p_chave:movChave.id});if(error)throw error;
    movChave=null;
    if(uid===currentUser?.id&&ano===anoAtual){g('movValor').value='';g('movDescricao').value='';await loadCarteira();g('movStatus').textContent='Movimentação registrada. Saldos e histórico atualizados.';}
  }catch(e){console.error(e);g('movStatus').textContent=e.message||'Não foi possível salvar. Confira a conexão e a migração carteira-movimentacoes.sql.';}
  finally{movBusy=false;g('movSave').disabled=!cartLoaded;}
}



// Apresentação: cartões, formulários recolhidos e prévia; não movimenta valores.
function abrirEditorCarteira(){
  cancelarAtivo();g('cartEditor').open=true;g('cartEditor').scrollIntoView({behavior:'smooth',block:'start'});g('cartNome').focus({preventScroll:true});
}
function abrirMovimentacao(i=null){
  g('movEditor').open=true;
  if(i!==null&&carteira[i])g('movOrigem').value=carteira[i].id;
  atualizarPreviaMovimento();g('movEditor').scrollIntoView({behavior:'smooth',block:'start'});g('movTipo').focus({preventScroll:true});
}
function setCarteiraView(view){
  carteiraVisual=view==='table'?'table':'cards';
  g('cartTableView').hidden=carteiraVisual!=='table';g('cartCards').hidden=carteiraVisual!=='cards';
  for(const [id,on] of [['cartViewCards',carteiraVisual==='cards'],['cartViewTable',carteiraVisual==='table']]){g(id).classList.toggle('on',on);g(id).setAttribute('aria-pressed',String(on));}
}
function renderCarteiraVisual(){
  const total=carteira.reduce((n,a)=>n+Number(a.atual),0);
  g('cartMeta').textContent=cartLoaded?`${carteira.length} ${carteira.length===1?'conta ou aplicação':'contas e aplicações'} · Exercício ${anoAtual}`:'Carregue suas aplicações para começar';
  g('cartCount').textContent=cartLoaded?`${carteira.length} ${carteira.length===1?'aplicação para acompanhar':'aplicações para acompanhar'}`:'Seus saldos em uma visão organizada';
  if(!cartLoaded){g('cartCards').innerHTML='<div class="wallet-empty"><span class="wallet-empty-symbol" aria-hidden="true">◌</span><h3>Sua carteira começa aqui</h3><p>Entre na sua conta e carregue os dados para acompanhar suas aplicações.</p></div>';}
  else if(!carteira.length){g('cartCards').innerHTML='<div class="wallet-empty"><span class="wallet-empty-symbol" aria-hidden="true">＋</span><h3>Um lugar para cada parte do seu dinheiro.</h3><p>Cadastre uma conta ou investimento e comece a acompanhar seus saldos.</p><button class="btn-primary" onclick="abrirEditorCarteira()">Adicionar primeira aplicação</button></div>';}
  else g('cartCards').innerHTML=carteira.map((a,i)=>{
    const value=Number(a.atual),base=Number(a.investido),result=value-base,share=total>0?value/total*100:0;
    const initial=Array.from(String(a.nome).trim()).slice(0,2).join('').toLocaleUpperCase('pt-BR');
    const resultText=(result>0?'+ ':'')+fmt(result);
    return `<article class="wallet-asset"><div class="wallet-asset-top"><span class="wallet-monogram" aria-hidden="true">${escHtml(initial)}</span><div><h3>${escHtml(a.nome)}</h3><span>${escHtml(cartCategorias[a.categoria]||a.categoria)} · ${a.tipo==='conta'?'Conta':'Investimento'}</span></div><details class="asset-menu"><summary aria-label="Opções de ${escHtml(a.nome)}">⋯</summary><div><button onclick="editarAtivo(${i})">Editar aplicação</button><button class="danger" onclick="excluirAtivo(${i})">Excluir aplicação</button></div></details></div><span class="wallet-asset-label">Saldo atual</span><strong class="wallet-asset-value priv">${escHtml(fmt(value))}</strong><div class="wallet-asset-result"><span>Resultado no saldo</span><strong class="priv ${result>=0?'movement-text-in':'movement-text-out'}">${escHtml(resultText)}</strong></div><div class="wallet-share-label"><span>Participação na carteira</span><strong class="priv">${share.toLocaleString('pt-BR',{maximumFractionDigits:1})}%</strong></div><div class="wallet-share-track priv"><span style="width:${Math.min(100,Math.max(0,share))}%"></span></div><div class="wallet-asset-actions"><button onclick="verHistoricoAtivo(${i})">Ver histórico</button><button onclick="abrirMovimentacao(${i})">Movimentar <span aria-hidden="true">↗</span></button></div></article>`;
  }).join('');
  setCarteiraView(carteiraVisual);
}
function atualizarPreviaMovimento(){
  const box=g('movPrevia');if(!box)return;
  const a=carteira.find(a=>a.id===g('movOrigem').value),b=carteira.find(a=>a.id===g('movDestino').value),v=Number(g('movValor').value),t=g('movTipo').value;
  if(!a||!Number.isFinite(v)||v<=0){box.innerHTML='<span class="preview-eyebrow">ANTES DE CONFIRMAR</span><p>Escolha a aplicação e informe um valor para conferir o efeito no saldo.</p>';return;}
  const internal=t==='transferencia'||(t==='resgate'&&b);
  const enter=['aporte','rendimento'].includes(t);
  if(internal&&(!b||a.id===b.id)){box.innerHTML='<p>Escolha uma aplicação de destino diferente da origem.</p>';return;}
  if(!enter&&v>Number(a.atual)){box.innerHTML='<p class="movement-text-out">O valor informado é maior que o saldo disponível.</p>';return;}
  const heading=internal?`${escHtml(a.nome)} <span aria-hidden="true">→</span> ${escHtml(b.nome)}`:enter?`Entrada em ${escHtml(a.nome)}`:`Saída de ${escHtml(a.nome)}`;
  const after=Number(a.atual)+(enter?v:-v);
  box.innerHTML=`<span class="preview-eyebrow">CONFIRA A MOVIMENTAÇÃO</span><strong>${heading}</strong><p class="priv">${escHtml(fmt(v))} · Saldo da ${escHtml(a.nome)} após: ${escHtml(fmt(after))}${internal?`<br>Saldo da ${escHtml(b.nome)} após: ${escHtml(fmt(Number(b.atual)+v))}`:''}</p><small>${internal?'O total da carteira não muda. Nenhuma nova receita ou despesa é criada.':enter?'Movimentação manual. Não repita uma receita que já foi vinculada.':'O valor sai da carteira. Nenhuma despesa é criada automaticamente.'}</small>`;
  applyPrivacy();
}
for(const id of ['movOrigem','movDestino','movValor','movTipo'])g(id).addEventListener('input',atualizarPreviaMovimento);
renderCarteira();

