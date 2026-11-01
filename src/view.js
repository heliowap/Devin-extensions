'use strict';

const DASH = '—';
const TOKEN_LABELS = Object.freeze({
  input: 'Entrada',
  output: 'Saída',
  cacheRead: 'Cache lido',
  cacheWrite: 'Cache criado',
});
const TOTAL_LABELS = Object.freeze({
  input: 'Entrada',
  output: 'Saída gerada (registrada)',
  cacheRead: 'Cache lido — acumulado por chamada',
  cacheWrite: 'Cache criado',
});
const BILLING_LABELS = Object.freeze({
  chatgpt: 'ChatGPT/OAuth (configuração informada)',
  devin: 'Cota/créditos Devin (configuração informada)',
  api: 'API externa (configuração informada)',
});
const TOKEN_KEYS = Object.keys(TOKEN_LABELS);
const TURN_LIMIT = 50;
const NO_PRICE = 'Não configurado / indisponível';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatNumber(value, digits) {
  if (!isFiniteNumber(value)) {
    return DASH;
  }
  const [integer, fraction] = Math.abs(value).toFixed(digits).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = value < 0 ? '-' : '';
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped},${fraction}`;
}

function formatCount(value) {
  return formatNumber(value, 0);
}

function formatDuration(ms) {
  if (!isFiniteNumber(ms) || ms < 0) {
    return DASH;
  }
  if (ms < 60000) {
    return `${formatNumber(ms / 1000, 1)} s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}

function formatTps(tps) {
  return isFiniteNumber(tps) && tps >= 0 ? `${formatNumber(tps, 1)} tok/s` : DASH;
}

function formatAmount(value) {
  return isFiniteNumber(value) && value >= 0 ? `US$ ${formatNumber(value, 4)}` : NO_PRICE;
}

function formatSignedUsd(value) {
  if (!isFiniteNumber(value)) {
    return NO_PRICE;
  }
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  return `${sign}US$ ${formatNumber(Math.abs(value), 4)}`;
}

function formatSignedPercent(value) {
  if (!isFiniteNumber(value)) {
    return DASH;
  }
  const sign = value < 0 ? '-' : value > 0 ? '+' : '';
  return `${sign}${formatNumber(Math.abs(value), 1)}%`;
}

function formatUsd(cost, pricedRequests, requests) {
  const coverage = isFiniteNumber(pricedRequests) && isFiniteNumber(requests) && requests > 0 && pricedRequests < requests
    ? ` (${pricedRequests} de ${requests} requisições com preço)`
    : '';
  return formatAmount(cost) + coverage;
}

