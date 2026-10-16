// SPLASH
function hideSplash(){const s=document.getElementById('splash');if(!s)return;s.classList.add('out');setTimeout(()=>s.style.display='none',750)}
window._splashTimer=setTimeout(hideSplash,2400);

// SQL SETUP
const SQL_SETUP=`-- Execute no SQL Editor do mesmo projeto Supabase usado pelo Capita.
-- Migração adicional: não apaga nem modifica suas tabelas existentes.
create table if not exists public.cap_carteira (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ano integer not null check (ano between 1900 and 9999),
  nome text not null check (length(trim(nome)) between 1 and 80),
  tipo text not null check (tipo in ('conta','investimento')),
  categoria text not null check (categoria in ('banco','poupanca','acoes','fiis','cripto','renda_fixa','fundos','outros')),
  investido numeric(18,2) not null check (investido >= 0),
  atual numeric(18,2) not null check (atual >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists cap_carteira_user_ano on public.cap_carteira(user_id,ano);
alter table public.cap_carteira enable row level security;
drop policy if exists carteira_proprietario on public.cap_carteira;
create policy carteira_proprietario on public.cap_carteira
for all to authenticated using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.cap_carteira to authenticated;

-- Execute no SQL Editor do Supabase
create table if not exists cap_receitas(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users not null,valor_fixa numeric default 0,valor_variavel numeric default 0,valor_rendimento numeric default 0,mes integer not null,ano integer not null,created_at timestamptz default now());
create table if not exists cap_despesas(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users not null,valor numeric not null,categoria text not null,entry_id bigint not null,mes integer not null,ano integer not null,created_at timestamptz default now());
create table if not exists cap_metas(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users not null,nome text not null,desc_meta text,emoji text,dream_id text,valor numeric not null,ja_tenho numeric default 0,prazo integer not null,ano_inicio integer,mes_inicio integer,aportes jsonb default '[]',created_at timestamptz default now());
create table if not exists cap_config(id uuid default gen_random_uuid() primary key,user_id uuid references auth.users not null unique,meta_rec_mes numeric default 0,meta_des_mes numeric default 0,meta_des_livre numeric default 0,des_mode text default 'linked',ano_atual integer,updated_at timestamptz default now());
alter table cap_receitas enable row level security;
alter table cap_despesas enable row level security;
alter table cap_metas enable row level security;
alter table cap_config enable row level security;
create policy "own_cap_rec" on cap_receitas for all using(auth.uid()=user_id);
create policy "own_cap_des" on cap_despesas for all using(auth.uid()=user_id);
create policy "own_cap_meta" on cap_metas for all using(auth.uid()=user_id);
create policy "own_cap_cfg" on cap_config for all using(auth.uid()=user_id);
-- Execute DEPOIS de carteira.sql. Não apaga receitas existentes.
begin;
alter table public.cap_receitas add column if not exists carteira_id uuid references public.cap_carteira(id) on delete set null;
alter table public.cap_receitas add column if not exists carteira_nome text;
-- Impede vincular uma receita a um ativo de outro usuário/exercício.
create or replace function public.validar_origem_rendimento()
returns trigger language plpgsql set search_path = public as $$
declare nome_ativo text;
begin
  if new.carteira_id is not null then
    select nome into nome_ativo from public.cap_carteira
    where id = new.carteira_id and user_id = new.user_id and ano = new.ano;
    if not found then raise exception 'Ativo não pertence ao usuário ou ao exercício da receita'; end if;
    if coalesce(new.valor_rendimento,0) <= 0 then raise exception 'O vínculo exige um rendimento positivo'; end if;
    new.carteira_nome := nome_ativo;
  end if;
  return new;
end $$;
drop trigger if exists validar_origem_rendimento on public.cap_receitas;
create trigger validar_origem_rendimento before insert or update on public.cap_receitas
for each row execute function public.validar_origem_rendimento();
commit;

-- Execute depois de carteira.sql e rendimentos.sql. Pode ser reexecutado.
-- Receitas antigas NÃO são somadas novamente.
begin;
alter table public.cap_receitas add column if not exists carteira_aplicada boolean not null default false;
drop trigger if exists validar_origem_rendimento on public.cap_receitas;
create or replace function public.sincronizar_receita_carteira()
returns trigger language plpgsql security invoker set search_path=public as $$
declare
  destino text;
  base numeric;
  total numeric;
  aplicar boolean := false;
begin
  -- Estorna apenas lançamentos que esta versão realmente somou.
  if TG_OP in ('UPDATE','DELETE') then
    if old.carteira_aplicada and old.carteira_id is not null then
      update public.cap_carteira set
        investido=investido-coalesce(old.valor_fixa,0)-coalesce(old.valor_variavel,0),
        atual=atual-coalesce(old.valor_fixa,0)-coalesce(old.valor_variavel,0)-coalesce(old.valor_rendimento,0),
        updated_at=now()
      where id=old.carteira_id and user_id=old.user_id and ano=old.ano;
    end if;
  end if;
  if TG_OP='DELETE' then return old; end if;
  new.carteira_aplicada := false;
  if new.carteira_id is not null then
    select nome into destino from public.cap_carteira
      where id=new.carteira_id and user_id=new.user_id and ano=new.ano for update;
    if not found then raise exception 'Aplicação não pertence ao usuário ou ao exercício'; end if;
    base := coalesce(new.valor_fixa,0)+coalesce(new.valor_variavel,0);
    total := base+coalesce(new.valor_rendimento,0);
    if coalesce(new.valor_fixa,0)<0 or coalesce(new.valor_variavel,0)<0 or coalesce(new.valor_rendimento,0)<0 or total<=0 then
      raise exception 'A receita vinculada deve ter valor positivo';
    end if;
    new.carteira_nome := destino;
    if TG_OP='INSERT' then aplicar := true;
    else
      aplicar := old.carteira_aplicada
        or new.carteira_id is distinct from old.carteira_id
        or new.valor_fixa is distinct from old.valor_fixa
        or new.valor_variavel is distinct from old.valor_variavel
        or new.valor_rendimento is distinct from old.valor_rendimento;
    end if;
    if aplicar then
      update public.cap_carteira set investido=investido+base,atual=atual+total,updated_at=now()
        where id=new.carteira_id and user_id=new.user_id and ano=new.ano;
      if not found then raise exception 'Não foi possível atualizar a aplicação'; end if;
      new.carteira_aplicada := true;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sincronizar_receita_carteira on public.cap_receitas;
create trigger sincronizar_receita_carteira before insert or update or delete on public.cap_receitas
for each row execute function public.sincronizar_receita_carteira();
commit;

-- Execute após carteira.sql, rendimentos.sql e carteira-receitas.sql.
-- Migração idempotente: preserva saldos e registra uma única posição inicial.
begin;
create table if not exists public.cap_carteira_movimentos (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 ano integer not null, carteira_id uuid references public.cap_carteira(id) on delete set null,
 carteira_nome text not null, grupo uuid not null default gen_random_uuid(),
 tipo text not null check(tipo in ('abertura','aporte','rendimento','retirada','resgate','transferencia','ajuste')),
 data date not null default current_date, descricao text not null default '',
 delta_base numeric(18,2) not null, delta_saldo numeric(18,2) not null,
 base_apos numeric(18,2) not null, saldo_apos numeric(18,2) not null,
 receita_id uuid, created_at timestamptz not null default now()
);
create index if not exists cap_mov_user_ano on public.cap_carteira_movimentos(user_id,ano,created_at);
create unique index if not exists cap_mov_abertura on public.cap_carteira_movimentos(carteira_id) where tipo='abertura';
alter table public.cap_carteira_movimentos enable row level security;
drop policy if exists mov_leitura on public.cap_carteira_movimentos;
create policy mov_leitura on public.cap_carteira_movimentos for select to authenticated using(user_id=(select auth.uid()));
revoke all on public.cap_carteira_movimentos from public, authenticated;
grant select on public.cap_carteira_movimentos to authenticated;
-- Valores já existentes viram posição inicial; não simulamos entradas históricas.
insert into public.cap_carteira_movimentos(user_id,ano,carteira_id,carteira_nome,tipo,descricao,delta_base,delta_saldo,base_apos,saldo_apos)
select user_id,ano,id,nome,'abertura','Posição inicial na ativação do histórico',investido,atual,investido,atual
from public.cap_carteira c where not exists(select 1 from public.cap_carteira_movimentos m where m.carteira_id=c.id and m.tipo='abertura');

create or replace function public.auditar_carteira()
returns trigger language plpgsql security definer set search_path=public as $$
declare k text; d text; gr uuid; dt date; rid uuid;
begin
 if TG_OP='INSERT' then k:='abertura';d:='Cadastro / posição inicial';
 else
   if new.investido=old.investido and new.atual=old.atual then return new;end if;
   k:=coalesce(nullif(current_setting('cap.mov_tipo',true),''),'ajuste');
   d:=coalesce(nullif(current_setting('cap.mov_desc',true),''),'Ajuste manual dos saldos');
 end if;
 gr:=coalesce(nullif(current_setting('cap.mov_grupo',true),'')::uuid,gen_random_uuid());
 dt:=coalesce(nullif(current_setting('cap.mov_data',true),'')::date,current_date);
 rid:=nullif(current_setting('cap.mov_receita',true),'')::uuid;
 insert into public.cap_carteira_movimentos(user_id,ano,carteira_id,carteira_nome,grupo,tipo,data,descricao,delta_base,delta_saldo,base_apos,saldo_apos,receita_id)
 values(new.user_id,new.ano,new.id,new.nome,gr,k,dt,d,
   case when TG_OP='INSERT' then new.investido else new.investido-old.investido end,
   case when TG_OP='INSERT' then new.atual else new.atual-old.atual end,new.investido,new.atual,rid);
 return new;
end $$;
drop trigger if exists auditar_carteira on public.cap_carteira;
create trigger auditar_carteira after insert or update on public.cap_carteira for each row execute function public.auditar_carteira();

-- Protege o histórico e o isolamento de exercício/usuário. Para remover um ativo,
-- primeiro transfira/resgate o saldo e zere eventual base residual com um ajuste.
create or replace function public.proteger_carteira()
returns trigger language plpgsql set search_path=public as $$
begin
 if TG_OP='DELETE' then
   if old.atual<>0 or old.investido<>0 then raise exception 'Transfira ou resgate o saldo antes de excluir a aplicação';end if;
   return old;
 end if;
 if new.user_id is distinct from old.user_id or new.ano is distinct from old.ano then
   raise exception 'Não é permitido mudar o usuário ou exercício de uma aplicação';end if;
 return new;
end $$;
drop trigger if exists proteger_carteira on public.cap_carteira;
create trigger proteger_carteira before update or delete on public.cap_carteira for each row execute function public.proteger_carteira();

create table if not exists public.cap_carteira_pedidos (
 user_id uuid not null references auth.users(id) on delete cascade,chave uuid not null,primary key(user_id,chave)
);
alter table public.cap_carteira_pedidos enable row level security;
drop policy if exists pedidos_proprietario on public.cap_carteira_pedidos;
create policy pedidos_proprietario on public.cap_carteira_pedidos for all to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
grant select,insert on public.cap_carteira_pedidos to authenticated;

create or replace function public.movimentar_carteira(p_tipo text,p_origem uuid,p_destino uuid,p_valor numeric,p_data date,p_descricao text,p_chave uuid)
returns uuid language plpgsql security invoker set search_path=public as $$
declare uid uuid:=auth.uid(); o public.cap_carteira%rowtype; d public.cap_carteira%rowtype; b numeric; n integer;
begin
 if uid is null then raise exception 'Entre na sua conta';end if;
 if p_chave is null or p_data is null or p_valor is null or p_valor::text in ('NaN','Infinity','-Infinity') or p_valor<=0 or p_valor<>round(p_valor,2) or p_valor>9999999999999999.99 then raise exception 'Informe data e valor positivo com até duas casas decimais';end if;
 if p_tipo is null or p_tipo not in ('aporte','rendimento','retirada','resgate','transferencia') then raise exception 'Tipo de movimentação inválido';end if;
 if length(coalesce(p_descricao,''))>240 then raise exception 'Descrição deve ter até 240 caracteres';end if;
 insert into public.cap_carteira_pedidos values(uid,p_chave) on conflict do nothing;
 get diagnostics n=row_count;if n=0 then return p_chave;end if;
 -- Ordem estável dos bloqueios evita transferências concorrentes cruzadas.
 perform id from public.cap_carteira where id in(p_origem,p_destino) and user_id=uid order by id for update;
 select * into o from public.cap_carteira where id=p_origem and user_id=uid;
 if not found then raise exception 'Aplicação de origem não encontrada';end if;
 if extract(year from p_data)::integer<>o.ano then raise exception 'A data deve pertencer ao exercício da aplicação';end if;
 if p_tipo='transferencia' then
   if p_destino is null or p_destino=p_origem then raise exception 'Escolha duas aplicações diferentes';end if;
   select * into d from public.cap_carteira where id=p_destino and user_id=uid and ano=o.ano;
   if not found then raise exception 'Destino deve pertencer ao mesmo usuário e exercício';end if;
 elsif p_destino is not null then raise exception 'Destino permitido apenas para transferência';end if;
 if p_tipo in ('retirada','resgate','transferencia') and p_valor>o.atual then raise exception 'Saldo insuficiente na origem';end if;
 perform set_config('cap.mov_tipo',p_tipo,true);perform set_config('cap.mov_grupo',p_chave::text,true);
 perform set_config('cap.mov_desc',case when p_tipo='transferencia' then o.nome||' → '||d.nome||case when coalesce(p_descricao,'')<>'' then ' · '||p_descricao else '' end else coalesce(p_descricao,'') end,true);perform set_config('cap.mov_data',p_data::text,true);
 perform set_config('cap.mov_receita','',true);
 if p_tipo in ('aporte','rendimento') then
   update public.cap_carteira set atual=atual+p_valor,investido=investido+case when p_tipo='aporte' then p_valor else 0 end,updated_at=now() where id=o.id;
 else
   -- Base proporcional ao saldo: transferências não criam ganho/perda artificial.
   b:=case when p_valor=o.atual then o.investido else round(o.investido*p_valor/o.atual,2) end;
   update public.cap_carteira set atual=atual-p_valor,investido=investido-b,updated_at=now() where id=o.id;
   if p_tipo='transferencia' then
     update public.cap_carteira set atual=atual+p_valor,investido=investido+b,updated_at=now() where id=d.id;
   end if;
 end if;
 perform set_config('cap.mov_tipo','',true);perform set_config('cap.mov_desc','',true);perform set_config('cap.mov_grupo','',true);perform set_config('cap.mov_data','',true);
 return p_chave;
end $$;
revoke all on function public.movimentar_carteira(text,uuid,uuid,numeric,date,text,uuid) from public;
grant execute on function public.movimentar_carteira(text,uuid,uuid,numeric,date,text,uuid) to authenticated;

-- Integração com as receitas: entradas e estornos também são auditados.
create or replace function public.sincronizar_receita_carteira()
returns trigger language plpgsql security invoker set search_path=public as $$
declare
  destino text;
  base numeric;
  total numeric;
  aplicar boolean := false;
begin
  perform set_config('cap.mov_grupo',gen_random_uuid()::text,true);
  perform set_config('cap.mov_data',current_date::text,true);
  -- Estorna apenas lançamentos que esta versão realmente somou.
  if TG_OP in ('UPDATE','DELETE') then
    if old.carteira_aplicada and old.carteira_id is not null then
      perform set_config('cap.mov_tipo',case when coalesce(old.valor_fixa,0)+coalesce(old.valor_variavel,0)>0 then 'aporte' else 'rendimento' end,true);
      perform set_config('cap.mov_desc','Estorno da receita vinculada',true);
      perform set_config('cap.mov_receita',old.id::text,true);
      update public.cap_carteira set
        investido=investido-coalesce(old.valor_fixa,0)-coalesce(old.valor_variavel,0),
        atual=atual-coalesce(old.valor_fixa,0)-coalesce(old.valor_variavel,0)-coalesce(old.valor_rendimento,0),
        updated_at=now()
      where id=old.carteira_id and user_id=old.user_id and ano=old.ano;
    end if;
  end if;
  if TG_OP='DELETE' then
    perform set_config('cap.mov_tipo','',true);perform set_config('cap.mov_desc','',true);perform set_config('cap.mov_receita','',true);perform set_config('cap.mov_grupo','',true);perform set_config('cap.mov_data','',true);
    return old;
  end if;
  new.carteira_aplicada := false;
  if new.carteira_id is not null then
    select nome into destino from public.cap_carteira
      where id=new.carteira_id and user_id=new.user_id and ano=new.ano for update;
    if not found then raise exception 'Aplicação não pertence ao usuário ou ao exercício'; end if;
    base := coalesce(new.valor_fixa,0)+coalesce(new.valor_variavel,0);
    total := base+coalesce(new.valor_rendimento,0);
    if coalesce(new.valor_fixa,0)<0 or coalesce(new.valor_variavel,0)<0 or coalesce(new.valor_rendimento,0)<0 or total<=0 then
      raise exception 'A receita vinculada deve ter valor positivo';
    end if;
    new.carteira_nome := destino;
    if TG_OP='INSERT' then aplicar := true;
    else
      aplicar := old.carteira_aplicada
        or new.carteira_id is distinct from old.carteira_id
        or new.valor_fixa is distinct from old.valor_fixa
        or new.valor_variavel is distinct from old.valor_variavel
        or new.valor_rendimento is distinct from old.valor_rendimento;
    end if;
    if aplicar then
      perform set_config('cap.mov_tipo',case when base>0 then 'aporte' else 'rendimento' end,true);
      perform set_config('cap.mov_desc','Receita vinculada à aplicação',true);
      perform set_config('cap.mov_receita',new.id::text,true);
      update public.cap_carteira set investido=investido+base,atual=atual+total,updated_at=now()
        where id=new.carteira_id and user_id=new.user_id and ano=new.ano;
      if not found then raise exception 'Não foi possível atualizar a aplicação'; end if;
      new.carteira_aplicada := true;
    end if;
  end if;
  perform set_config('cap.mov_tipo','',true);perform set_config('cap.mov_desc','',true);perform set_config('cap.mov_receita','',true);perform set_config('cap.mov_grupo','',true);perform set_config('cap.mov_data','',true);
  return new;
end $$;

-- Leitura em uma única instrução: saldos e histórico no mesmo snapshot.
create or replace function public.consultar_carteira(p_ano integer)
returns jsonb language sql stable security invoker set search_path=public as $$
 select jsonb_build_object(
   'ativos',coalesce((select jsonb_agg(to_jsonb(c) order by c.updated_at desc,c.id) from public.cap_carteira c where c.user_id=auth.uid() and c.ano=p_ano),'[]'::jsonb),
   'movimentos',coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc,m.id desc) from public.cap_carteira_movimentos m where m.user_id=auth.uid() and m.ano=p_ano),'[]'::jsonb)
 );
$$;
revoke all on function public.consultar_carteira(integer) from public;
grant execute on function public.consultar_carteira(integer) to authenticated;

commit;
`;

