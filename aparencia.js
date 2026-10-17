/* Preferências visuais na conta. Não grava saldos ou movimentações. */
(() => {
 const PADRAO='#1e3a5f', valid=c=>typeof c==='string'&&/^#[0-9a-f]{6}$/i.test(c);
 const palette=['#2563eb','#8b5cf6','#0891b2','#ea580c','#d946ef','#0d9488','#dc2626','#64748b'];
 let cor=PADRAO, cores={}, usuario=null, sequencia=0, salvando=false, carregado=false;
 const pendentes=new Set();
 const rgb=c=>c.slice(1).match(/../g).map(v=>parseInt(v,16));
 const lum=c=>rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,x,i)=>v+x*[.2126,.7152,.0722][i],0);
 const contraste=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
 function aplicar(c){
  if(!valid(c))c=PADRAO;
  const dark=document.body.classList.contains('dark'),bg=dark?'#151611':'#efede8';
  let texto=c,arr=rgb(c);const alvo=dark?255:0;
  for(let i=0;i<30&&contraste(texto,bg)<4.5;i++){arr=arr.map(v=>Math.round(v+(alvo-v)*.14));texto='#'+arr.map(v=>v.toString(16).padStart(2,'0')).join('');}
  const root=document.body.style;
  root.setProperty('--ui-cor',c);root.setProperty('--ui-texto',texto);
  root.setProperty('--ui-suave',`rgba(${rgb(c).join(',')},${dark?'.24':'.10'})`);
  root.setProperty('--ui-contraste',contraste(c,'#ffffff')>=contraste(c,'#101010')?'#ffffff':'#101010');
 }
 function aviso(texto){const e=g('aparenciaStatus');if(e)e.textContent=texto;}
 function atualizarPicker(){if(g('corSistema'))g('corSistema').value=cor;}
 function corAtivo(id){if(valid(cores[id]))return cores[id];const ids=carteira.map(a=>a.id).sort();const i=ids.indexOf(id);return palette[(i<0?0:i)%palette.length];}
 function pintar(){
  document.querySelectorAll('#cartCards .wallet-asset').forEach((el,i)=>{
   const a=carteira[i];if(!a)return;const c=corAtivo(a.id);el.style.setProperty('--aplicacao-cor',c);
   const mono=el.querySelector('.wallet-monogram');if(mono){mono.style.color=c;mono.style.background=`rgba(${rgb(c).join(',')},.12)`;}
   const bar=el.querySelector('.wallet-share-track>span');if(bar)bar.style.background=c;
  });
  const items=carteira.filter(a=>Number(a.atual)>0).slice().sort((a,b)=>Number(b.atual)-Number(a.atual));
  g('cartDistribuicao')?.querySelectorAll('svg circle').forEach((circle,i)=>{if(items[i])circle.setAttribute('stroke',corAtivo(items[i].id));});
  g('cartDistribuicao')?.querySelectorAll('.cart-color').forEach((el,i)=>{if(items[i])el.style.background=corAtivo(items[i].id);});
  document.querySelectorAll('[data-cor-ativo]').forEach(el=>{el.value=corAtivo(el.dataset.corAtivo);el.disabled=pendentes.has(el.dataset.corAtivo);});
  document.querySelectorAll('#tbCarteira tr').forEach((tr,i)=>{const a=carteira[i];if(!a)return;let dot=tr.querySelector('.aplicacao-dot');if(!dot){dot=document.createElement('span');dot.className='aplicacao-dot';dot.setAttribute('aria-hidden','true');tr.firstElementChild.prepend(dot);}dot.style.background=corAtivo(a.id);});
 }
 function seletor(a,classe){
  const label=document.createElement('label');label.className='aplicacao-color '+classe;
  const texto=document.createElement('span');texto.textContent='Cor da aplicação';
  const input=document.createElement('input');input.type='color';input.value=corAtivo(a.id);input.dataset.corAtivo=a.id;input.setAttribute('aria-label','Cor de '+a.nome);
  input.addEventListener('change',()=>salvarAplicacao(a.id,input.value));label.append(texto,input);return label;
 }
 function prepararCartoes(){document.querySelectorAll('#cartCards .wallet-asset').forEach((el,i)=>{if(carteira[i]&&!el.querySelector('.aplicacao-color'))el.append(seletor(carteira[i],''));});
 document.querySelectorAll('#tbCarteira tr').forEach((tr,i)=>{if(carteira[i]&&!tr.querySelector('.aplicacao-color'))tr.lastElementChild.append(seletor(carteira[i],'aplicacao-color-table'));});pintar();}
 const visualOriginal=renderCarteiraVisual;renderCarteiraVisual=function(){visualOriginal();prepararCartoes();};
 const distribuicaoOriginal=renderDistribuicaoCarteira;renderDistribuicaoCarteira=function(){distribuicaoOriginal();pintar();};
 const temaOriginal=applyTheme;applyTheme=function(...args){const r=temaOriginal(...args);aplicar(cor);return r;};
 function reset(){sequencia++;usuario=null;cor=PADRAO;cores={};carregado=false;salvando=false;pendentes.clear();if(g('salvarCorSistema'))g('salvarCorSistema').disabled=false;atualizarPicker();aplicar(cor);aviso('Carregue suas preferências para editar.');}
 window.carregarAparencia=async function(){
  if(!sb||!currentUser)return;if(salvando||pendentes.size){aviso('Aguarde o salvamento atual.');return;}const uid=currentUser.id,seq=++sequencia;
  if(usuario!==uid){cores={};cor=PADRAO;carregado=false;usuario=uid;aplicar(cor);atualizarPicker();}
  aviso('Carregando preferências…');
  try{const {data,error}=await sb.rpc('carregar_aparencia');if(error)throw error;if(seq!==sequencia||uid!==currentUser?.id)return;
   cor=valid(data?.cor_sistema)?data.cor_sistema:PADRAO;cores={};
   Object.entries(data?.aplicacoes||{}).forEach(([id,c])=>{if(valid(c))cores[id]=c;});carregado=true;atualizarPicker();aplicar(cor);pintar();aviso('Preferências carregadas da sua conta.');
  }catch(e){if(seq!==sequencia||uid!==currentUser?.id)return;carregado=false;aviso('Não foi possível carregar as cores. Confira a conexão e a instalação de aparencia.sql. Use “Recarregar”.');console.warn('Aparência indisponível',e);}
 };
 window.preverCorSistema=function(c){if(valid(c)){aplicar(c);aviso('Prévia: clique em Salvar cor para guardar na sua conta.');}};
 window.restaurarCorSistema=function(){g('corSistema').value=PADRAO;preverCorSistema(PADRAO);};
 window.salvarCorSistema=async function(){
  if(salvando)return;if(!carregado||usuario!==currentUser?.id){aviso('Recarregue as preferências antes de salvar.');return;}
  const c=g('corSistema').value,uid=usuario,seq=sequencia;if(!valid(c))return;
  salvando=true;g('salvarCorSistema').disabled=true;aviso('Salvando…');
  try{const {error}=await sb.rpc('salvar_cor_sistema',{p_cor:c});if(error)throw error;if(uid!==currentUser?.id||seq!==sequencia)return;cor=c;aplicar(cor);aviso('Cor salva na sua conta.');}
  catch(e){if(uid===currentUser?.id&&seq===sequencia){aplicar(cor);atualizarPicker();aviso('Não foi possível salvar. A cor anterior foi mantida.');}}
  finally{if(uid===currentUser?.id&&seq===sequencia){salvando=false;g('salvarCorSistema').disabled=false;}}
 };
 async function salvarAplicacao(id,c){
  if(pendentes.has(id))return;
  if(!carregado||usuario!==currentUser?.id){pintar();toast('Carregue as preferências em Conta → Aparência.');return;}
  if(!valid(c)||!carteira.some(a=>a.id===id))return;
  const uid=usuario,seq=sequencia,anterior=cores[id];pendentes.add(id);cores[id]=c;pintar();
  try{const {error}=await sb.rpc('salvar_cor_aplicacao',{p_carteira_id:id,p_cor:c});if(error)throw error;if(uid===currentUser?.id&&seq===sequencia)toast('Cor da aplicação salva na sua conta.');}
  catch(e){if(uid===currentUser?.id&&seq===sequencia){if(anterior)cores[id]=anterior;else delete cores[id];toast('Não foi possível salvar a cor. Cor anterior restaurada.');}}
  finally{if(uid===currentUser?.id&&seq===sequencia){pendentes.delete(id);pintar();}}
 }
 const appOriginal=exibirApp;exibirApp=async function(...args){if(usuario!==currentUser?.id)reset();const r=await appOriginal(...args);await carregarAparencia();return r;};
 const authOriginal=exibirAuth;exibirAuth=function(...args){reset();return authOriginal(...args);};
 const fecharOriginal=fecharConta;fecharConta=function(...args){aplicar(cor);atualizarPicker();return fecharOriginal(...args);};
 aplicar(cor);
})();