function formatTime(ms) {
  if (!isFiniteNumber(ms)) {
    return DASH;
  }
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shortModel(model) {
  if (typeof model !== 'string' || model.trim() === '') {
    return DASH;
  }
  const clean = model.replace(/\$/g, '').trim();
  return clean.length > 24 ? `${clean.slice(0, 23)}…` : clean;
}

function fullModel(model) {
  return escapeHtml(typeof model === 'string' && model.trim() !== '' ? model : DASH);
}

function billingLabel(billing) {
  const safe = billing && typeof billing === 'object' ? billing : {};
  if (safe.basis !== 'declared' || !Object.prototype.hasOwnProperty.call(BILLING_LABELS, safe.source)) {
    return 'Não informada';
  }
  return BILLING_LABELS[safe.source];
}

function usageOf(usage) {
  const safe = usage && typeof usage === 'object' ? usage : {};
  const tokens = safe.tokens && typeof safe.tokens === 'object' ? safe.tokens : {};
  return {
    requests: safe.requests,
    costUsd: safe.costUsd,
    pricedRequests: safe.pricedRequests,
    tokens,
    unknown: Array.isArray(tokens.unknown) ? tokens.unknown : [],
  };
}

function formatTokenValue(tokens, key) {
  const unknown = Array.isArray(tokens.unknown) ? tokens.unknown : [];
  const prefix = unknown.includes(key) ? '≥ ' : '';
  return `${prefix}${formatCount(tokens[key])}`;
}

function formatTokenTotal(tokens) {
  const unknown = Array.isArray(tokens.unknown) ? tokens.unknown : [];
  return `${unknown.length > 0 ? '≥ ' : ''}${formatCount(tokens.total)}`;
}

function tpsBasisLabel(kind) {
  if (kind === 'reported') {
    return 'reportado pelo Devin';
  }
  if (kind === 'request') {
    return 'requisição, inclui espera';
  }
  return 'indisponível';
}

function scopeLabel(scope) {
  if (scope === 'lead') {
    return 'Principal';
  }
  if (scope === 'delegated') {
    return 'Delegada';
  }
  return DASH;
}

function stateLabel(state) {
  if (state === 'open') {
    return 'Sem resposta final';
  }
  if (state === 'complete') {
    return 'Concluído';
  }
  if (state === 'superseded') {
    return 'Substituído pelo próximo prompt';
  }
  return DASH;
}

function findLastRequest(turns) {
  for (const turn of turns) {
    if (turn && turn.lastRequest) {
      return turn.lastRequest;
    }
  }
  return null;
}

function liveElapsedText(turn, now) {
  if (!turn || turn.state !== 'open' || !isFiniteNumber(turn.startedAt)) {
    return DASH;
  }
  return formatDuration(Math.max(0, now - turn.startedAt));
}

function turnElapsedText(turn, now) {
  if (turn.state === 'open') {
    return liveElapsedText(turn, now);
  }
  return turn.state === 'complete' ? formatDuration(turn.elapsedMs) : DASH;
}

function statusBarModel({ snapshot, error = null, mode = 'auto', now }) {
  if (error) {
    return { text: '$(warning) Devin Pulse', tooltip: `Indisponível: ${error}`, warning: true };
  }
  if (!snapshot) {
    return { text: '$(graph) Devin Pulse', tooltip: 'Aguardando a primeira coleta local.', warning: false };
  }
  const source = snapshot.source || {};
  if (source.state !== 'ready') {
    return {
      text: '$(warning) Devin Pulse',
      tooltip: `Fonte local indisponível: ${source.message || 'motivo não informado'}`,
      warning: true,
    };
  }
  const session = snapshot.session;
  if (!session) {
    return {
      text: '$(graph) Devin Pulse: sem sessão',
      tooltip: 'Nenhuma sessão encontrada. Use "Devin Pulse: Selecionar sessão".',
      warning: false,
    };
  }
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const current = turns[0] || null;
  const isOpen = Boolean(current && current.state === 'open');
  const last = isOpen ? current.lastRequest || null : findLastRequest(turns);
  const modeText = mode === 'manual' ? 'sessão fixada' : 'workspace recente';
  const title = session.title || '(sem título)';

  const lines = [`Sessão: ${title} (${modeText})`];
  if (last) {
    lines.push(`Última requisição concluída: ${shortModel(last.model)}`);
    lines.push(`Latência da requisição: ${formatDuration(last.durationMs)}`);
    lines.push(`TPS: ${formatTps(last.tps)} (${tpsBasisLabel(last.tpsKind)})`);
  } else {
    lines.push('Nenhuma requisição concluída registrada.');
  }
  if (isOpen) {
    lines.push(
      `Prompt sem resposta final registrada: ${liveElapsedText(current, now)} desde o envio, incluindo ferramentas e espera do modelo.`,
    );
  }
  lines.push('TPS é atualizado após cada requisição; não há TPS de streaming exato.');

  if (isOpen) {
    const model = shortModel((current.lastRequest && current.lastRequest.model) || session.model);
    return {
      text: `$(sync~spin) ${model} · ${liveElapsedText(current, now)} desde envio · última chamada: ${formatTps(last && last.tps)}`,
      tooltip: lines.join('\n'),
      warning: false,
    };
  }
  if (last) {
    return {
      text: `${shortModel(last.model)} · ${formatDuration(last.durationMs)} · ${formatTps(last.tps)}`,
      tooltip: lines.join('\n'),
      warning: false,
    };
  }
  return { text: `$(graph) ${shortModel(session.model)} · sem respostas`, tooltip: lines.join('\n'), warning: false };
}

function tokenRows(usage) {
  const tokens = usage.tokens;
  return TOKEN_KEYS.map(
    (key) => `<div class="metric"><span class="label">${TOKEN_LABELS[key]}</span><span class="value">${formatTokenValue(tokens, key)}</span></div>`,
  ).join('');
}

function renderBanner(kind, message) {
  return `<div class="banner ${kind}" role="status">${escapeHtml(message)}</div>`;
}

function renderHeader(mode, snapshot) {
  const manual = mode === 'manual';
  const modeText = manual ? 'sessão fixada' : 'workspace recente';
  const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const selectedId = snapshot && snapshot.selectedSessionId;
  const options = [];
  if (!selectedId) {
    options.push('<option value="" selected disabled>Selecione uma sessão</option>');
  }
  for (const item of sessions) {
    const selected = item.id === selectedId ? ' selected' : '';
    const label = `${item.title || '(sem título)'} · ${typeof item.model === 'string' ? item.model : DASH}`;
    options.push(`<option value="${escapeHtml(item.id)}"${selected}>${escapeHtml(label)}</option>`);
  }
  const select = sessions.length
    ? `<select data-action="selectSession" aria-label="Sessão">${options.join('')}</select>`
    : '<p class="empty">Nenhuma sessão disponível para seleção.</p>';
  const autoButton = manual ? '<button type="button" data-action="autoSession">Acompanhar workspace</button>' : '';
  return [
    '<header class="top">',
    `<h1>Devin Pulse <span class="badge">${modeText}</span></h1>`,
    '<div class="actions">',
    '<button type="button" data-action="refresh">Atualizar</button>',
    '<button type="button" data-action="chooseSession">Escolher sessão</button>',
    autoButton,
    '</div>',
    '</header>',
    `<div class="session-bar">${select}</div>`,
  ].join('');
}

function renderTurnStatus(turn, now) {
  if (turn.state === 'open') {
    return `<p>Sem resposta final registrada · <span data-live-elapsed>${liveElapsedText(turn, now)}</span> desde o envio.</p>`;
  }
  if (turn.state === 'complete') {
    return `<p>Concluído · ${formatDuration(turn.elapsedMs)} desde o envio.</p>`;
  }
  return '<p>Sem resposta final antes do próximo prompt.</p>';
}

function renderCurrentTurn(turn, now) {
  if (!turn) {
    return '<section class="card"><h2>Prompt atual</h2><p class="empty">Nenhum prompt registrado nesta sessão.</p></section>';
  }
  const lead = usageOf(turn.lead);
  const delegated = usageOf(turn.delegated);
  const last = turn.lastRequest;
  const lastBlock = last
    ? [
        '<dl class="pairs">',
        `<dt>Modelo</dt><dd>${fullModel(last.model)} (${scopeLabel(last.scope)})</dd>`,
        `<dt>Latência da requisição</dt><dd>${formatDuration(last.durationMs)}</dd>`,
        `<dt>TTFT</dt><dd>${formatDuration(last.ttftMs)}</dd>`,
        `<dt>TPS da última chamada</dt><dd>${formatTps(last.tps)} · ${tpsBasisLabel(last.tpsKind)}</dd>`,
        '</dl>',
      ].join('')
    : '<p class="empty">Nenhuma requisição concluída neste prompt.</p>';
  return [
    '<section class="card current">',
    '<h2>Prompt atual</h2>',
    renderTurnStatus(turn, now),
    lastBlock,
    '<div class="split">',
    `<div><h3>Principal</h3>${tokenRows(lead)}<p class="meta">Equivalente de API: ${formatUsd(lead.costUsd, lead.pricedRequests, lead.requests)}</p></div>`,
    `<div><h3>Delegadas</h3>${tokenRows(delegated)}<p class="meta">Equivalente de API: ${formatUsd(delegated.costUsd, delegated.pricedRequests, delegated.requests)}</p></div>`,
    '</div>',
    '</section>',
  ].join('');
}

function renderTotals(session) {
  const totals = usageOf(session.totals);
  const totalsRows = TOKEN_KEYS.map(
    (key) => `<div class="metric"><span class="label">${TOTAL_LABELS[key]}</span><span class="value">${formatTokenValue(totals.tokens, key)}</span></div>`,
  ).join('');
  const unassigned = Number(session.unassignedRequests) > 0
    ? `<p class="meta">${formatCount(session.unassignedRequests)} requisições fora do histórico de prompts exibido; incluídas nos totais da sessão.</p>`
    : '';
  return [
    '<section class="card">',
    '<h2>Totais da sessão</h2>',
    totalsRows,
    `<div class="metric total"><span class="label">Volume acumulado de tokens</span><span class="value">${formatTokenTotal(totals.tokens)}</span></div>`,
    '<p class="meta">Volume acumulado de tokens inclui releituras do contexto em cache; não é texto único nem percentual da cota.</p>',
    '<p class="meta">Saída gerada (registrada) inclui o que a fonte registra como saída, podendo incluir raciocínio além da resposta visível.</p>',
    `<p class="meta">Requisições: ${formatCount(totals.requests)} · Equivalente de API a preços configurados: ${formatUsd(totals.costUsd, totals.pricedRequests, totals.requests)}</p>`,
    unassigned,
    '</section>',
  ].join('');
}

function renderModelRow(entry) {
  const usage = usageOf(entry.usage);
  const roles = entry.roleCounts && typeof entry.roleCounts === 'object' ? entry.roleCounts : {};
  const latest = entry.latestRequest;
  const requestTps = entry.requestTps && typeof entry.requestTps === 'object' ? entry.requestTps : {};
  const tokenCells = TOKEN_KEYS.map((key) => `<td>${formatTokenValue(usage.tokens, key)}</td>`).join('');
  return [
    '<tr>',
    `<td class="model">${fullModel(entry.model)}</td>`,
    `<td>${escapeHtml(billingLabel(entry.billing))}</td>`,
    `<td>${formatCount(usage.requests)}</td>`,
    `<td>Principal ${formatCount(roles.lead)} · Delegada ${formatCount(roles.delegated)} · Fora do histórico ${formatCount(roles.unassigned)}</td>`,
    tokenCells,
    `<td>${formatTokenTotal(usage.tokens)}</td>`,
    `<td>${latest ? `${formatTps(latest.tps)} · ${tpsBasisLabel(latest.tpsKind)}` : DASH}</td>`,
    `<td>${formatTps(requestTps.value)} · ${formatCount(requestTps.sampleCount)} de ${formatCount(requestTps.requests)} requisições</td>`,
    `<td>${formatUsd(usage.costUsd, usage.pricedRequests, usage.requests)}</td>`,
    '</tr>',
  ].join('');
}

function renderModels(session) {
  const entries = Array.isArray(session.byModel) ? session.byModel : null;
  let body;
  if (entries === null) {
    body = '<p class="empty">Consumo por modelo indisponível nesta versão do coletor.</p>';
  } else if (entries.length === 0) {
    body = '<p class="empty">Nenhum modelo registrado nesta sessão.</p>';
  } else {
    body = [
      '<div class="scroll"><table class="models">',
      '<thead><tr><th>Modelo</th><th>Origem de cobrança</th><th>Requisições</th><th>Escopo</th>',
      `<th>${TOTAL_LABELS.input}</th><th>${TOTAL_LABELS.output}</th><th>${TOTAL_LABELS.cacheRead}</th><th>${TOTAL_LABELS.cacheWrite}</th>`,
      '<th>Volume acumulado</th><th>Última TPS reportada</th><th>TPS por tempo de chamadas (inclui espera)</th><th>Equivalente de API</th>',
      '</tr></thead>',
      `<tbody>${entries.map(renderModelRow).join('')}</tbody>`,
      '</table></div>',
    ].join('');
  }
  return [
    '<section class="card">',
    '<h2>Consumo por modelo</h2>',
    '<p class="meta">Origem de cobrança é uma rota declarada nas configurações e aplicada ao histórico desta sessão; não é registro de transações. Mudanças passadas de modelo ou rota não são conhecidas.</p>',
    body,
    '</section>',
  ].join('');
}

function renderSimulation(simulation) {
  if (!simulation || typeof simulation !== 'object') {
    return [
      '<section class="card">',
      '<h2>Simulação a preços de API</h2>',
      '<p class="empty">Simulação indisponível nesta versão do coletor.</p>',
      '</section>',
    ].join('');
  }
  const hasBaseline = typeof simulation.baselineModel === 'string' && simulation.baselineModel !== '';
  const hasSample = hasBaseline && Number(simulation.comparedRequests) > 0;
  const skipped = Number(simulation.skippedRequests) > 0
    ? ` (${formatCount(simulation.skippedRequests)} não comparadas: preços ou contadores incompletos)`
    : '';
  const header = [
    `<p class="meta">Modelo de referência: ${hasBaseline ? fullModel(simulation.baselineModel) : DASH}</p>`,
    `<p class="meta">Requisições comparadas: ${formatCount(simulation.comparedRequests)} de ${formatCount(simulation.allRequests)}${skipped}</p>`,
  ].join('');
  const values = hasSample
    ? [
        `<div class="metric"><span class="label">Modelos observados (equivalente API)</span><span class="value">${formatAmount(simulation.actualEquivalentUsd)}</span></div>`,
        `<div class="metric"><span class="label">Mesmo volume à tarifa do modelo de referência</span><span class="value">${formatAmount(simulation.baselineEquivalentUsd)}</span></div>`,
        `<div class="metric"><span class="label">Diferença simulada</span><span class="value">${formatSignedUsd(simulation.differenceUsd)} (${formatSignedPercent(simulation.differencePercent)})</span></div>`,
      ].join('')
    : '<p class="empty">Configure preços e um modelo de referência para simular.</p>';
  return [
    '<section class="card">',
    '<h2>Simulação a preços de API</h2>',
    header,
    values,
    '<p class="meta"><strong>Simulação, não medição:</strong> mesmo volume de tokens observado a tarifas diferentes NÃO mede como a tarefa rodaria sem o Fusion, nem economia real de assinatura ou cota. Não é valor pago nem afirmação de economia.</p>',
    '</section>',
  ].join('');
}

function renderHistory(turns, selectedId, now) {
  const rows = turns.slice(0, TURN_LIMIT).map((turn) => {
    const selected = turn.id === selectedId;
    const last = turn.lastRequest;
    const lastText = last ? `${fullModel(last.model)} · ${formatTps(last.tps)}` : DASH;
    return [
      `<tr class="${selected ? 'selected' : ''}" tabindex="0" data-action="selectTurn" data-id="${escapeHtml(turn.id)}">`,
      `<td>${formatCount(turn.index)}</td>`,
      `<td>${formatTime(turn.startedAt)}</td>`,
      turn.state === 'open'
        ? `<td><span data-live-elapsed>${liveElapsedText(turn, now)}</span></td>`
        : `<td>${turnElapsedText(turn, now)}</td>`,
      `<td>${lastText}</td>`,
      `<td>${formatCount(usageOf(turn.lead).requests)}</td>`,
      `<td>${formatCount(usageOf(turn.delegated).requests)}</td>`,
      `<td>${stateLabel(turn.state)}</td>`,
      '</tr>',
    ].join('');
  });
  const note = turns.length > TURN_LIMIT ? `<p class="meta">Mostrando ${TURN_LIMIT} de ${turns.length} prompts.</p>` : '';
  return [
    '<section class="card">',
    '<h2>Histórico de prompts</h2>',
    turns.length === 0
      ? '<p class="empty">Nenhum prompt registrado nesta sessão.</p>'
      : [
          '<div class="scroll"><table class="history">',
          '<thead><tr><th>#</th><th>Início</th><th>Tempo</th><th>Última chamada</th><th>Principal</th><th>Delegadas</th><th>Estado</th></tr></thead>',
          `<tbody>${rows.join('')}</tbody>`,
          '</table></div>',
          note,
        ].join(''),
    '</section>',
  ].join('');
}

function renderRequests(turn) {
  if (!turn) {
    return '';
  }
  const requests = Array.isArray(turn.requests) ? turn.requests : [];
  const rows = requests.map((request) => {
    const tokens = request.tokens && typeof request.tokens === 'object' ? request.tokens : { unknown: [] };
    const cells = TOKEN_KEYS.map((key) => `<td>${formatTokenValue(tokens, key)}</td>`).join('');
    return [
      '<tr>',
      `<td>${fullModel(request.model)}</td>`,
      `<td>${scopeLabel(request.scope)}</td>`,
      `<td>${formatDuration(request.durationMs)}</td>`,
      `<td>${formatDuration(request.ttftMs)}</td>`,
      `<td>${formatTps(request.tps)}<span class="meta"> · ${tpsBasisLabel(request.tpsKind)}</span></td>`,
      cells,
      `<td>${formatTokenTotal(tokens)}</td>`,
      `<td>${formatUsd(request.costUsd)}</td>`,
      '</tr>',
    ].join('');
  });
  return [
    '<section class="card">',
    `<h2>Requisições do prompt #${formatCount(turn.index)}</h2>`,
    requests.length === 0
      ? '<p class="empty">Nenhuma requisição registrada para este prompt.</p>'
      : [
          '<div class="scroll"><table class="requests">',
          '<thead><tr><th>Modelo</th><th>Escopo</th><th>Latência</th><th>TTFT</th><th>TPS</th>',
          `<th>${TOKEN_LABELS.input}</th><th>${TOKEN_LABELS.output}</th><th>${TOKEN_LABELS.cacheRead}</th><th>${TOKEN_LABELS.cacheWrite}</th>`,
          '<th>Volume acumulado</th><th>Equivalente de API</th></tr></thead>',
          `<tbody>${rows.join('')}</tbody>`,
          '</table></div>',
        ].join(''),
    '</section>',
  ].join('');
}

function renderSession(snapshot, mode, selectedTurnId, now) {
  const session = snapshot.session;
  const turns = Array.isArray(session.turns) ? session.turns : [];
  const current = turns[0] || null;
  const detailTurn = turns.find((turn) => turn.id === selectedTurnId) || current;
  const warnings = Array.isArray(session.warnings) ? session.warnings : [];
  const warningBlock = warnings.length
    ? `<ul class="warnings">${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>`
    : '';
  const sessionTitle = session.title || '(sem título)';
  return [
    `<section class="session"><h2>${escapeHtml(sessionTitle)}</h2>`,
    `<p class="meta">${escapeHtml(session.directory || '')}</p>`,
    `<p class="meta">Modelo configurado da sessão: <span class="model">${fullModel(session.model)}</span> (configuração, não prova do modelo ativo)</p>`,
    warningBlock,
    renderCurrentTurn(current, now),
    renderTotals(session),
    renderModels(session),
    renderSimulation(session.simulation),
    renderHistory(turns, detailTurn ? detailTurn.id : null, now),
    renderRequests(detailTurn),
    '<p class="note">Métricas são atualizadas após cada requisição concluída; não há TPS de streaming exato. ',
    'Equivalente de API e simulação são cálculos a partir de preços configurados por você; não são cobranças nem saldo de cota. ',
    'Tempo de prompt aberto é o tempo desde o envio, sem resposta final registrada. ',
    'Principal e delegada indicam o escopo da requisição. Nenhum conteúdo de prompt ou resposta é exibido ou exportado.</p>',
    '</section>',
  ].join('');
}

function renderPanel({ snapshot = null, error = null, mode = 'auto', selectedTurnId = null, now }) {
  const header = renderHeader(mode, snapshot);
  if (error) {
    return `${header}${renderBanner('warn', `Indisponível: ${error}`)}`;
  }
  if (!snapshot) {
    return `${header}<p class="empty">Aguardando a primeira coleta local.</p>`;
  }
  const source = snapshot.source || {};
  if (source.state !== 'ready') {
    return [
      header,
      renderBanner('warn', source.message || 'Fonte local indisponível.'),
      '<p class="meta">Verifique devinPulse.databasePath e devinPulse.pythonPath nas configurações.</p>',
    ].join('');
  }
  if (!snapshot.session) {
    const text = mode === 'manual'
      ? 'A sessão fixada não está disponível. Escolha outra ou acompanhe o workspace.'
      : 'Nenhuma sessão encontrada para este workspace.';
    return `${header}<p class="empty">${text}</p>`;
  }
  return `${header}${renderSession(snapshot, mode, selectedTurnId, now)}`;
}

function stableSignature(html) {
  return html.replace(/(data-live-elapsed>)[^<]*/g, '$1');
}

function buildDocument({ nonce, cspSource, styleUri, scriptUri }) {
  const safeNonce = escapeHtml(nonce);
  const policy = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${safeNonce}';`;
  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, '&quot;')}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<link rel="stylesheet" href="${escapeHtml(styleUri)}">`,
    '<title>Devin Pulse</title>',
    '</head>',
    '<body>',
    '<main id="root"></main>',
    `<script nonce="${safeNonce}" src="${escapeHtml(scriptUri)}"></script>`,
    '</body>',
    '</html>',
  ].join('');
}

module.exports = {
  buildDocument,
  escapeHtml,
  formatCount,
  formatDuration,
  formatNumber,
  formatTps,
  formatUsd,
  liveElapsedText,
  renderPanel,
  stableSignature,
  statusBarModel,
};