let sb=null,currentUser=null;
function getConfig(){try{const s=localStorage.getItem('capita_cfg');if(!s)return null;const c=JSON.parse(s);return(c.url&&c.key)?c:null}catch{return null}}
function salvarConfig(){const url=document.getElementById('cfgUrl').value.trim(),key=document.getElementById('cfgKey').value.trim();if(!url||!key){toast('Preencha URL e Key');return}localStorage.setItem('capita_cfg',JSON.stringify({url,key}));document.getElementById('sqlBlock').style.display='block';document.getElementById('sqlText').value=SQL_SETUP;toast('Configuração salva! Execute o SQL e recarregue.')}
function copiarSQL(){navigator.clipboard.writeText(SQL_SETUP).then(()=>toast('SQL copiado!'))}

const MESES=["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const MABR=["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
const CATS=['moradia','alimentacao','transporte','saude','lazer','educacao','outros'];
const CNAME={moradia:"Moradia",alimentacao:"Alimentação",transporte:"Transporte",saude:"Saúde",lazer:"Lazer",educacao:"Educação",outros:"Outros"};
const CCLR={moradia:"#4a70c8",alimentacao:"#28a05a",transporte:"#c89428",saude:"#c04b4b",lazer:"#8250d2",educacao:"#509bf0",outros:"#646e82"};
const DREAMS=[{id:'casa',emoji:'🏠',label:'Casa'},{id:'viagem',emoji:'✈️',label:'Viagem'},{id:'carro',emoji:'🚗',label:'Carro'},{id:'celular',emoji:'📱',label:'Celular'},{id:'poupanca',emoji:'🐷',label:'Poupança'},{id:'moto',emoji:'🏍️',label:'Moto'},{id:'festa',emoji:'🎉',label:'Festa'},{id:'estudo',emoji:'🎓',label:'Estudo'},{id:'saude',emoji:'💊',label:'Saúde'},{id:'outro',emoji:'⭐',label:'Outro'}];

let anoAtual=new Date().getFullYear(),currentPage='dashboard',chartMode='bar',pizzaModeRec='annual',pizzaModeDes='annual',desMode='linked',wizEmoji=null,sonhoAtivo=null;
const eRec=()=>Array.from({length:12},()=>({fixa:0,variavel:0,rendimento:0}));
const eDes=()=>Array.from({length:12},()=>CATS.reduce((o,c)=>(o[c]=[],o),{}));
let rec=eRec(),des=eDes(),meta={recMes:0,desMes:0,desLivre:0},sonhos=[];

const g=id=>document.getElementById(id);
const fmt=v=>"R$\u00a0"+(v||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});
const tRec=m=>(m.fixa||0)+(m.variavel||0)+(m.rendimento||0);
const tDes=(i,d)=>CATS.reduce((s,c)=>s+((d[i][c]||[]).reduce((a,e)=>a+(e.v||0),0)),0);
const tDesAno=d=>Array.from({length:12},(_,i)=>tDes(i,d)).reduce((a,b)=>a+b,0);
const saldo=i=>tRec(rec[i])-tDes(i,des);
function escHtml(str){return String(str==null?'':str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

// SUPABASE
let anoLoadSeq=0;
async function loadAll(){if(!sb||!currentUser)return;const uid=currentUser.id;const anoReq=anoAtual,seq=anoLoadSeq;try{const[rR,rD,rM,rC]=await Promise.all([sb.from('cap_receitas').select('*').eq('user_id',uid).eq('ano',anoReq),sb.from('cap_despesas').select('*').eq('user_id',uid).eq('ano',anoReq),sb.from('cap_metas').select('*').eq('user_id',uid),sb.from('cap_config').select('*').eq('user_id',uid).maybeSingle()]);if(seq!==anoLoadSeq||anoReq!==anoAtual||uid!==currentUser?.id)return;if(!rR.error){receitasDetalhadas=rR.data||[];rendimentosRows=(rR.data||[]).filter(r=>Number(r.valor_rendimento)>0);renderRendimentos();}const newRec=eRec();(rR.data||[]).forEach(row=>{newRec[row.mes].fixa+=(row.valor_fixa||0);newRec[row.mes].variavel+=(row.valor_variavel||0);newRec[row.mes].rendimento+=(row.valor_rendimento||0)});const newDes=eDes();(rD.data||[]).forEach(row=>{if(!newDes[row.mes][row.categoria])newDes[row.mes][row.categoria]=[];newDes[row.mes][row.categoria].push({v:row.valor,id:row.entry_id,_sbid:row.id})});rec=newRec;des=newDes;sonhos=(rM.data||[]).map(row=>({id:row.id,nome:row.nome,desc:row.desc_meta||'',emoji:row.emoji||'⭐',dreamId:row.dream_id||'outro',valor:row.valor,jaTenho:row.ja_tenho||0,prazo:row.prazo,anoInicio:row.ano_inicio||anoAtual,mesInicio:row.mes_inicio||0,aportes:row.aportes||[]}));if(rC.data){meta.recMes=rC.data.meta_rec_mes||0;meta.desMes=rC.data.meta_des_mes||0;meta.desLivre=rC.data.meta_des_livre||0;desMode=rC.data.des_mode||'linked'}}catch(e){console.error('loadAll',e);toast('Erro ao carregar dados — verifique sua conexão')}}
async function sbSaveReceita(mes,orig,valor,ativo=null){if(!sb||!currentUser)return{error:new Error('Entre na sua conta')};return await sb.from('cap_receitas').insert({...(ativo?{carteira_id:ativo.id,carteira_nome:ativo.nome}:{}),user_id:currentUser.id,valor_fixa:orig==='fixa'?valor:0,valor_variavel:orig==='variavel'?valor:0,valor_rendimento:orig==='rendimento'?valor:0,mes,ano:anoAtual})}
async function sbDeleteReceita(mes,orig,valor){if(!sb||!currentUser)return{error:null};const cm={fixa:'valor_fixa',variavel:'valor_variavel',rendimento:'valor_rendimento'};const{data,error}=await sb.from('cap_receitas').select('id').eq('user_id',currentUser.id).eq('mes',mes).eq('ano',anoAtual).eq(cm[orig],valor).order('created_at',{ascending:false}).limit(1);if(error)return{error};if(data&&data[0])return await sb.from('cap_receitas').delete().eq('id',data[0].id);return{error:null}}
async function sbSaveDespesa(mes,cat,valor,entryId){if(!sb||!currentUser)return{error:null};return await sb.from('cap_despesas').insert({user_id:currentUser.id,valor,categoria:cat,entry_id:entryId,mes,ano:anoAtual})}
async function sbDeleteDespesa(sbid){if(!sb||!currentUser)return{error:null};return await sb.from('cap_despesas').delete().eq('id',sbid)}
async function sbSaveConfig(){if(!sb||!currentUser)return{error:null};const uid=currentUser.id;const p={user_id:uid,meta_rec_mes:meta.recMes,meta_des_mes:meta.desMes,meta_des_livre:meta.desLivre,des_mode:desMode,ano_atual:anoAtual,updated_at:new Date().toISOString()};const{data}=await sb.from('cap_config').select('id').eq('user_id',uid).maybeSingle();if(data)return await sb.from('cap_config').update(p).eq('user_id',uid);else return await sb.from('cap_config').insert(p)}
async function sbSaveMeta(m){if(!sb||!currentUser)return{id:null,error:null};const p={user_id:currentUser.id,nome:m.nome,desc_meta:m.desc||'',emoji:m.emoji,dream_id:m.dreamId,valor:m.valor,ja_tenho:m.jaTenho||0,prazo:m.prazo,ano_inicio:m.anoInicio,mes_inicio:m.mesInicio,aportes:m.aportes||[]};if(m.id){const{error}=await sb.from('cap_metas').update(p).eq('id',m.id);return{id:m.id,error}}else{const{data,error}=await sb.from('cap_metas').insert(p).select('id').single();return{id:data?.id,error}}}
async function sbDeleteMeta(id){if(!sb||!currentUser)return{error:null};return await sb.from('cap_metas').delete().eq('id',id)}
async function sbUpdateAportes(metaId,aportes){if(!sb||!currentUser)return{error:null};return await sb.from('cap_metas').update({aportes}).eq('id',metaId)}

// AUTH
function mostrarLogin(){g('loginForm').style.display='block';g('registerForm').style.display='none';limparAuthErr()}
function mostrarCadastro(){g('loginForm').style.display='none';g('registerForm').style.display='block';limparAuthErr()}
function limparAuthErr(){const e=g('authErr');e.style.display='none';e.textContent=''}
function mostrarAuthErr(msg){const e=g('authErr');e.textContent=msg;e.style.display='block'}
async function fazerLogin(){const email=g('loginEmail').value.trim(),pass=g('loginPass').value;if(!email||!pass){mostrarAuthErr('Preencha email e senha');return}const btn=g('loginBtn');btn.innerHTML='<span class="spinner"></span>';btn.disabled=true;const{error}=await sb.auth.signInWithPassword({email,password:pass});btn.innerHTML='Entrar';btn.disabled=false;if(error)mostrarAuthErr(error.message==='Invalid login credentials'?'Email ou senha incorretos':error.message)}
async function fazerCadastro(){const name=g('regName').value.trim(),email=g('regEmail').value.trim(),pass=g('regPass').value;if(!name||!email||!pass){mostrarAuthErr('Preencha todos os campos');return}if(pass.length<6){mostrarAuthErr('Senha deve ter no mínimo 6 caracteres');return}const btn=g('regBtn');btn.innerHTML='<span class="spinner"></span>';btn.disabled=true;const{error}=await sb.auth.signUp({email,password:pass,options:{data:{name}}});btn.innerHTML='Criar Conta';btn.disabled=false;if(error)mostrarAuthErr(error.message);else{toast('Conta criada! Verifique seu email.');mostrarLogin()}}
async function fazerLogout(){await sb.auth.signOut()}
function atualizarUserCard(){if(!currentUser)return;const name=currentUser.user_metadata?.name||currentUser.email.split('@')[0];const initial=name[0].toUpperCase();g('sideAvatar').textContent=initial;g('sideUserName').textContent=name;g('sideUserEmail').textContent=currentUser.email;const mp=g('mobProfileBtn');if(mp)mp.textContent=initial;const aa=g('accAvatar');if(aa)aa.textContent=initial;const an=g('accUserName');if(an)an.textContent=name;const ae=g('accUserEmail');if(ae)ae.textContent=currentUser.email}
function exibirConfig(){g('configScreen').classList.add('visible');g('authScreen').classList.remove('visible');g('appScreen').style.display='none';hideSplash()}
function exibirAuth(){encerrarOnboarding(false);rendimentosRows=[];receitasDetalhadas=[];renderRendimentos();if(typeof limparCarteira==='function')limparCarteira();g('configScreen').classList.remove('visible');g('authScreen').classList.add('visible');g('appScreen').style.display='none';hideSplash()}
async function exibirApp(){if(typeof loadCarteira==='function')loadCarteira();g('configScreen').classList.remove('visible');g('authScreen').classList.remove('visible');g('appScreen').style.display='block';hideSplash();atualizarUserCard();initSelects();loadSaldoInicial();loadCatLimits();await loadAll();await loadHistorico();loadMetaUI();setMode(desMode);updateAnoUI();buildCatLimits();render();verificarWhatsNew()}

// INIT
function init(){const cfg=getConfig();if(!cfg){exibirConfig();return}try{sb=window._sbCreate(cfg.url,cfg.key);sb.auth.onAuthStateChange((event,session)=>{if(session){currentUser=session.user;exibirApp()}else{currentUser=null;exibirAuth()}});sb.auth.getSession().then(({data:{session}})=>{if(!session)exibirAuth()})}catch(e){exibirConfig()}}
function esperarSB(cb,tries=0){if(window._sbCreate)cb();else if(tries<60)setTimeout(()=>esperarSB(cb,tries+1),100);else console.error('Supabase SDK não carregou')}
window.addEventListener('sbready',()=>init(),{once:true});
setTimeout(()=>{if(!sb)esperarSB(init)},500);

// SELECTS & YEAR
function initSelects(){['recMes','desMes'].forEach(id=>{const el=g(id),cur=el.value;el.innerHTML='';MESES.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m;el.appendChild(o)});el.value=cur!==''?cur:new Date().getMonth()})}
function setAno(a){anoAtual=a;rendimentosRows=[];receitasDetalhadas=[];renderRendimentos();if(typeof loadCarteira==='function'){cancelarAtivo();loadCarteira();}anoLoadSeq++;rec=eRec();des=eDes();historicoCache=null;updateAnoUI();loadAll().then(()=>{loadMetaUI();setMode(desMode);updateAnoUI();loadHistorico().then(()=>render());sbSaveConfig()})}
const mudarAno=d=>setAno(anoAtual+d);
const goCurrentYear=()=>setAno(new Date().getFullYear());
function updateAnoUI(){['sidebarAno','mobAno'].forEach(id=>{const e=g(id);if(e)e.textContent=anoAtual});const ha=g('heroAno');if(ha)ha.textContent=anoAtual;const rl=g('recAnoLbl');if(rl)rl.textContent=anoAtual;const rs=g('relSub');if(rs)rs.textContent=`Exercício ${anoAtual}`;const ds=g('dashSub');if(ds)ds.textContent=`Exercício ${anoAtual}`;buildYearQuick()}
function buildYearQuick(){const el=g('yearQuick');if(!el)return;const anos=[anoAtual-2,anoAtual-1,anoAtual,anoAtual+1];el.innerHTML=anos.map(y=>`<button class="yq ${y===anoAtual?'on':''}" onclick="setAno(${y})">${y}</button>`).join('')}

