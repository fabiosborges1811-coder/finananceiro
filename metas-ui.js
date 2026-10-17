/* Interface de Metas. Não grava no banco nem substitui cálculos financeiros. */
(() => {
  const detalheOriginal = renderDetalhe;
  let filtro = 'todas';
  const guardado = s => s.aportes.reduce((v,a) => v + (a.v || 0), 0) + (s.jaTenho || 0);
  const concluida = s => s.valor > 0 && guardado(s) >= s.valor;
  const visivel = s => filtro === 'todas' || (filtro === 'concluidas' ? concluida(s) : !concluida(s));
  function desenharCartoes() {
    const list = g('sonhoList');
    list.innerHTML = sonhos.map((s,i) => {
      if (!visivel(s)) return '';
      const ac = guardado(s), pct = s.valor > 0 ? Math.min(Math.round(ac / s.valor * 100), 100) : 0;
      const fim = new Date(s.anoInicio, s.mesInicio + s.prazo, 1);
      const pronta = concluida(s);
      return `<article class="sonho-item goal-card ${i === sonhoAtivo ? 'active-goal' : ''}">
        <div class="goal-card-top"><span class="goal-icon" aria-hidden="true">${escHtml(s.emoji)}</span><span class="goal-state ${pronta ? 'done' : ''}">${pronta ? '✓ Concluída' : 'Em andamento'}</span></div>
        <h3>${escHtml(s.nome)}</h3><p class="goal-card-desc">${escHtml(s.desc || 'Um passo de cada vez, no seu ritmo.')}</p>
        <div class="goal-card-meter"><span>Progresso</span><strong>${pct}%</strong></div>
        <div class="goal-track" role="progressbar" aria-label="Progresso da meta" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0,pct)}"><span style="width:${Math.max(0,pct)}%"></span></div>
        <div class="goal-card-money"><strong class="priv">${fmt(ac)}</strong><span class="priv">de ${fmt(s.valor)}</span></div>
        <div class="goal-card-bottom"><span>${MESES[fim.getMonth()]} ${fim.getFullYear()}</span><button type="button" aria-pressed="${i === sonhoAtivo}" onclick="selecionarMeta(${i})">${i === sonhoAtivo ? 'Em foco' : 'Acompanhar'} <span aria-hidden="true">↗</span></button></div>
      </article>`;
    }).join('');
    g('goalCount').textContent = sonhos.length === 1 ? '1 meta' : sonhos.length + ' metas';
    g('goalFilterEmpty').hidden = !sonhos.length || sonhos.some(visivel);
    document.querySelectorAll('[data-goal-filter]').forEach(b => {
      const on = b.dataset.goalFilter === filtro; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    applyPrivacy();
  }
  window.filtrarMetas = function(valor) {
    if (!['todas','andamento','concluidas'].includes(valor)) return;
    filtro = valor;
    if (sonhoAtivo !== null && sonhos[sonhoAtivo] && !visivel(sonhos[sonhoAtivo])) sonhoAtivo = null;
    renderMetas();
  };
  renderMetas = function() {
    buildAporteMes();
    if (sonhoAtivo === null || !sonhos[sonhoAtivo] || !visivel(sonhos[sonhoAtivo])) {
      const primeiro = sonhos.findIndex(visivel); sonhoAtivo = primeiro < 0 ? null : primeiro;
    }
    g('sonhoEmpty').style.display = sonhos.length ? 'none' : 'block';
    g('goalToolbar').hidden = !sonhos.length;
    g('sonhoDetalhe').style.display = sonhoAtivo === null ? 'none' : 'block';
    if (sonhoAtivo !== null) renderDetalhe();
    else desenharCartoes();
  };
  renderDetalhe = function() {
    detalheOriginal();
    if (sonhoAtivo === null || !sonhos[sonhoAtivo]) return;
    // Os valores do detalhe continuam sendo calculados pela função original.
    g('goalDetailPct').textContent = g('arcPct').textContent;
    const pct = parseInt(g('arcPct').textContent, 10) || 0;
    g('goalDetailBar').style.width = Math.max(0,Math.min(100,pct)) + '%';
    desenharCartoes();
  };
  selecionarMeta = function(i) {
    if (!sonhos[i]) return;
    sonhoAtivo = i; renderMetas();
    g('sonhoDetalhe').scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',block:'start'});
  };
})();