// NAV
function navTo(page){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.querySelectorAll('[data-page]').forEach(n=>n.classList.remove('active'));g('page-'+page).classList.add('active');document.querySelectorAll(`[data-page="${page}"]`).forEach(n=>n.classList.add('active'));currentPage=page;if(typeof renderCarteira==='function'){if(page==='carteira'){loadCarteira();verificarAjudaCarteira();}document.querySelector('[data-page="mais"]')?.classList.toggle('active',['metas','relatorio'].includes(page));}if(page==='despesas')buildCatLimits();render();window.scrollTo({top:0,behavior:'smooth'})}

// CHART MODE
function setChartMode(mode,el){chartMode=mode;document.querySelectorAll('.chart-toggle .chart-btn:not(.pizza-btn)').forEach(b=>b.classList.remove('active'));if(el)el.classList.add('active');buildEvo();applyPrivacy()}
function setPizzaMode(tipo,mode){if(tipo==='rec'){pizzaModeRec=mode;document.querySelectorAll('#recToggle .pizza-btn').forEach(b=>{const im=b.textContent.trim()==='Mensal';b.classList.toggle('active',mode==='monthly'?im:!im)});buildPizzaRec()}else{pizzaModeDes=mode;document.querySelectorAll('#desToggle .pizza-btn').forEach(b=>{const im=b.textContent.trim()==='Mensal';b.classList.toggle('active',mode==='monthly'?im:!im)});buildPizzaDes()}applyPrivacy()}

// MODE
function setMode(m){desMode=m;g('btnLinked').className='mode-btn '+(m==='linked'?'m-linked':'');g('btnFree').className='mode-btn '+(m==='free'?'m-free':'');g('modeDesc').innerHTML=m==='linked'?'<strong>Modo Vinculado:</strong> Os gastos são comparados com sua receita do mês.':'<strong>Modo Independente:</strong> Os gastos têm orçamento próprio, sem relação com a receita.';g('freeBudget').style.display=m==='free'?'block':'none';g('linkedLimit').style.display=m==='linked'?'block':'none'}

// ACTIONS
let receitaSalvando=false;
async function doSaveReceita(mes,orig,v,ativo=null){
  if(receitaSalvando)return false;
  if(!Number.isFinite(v)||v<=0||!Number.isInteger(mes)||mes<0||mes>11){toast('Informe um valor e mês válidos');return false;}
  receitaSalvando=true;
  try{
    const {error}=await sbSaveReceita(mes,orig,v,ativo);if(error)throw error;
    await loadAll();await loadCarteira();historicoCache=null;render();toast(ativo?'Receita salva e saldo da aplicação atualizado!':'Receita salva sem alterar a carteira');return true;
  }catch(e){console.error('doSaveReceita',e);toast('Não foi possível salvar. Confira a conexão e execute carteira-receitas.sql. Seu valor foi mantido.');return false;}
  finally{receitaSalvando=false;}
}
async function salvarReceita(){
  const v=Number(g('recValor').value),mes=Number(g('recMes').value),orig=g('recOrigem').value;
  const ativo=obterOrigemRendimento('recCarteira');
  if(ativo===false)return;
  if(await doSaveReceita(mes,orig,v,ativo))g('recValor').value='';
}
async function doSaveDespesa(mes,cat,v){if(desMode==='linked'){const rm=tRec(rec[mes]),dm=tDes(mes,des);if(rm>0&&(dm+v)>rm){toast('Limite da receita atingido');return false}}if(!des[mes][cat])des[mes][cat]=[];const eid=Date.now();des[mes][cat].push({v,id:eid,_sbid:null});toast('Despesa adicionada');render();try{const{error}=await sbSaveDespesa(mes,cat,v,eid);if(error)throw error}catch(e){console.error('doSaveDespesa',e);toast('Erro ao salvar — verifique sua conexão')}await loadAll();render();historicoCache=null;return true}
async function salvarDespesa(){const v=Number(g('desValor').value);if(!v||!isFinite(v)||v<=0){toast('Informe um valor válido');return}const mes=Number(g('desMes').value),cat=g('desCategoria').value;g('desValor').value='';await doSaveDespesa(mes,cat,v)}
async function deletarDespesa(mes,cat,id){const entry=(des[mes][cat]||[]).find(e=>e.id===id);des[mes][cat]=(des[mes][cat]||[]).filter(e=>e.id!==id);historicoCache=null;render();if(entry&&entry._sbid){const{error}=await sbDeleteDespesa(entry._sbid);if(error){console.error('deletarDespesa',error);toast('Erro ao remover — recarregando dados');await loadAll();render()}}}
async function deletarReceita(mes,orig,valor){const nome=orig==='fixa'?'Renda Fixa':orig==='variavel'?'Renda Variável':'Rendimento';if(!confirm('Remover '+fmt(valor)+' de '+nome+' em '+MESES[mes]+'?'))return;toast('Removendo...');const{error}=await sbDeleteReceita(mes,orig,valor);if(error){console.error('deletarReceita',error);toast('Erro ao remover');return}await loadAll();await loadCarteira();historicoCache=null;render();toast('Receita removida')}
async function apagarMes(){const mes=Number(g('recMes').value);if(!confirm('Apagar todas as receitas de '+MESES[mes]+' '+anoAtual+'?'))return;toast('Apagando...');const{error}=await sb.from('cap_receitas').delete().eq('user_id',currentUser.id).eq('mes',mes).eq('ano',anoAtual);if(error){console.error('apagarMes',error);toast('Erro ao apagar');return}await loadAll();await loadCarteira();historicoCache=null;render();toast('Receitas de '+MESES[mes]+' apagadas')}
async function apagarTudo(){if(!confirm('Apagar TODAS as receitas de '+anoAtual+'? Esta ação não pode ser desfeita.'))return;toast('Apagando...');const{error}=await sb.from('cap_receitas').delete().eq('user_id',currentUser.id).eq('ano',anoAtual);if(error){console.error('apagarTudo',error);toast('Erro ao apagar');return}await loadAll();await loadCarteira();historicoCache=null;render();toast('Todas as receitas de '+anoAtual+' apagadas')}

// META UI
function loadMetaUI(){g('metaRecMes').value=meta.recMes||'';g('metaDesMes').value=meta.desMes||'';g('metaDesLivre').value=meta.desLivre||''}
function setBar(fid,pid,val,lim,inv){const fill=g(fid),pct=g(pid);if(!fill||!pct)return;if(lim>0){const p=(val/lim)*100;fill.style.width=Math.min(p,100)+'%';fill.style.background=inv?(p<50?'var(--green)':p<80?'var(--amber)':'var(--red)'):(p<50?'var(--red)':p<100?'var(--amber)':'var(--green)');pct.textContent=Math.round(p)+'%'}else{fill.style.width='0%';pct.textContent='—'}}
let metaSaveTimer;
function onMetaInput(){meta.recMes=Number(g('metaRecMes').value)||0;meta.desMes=Number(g('metaDesMes').value)||0;meta.desLivre=Number(g('metaDesLivre').value)||0;render();clearTimeout(metaSaveTimer);metaSaveTimer=setTimeout(async()=>{const{error}=await sbSaveConfig();if(error){console.error('onMetaInput',error);toast('Erro ao salvar metas')}},1500)}

// THEME
function applyTheme(dark){document.body.classList.toggle('dark',dark);const moon='<use href="#ni-moon"/>',sun='<use href="#ni-sun"/>';['themeIco','accThemeIco'].forEach(id=>{const e=g(id);if(e)e.innerHTML=dark?moon:sun});['themeTxt','accThemeTxt'].forEach(id=>{const e=g(id);if(e)e.textContent=dark?'Modo Claro':'Modo Escuro'})}
function toggleTheme(){const dark=!document.body.classList.contains('dark');applyTheme(dark);localStorage.setItem('cap_theme',dark?'dark':'light');render()}

// ACCOUNT SHEET (mobile)
function abrirConta(){const ov=g('accOverlay');ov.classList.add('open');document.body.style.overflow='hidden'}
function fecharConta(){g('accOverlay').classList.remove('open');document.body.style.overflow=''}
function fecharContaFora(e){if(e.target===g('accOverlay'))fecharConta()}

// EXPORT/IMPORT
function exportarDados(){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({rec,des,meta,ano:anoAtual,desMode,sonhos,rendimentos:rendimentosRows.map(r=>({mes:r.mes,valor:r.valor_rendimento,origem:r.carteira_nome||null}))},null,2)],{type:'application/json'}));a.download=`capita-${anoAtual}.json`;a.click();toast('Exportado!')}
function importarDados(){if(receitasDetalhadas.some(r=>r.carteira_aplicada)){toast('A importação antiga não suporta receitas que já atualizaram a carteira. Preserve o backup do banco; importação cancelada.');return;}const fi=g('fileInput');fi.value='';fi.click();fi.onchange=async e=>{const r=new FileReader();r.onload=async()=>{try{const j=JSON.parse(r.result);if(j.rec)rec=j.rec;if(j.des)des=j.des;if(j.meta)meta=j.meta;if(j.desMode)desMode=j.desMode;loadMetaUI();setMode(desMode);render();toast('Importando...');await sb.from('cap_receitas').delete().eq('user_id',currentUser.id).eq('ano',anoAtual);for(let m=0;m<12;m++){const mx=rec[m];if((mx.fixa||0)>0)await sbSaveReceita(m,'fixa',mx.fixa);if((mx.variavel||0)>0)await sbSaveReceita(m,'variavel',mx.variavel);if(!Array.isArray(j.rendimentos)&&(mx.rendimento||0)>0)await sbSaveReceita(m,'rendimento',mx.rendimento)}if(Array.isArray(j.rendimentos))for(const r of j.rendimentos){const {error}=await sb.from('cap_receitas').insert({user_id:currentUser.id,ano:anoAtual,mes:r.mes,valor_rendimento:r.valor,carteira_nome:r.origem||null});if(error)throw error;}await sb.from('cap_despesas').delete().eq('user_id',currentUser.id).eq('ano',anoAtual);for(let m=0;m<12;m++)for(const c of CATS)for(const e of(des[m][c]||[]))await sbSaveDespesa(m,c,e.v,e.id||Date.now());await sbSaveConfig();for(const s of(j.sonhos||[])){s.id=null;await sbSaveMeta(s)}await loadAll();historicoCache=null;render();toast('Importação concluída!')}catch(e2){toast('Arquivo inválido');console.error(e2)}};r.readAsText(e.target.files[0])}}
function exportarCSV(){const rows=[["Mês","Rec.Fixa","Rec.Variável","Rendimento","Total Receita",...CATS.map(c=>CNAME[c]),"Total Despesa","Saldo","Tx.Poupança"]];MESES.forEach((m,i)=>{const r2=rec[i],tr=tRec(r2),cv=CATS.map(c=>(des[i][c]||[]).reduce((s,e)=>s+(e.v||0),0)),td=cv.reduce((a,b)=>a+b,0),s=tr-td;rows.push([m,r2.fixa||0,r2.variavel||0,r2.rendimento||0,tr,...cv,td,s,tr>0?Math.round(s/tr*100):''])});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.join(';')).join('\n')],{type:'text/csv;charset=utf-8'}));a.download=`capita-${anoAtual}.csv`;a.click();toast('CSV exportado!')}

// CHARTS
let charts={};
const destroyChart=id=>{if(charts[id]){charts[id].destroy();delete charts[id]}};
const isDark=()=>document.body.classList.contains('dark');
const gColor=()=>isDark()?'rgba(240,237,232,.05)':'rgba(10,10,10,.04)';
const tColor=()=>isDark()?'#665f58':'#aaa';

/* ─── Helpers visuais dos gráficos ─── */
const chartFont = {family:'DM Mono, monospace', size:10};
function vGrad(ctx, area, c1, c2){
  if(!area) return c1;
  const gr = ctx.createLinearGradient(0, area.bottom, 0, area.top);
  gr.addColorStop(0, c2); gr.addColorStop(1, c1);
  return gr;
}
const tipStyle = () => ({
  backgroundColor: isDark() ? 'rgba(16,16,8,.96)' : 'rgba(10,10,10,.94)',
  titleColor: isDark() ? '#f0ede8' : '#f5f4f0',
  bodyColor: isDark() ? 'rgba(240,237,232,.78)' : 'rgba(245,244,240,.82)',
  borderColor: isDark() ? 'rgba(240,237,232,.14)' : 'rgba(255,255,255,.10)',
  borderWidth: 1, cornerRadius: 12, padding: 12, displayColors: true,
  usePointStyle: true, boxPadding: 6,
  titleFont: {family:'DM Sans, sans-serif', size:11, weight:'600'},
  bodyFont: {family:'DM Mono, monospace', size:11.5},
  caretSize: 6, caretPadding: 8
});
/* linha vertical guia ao passar o mouse */
const crosshair = {
  id:'crosshair',
  afterDatasetsDraw(c){
    const act = c.tooltip?._active;
    if(!act || !act.length) return;
    const x = act[0].element.x, {top,bottom} = c.chartArea, ctx = c.ctx;
    ctx.save();
    ctx.beginPath(); ctx.setLineDash([4,4]); ctx.lineWidth = 1;
    ctx.strokeStyle = isDark() ? 'rgba(240,237,232,.22)' : 'rgba(10,10,10,.18)';
    ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.restore();
  }
};
/* texto central do donut */
const donutCenter = {
  id:'donutCenter',
  afterDraw(c){
    const opt = c.options.plugins.donutCenter; if(!opt || !opt.text) return;
    const {ctx, chartArea:{left,right,top,bottom}} = c;
    const cx = (left+right)/2, cy = (top+bottom)/2;
    ctx.save(); ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillStyle = isDark() ? 'rgba(240,237,232,.34)' : 'rgba(10,10,10,.34)';
    ctx.font = '600 8px "DM Sans", sans-serif';
    ctx.fillText(opt.label || 'TOTAL', cx, cy - 11);
    ctx.fillStyle = isDark() ? 'rgba(240,237,232,.92)' : 'rgba(10,10,10,.88)';
    ctx.font = '500 14px "DM Mono", monospace';
    ctx.fillText(opt.text, cx, cy + 5);
    ctx.restore();
  }
};
if(window.Chart){
  Chart.register(crosshair, donutCenter);
  Chart.defaults.font.family = 'DM Sans, sans-serif';
  Chart.defaults.animation.duration = 900;
  Chart.defaults.animation.easing = 'easeOutQuart';
}

function buildEvo(){
  destroyChart('evo');
  const ds = [];
  const recData = rec.map(tRec);
  const desData = Array.from({length:12},(_,i)=>tDes(i,des));
  if(chartMode==='bar' || chartMode==='both'){
    ds.push({label:'Receitas', data:recData, type:'bar', order:2,
      backgroundColor:(c)=>vGrad(c.chart.ctx, c.chart.chartArea,
        isDark()?'rgba(45,189,110,.95)':'rgba(28,122,69,.95)',
        isDark()?'rgba(45,189,110,.30)':'rgba(28,122,69,.32)'),
      hoverBackgroundColor: isDark()?'#3ddc84':'#1c7a45',
      borderRadius:{topLeft:6,topRight:6,bottomLeft:2,bottomRight:2},
      borderSkipped:false, maxBarThickness:26, categoryPercentage:.68, barPercentage:.86});
    ds.push({label:'Despesas', data:desData, type:'bar', order:2,
      backgroundColor:(c)=>vGrad(c.chart.ctx, c.chart.chartArea,
        isDark()?'rgba(232,85,85,.92)':'rgba(176,32,32,.92)',
        isDark()?'rgba(232,85,85,.28)':'rgba(176,32,32,.30)'),
      hoverBackgroundColor: isDark()?'#ff6b6b':'#b02020',
      borderRadius:{topLeft:6,topRight:6,bottomLeft:2,bottomRight:2},
      borderSkipped:false, maxBarThickness:26, categoryPercentage:.68, barPercentage:.86});
  }
  if(chartMode==='line' || chartMode==='both'){
    const lc = isDark()?'#6090f8':'#4a70c8';
    ds.push({label:'Saldo', data:Array.from({length:12},(_,i)=>saldo(i)), type:'line', order:1,
      borderColor:lc, borderWidth:2.5, tension:.42,
      backgroundColor:(c)=>vGrad(c.chart.ctx, c.chart.chartArea,
        isDark()?'rgba(96,144,248,.30)':'rgba(74,112,200,.24)','rgba(96,144,248,0)'),
      fill: chartMode==='line',
      pointRadius:0, pointHoverRadius:6,
      pointBackgroundColor:lc, pointBorderColor:isDark()?'#101008':'#fff', pointBorderWidth:2.5,
      pointHoverBackgroundColor:lc, pointHoverBorderWidth:3,
      borderCapStyle:'round', borderJoinStyle:'round'});
  }
  charts.evo = new Chart(g('chartEvo'),{
    type:'bar',
    data:{labels:MABR, datasets:ds},
    options:{
      responsive:true, maintainAspectRatio:false,
      layout:{padding:{top:8}},
      interaction:{mode:'index', intersect:false},
      animation:{duration:1000, easing:'easeOutQuart'},
      animations:{y:{from:(ctx)=>ctx.chart.chartArea?.bottom}},
      plugins:{
        legend:{display:false},
        tooltip:Object.assign(tipStyle(),{
          callbacks:{
            title:(it)=>MESES[it[0].dataIndex] ?? it[0].label,
            label:c=>'  '+c.dataset.label+': '+fmt(c.raw)
          }
        })
      },
      scales:{
        x:{ticks:{color:tColor(), font:chartFont, padding:6},
           grid:{display:false}, border:{display:false}},
        y:{beginAtZero:true, border:{display:false},
           ticks:{color:tColor(), font:chartFont, padding:8, maxTicksLimit:6,
                  callback:v=>(Math.abs(v)>=1000?(v/1000).toFixed(0)+'k':v)},
           grid:{color:gColor(), drawTicks:false}}
      }
    }
  });
}

function donutOpts(pct, totalTxt, filtro){
  return {
    responsive:true, maintainAspectRatio:false, cutout:'68%',
    radius:'94%',
    animation:{animateRotate:true, animateScale:false, duration:1100, easing:'easeOutQuart'},
    plugins:{
      legend:{display:false},
      donutCenter:{text:totalTxt, label:'TOTAL'},
      tooltip:Object.assign(tipStyle(),{
        filter: filtro || (()=>true),
        callbacks:{label:c=>'  '+fmt(c.raw)+'  ·  '+pct(c.raw)+'%'}
      })
    }
  };
}

function buildPizzaRec(){
  destroyChart('pRec');
  let fixa,var_,rend;
  if(pizzaModeRec==='annual'){
    fixa=rec.reduce((a,m)=>a+(m.fixa||0),0);
    var_=rec.reduce((a,m)=>a+(m.variavel||0),0);
    rend=rec.reduce((a,m)=>a+(m.rendimento||0),0);
  } else {
    const mes=new Date().getMonth();
    fixa=rec[mes].fixa||0; var_=rec[mes].variavel||0; rend=rec[mes].rendimento||0;
  }
  const total=fixa+var_+rend, pct=v=>total>0?Math.round(v/total*100):0;
  const itens=[{n:'Renda Fixa',v:fixa,c:'#1c7a45'},{n:'Renda Variável',v:var_,c:'#4a70c8'},{n:'Rendimento',v:rend,c:'#8250d2'}];
  charts.pRec = new Chart(g('chartPRec'),{
    type:'doughnut',
    data:{labels:itens.map(x=>x.n),
      datasets:[{data:itens.map(x=>x.v), backgroundColor:itens.map(x=>x.c),
        borderColor:isDark()?'#101008':'#efede8', borderWidth:3, borderRadius:6,
        hoverOffset:10, hoverBorderWidth:3, spacing:2}]},
    options: donutOpts(pct, total>0?fmt(total):'—')
  });
  g('lgPRec').innerHTML = itens.filter(x=>x.v>0).map(x=>`<div class="plg-item"><span class="plg-dot" style="background:${x.c}"></span><div class="plg-name">${x.n}</div><div class="plg-val">${fmt(x.v)} · ${pct(x.v)}%</div></div>`).join('');
}

function buildPizzaDes(){
  destroyChart('pDes');
  let dados;
  if(pizzaModeDes==='annual')
    dados=CATS.map(c=>Array.from({length:12},(_,i)=>(des[i][c]||[]).reduce((s,e)=>s+(e.v||0),0)).reduce((a,b)=>a+b,0));
  else{
    const mes=new Date().getMonth();
    dados=CATS.map(c=>(des[mes][c]||[]).reduce((s,e)=>s+(e.v||0),0));
  }
  const total=dados.reduce((a,b)=>a+b,0), pct=v=>total>0?Math.round(v/total*100):0;
  const ativos=CATS.map((c,i)=>({c,v:dados[i],cor:CCLR[c],nome:CNAME[c]})).filter(x=>x.v>0);
  charts.pDes = new Chart(g('chartPDes'),{
    type:'doughnut',
    data:{labels:CATS.map(c=>CNAME[c]),
      datasets:[{data:dados, backgroundColor:CATS.map((c,i)=>dados[i]>0?CCLR[c]:'transparent'),
        borderColor:isDark()?'#101008':'#efede8', borderWidth:3, borderRadius:6,
        hoverOffset:10, hoverBorderWidth:3, spacing:2}]},
    options: donutOpts(pct, total>0?fmt(total):'—', item=>item.raw>0)
  });
  g('lgPDes').innerHTML = ativos.length===0
    ? '<div style="font-size:11.5px;color:var(--ink4);padding:8px 0">Nenhuma despesa lançada.</div>'
    : ativos.map(x=>`<div class="plg-item"><span class="plg-dot" style="background:${x.cor}"></span><div class="plg-name">${x.nome}</div><div class="plg-val">${fmt(x.v)} · ${pct(x.v)}%</div></div>`).join('');
}


function buildCatSummary(){const el=g('catGrid');if(!el)return;const cv=CATS.map(c=>Array.from({length:12},(_,i)=>(des[i][c]||[]).reduce((s,e)=>s+(e.v||0),0)).reduce((a,b)=>a+b,0));const tot=cv.reduce((a,b)=>a+b,0),maxV=Math.max(...cv,1);el.innerHTML=CATS.map((cat,ci)=>{const v=cv[ci],p=tot>0?Math.round(v/tot*100):0,bp=Math.round(v/maxV*100);return`<div class="cat-item"><div class="cat-ico eic-${cat}"><svg><use href="#ico-${cat}"/></svg></div><div class="cat-name">${CNAME[cat]}</div><div class="cat-val">${v>0?fmt(v):'—'}</div><div class="cat-pct">${p}% do total</div><div class="cat-bar"><div class="cat-bar-fill" style="width:${bp}%;background:${CCLR[cat]}"></div></div></div>`}).join('')}

// RENDER
function render(){updateAnoUI();setMode(desMode);if(!historicoCache){ensureHistorico().then(()=>render());return;}const somaRec=rec.reduce((a,m)=>a+tRec(m),0),somaDes=tDesAno(des),saldoAno=desMode==='free'?somaRec:somaRec-somaDes,txP=somaRec>0?Math.round(saldoAno/somaRec*100):null,mAt=rec.filter(m=>tRec(m)>0).length,mc=new Date().getMonth(),recM=tRec(rec[mc]),desM=tDes(mc,des),sM=desMode==='free'?recM:recM-desM,mediaRec=mAt>0?somaRec/mAt:0;
g('kpiMediaRec').textContent=mAt>0?fmt(mediaRec):'—';g('kpiMediaRecBadge').className='badge nn';g('kpiMediaRecBadge').textContent=mAt>0?mAt+(mAt===1?' mês ativo':' meses ativos'):'—';
const hv=g('heroSaldo');
const hl=g('heroLbl');
if(patrimonioMode){
  const patrimonio=calcPatrimonio();
  const histRec=(historicoCache||[]).reduce((a,h)=>a+h.rec,0);
  const histDes=(historicoCache||[]).reduce((a,h)=>a+h.des,0);
  hl.innerHTML='Patrimônio Líquido Total';
  hv.textContent=fmt(patrimonio);hv.className='hero-val'+(patrimonio<0?' neg':'');
  g('heroRec').textContent=fmt(histRec);
  g('heroDes').textContent=fmt(saldoInicial);
  g('heroTaxa').textContent=(historicoCache?historicoCache.length:0)+' ano(s)';
  g('heroMeses').textContent=fmt(histDes);
  g('heroRecLbl').textContent='Receitas (total)';
  g('heroDesLbl').textContent='Saldo inicial';
  g('heroTaxaLbl').textContent='Anos';
  g('heroMesesLbl').textContent='Despesas (total)';
  g('heroExtra').style.display='flex';
  const si=g('saldoInicialInput');if(si&&document.activeElement!==si)si.value=saldoInicial||'';
}else{
  hl.innerHTML='Saldo Líquido — <span id="heroAno"></span>';
  g('heroAno').textContent=anoAtual;
  hv.textContent=fmt(saldoAno);hv.className='hero-val'+(saldoAno<0?' neg':'');
  g('heroRec').textContent=fmt(somaRec);g('heroDes').textContent=fmt(somaDes);
  g('heroTaxa').textContent=txP!==null?txP+'%':'—';g('heroMeses').textContent=mAt+(mAt===1?' mês':' meses');
  g('heroRecLbl').textContent='Total Receitas';
  g('heroDesLbl').textContent='Total Despesas';
  g('heroTaxaLbl').textContent='Taxa de Poupança';
  g('heroMesesLbl').textContent='Meses Ativos';
  g('heroExtra').style.display='none';
}
const proj=mAt>0?(somaRec/mAt)*12:0;g('kpiRecMes').textContent=mAt>0?fmt(proj):'—';g('kpiDesMes').textContent=fmt(desM);g('kpiSaldoMes').textContent=fmt(sM);g('kpiSaldoMes').className='kpi-val mn'+(sM<0?' r':'');
g('kpiRecBadge').className='badge nn';g('kpiRecBadge').textContent=mAt>0?'base: '+mAt+(mAt===1?' mês':' meses'):'—';
const mMes=meta.recMes||0;if(mMes>0){g('kpiMetaVal').textContent=fmt(mMes);const p=Math.round(recM/mMes*100);g('kpiMetaBadge').className='badge '+(p>=100?'up':p>=70?'nn':'dn');g('kpiMetaBadge').textContent=p+'% atingido'}else{g('kpiMetaVal').textContent='Não definida';g('kpiMetaBadge').className='badge nn';g('kpiMetaBadge').textContent='—'}
const limDesM = desMode==='free' ? (meta.desLivre||0) : (meta.desMes||0);
if (limDesM > 0) {
  const pDesM = desM/limDesM*100;
  const diff = limDesM - desM; // positivo = falta, negativo = excedeu
  g('kpiDesBadge').className='badge '+(pDesM>100?'dn':pDesM>=80?'nn':'up');
  g('kpiDesBadge').textContent = diff >= 0
    ? `Faltam ${fmt(diff)} para o limite`
    : `Estourou em ${fmt(Math.abs(diff))}`;
} else {
  g('kpiDesBadge').className='badge '+(desM<recM?'up':desM>recM?'dn':'nn');
  g('kpiDesBadge').textContent=desM<recM?'Dentro do orçamento':desM>recM?'Acima da receita':'Zerado';
}
g('kpiSaldoBadge').className='badge '+(sM>0?'up':sM<0?'dn':'nn');g('kpiSaldoBadge').textContent=sM>0?'Positivo':sM<0?'Negativo':'Neutro';
const hj=new Date(),dR=new Date(hj.getFullYear(),hj.getMonth()+1,0).getDate()-hj.getDate();

loadMetaUI();setBar('fillRecMes','pctRecMes',recM,mMes,false);setBar('fillDesMes','pctDesMes',desM,meta.desMes||0,true);setBar('fillDesLivre','pctDesLivre',desM,meta.desLivre||0,true);
const atv=rec.map(tRec).map((v,i)=>({v,i})).filter(x=>x.v>0);
if(atv.length>=2){g('growthStrip').style.display='grid';const cr=[];for(let k=1;k<atv.length;k++)if(atv[k-1].v>0)cr.push((atv[k].v-atv[k-1].v)/atv[k-1].v*100);const med=cr.reduce((a,b)=>a+b,0)/cr.length,ult=cr[cr.length-1];const gm=g('gMed');gm.textContent=(med>=0?'+':'')+med.toFixed(1)+'%';gm.className='g-val '+(med>=0?'g':'r');const n=atv.length;let sx=0,sy=0,sxy=0,sx2=0;atv.forEach((p,idx)=>{sx+=idx;sy+=p.v;sxy+=idx*p.v;sx2+=idx*idx});const dn=n*sx2-sx*sx,slope=dn?(n*sxy-sx*sy)/dn:0;const gt=g('gTend'),ts=g('gTendSub');if(slope>50){gt.textContent='Crescendo';gt.className='g-val g';ts.textContent='tendência de alta'}else if(slope<-50){gt.textContent='Caindo';gt.className='g-val r';ts.textContent='tendência de queda'}else{gt.textContent='Estável';gt.className='g-val';ts.textContent='sem tendência clara'}}else g('growthStrip').style.display='none';
const tbR=g('tbRec');if(tbR){tbR.innerHTML='';let prev=null;rec.forEach((m,i)=>{const t=tRec(m);let vt='—',vc='';if(prev!==null&&prev>0&&t>0){const c=(t-prev)/prev*100;vt=(c>0?'+':'')+c.toFixed(1)+'%';vc=c>0?'vup':'vdn'}const ok=mMes>0&&t>=mMes&&t>0;tbR.innerHTML+=`<tr><td>${MESES[i]}</td><td class="mn">${fmt(m.fixa||0)}</td><td class="mn">${fmt(m.variavel||0)}</td><td class="mn">${fmt(m.rendimento||0)}</td><td class="mn ${ok?'cg':''}">${fmt(t)}</td><td class="${vc}">${vt}</td></tr>`;if(t>0)prev=t});g('tfRec').innerHTML=`<tr><td>Total ${anoAtual}</td><td></td><td></td><td></td><td class="cg">${fmt(somaRec)}</td><td></td></tr>`}
const tbD=g('tbDes');if(tbD){tbD.innerHTML='';const totC=CATS.map(()=>0);des.forEach((m,i)=>{const vals=CATS.map(c=>(m[c]||[]).reduce((a,e)=>a+(e.v||0),0));vals.forEach((v,ci)=>totC[ci]+=v);const tot=vals.reduce((a,b)=>a+b,0);tbD.innerHTML+=`<tr><td>${MESES[i]}</td>${vals.map(v=>`<td class="mn ${v>0?'cr':''}">${v>0?fmt(v):'—'}</td>`).join('')}<td class="mn cr">${tot>0?fmt(tot):'—'}</td></tr>`});g('tfDes').innerHTML=`<tr><td>Total ${anoAtual}</td>${totC.map(v=>`<td class="${v>0?'cr':''}">${v>0?fmt(v):'—'}</td>`).join('')}<td class="cr">${fmt(totC.reduce((a,b)=>a+b,0))}</td></tr>`}
const mesD=Number(g('desMes').value);const dl=g('desMesLabel');if(dl)dl.textContent=MESES[mesD]+' '+anoAtual;
const entries=[];CATS.forEach(c=>(des[mesD][c]||[]).forEach(e=>entries.push({...e,cat:c})));entries.sort((a,b)=>b.id-a.id);
const el=g('entryList');if(el){if(!entries.length)el.innerHTML='<div style="padding:24px;text-align:center;color:var(--ink4);font-size:12.5px">Nenhuma despesa lançada neste mês.</div>';else el.innerHTML=entries.map(e=>`<div class="entry-item"><div class="entry-left"><span class="entry-icon eic-${e.cat}"><svg width="14" height="14"><use href="#ico-${e.cat}"/></svg></span><div><div class="entry-name">${CNAME[e.cat]}</div><div class="entry-cat">${MESES[mesD]} ${anoAtual}</div></div></div><div style="display:flex;align-items:center"><span class="entry-amt">${fmt(e.v)}</span><button class="entry-del" aria-label="Remover despesa" onclick="deletarDespesa(${mesD},'${e.cat}',${e.id})">×</button></div></div>`).join('')}
const tbRl=g('tbRel');if(tbRl){tbRl.innerHTML='';let prevS=null,totR=0,totD=0,totS=0;MESES.forEach((m,i)=>{const r2=tRec(rec[i]),d2=tDes(i,des),s=r2-d2,tx=r2>0?Math.round(s/r2*100):null;totR+=r2;totD+=d2;totS+=s;let vt='—',vc='';if(prevS!==null&&prevS!==0&&s!==0){const c=(s-prevS)/Math.abs(prevS)*100;vt=(c>0?'+':'')+c.toFixed(1)+'%';vc=c>0?'vup':'vdn'}tbRl.innerHTML+=`<tr><td>${m}</td><td class="mn ${r2>0?'cg':''}">${r2>0?fmt(r2):'—'}</td><td class="mn ${d2>0?'cr':''}">${d2>0?fmt(d2):'—'}</td><td class="mn ${s>0?'cg':s<0?'cr':''}">${r2>0||d2>0?fmt(s):'—'}</td><td class="mn ${tx!==null?(tx>=50?'cg':tx>=20?'ca':'cr'):''}">${tx!==null?tx+'%':'—'}</td><td class="${vc}">${vt}</td></tr>`;if(r2>0||d2>0)prevS=s});const txT=totR>0?Math.round(totS/totR*100):null;g('tfRel').innerHTML=`<tr><td>Total ${anoAtual}</td><td class="cg">${fmt(totR)}</td><td class="cr">${fmt(totD)}</td><td class="${totS>=0?'cg':'cr'}">${fmt(totS)}</td><td>${txT!==null?txT+'%':'—'}</td><td></td></tr>`}
if(currentPage==='dashboard'){buildEvo();buildPizzaRec();buildPizzaDes();buildDiasRestantes();buildEstatisticas();renderInsights()}
if(currentPage==='despesas')renderInsights();
if(currentPage==='receitas')renderInsights();
if(currentPage==='relatorio')buildCatSummary();
if(currentPage==='metas')renderMetas();
applyPrivacy();}

// ═══════════════════════════════════════════════════
// NOVOS RECURSOS — privacidade, patrimônio, FIRE, termômetro, projeção, insights, inserção rápida
// ═══════════════════════════════════════════════════
let patrimonioMode = false;
let saldoInicial = 0;
let historicoCache = null;
let catLimits = {};
let quickTipo = 'rec';

// Patrimônio = Saldo Inicial + soma das RECEITAS de todos os anos (não subtrai despesas)
const calcPatrimonio = () => saldoInicial + (historicoCache||[]).reduce((a,h)=>a+h.rec,0);

/* ─── Privacidade ─── */
function togglePrivacy() {
  const on = document.body.classList.toggle('private');
  const ico = g('eyeIco');
  if (ico) ico.innerHTML = on ? '<use href="#ni-eye-off"/>' : '<use href="#ni-eye"/>';
  applyPrivacy();
  toast(on ? 'Modo privacidade ativado' : 'Valores visíveis');
}
function applyPrivacy() {
  const on = document.body.classList.contains('private');
  const sel = '.mn,.hero-val,.hc-val,.kpi-val,.entry-amt,.cat-val,.plg-val,.status-bar,.g-val,.sr-stat-val,.si-sub,.badge,.meta-pct,.priv,.thermo-amt,canvas';
  document.querySelectorAll(sel).forEach(e => { e.style.filter = on ? 'blur(7px)' : ''; });
}

/* ─── Patrimônio (histórico de todos os anos) ─── */
async function loadHistorico() {
  if (!sb || !currentUser) { historicoCache = []; return; }
  try {
    const [rR, rD] = await Promise.all([
      sb.from('cap_receitas').select('valor_fixa,valor_variavel,valor_rendimento,ano'),
      sb.from('cap_despesas').select('valor,ano')
    ]);
    const porAno = {};
    (rR.data||[]).forEach(r => { const a=r.ano; porAno[a]=porAno[a]||{rec:0,des:0}; porAno[a].rec += (r.valor_fixa||0)+(r.valor_variavel||0)+(r.valor_rendimento||0); });
    (rD.data||[]).forEach(r => { const a=r.ano; porAno[a]=porAno[a]||{rec:0,des:0}; porAno[a].des += (r.valor||0); });
    historicoCache = Object.keys(porAno).map(a => ({ano:+a, rec:porAno[a].rec, des:porAno[a].des, net:porAno[a].rec-porAno[a].des})).sort((x,y)=>x.ano-y.ano);
  } catch(e) { console.error('loadHistorico', e); if(!historicoCache) historicoCache = []; }
}
async function ensureHistorico() { if (historicoCache) return historicoCache; await loadHistorico(); return historicoCache; }
function togglePatrimonio(el) { patrimonioMode = el.checked; render(); }

/* ─── Saldo inicial (persistência local) ─── */
function loadSaldoInicial() {
  try { const v = localStorage.getItem('cap_saldo_inicial'+(currentUser?('_'+currentUser.id):'')); saldoInicial = v!==null ? Number(v) : 0; } catch { saldoInicial = 0; }
}
function saveSaldoInicial() {
  try { localStorage.setItem('cap_saldo_inicial'+(currentUser?('_'+currentUser.id):''), String(saldoInicial)); } catch {}
}

/* ─── Orçamentos por categoria (persistência local) ─── */
function loadCatLimits() {
  try { const s = localStorage.getItem('cap_cat_limits'+(currentUser?('_'+currentUser.id):'')); catLimits = s ? JSON.parse(s) : {}; } catch { catLimits = {}; }
}
function saveCatLimitsLS() {
  try { localStorage.setItem('cap_cat_limits'+(currentUser?('_'+currentUser.id):''), JSON.stringify(catLimits)); } catch {}
}
function buildCatLimits() {
  const grid = g('catLimitsGrid'); if (!grid) return;
  grid.innerHTML = CATS.map(c => `<div class="cat-limit-field"><label>${CNAME[c]}</label><input type="number" id="catLim_${c}" inputmode="decimal" placeholder="0,00" min="0" step="0.01" value="${catLimits[c]||''}"></div>`).join('');
}
function salvarCatLimits() {
  CATS.forEach(c => { catLimits[c] = Number(g('catLim_'+c).value) || 0; });
  saveCatLimitsLS(); render(); toast('Orçamentos salvos');
}

/* ─── Independência Financeira (FIRE / regra dos 4%) ─── */
function buildFire() {
  const fireAtual=g('fireAtual'), fireNec=g('fireNecessario'), fireBar=g('fireBar'), fireText=g('fireText');
  if(!fireAtual) return;
  const somaDes = tDesAno(des);
  const mAt = rec.filter(m=>tRec(m)>0).length;
  let gastoMedio = mAt>0 ? somaDes/mAt : 0;
  if (gastoMedio<=0 && historicoCache && historicoCache.length) {
    let td=0, ty=0; historicoCache.forEach(h=>{ if(h.des>0){td+=h.des; ty++;} });
    if (ty>0) gastoMedio = td/(ty*12);
  }
  const nec = gastoMedio*300;
  const pat = calcPatrimonio();
  const prog = nec>0 ? Math.min(pat/nec,1) : 0;
  fireAtual.textContent = fmt(pat); fireAtual.className='fire-val'+(pat<0?'':' g');
  fireNec.textContent = nec>0 ? fmt(nec) : '—';
  fireBar.style.width = (prog*100)+'%';
  if (gastoMedio<=0) fireText.innerHTML = 'Cadastre despesas para projetar sua <b>Independência Financeira</b> (regra dos 4%).';
  else fireText.innerHTML = `Com gasto médio de <b>${fmt(gastoMedio)}/mês</b>, você precisaria de <b>${fmt(nec)}</b> investidos. Você já conquistou <b>${Math.round(prog*100)}%</b> da sua meta de independência.`;
}

/* ─── Dias restantes no mês (corridos e úteis) ─── */
function buildDiasRestantes() {
  const elC=g('diasCorridos'), elU=g('diasUteis'); if(!elC||!elU) return;
  const hoje=new Date();
  const ano=hoje.getFullYear(), mesIdx=hoje.getMonth(), diaHoje=hoje.getDate();
  const diasNoMes=new Date(ano,mesIdx+1,0).getDate();
  const diasCorridosRestantes=Math.max(diasNoMes-diaHoje,0);
  let uteisTotal=0, uteisRestantes=0;
  for(let d=1; d<=diasNoMes; d++){
    const dow=new Date(ano,mesIdx,d).getDay();
    if(dow!==0 && dow!==6){
      uteisTotal++;
      if(d>diaHoje) uteisRestantes++;
    }
  }
  elC.textContent = diasCorridosRestantes + (diasCorridosRestantes===1?' dia':' dias');
  g('diasCorridosSub').textContent = 'de '+diasNoMes+' dias corridos no mês';
  elU.textContent = uteisRestantes + (uteisRestantes===1?' dia':' dias');
  g('diasUteisSub').textContent = 'de '+uteisTotal+' dias úteis no mês';
}

/* ─── Estatísticas: maior receita, maior despesa e melhor mês (exercício atual) ─── */
function buildEstatisticas() {
  const bMR=g('statMaxRec'), bMD=g('statMaxDes'), bB=g('statBest'); if(!bMR) return;
  const recVals = rec.map(tRec);
  const desVals = Array.from({length:12},(_,i)=>tDes(i,des));
  let idxR=-1, vR=0;
  recVals.forEach((v,i)=>{ if(v>vR){ vR=v; idxR=i; } });
  let idxD=-1, vD=0;
  desVals.forEach((v,i)=>{ if(v>vD){ vD=v; idxD=i; } });
  let idxB=-1, vB=-Infinity;
  recVals.forEach((v,i)=>{
    if(v>0 || desVals[i]>0){
      const net = v - desVals[i];
      if(net>vB){ vB=net; idxB=i; }
    }
  });
  const statHTML = (i,v)=> i>=0
    ? `<span class="stats-mo">${MESES[i]}</span><span class="stats-amt">${fmt(v)}</span>`
    : '<span class="stats-amt">—</span>';
  bMR.innerHTML = statHTML(idxR,vR);
  bMD.innerHTML = statHTML(idxD,vD);
  bB.innerHTML  = statHTML(idxB,vB);
}

/* ─── Projeção de saldo fim do mês ─── */
function buildProjecao() {
  const el=g('projTxt'); if(!el) return;
  const hoje=new Date();
  const dia=hoje.getDate();
  const diasMes=new Date(hoje.getFullYear(),hoje.getMonth()+1,0).getDate();
  const frac=dia/diasMes;
  const mc=hoje.getMonth();
  const recM=tRec(rec[mc]);
  const desM=tDes(mc,des);
  if (desM>0 && frac>0.04) {
    const projDes=desM/frac;
    const projSaldo=recM-projDes;
    const cls=projSaldo>=0?'pos':'neg';
    el.innerHTML=`Se você mantiver o ritmo atual de gastos, terminará <b>${MESES[mc]}</b> com saldo de <b class="${cls} priv">${fmt(projSaldo)}</b>.`;
  } else if (desM>0) {
    el.innerHTML=`Gastos de <b class="priv">${fmt(desM)}</b> em <b>${MESES[mc]}</b> — projeção disponível em alguns dias.`;
  } else {
    el.innerHTML=`Nenhum gasto registrado em <b>${MESES[mc]}</b> ainda.`;
  }
}

/* ─── Termômetro de orçamento ─── */
function thermoRow(name,v,lim,cor){
  const p = lim>0 ? (v/lim)*100 : 0;
  const col = p>=100?'var(--red)':p>=80?'var(--amber)':'var(--green)';
  return `<div class="thermo-row"><div class="thermo-top"><span class="thermo-name"><span class="dot" style="background:${cor}"></span>${name}</span><span class="thermo-amt">${fmt(v)} <span class="lim">/ ${fmt(lim)} · ${Math.round(p)}%</span></span></div><div class="thermo-track"><div class="thermo-fill" style="width:${Math.min(p,100)}%;background:${col}"></div></div></div>`;
}
function buildTermometro() {
  const body=g('thermoBody'); if(!body) return;
  const mc=new Date().getMonth();
  const lbl=g('thermoMonth'); if(lbl) lbl.textContent=MESES[mc]+' '+anoAtual;
  const temLimite = CATS.some(c=>(catLimits[c]||0)>0) || (desMode==='free'?(meta.desLivre||0)>0:(meta.desMes||0)>0);
  if(!temLimite){ body.innerHTML='<div class="thermo-empty">Nenhum orçamento definido. <a onclick="navTo(\'despesas\')">Definir limites por categoria →</a></div>'; return; }
  let rows='';
  const totLim = desMode==='free'?(meta.desLivre||0):(meta.desMes||0);
  const totDes = tDes(mc,des);
  if(totLim>0) rows+=thermoRow('Total de Despesas',totDes,totLim,'#646e82');
  CATS.forEach(c=>{ const lim=catLimits[c]||0; if(lim>0){ const v=(des[mc][c]||[]).reduce((s,e)=>s+(e.v||0),0); rows+=thermoRow(CNAME[c],v,lim,CCLR[c]); } });
  body.innerHTML = rows || '<div class="thermo-empty">Sem limites para este mês.</div>';
}

/* ─── Insights / anomalias (contextual por tela) ─── */
function buildExpenseInsights(out, mc, pm) {
  if (mc > 0) {
    CATS.forEach(c => {
      const cur = (des[mc][c]||[]).reduce((s,e)=>s+(e.v||0),0);
      const prev = (des[pm][c]||[]).reduce((s,e)=>s+(e.v||0),0);
      if (cur>0 && prev>0 && cur > prev*1.15) {
        const pct = Math.round((cur-prev)/prev*100);
        out.push({tipo:'warn', ico:'Atenção', txt:`Sua despesa com <b>${CNAME[c]}</b> aumentou <b>${pct}%</b> em relação a ${MESES[pm]}. <a onclick="navTo('despesas')">Quer revisar?</a>`});
      }
    });
  }
  const totMes = tDes(mc, des);
  const limite = desMode==='free' ? (meta.desLivre||0) : (meta.desMes||0);
  if (limite>0 && totMes>0) {
    const p = totMes/limite*100;
    if (p>100) out.push({tipo:'alert', ico:'Alerta', txt:`Você <b>estourou</b> o limite de gastos em <b>${Math.round(p-100)}%</b> (${fmt(totMes)} de ${fmt(limite)}).`});
    else if (p>=80) out.push({tipo:'warn', ico:'Atenção', txt:`Você já usou <b>${Math.round(p)}%</b> do limite mensal de gastos. Atenção ao restante do mês.`});
  }
  let maxE=null;
  CATS.forEach(c=>(des[mc][c]||[]).forEach(e=>{ if(!maxE||e.v>maxE.v) maxE={...e,cat:c}; }));
  if (maxE) {
    const arr = (des[mc][maxE.cat]||[]).map(e=>e.v);
    const avg = arr.reduce((a,b)=>a+b,0)/(arr.length||1);
    if (maxE.v > avg*2 && maxE.v > (meta.desMes||0)*0.3 && (meta.desMes||0)>0) {
      out.push({tipo:'warn', ico:'Atenção', txt:`Lançamento atípico de <b>${fmt(maxE.v)}</b> em ${CNAME[maxE.cat]}. Confira se está correto.`});
    }
  }
}
function buildRevenueInsights(out, mc, pm) {
  if (mc > 0) {
    const recCur = tRec(rec[mc]), recPrev = tRec(rec[pm]);
    if (recCur>0 && recPrev>0 && recCur < recPrev*0.8) {
      const pct = Math.round((recPrev-recCur)/recPrev*100);
      out.push({tipo:'alert', ico:'Alerta', txt:`Sua receita caiu <b>${pct}%</b> em relação a ${MESES[pm]}.`});
    } else if (recCur>0 && recPrev>0 && recCur > recPrev*1.15) {
      const pct = Math.round((recCur-recPrev)/recPrev*100);
      out.push({tipo:'warn', ico:'Atenção', txt:`Sua receita subiu <b>${pct}%</b> em relação a ${MESES[pm]}.`});
    }
  }
  const mMes = meta.recMes||0, recM = tRec(rec[mc]);
  if (mMes>0 && recM>0 && recM<mMes) {
    const hoje=new Date(), diasMes=new Date(hoje.getFullYear(),hoje.getMonth()+1,0).getDate();
    if (hoje.getDate()/diasMes >= 0.5) {
      const p = Math.round(recM/mMes*100);
      out.push({tipo:'warn', ico:'Atenção', txt:`Você está com <b>${p}%</b> da meta mensal de receita (${fmt(recM)} de ${fmt(mMes)}) e já passamos da metade do mês.`});
    }
  }
}
function buildPatrimonioInsights(out) {
  const pat = calcPatrimonio();
  if (historicoCache && historicoCache.length>=2) {
    const ult = historicoCache[historicoCache.length-1];
    const pen = historicoCache[historicoCache.length-2];
    if (ult.rec>0 && pen.rec>0) {
      const pct = Math.round((ult.rec-pen.rec)/pen.rec*100);
      if (pct <= -10) out.push({tipo:'alert', ico:'Alerta', txt:`Sua receita acumulada em <b>${ult.ano}</b> caiu <b>${Math.abs(pct)}%</b> vs. ${pen.ano} (${fmt(ult.rec)} de ${fmt(pen.rec)}).`});
      else if (pct >= 10) out.push({tipo:'warn', ico:'Atenção', txt:`Sua receita acumulada em <b>${ult.ano}</b> cresceu <b>${pct}%</b> vs. ${pen.ano}.`});
    }
  }
  const somaDes = tDesAno(des);
  const mAt = rec.filter(m=>tRec(m)>0).length;
  let gastoMedio = mAt>0 ? somaDes/mAt : 0;
  if (gastoMedio<=0 && historicoCache && historicoCache.length) { let td=0,ty=0; historicoCache.forEach(h=>{if(h.des>0){td+=h.des;ty++;}}); if(ty>0) gastoMedio=td/(ty*12); }
  const nec = gastoMedio*300;
  if (nec>0) {
    const prog = Math.min(pat/nec,1);
    if (prog<0.25) out.push({tipo:'warn', ico:'Atenção', txt:`Você conquistou <b>${Math.round(prog*100)}%</b> da meta de independência financeira (regra dos 4%).`});
  }
}
function buildInsights(ctx) {
  const out = [];
  const mc = new Date().getMonth();
  const pm = mc>0 ? mc-1 : 0;
  if (ctx==='despesas') buildExpenseInsights(out, mc, pm);
  else if (ctx==='receitas') buildRevenueInsights(out, mc, pm);
  else if (ctx==='patrimonio') buildPatrimonioInsights(out);
  else { buildExpenseInsights(out, mc, pm); buildRevenueInsights(out, mc, pm); }
  return out;
}
function renderInsights() {
  const dashCtx = patrimonioMode ? 'patrimonio' : 'all';
  const fill = (bodyId, badgeId, ctx) => {
    const ins = buildInsights(ctx);
    const body = g(bodyId);
    if (body) body.innerHTML = ins.length
      ? ins.map(i=>`<div class="insight-item ${i.tipo}"><span class="insight-ico">${i.ico}</span><div class="insight-txt">${i.txt}</div></div>`).join('')
      : '<div class="insight-ok">Tudo sob controle. Nenhum comportamento atípico detectado.</div>';
    const badge = g(badgeId);
    if (badge) badge.textContent = ins.length;
  };
  fill('insightsBody','insightBadge', dashCtx);
  fill('insightsBodyD','insightBadgeD', 'despesas');
  fill('insightsBodyR','insightBadgeR', 'receitas');
  const insDash = buildInsights(dashCtx);
  const bell = g('bellBadge');
  if (bell) { if(insDash.length>0){bell.style.display='flex';bell.textContent=insDash.length;} else bell.style.display='none'; }
}
function abrirAlertas(){ navTo('dashboard'); setTimeout(()=>{ const c=g('insightsCard'); if(c){ c.scrollIntoView({behavior:'smooth',block:'center'}); c.style.boxShadow='var(--shadow-lg)'; setTimeout(()=>c.style.boxShadow='',1600);} }, 260); }

/* ─── Inserção rápida (FAB + tecla N) ─── */
function setQuickTipo(t) {
  quickTipo = t;
  g('qRec').className = 'mode-btn ' + (t==='rec' ? 'm-linked' : '');
  g('qDes').className = 'mode-btn ' + (t==='des' ? 'm-free' : '');
  fillQuickCat();
  if(typeof atualizarOrigemRendimento==='function')atualizarOrigemRendimento();
}
function fillQuickCat() {
  const sel=g('qCat'); if(!sel) return; sel.innerHTML='';
  if(quickTipo==='rec'){
    g('qCatLabel').textContent='Origem';
    [['fixa','Salário / renda regular'],['variavel','Renda extra'],['rendimento','Rendimento']].forEach(([v,n])=>{const o=document.createElement('option');o.value=v;o.textContent=n;sel.appendChild(o);});
  } else {
    g('qCatLabel').textContent='Categoria';
    CATS.forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=CNAME[c];sel.appendChild(o);});
  }
}
function abrirQuick() {
  fillQuickCat();
  const qm=g('qMes'); if(qm){ qm.innerHTML=''; MESES.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m;qm.appendChild(o);}); qm.value=new Date().getMonth(); }
  g('qValor').value='';
  setQuickTipo('rec');
  g('quickOverlay').classList.add('open'); document.body.style.overflow='hidden';
  setTimeout(()=>g('qValor').focus(),150);
}
function fecharQuick(){ g('quickOverlay').classList.remove('open'); document.body.style.overflow=''; }
function fecharQuickFora(e){ if(e.target===g('quickOverlay')) fecharQuick(); }
async function quickSalvar() {
  const v=Number(g('qValor').value);
  if(!Number.isFinite(v)||v<=0){ toast('Informe um valor válido'); return; }
  const mes=Number(g('qMes').value);
  if(quickTipo==='rec'){ const orig=g('qCat').value,ativo=obterOrigemRendimento('qCarteira');if(ativo===false)return;if(await doSaveReceita(mes,orig,v,ativo))fecharQuick(); }
  else { const cat=g('qCat').value; const ok=await doSaveDespesa(mes,cat,v); if(ok!==false) fecharQuick(); }
}

/* ─── Nota de atualização (aparece uma vez) ─── */
const WHATSNEW_KEY='cap_novidades_carteira_completa_v1';
const CARTEIRA_HELP_KEY='cap_ajuda_carteira_v1';
const onboardingVistos=new Set();
let onboardingAberto=null;
function chaveOnboarding(base){return base+'_'+(currentUser?.id||'visitante');}
function onboardingVisto(base){const k=chaveOnboarding(base);if(onboardingVistos.has(k))return true;try{return localStorage.getItem(k)==='1';}catch{return false;}}
function abrirOnboarding(id,base){
  if(onboardingAberto)return;
  const overlay=g(id);if(!overlay)return;
  onboardingAberto={id,key:chaveOnboarding(base),focus:document.activeElement,overflow:document.body.style.overflow};
  overlay.classList.add('open');document.body.style.overflow='hidden';
  overlay.querySelector('[role="dialog"]').focus();
}
function encerrarOnboarding(marcar=true){
  const state=onboardingAberto;if(!state)return;
  if(marcar){onboardingVistos.add(state.key);try{localStorage.setItem(state.key,'1');}catch{}}
  g(state.id)?.classList.remove('open');document.body.style.overflow=state.overflow;onboardingAberto=null;
  if(state.focus?.isConnected)state.focus.focus();
}
function verificarWhatsNew(){
  if(!currentUser||onboardingAberto)return;
  if(!onboardingVisto(WHATSNEW_KEY))abrirOnboarding('whatsnewOverlay',WHATSNEW_KEY);
  else if(currentPage==='carteira')verificarAjudaCarteira();
}
function fecharWhatsNew(){
  if(onboardingAberto?.id!=='whatsnewOverlay')return;
  encerrarOnboarding();if(currentPage==='carteira')verificarAjudaCarteira();
}
function fecharWhatsNewFora(e){if(e.target===g('whatsnewOverlay'))fecharWhatsNew();}
function verificarAjudaCarteira(){
  if(!currentUser||onboardingAberto)return;
  if(!onboardingVisto(WHATSNEW_KEY)){verificarWhatsNew();return;}
  if(!onboardingVisto(CARTEIRA_HELP_KEY))abrirOnboarding('carteiraAjudaOverlay',CARTEIRA_HELP_KEY);
}
function abrirAjudaCarteira(){if(!onboardingAberto)abrirOnboarding('carteiraAjudaOverlay',CARTEIRA_HELP_KEY);}
function fecharAjudaCarteira(){if(onboardingAberto?.id==='carteiraAjudaOverlay')encerrarOnboarding();}
function fecharAjudaCarteiraFora(e){if(e.target===g('carteiraAjudaOverlay'))fecharAjudaCarteira();}
document.addEventListener('keydown',e=>{
  if(!onboardingAberto)return;
  if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(onboardingAberto.id==='whatsnewOverlay')fecharWhatsNew();else fecharAjudaCarteira();return;}
  if(e.key==='Tab'){
    const dialog=g(onboardingAberto.id).querySelector('[role="dialog"]'),buttons=[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')];
    const first=buttons[0],last=buttons[buttons.length-1];
    if(!first){e.preventDefault();dialog.focus();}
    else if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&(document.activeElement===last||document.activeElement===dialog)){e.preventDefault();first.focus();}
  }
},true);

// BANNER + TOAST
let bannerTmr;
function showBanner(msg){clearTimeout(bannerTmr);g('bannerTxt').textContent=msg;g('metaBanner').classList.add('show');bannerTmr=setTimeout(closeBanner,5000)}
function closeBanner(){g('metaBanner').classList.remove('show')}
let toastTmr;
function toast(msg){clearTimeout(toastTmr);const t=g('toast');t.textContent=msg;t.classList.add('show');toastTmr=setTimeout(()=>t.classList.remove('show'),2800)}

// WIZARD
function abrirWizard(editIdx){wizEmoji=null;g('wizNome').value='';g('wizDesc').value='';g('wizValor').value='';g('wizJaTenho').value='';g('wizPrazo').value='';g('wizPreview').style.display='none';const dg=g('dreamGrid');dg.innerHTML=DREAMS.map(d=>`<div class="dream-card" data-id="${d.id}" onclick="selecionarDream('${d.id}')"><span class="dream-ico">${d.emoji}</span><div class="dream-name">${d.label}</div></div>`).join('');const mi=g('wizMesInicio');mi.innerHTML='';const now=new Date();for(let i=0;i<12;i++){const d=new Date(now.getFullYear(),now.getMonth()+i,1);const o=document.createElement('option');o.value=`${d.getFullYear()}-${d.getMonth()}`;o.textContent=MESES[d.getMonth()]+' '+d.getFullYear();mi.appendChild(o)}const ov=g('wizOverlay');if(editIdx!==undefined){const s=sonhos[editIdx];g('wizTitle').textContent='Editar Meta';g('wizNome').value=s.nome;g('wizDesc').value=s.desc||'';g('wizValor').value=s.valor;g('wizJaTenho').value=s.jaTenho||0;g('wizPrazo').value=s.prazo;wizEmoji=s.emoji;ov.dataset.editIdx=editIdx;const mVal=`${s.anoInicio}-${s.mesInicio}`;setTimeout(()=>{Array.from(mi.options).forEach(o=>{if(o.value===mVal)o.selected=true});document.querySelectorAll('.dream-card').forEach(c=>c.classList.toggle('selected',c.dataset.id===s.dreamId))},50)}else{g('wizTitle').textContent='Nova Meta';delete ov.dataset.editIdx}ov.classList.add('open');document.body.style.overflow='hidden';showWizStep(1);setTimeout(()=>g('wizNome').focus(),200)}
function fecharWizard(){g('wizOverlay').classList.remove('open');document.body.style.overflow=''}
function fecharWizardFora(e){if(e.target===g('wizOverlay'))fecharWizard()}
function selecionarDream(id){document.querySelectorAll('.dream-card').forEach(c=>c.classList.toggle('selected',c.dataset.id===id));const d=DREAMS.find(x=>x.id===id);if(d)wizEmoji=d.emoji}
function showWizStep(n){[1,2,3].forEach(i=>{g('wp'+i).classList.toggle('active',i===n);const ws=g('ws'+i);ws.classList.remove('cur','done');if(i<n)ws.classList.add('done');else if(i===n)ws.classList.add('cur')})}
function wizNext(from){if(from===1){if(!g('wizNome').value.trim()){toast('Dê um nome para a meta');return}showWizStep(2)}else if(from===2){if(!wizEmoji){toast('Escolha uma imagem');return}showWizStep(3);calcWizPreview()}}
function wizBack(from){showWizStep(from-1)}
function calcWizPreview(){const valor=Number(g('wizValor').value)||0,jaTenho=Number(g('wizJaTenho').value)||0,prazo=Number(g('wizPrazo').value)||0;const preview=g('wizPreview');if(valor>0&&prazo>0){const falta=Math.max(valor-jaTenho,0),porMes=falta/prazo;const miVal=g('wizMesInicio').value||`${new Date().getFullYear()}-${new Date().getMonth()}`;const[ano2,mes2]=miVal.split('-').map(Number);const dataFim=new Date(ano2,mes2+prazo,1);g('wizPreviewMes').textContent=fmt(porMes);g('wizPreviewFalta').textContent=fmt(falta);g('wizPreviewData').textContent=MESES[dataFim.getMonth()]+' '+dataFim.getFullYear();preview.style.display='block'}else preview.style.display='none'}
async function salvarMeta(){const nome=g('wizNome').value.trim(),valor=Number(g('wizValor').value)||0,prazo=Number(g('wizPrazo').value)||0;if(!nome){toast('Dê um nome para a meta');return}if(!isFinite(valor)||valor<=0){toast('Informe o valor da meta');return}if(!isFinite(prazo)||prazo<=0){toast('Informe o prazo em meses');return}if(!wizEmoji){toast('Escolha uma imagem');return}const dreamId=document.querySelector('.dream-card.selected')?.dataset.id||'outro';const miVal=g('wizMesInicio').value||`${new Date().getFullYear()}-${new Date().getMonth()}`;const[anoI,mesI]=miVal.split('-').map(Number);const ov=g('wizOverlay');const editIdx=ov.dataset.editIdx!==undefined?Number(ov.dataset.editIdx):-1;const obj={id:editIdx>=0?sonhos[editIdx].id:null,nome,desc:g('wizDesc').value.trim(),emoji:wizEmoji,dreamId,valor,jaTenho:Number(g('wizJaTenho').value)||0,prazo,anoInicio:anoI,mesInicio:mesI,aportes:editIdx>=0?sonhos[editIdx].aportes:[]};const{id:newId,error}=await sbSaveMeta(obj);if(error){console.error('salvarMeta',error);toast('Erro ao salvar meta');return}if(newId)obj.id=newId;if(editIdx>=0)sonhos[editIdx]=obj;else sonhos.push(obj);fecharWizard();sonhoAtivo=editIdx>=0?editIdx:sonhos.length-1;renderMetas();toast('Meta salva!')}

// METAS
function buildAporteMes(){const el=g('aporteMes');if(!el)return;const cur=el.value;el.innerHTML='';MESES.forEach((m,i)=>{const o=document.createElement('option');o.value=i;o.textContent=m;el.appendChild(o)});el.value=cur!==''?cur:new Date().getMonth()}
async function lancarAporte(){if(sonhoAtivo===null||sonhoAtivo>=sonhos.length){toast('Selecione uma meta');return}const v=Number(g('aporteVal').value);if(!v||!isFinite(v)||v<=0){toast('Informe um valor válido');return}const mes=Number(g('aporteMes').value);const aporte={v,mes,ano:anoAtual,id:Date.now()};sonhos[sonhoAtivo].aportes.push(aporte);g('aporteVal').value='';toast('+\u00a0'+fmt(v)+' registrado');renderDetalhe();const{error}=await sbUpdateAportes(sonhos[sonhoAtivo].id,sonhos[sonhoAtivo].aportes);if(error){console.error('lancarAporte',error);sonhos[sonhoAtivo].aportes=sonhos[sonhoAtivo].aportes.filter(a=>a.id!==aporte.id);toast('Erro ao salvar aporte');renderDetalhe()}}
function renderMetas(){buildAporteMes();const list=g('sonhoList'),det=g('sonhoDetalhe'),emp=g('sonhoEmpty');if(!sonhos.length){list.innerHTML='';det.style.display='none';emp.style.display='block';return}emp.style.display='none';const totalAcum=s=>s.aportes.reduce((a,e)=>a+(e.v||0),0)+(s.jaTenho||0);list.innerHTML=sonhos.map((s,i)=>{const ac=totalAcum(s),pct=s.valor>0?Math.min(Math.round(ac/s.valor*100),100):0;return`<div class="sonho-item ${i===sonhoAtivo?'active-goal':''}" onclick="selecionarMeta(${i})"><div class="si-top"><div class="si-ico">${s.emoji}</div><div class="si-info"><div class="si-name">${escHtml(s.nome)}</div><div class="si-sub">${fmt(ac)} <span style="color:var(--ink5)">/ ${fmt(s.valor)}</span></div></div><div class="si-pct">${pct}%</div><button class="si-del" aria-label="Excluir meta" onclick="event.stopPropagation();deletarMeta(${i})">×</button></div><div class="si-bar"><div class="si-bar-fill" style="width:${pct}%"></div></div></div>`}).join('');if(sonhoAtivo!==null&&sonhoAtivo<sonhos.length){det.style.display='block';renderDetalhe()}else det.style.display='none'}
function selecionarMeta(i){sonhoAtivo=i;buildAporteMes();renderMetas();window.scrollTo({top:0,behavior:'smooth'})}
function renderDetalhe(){
  if(sonhoAtivo===null||sonhoAtivo>=sonhos.length)return;
  const s=sonhos[sonhoAtivo];
  const acumulado=s.aportes.reduce((a,e)=>a+(e.v||0),0)+(s.jaTenho||0);
  const pct=s.valor>0?Math.min(acumulado/s.valor,1):0;
  const falta=Math.max(s.valor-acumulado,0);

  // Data de conclusão (fixa, definida na criação da meta)
  const dataFim=new Date(s.anoInicio,s.mesInicio+s.prazo,1);

  // Meses que REALMENTE restam a partir de hoje até a conclusão
  const hoje=new Date();
  let mesesRestantes=(dataFim.getFullYear()-hoje.getFullYear())*12+(dataFim.getMonth()-hoje.getMonth());
  if(mesesRestantes<1)mesesRestantes=1; // evita divisão por zero ou negativo (meta já vencida)

  const porMes=falta>0?falta/mesesRestantes:0;

  g('sdEmoji').textContent=s.emoji;
  g('sdTitulo').textContent=s.nome;
  g('sdSub').textContent=s.desc||'';
  g('sdAcumulado').textContent=fmt(acumulado);
  g('sdObjetivo').textContent=fmt(s.valor);
  g('sdFalta').textContent=fmt(falta);
  g('sdPorMes').textContent=fmt(porMes);
  g('sdPrazo').textContent=MESES[dataFim.getMonth()]+' '+dataFim.getFullYear();

  const arcLen=276,offset=arcLen-pct*arcLen;
  const arcEl=g('arcFill');
  arcEl.style.strokeDashoffset=offset;
  arcEl.style.stroke=pct>=1?'#2dbd6e':pct>=0.5?'#f0a830':'#6090f8';
  g('arcPct').textContent=Math.round(pct*100)+'%';
  g('arcLbl').textContent=pct>=1?'Concluída!':'do objetivo';
  g('projBadge').textContent=pct>=1?'Concluída':`${s.prazo} meses`;
  g('projBadge').className='badge '+(pct>=1?'up':'nn');

  const tbody=g('projBody');
  tbody.innerHTML='';
  let acum=s.jaTenho||0,metaBatida=false;
  for(let i=0;i<s.prazo;i++){
    const mesIdx=(s.mesInicio+i)%12,anoP=s.anoInicio+Math.floor((s.mesInicio+i)/12);
    const aporte=s.aportes.filter(a=>a.mes===mesIdx&&a.ano===anoP).reduce((sum,a)=>sum+(a.v||0),0);
    acum+=aporte;
    const pctRow=s.valor>0?Math.min(acum/s.valor*100,100):0;
    const now=new Date(),isCur=anoP===now.getFullYear()&&mesIdx===now.getMonth();
    const isDone=acum>=s.valor&&!metaBatida,isPast=new Date(anoP,mesIdx+1,0)<now;
    let rowClass='';
    if(isDone){rowClass='proj-done';metaBatida=true}else if(isCur)rowClass='proj-cur';
    const status=acum>=s.valor?'✓':isPast&&aporte===0?'–':isCur?'►':'·';
    tbody.innerHTML+=`<tr class="${rowClass}"><td>${MABR[mesIdx]} ${anoP}</td><td class="mn">${aporte>0?fmt(aporte):'—'}</td><td class="mn ${acum>0?'cg':''}">${fmt(acum)}</td><td class="proj-bar-cell"><div class="proj-bar-outer"><div class="proj-bar-inner" style="width:${pctRow}%"></div></div></td><td style="text-align:center;font-weight:600;color:${acum>=s.valor?'var(--green)':'var(--ink4)'}">${status}</td></tr>`;
  }
}

/* ══════════════════════════════════════════════════════════════
   RELATÓRIO PDF
   ══════════════════════════════════════════════════════════════ */
function gerarPDF(){
  const nf = v => (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const money = v => 'R$ ' + nf(v);
  const esc = t => String(t==null?'':t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  /* ── dados ── */
  const recArr = rec.map(tRec);
  const desArr = Array.from({length:12},(_,i)=>tDes(i,des));
  const salArr = recArr.map((v,i)=>v-desArr[i]);
  const totRec = recArr.reduce((a,b)=>a+b,0);
  const totDes = desArr.reduce((a,b)=>a+b,0);
  const totSal = totRec-totDes;
  const ativos = recArr.map((v,i)=>(v>0||desArr[i]>0)?i:-1).filter(i=>i>=0);
  const nAtivos = ativos.length||1;
  const mediaRec = totRec/nAtivos, mediaDes = totDes/nAtivos;
  const txPoup = totRec>0 ? (totSal/totRec*100) : 0;
  const maxAbs = Math.max(...recArr,...desArr,1);

  let iMaxR=-1,vMaxR=0; recArr.forEach((v,i)=>{if(v>vMaxR){vMaxR=v;iMaxR=i}});
  let iMaxD=-1,vMaxD=0; desArr.forEach((v,i)=>{if(v>vMaxD){vMaxD=v;iMaxD=i}});
  let iBest=-1,vBest=-Infinity; salArr.forEach((v,i)=>{if((recArr[i]>0||desArr[i]>0)&&v>vBest){vBest=v;iBest=i}});

  /* categorias */
  const catVals = CATS.map(c => Array.from({length:12},(_,i)=>(des[i][c]||[]).reduce((s,e)=>s+(e.v||0),0)).reduce((a,b)=>a+b,0));
  const catTot = catVals.reduce((a,b)=>a+b,0);
  const catRows = CATS.map((c,i)=>({nome:CNAME[c],cor:CCLR[c],v:catVals[i],p:catTot>0?catVals[i]/catTot*100:0}))
                      .filter(x=>x.v>0).sort((a,b)=>b.v-a.v);

  /* receitas por tipo */
  const rFixa = rec.reduce((a,m)=>a+(m.fixa||0),0);
  const rVar  = rec.reduce((a,m)=>a+(m.variavel||0),0);
  const rRend = rec.reduce((a,m)=>a+(m.rendimento||0),0);
  const recRows = [
    {nome:'Renda Fixa',     cor:'#1c7a45', v:rFixa},
    {nome:'Renda Variável', cor:'#4a70c8', v:rVar },
    {nome:'Rendimento',     cor:'#8250d2', v:rRend}
  ].filter(x=>x.v>0).map(x=>Object.assign(x,{p:totRec>0?x.v/totRec*100:0}));

  /* usuário e data */
  const uNome = (currentUser && (currentUser.user_metadata?.name || currentUser.email?.split('@')[0])) || 'Usuário';
  const hoje  = new Date();
  const dataStr = hoje.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});
  const horaStr = hoje.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});

  /* ── gráfico de barras em SVG ── */
  const W=760,H=190,pad=26,bw=(W-pad*2)/12;
  let bars='';
  for(let i=0;i<12;i++){
    const hR = Math.round(recArr[i]/maxAbs*(H-46));
    const hD = Math.round(desArr[i]/maxAbs*(H-46));
    const x  = pad + i*bw;
    const w  = bw*0.30;
    const gap= bw*0.06;
    const xR = x + bw/2 - w - gap/2;
    const xD = x + bw/2 + gap/2;
    if(hR>0) bars += `<rect x="${xR.toFixed(1)}" y="${H-28-hR}" width="${w.toFixed(1)}" height="${hR}" rx="3" fill="#1c7a45"/>`;
    if(hD>0) bars += `<rect x="${xD.toFixed(1)}" y="${H-28-hD}" width="${w.toFixed(1)}" height="${hD}" rx="3" fill="#b02020"/>`;
    bars += `<text x="${(x+bw/2).toFixed(1)}" y="${H-10}" text-anchor="middle" font-size="9" fill="#999" font-family="DM Mono,monospace">${MABR[i]}</text>`;
  }
  const grid = [0,.25,.5,.75,1].map(f=>{
    const y = H-28-(H-46)*f;
    return `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${W-pad}" y2="${y.toFixed(1)}" stroke="#e8e6e0" stroke-width="1"/>`;
  }).join('');
  const chartSVG = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">${grid}${bars}</svg>`;

  /* ── donut de categorias em SVG ── */
  function donut(rows,total){
    if(!rows.length) return '<div class="empty">Sem dados no período.</div>';
    const cx=78,cy=78,r=58,sw=26,C=2*Math.PI*r;
    let off=0, segs='';
    rows.forEach(x=>{
      const frac = total>0 ? x.v/total : 0;
      const len  = frac*C;
      segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${x.cor}" stroke-width="${sw}"
                stroke-dasharray="${(len-2>0?len-2:len).toFixed(2)} ${(C-len+2).toFixed(2)}"
                stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      off += len;
    });
    return `<svg viewBox="0 0 156 156" width="156" height="156" xmlns="http://www.w3.org/2000/svg">${segs}
      <text x="78" y="74" text-anchor="middle" font-size="8" fill="#999" font-family="DM Sans,sans-serif" letter-spacing="1">TOTAL</text>
      <text x="78" y="90" text-anchor="middle" font-size="12" fill="#1a1a1a" font-family="DM Mono,monospace">${esc(money(total))}</text>
    </svg>`;
  }

  const legenda = rows => rows.map(x=>`
    <div class="lg">
      <span class="lgd" style="background:${x.cor}"></span>
      <span class="lgn">${esc(x.nome)}</span>
      <span class="lgv">${esc(money(x.v))}<em>${x.p.toFixed(1)}%</em></span>
    </div>`).join('');

  /* ── tabela mensal ── */
  const linhas = MESES.map((m,i)=>{
    const vazio = recArr[i]===0 && desArr[i]===0;
    const tx = recArr[i]>0 ? (salArr[i]/recArr[i]*100) : null;
    return `<tr class="${vazio?'off':''}">
      <td class="l">${m}</td>
      <td>${recArr[i]>0?esc(money(recArr[i])):'—'}</td>
      <td>${desArr[i]>0?esc(money(desArr[i])):'—'}</td>
      <td class="${salArr[i]>0?'pos':salArr[i]<0?'neg':''}">${vazio?'—':esc(money(salArr[i]))}</td>
      <td>${tx!==null?tx.toFixed(0)+'%':'—'}</td>
    </tr>`;
  }).join('');

  /* ── metas ── */
  let metasHTML = '';
  if(typeof sonhos!=='undefined' && sonhos.length){
    metasHTML = `
    <section class="blk">
      <h2>Metas</h2>
      <div class="metas">
        ${sonhos.map(s=>{
          const ac = (s.jaTenho||0) + (s.aportes||[]).reduce((a,x)=>a+(x.v||0),0);
          const p  = s.valor>0 ? Math.min(ac/s.valor*100,100) : 0;
          return `<div class="meta">
            <div class="meta-h">
              <span class="meta-e">${esc(s.emoji||'⭐')}</span>
              <span class="meta-n">${esc(s.nome)}</span>
              <span class="meta-p">${p.toFixed(0)}%</span>
            </div>
            <div class="meta-b"><i style="width:${p.toFixed(1)}%"></i></div>
            <div class="meta-f"><span>${esc(money(ac))}</span><span>de ${esc(money(s.valor))}</span></div>
          </div>`;
        }).join('')}
      </div>
    </section>`;
  }

  /* ── documento ── */
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<title>Capita — Relatório ${anoAtual}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  @page{size:A4;margin:14mm 13mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',system-ui,sans-serif;color:#1a1a1a;background:#fff;font-size:10.5px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .mono{font-family:'DM Mono',monospace;font-variant-numeric:tabular-nums}

  /* CAPA / CABEÇALHO */
  .head{background:linear-gradient(135deg,#0a0a0a 0%,#16150f 55%,#0a0a0a 100%);color:#f0ede8;border-radius:14px;padding:26px 28px;position:relative;overflow:hidden;margin-bottom:18px}
  .head::after{content:'';position:absolute;right:-70px;top:-90px;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(45,189,110,.20),transparent 68%)}
  .head-top{display:flex;justify-content:space-between;align-items:flex-start;position:relative;z-index:1}
  .brand{font-family:'DM Serif Display',Georgia,serif;font-style:italic;font-size:30px;letter-spacing:-.5px;line-height:1}
  .brand small{display:block;font-family:'DM Sans',sans-serif;font-style:normal;font-size:7.5px;letter-spacing:3.4px;text-transform:uppercase;color:rgba(240,237,232,.42);margin-top:7px}
  .head-meta{text-align:right;font-size:9px;color:rgba(240,237,232,.5);line-height:1.7}
  .head-meta b{color:rgba(240,237,232,.9);font-weight:500}
  .head-rule{height:1px;background:rgba(240,237,232,.14);margin:20px 0 16px;position:relative;z-index:1}
  .head-cols{display:flex;gap:26px;position:relative;z-index:1}
  .hc{flex:1}
  .hc-l{font-size:7.5px;text-transform:uppercase;letter-spacing:1.6px;color:rgba(240,237,232,.4);margin-bottom:5px}
  .hc-v{font-family:'DM Mono',monospace;font-size:15px;font-variant-numeric:tabular-nums}
  .hc-v.g{color:#3ddc84}.hc-v.r{color:#ff7b7b}.hc-v.b{color:#7fa8ff}

  /* BLOCOS */
  .blk{margin-bottom:16px;break-inside:avoid}
  h2{font-size:8.5px;text-transform:uppercase;letter-spacing:1.7px;color:#888;font-weight:600;margin-bottom:9px;padding-bottom:6px;border-bottom:1px solid #e8e6e0;display:flex;align-items:center;gap:7px}
  h2::before{content:'';width:4px;height:4px;border-radius:50%;background:#0a0a0a}

  /* KPIs */
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
  .kpi{border:1px solid #e8e6e0;border-radius:10px;padding:11px 12px;background:#faf9f6;position:relative;overflow:hidden}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--c,#0a0a0a);opacity:.55}
  .kpi-l{font-size:7px;text-transform:uppercase;letter-spacing:1.3px;color:#999;margin-bottom:5px}
  .kpi-v{font-family:'DM Mono',monospace;font-size:13px;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
  .kpi-s{font-size:8px;color:#aaa;margin-top:3px}

  /* GRÁFICO */
  .chart{border:1px solid #e8e6e0;border-radius:10px;padding:12px 10px 6px;background:#fff}
  .clg{display:flex;gap:14px;justify-content:center;margin-top:2px;font-size:8.5px;color:#888}
  .clg span{display:inline-flex;align-items:center;gap:5px}
  .clg i{width:7px;height:7px;border-radius:2px;display:inline-block}

  /* DUAS COLUNAS */
  .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .box{border:1px solid #e8e6e0;border-radius:10px;padding:13px 14px;background:#fff}
  .box h3{font-size:8px;text-transform:uppercase;letter-spacing:1.4px;color:#999;font-weight:600;margin-bottom:10px}
  .dnut{display:flex;align-items:center;gap:12px}
  .dnut>div:last-child{flex:1;min-width:0}
  .lg{display:flex;align-items:center;gap:7px;padding:3.5px 0;border-bottom:1px solid #f2f0ec}
  .lg:last-child{border-bottom:none}
  .lgd{width:7px;height:7px;border-radius:2px;flex-shrink:0}
  .lgn{font-size:9px;color:#3d3d3d;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lgv{font-family:'DM Mono',monospace;font-size:9px;color:#1a1a1a;text-align:right;white-space:nowrap}
  .lgv em{display:block;font-style:normal;font-size:7.5px;color:#aaa}
  .empty{font-size:9px;color:#aaa;padding:16px 0;text-align:center}

  /* TABELA */
  table{width:100%;border-collapse:collapse;font-size:9.5px;font-variant-numeric:tabular-nums}
  thead th{font-size:7.5px;text-transform:uppercase;letter-spacing:1.2px;color:#999;font-weight:600;padding:7px 9px;text-align:right;border-bottom:1.5px solid #e0ded8;background:#faf9f6}
  thead th:first-child{text-align:left;border-radius:7px 0 0 0}
  thead th:last-child{border-radius:0 7px 0 0}
  tbody td{padding:6.5px 9px;text-align:right;border-bottom:1px solid #f2f0ec;font-family:'DM Mono',monospace;color:#3d3d3d}
  tbody td.l{text-align:left;font-family:'DM Sans',sans-serif;color:#1a1a1a;font-weight:500}
  tbody tr.off td{color:#c8c5be}
  tbody tr:nth-child(even) td{background:#fcfbf9}
  td.pos{color:#1c7a45}td.neg{color:#b02020}
  tfoot td{padding:8px 9px;text-align:right;font-family:'DM Mono',monospace;font-weight:600;border-top:1.5px solid #d8d5ce;background:#f5f4f0}
  tfoot td:first-child{text-align:left;font-family:'DM Sans',sans-serif;letter-spacing:.3px}

  /* METAS */
  .metas{display:grid;grid-template-columns:1fr 1fr;gap:9px}
  .meta{border:1px solid #e8e6e0;border-radius:10px;padding:11px 12px;background:#faf9f6}
  .meta-h{display:flex;align-items:center;gap:7px;margin-bottom:8px}
  .meta-e{font-size:14px}
  .meta-n{flex:1;font-size:10px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta-p{font-family:'DM Mono',monospace;font-size:11px}
  .meta-b{height:5px;background:#eae8e2;border-radius:5px;overflow:hidden}
  .meta-b i{display:block;height:5px;border-radius:5px;background:linear-gradient(90deg,#228b4f,#1c7a45)}
  .meta-f{display:flex;justify-content:space-between;font-family:'DM Mono',monospace;font-size:8px;color:#999;margin-top:5px}

  /* RODAPÉ */
  .foot{margin-top:20px;padding-top:11px;border-top:1px solid #e8e6e0;display:flex;justify-content:space-between;font-size:8px;color:#aaa}
  .foot b{color:#777;font-weight:500}

  .noprint{position:fixed;top:14px;right:14px;display:flex;gap:8px;z-index:99}
  .noprint button{font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;padding:10px 20px;border-radius:10px;border:none;cursor:pointer;background:#0a0a0a;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.22)}
  .noprint button.sec{background:#fff;color:#3d3d3d;border:1px solid #ddd}
  @media print{.noprint{display:none!important}body{font-size:10px}}
</style></head><body>

<div class="noprint">
  <button class="sec" onclick="window.close()">Fechar</button>
  <button onclick="window.print()">Salvar PDF</button>
</div>

<div class="head">
  <div class="head-top">
    <div class="brand">Capita<small>Finanças Pessoais</small></div>
    <div class="head-meta">
      Relatório Anual · <b>${anoAtual}</b><br>
      ${esc(uNome)}<br>
      ${esc(dataStr)} · ${esc(horaStr)}
    </div>
  </div>
  <div class="head-rule"></div>
  <div class="head-cols">
    <div class="hc"><div class="hc-l">Receitas</div><div class="hc-v g">${esc(money(totRec))}</div></div>
    <div class="hc"><div class="hc-l">Despesas</div><div class="hc-v r">${esc(money(totDes))}</div></div>
    <div class="hc"><div class="hc-l">Saldo Líquido</div><div class="hc-v ${totSal<0?'r':'g'}">${esc(money(totSal))}</div></div>
    <div class="hc"><div class="hc-l">Taxa de Poupança</div><div class="hc-v b">${txPoup.toFixed(1)}%</div></div>
  </div>
</div>

<section class="blk">
  <h2>Indicadores</h2>
  <div class="kpis">
    <div class="kpi" style="--c:#1c7a45"><div class="kpi-l">Média Receita</div><div class="kpi-v">${esc(money(mediaRec))}</div><div class="kpi-s">${nAtivos} ${nAtivos===1?'mês ativo':'meses ativos'}</div></div>
    <div class="kpi" style="--c:#b02020"><div class="kpi-l">Média Despesa</div><div class="kpi-v">${esc(money(mediaDes))}</div><div class="kpi-s">por mês ativo</div></div>
    <div class="kpi" style="--c:#4a70c8"><div class="kpi-l">Maior Receita</div><div class="kpi-v">${iMaxR>=0?esc(money(vMaxR)):'—'}</div><div class="kpi-s">${iMaxR>=0?MESES[iMaxR]:'sem registro'}</div></div>
    <div class="kpi" style="--c:#8a5c00"><div class="kpi-l">Maior Despesa</div><div class="kpi-v">${iMaxD>=0?esc(money(vMaxD)):'—'}</div><div class="kpi-s">${iMaxD>=0?MESES[iMaxD]:'sem registro'}</div></div>
  </div>
</section>

<section class="blk">
  <h2>Evolução Mensal</h2>
  <div class="chart">
    ${chartSVG}
    <div class="clg"><span><i style="background:#1c7a45"></i>Receitas</span><span><i style="background:#b02020"></i>Despesas</span></div>
  </div>
</section>

<section class="blk">
  <h2>Composição</h2>
  <div class="two">
    <div class="box"><h3>Receitas por origem</h3><div class="dnut"><div>${donut(recRows,totRec)}</div><div>${recRows.length?legenda(recRows):'<div class="empty">Sem receitas.</div>'}</div></div></div>
    <div class="box"><h3>Despesas por categoria</h3><div class="dnut"><div>${donut(catRows,catTot)}</div><div>${catRows.length?legenda(catRows):'<div class="empty">Sem despesas.</div>'}</div></div></div>
  </div>
</section>

<section class="blk">
  <h2>Detalhamento Mês a Mês</h2>
  <table>
    <thead><tr><th>Mês</th><th>Receita</th><th>Despesa</th><th>Saldo</th><th>Tx. Poup.</th></tr></thead>
    <tbody>${linhas}</tbody>
    <tfoot><tr>
      <td>Total ${anoAtual}</td>
      <td>${esc(money(totRec))}</td>
      <td>${esc(money(totDes))}</td>
      <td style="color:${totSal<0?'#b02020':'#1c7a45'}">${esc(money(totSal))}</td>
      <td>${txPoup.toFixed(0)}%</td>
    </tr></tfoot>
  </table>
</section>

${metasHTML}

<div class="foot">
  <span>Gerado por <b>Capita</b> · Finanças Pessoais</span>
  <span>${esc(dataStr)} às ${esc(horaStr)}</span>
</div>

<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},700)})<\/script>
</body></html>`;

  const w = window.open('','_blank');
  if(!w){ toast('Permita pop-ups para gerar o PDF'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  toast('Relatório gerado — escolha "Salvar como PDF"');
}

function editarMeta(){if(sonhoAtivo===null)return;abrirWizard(sonhoAtivo)}
async function deletarMetaAtiva(){if(sonhoAtivo===null)return;if(!confirm('Excluir "'+sonhos[sonhoAtivo].nome+'"?'))return;const id=sonhos[sonhoAtivo].id;sonhos.splice(sonhoAtivo,1);sonhoAtivo=sonhos.length>0?0:null;renderMetas();if(id){const{error}=await sbDeleteMeta(id);if(error){console.error('deletarMetaAtiva',error);toast('Erro ao excluir — recarregando');await loadAll();renderMetas();return}}toast('Meta excluída')}
async function deletarMeta(i){if(!confirm('Excluir "'+sonhos[i].nome+'"?'))return;const id=sonhos[i].id;sonhos.splice(i,1);if(sonhoAtivo===i)sonhoAtivo=sonhos.length>0?0:null;else if(sonhoAtivo>i)sonhoAtivo--;renderMetas();if(id){const{error}=await sbDeleteMeta(id);if(error){console.error('deletarMeta',error);toast('Erro ao excluir — recarregando');await loadAll();renderMetas();return}}toast('Meta excluída')}

// BOOT
(function boot(){applyTheme(localStorage.getItem('cap_theme')==='dark');['metaRecMes','metaDesMes','metaDesLivre'].forEach(id=>{const e=g(id);if(e)e.addEventListener('input',onMetaInput)});['nav-item'].forEach(()=>{});document.querySelectorAll('.nav-item').forEach(el=>{el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}})});setTimeout(()=>{const dm=g('desMes');if(dm)dm.addEventListener('change',render);const rm=g('recMes');if(rm)rm.addEventListener('change',render);const rv=g('recValor');if(rv)rv.addEventListener('keydown',e=>{if(e.key==='Enter')salvarReceita()});const dv=g('desValor');if(dv)dv.addEventListener('keydown',e=>{if(e.key==='Enter')salvarDespesa()});const av=g('aporteVal');if(av)av.addEventListener('keydown',e=>{if(e.key==='Enter')lancarAporte()});
  const si=g('saldoInicialInput');if(si)si.addEventListener('input',()=>{saldoInicial=Number(si.value)||0;saveSaldoInicial();render()});
  const qv=g('qValor');if(qv)qv.addEventListener('keydown',e=>{if(e.key==='Enter')quickSalvar()});
  document.addEventListener('keydown',e=>{const tag=(e.target.tagName||'').toLowerCase();const typing=tag==='input'||tag==='textarea'||tag==='select'||e.target.isContentEditable;if(e.key==='Escape'){const qo=g('quickOverlay');if(qo&&qo.classList.contains('open'))fecharQuick()}if((e.key==='n'||e.key==='N')&&!typing){const app=g('appScreen'),qo=g('quickOverlay');if(app&&app.style.display==='block'&&qo&&!qo.classList.contains('open')){e.preventDefault();abrirQuick()}}});
},300)})();

// Origem dos rendimentos — identifica a receita sem movimentar o saldo da carteira.
let rendimentosRows=[],receitasDetalhadas=[];
function atualizarOrigemRendimento(){
  [['recCarteira','recCarteiraField',true],['qCarteira','qCarteiraField',typeof quickTipo!=='undefined'&&quickTipo==='rec']].forEach(([select,field,isRec])=>{
    const el=g(select),box=g(field);if(!el||!box)return;
    box.hidden=!isRec;el.required=false;
    const selected=el.value;
    el.innerHTML='<option value="">Não adicionar à carteira</option>'+
      (cartLoaded?carteira.map(a=>`<option value="${escHtml(a.id)}">${escHtml(a.nome)} · ${escHtml(cartCategorias[a.categoria]||a.categoria)}</option>`).join(''):'');
    if(cartLoaded&&carteira.some(a=>a.id===selected))el.value=selected;
    el.disabled=false;
  });
}
function obterOrigemRendimento(select){
  const id=g(select).value;if(!id)return null;
  const a=cartLoaded?carteira.find(a=>a.id===id):null;
  if(!a){toast('A aplicação não está disponível. Atualize a lista ou escolha não adicionar à carteira.');return false;}
  return a;
}
function renderRendimentos(){
  const el=g('tbRendimentos');if(!el)return;
  el.innerHTML=receitasDetalhadas.slice().sort((a,b)=>a.mes-b.mes).map(r=>{
    const valor=Number(r.valor_fixa||0)+Number(r.valor_variavel||0)+Number(r.valor_rendimento||0);
    const tipo=Number(r.valor_rendimento)>0?'Rendimento':Number(r.valor_variavel)>0?'Renda extra':'Renda fixa / regular';
    const status=r.carteira_aplicada?'Somado à carteira':r.carteira_nome?'Vínculo antigo / histórico':'Somente receita';
    return `<tr><td>${escHtml(MESES[r.mes]||'—')}</td><td>${tipo}</td><td>${escHtml(r.carteira_nome||'Não adicionada à carteira')}<small class="cart-kind">${status}</small></td><td class="priv">${fmt(valor)}</td><td><button class="btn-ghost danger" onclick="excluirRendimento('${escHtml(r.id)}')">Excluir</button></td></tr>`;
  }).join('')||'<tr><td colspan="5">Nenhuma receita registrada neste exercício.</td></tr>';
  applyPrivacy();
}
let rendimentoExcluindo=false;
async function excluirRendimento(id){
  if(rendimentoExcluindo||!sb||!currentUser)return;
  const r=receitasDetalhadas.find(r=>r.id===id);if(!r)return;
  if(!confirm('Excluir a receita de '+fmt(Number(r.valor_fixa||0)+Number(r.valor_variavel||0)+Number(r.valor_rendimento||0))+' de '+(r.carteira_nome||'origem não informada')+'? Se este lançamento atualizou a carteira, o valor será estornado.'))return;
  rendimentoExcluindo=true;
  try{
    const {data,error}=await sb.from('cap_receitas').delete().eq('id',id).eq('user_id',currentUser.id).eq('ano',anoAtual).select('id');
    if(error)throw error;if(!data?.length)throw new Error('Receita não encontrada');
    await loadAll();await loadCarteira();historicoCache=null;render();toast('Receita excluída');
  }catch(e){console.error(e);toast('Não foi possível excluir. Se o saldo foi reduzido manualmente, confira a aplicação antes de estornar.');}finally{rendimentoExcluindo=false;}
}
