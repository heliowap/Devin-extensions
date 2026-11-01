'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/view');

const UNKNOWN_PRICE = 'Não configurado / indisponível';
const HOSTILE_TITLE = '</script><img src=x onerror=alert(1)>';

function tokens(overrides = {}) {
  return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, unknown: [], ...overrides };
}

function usage(overrides = {}) {
  return { requests: 1, tokens: tokens(), costUsd: null, pricedRequests: 0, ...overrides };
}

function request(overrides = {}) {
  return {
    id: 'r1',
    nodeId: 1,
    scope: 'lead',
    model: 'gpt-test',
    finishedAt: 15000,
    durationMs: 13800,
    ttftMs: 900,
    tps: 54.8,
    tpsKind: 'reported',
    tokens: tokens(),
    costUsd: null,
    ...overrides,
  };
}

function turn(overrides = {}) {
  const last = request();
  return {
    id: 't1',
    index: 1,
    startedAt: 1000,
    endedAt: 15000,
    state: 'complete',
    elapsedMs: 14000,
    lead: usage(),
    delegated: usage({ requests: 0, tokens: tokens({ input: 0, output: 0, total: 0 }) }),
    lastRequest: last,
    requests: [last],
    ...overrides,
  };
}

function snapshot({ turns = [turn()], session = {}, source = {} } = {}) {
  return {
    schemaVersion: 1,
    observedAt: 20000,
    source: { state: 'ready', message: null, ...source },
    sessions: [{ id: 's1', title: 'Sessão de teste', directory: '/fixture/work', model: 'gpt-test', updatedAt: 1 }],
    selectedSessionId: 's1',
    session: {
      id: 's1',
      title: 'Sessão de teste',
      directory: '/fixture/work',
      model: 'gpt-test',
      warnings: [],
      totals: usage({ requests: 1 }),
      unassignedRequests: 0,
      turns,
      ...session,
    },
  };
}

test('escapeHtml neutralises markup characters', () => {
  assert.equal(view.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(view.escapeHtml(undefined), '');
});

test('hostile session title and model stay inert text in the panel', () => {
  const hostile = snapshot({
    session: { title: HOSTILE_TITLE, model: HOSTILE_TITLE },
  });
  hostile.sessions[0].title = HOSTILE_TITLE;
  hostile.sessions[0].model = HOSTILE_TITLE;
  const html = view.renderPanel({ snapshot: hostile, mode: 'auto', now: 20000 });
  assert.equal(/<img/i.test(html), false);
  assert.equal(/<script/i.test(html), false);
  assert.match(html, /&lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('status bar tooltip carries the title as plain text', () => {
  const model = view.statusBarModel({ snapshot: snapshot({ session: { title: HOSTILE_TITLE } }), now: 20000 });
  assert.match(model.tooltip, /Sessão: <\/script><img/);
});

test('unknown prices render as unavailable, never as zero dollars', () => {
  const data = snapshot({ session: { totals: usage({ requests: 3, costUsd: null, pricedRequests: 0 }) } });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.match(html, new RegExp(UNKNOWN_PRICE));
  assert.equal(html.includes('US$ 0'), false);
});

test('configured price shows coverage when only some requests are priced', () => {
  assert.equal(view.formatUsd(0.1234, 2, 3), 'US$ 0,1234 (2 de 3 requisições com preço)');
  assert.equal(view.formatUsd(0, 3, 3), 'US$ 0,0000');
  assert.equal(view.formatUsd(null, 0, 3), `${UNKNOWN_PRICE} (0 de 3 requisições com preço)`);
  assert.equal(view.formatUsd(null, 2, 3), `${UNKNOWN_PRICE} (2 de 3 requisições com preço)`);
  assert.equal(view.formatUsd(0, 2, 3), 'US$ 0,0000 (2 de 3 requisições com preço)');
});

test('zero TPS and zero duration are retained', () => {
  const zero = request({ durationMs: 0, tps: 0 });
  const data = snapshot({ turns: [turn({ lastRequest: zero, requests: [zero] })] });
  const model = view.statusBarModel({ snapshot: data, now: 20000 });
  assert.equal(model.text, 'gpt-test · 0,0 s · 0,0 tok/s');
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.match(html, /0,0 tok\/s/);
  assert.match(html, />0,0 s</);
});

test('unknown TPS and empty history use a dash', () => {
  assert.equal(view.formatTps(null), '—');
  const html = view.renderPanel({ snapshot: snapshot({ turns: [] }), mode: 'auto', now: 20000 });
  assert.match(html, /Nenhum prompt registrado nesta sessão/);
});

test('open prompt timer advances while a completed prompt does not', () => {
  const open = turn({ state: 'open', elapsedMs: null, endedAt: null, lastRequest: null, requests: [] });
  assert.notEqual(view.liveElapsedText(open, 6000), view.liveElapsedText(open, 10000));
  assert.equal(view.liveElapsedText(open, 6000), '5,0 s');

  const completed = turn();
  const first = view.renderPanel({ snapshot: snapshot({ turns: [completed] }), mode: 'auto', now: 6000 });
  const second = view.renderPanel({ snapshot: snapshot({ turns: [completed] }), mode: 'auto', now: 10000 });
  assert.equal(first, second);
});

test('open-turn render differs only in its live elapsed text', () => {
  const open = turn({ state: 'open', elapsedMs: null, endedAt: null });
  const first = view.renderPanel({ snapshot: snapshot({ turns: [open] }), mode: 'auto', now: 6000 });
  const second = view.renderPanel({ snapshot: snapshot({ turns: [open] }), mode: 'auto', now: 10000 });
  assert.notEqual(first, second);
  assert.equal(view.stableSignature(first), view.stableSignature(second));
});

test('open status bar shows live elapsed and the last call TPS label', () => {
  const open = turn({ state: 'open', elapsedMs: null, endedAt: null });
  const model = view.statusBarModel({ snapshot: snapshot({ turns: [open] }), now: 1000 + 13800 });
  assert.match(model.text, /13,8 s desde envio/);
  assert.match(model.text, /última chamada: 54,8 tok\/s/);
  assert.match(model.tooltip, /Última requisição concluída: gpt-test/);
  assert.match(model.tooltip, /incluindo ferramentas/);
});

test('open prompt without a completed call does not borrow TPS from the previous prompt', () => {
  const previous = turn({ id: 't0', index: 1, lastRequest: request({ model: 'model-a', tps: 100 }) });
  const open = turn({ id: 't1', index: 2, state: 'open', elapsedMs: null, endedAt: null, lastRequest: null, requests: [] });
  const data = snapshot({ turns: [open, previous], session: { model: 'model-b' } });
  const model = view.statusBarModel({ snapshot: data, now: 6000 });
  assert.match(model.text, /^\$\(sync~spin\) model-b · /);
  assert.match(model.text, /última chamada: —$/);
  assert.equal(model.tooltip.includes('100,0'), false);
  assert.match(model.tooltip, /Nenhuma requisição concluída registrada\./);
});

test('completed status bar shows last confirmed request model, duration and TPS', () => {
  const model = view.statusBarModel({ snapshot: snapshot(), now: 20000 });
  assert.equal(model.text, 'gpt-test · 13,8 s · 54,8 tok/s');
  assert.equal(model.warning, false);
});

test('superseded prompt does not invent a duration', () => {
  const superseded = turn({ state: 'superseded', elapsedMs: null, endedAt: null });
  const html = view.renderPanel({ snapshot: snapshot({ turns: [superseded] }), mode: 'auto', now: 20000 });
  assert.match(html, /Sem resposta final antes do próximo prompt/);
  assert.match(html, /<td>—<\/td>/);
});

test('lower-bound tokens are marked with ≥ and never implied complete', () => {
  const partial = turn({
    lead: usage({ tokens: tokens({ cacheWrite: 0, total: 15, unknown: ['cacheWrite'] }) }),
  });
  const html = view.renderPanel({ snapshot: snapshot({ turns: [partial] }), mode: 'auto', now: 20000 });
  assert.match(html, /Cache criado<\/span><span class="value">≥ 0/);
});

test('source missing shows a warning status and no session numbers', () => {
  const data = snapshot({ source: { state: 'missing', message: 'Banco não encontrado.' } });
  const model = view.statusBarModel({ snapshot: data, now: 20000 });
  assert.equal(model.warning, true);
  assert.match(model.tooltip, /Banco não encontrado/);
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.match(html, /Banco não encontrado/);
  assert.equal(html.includes('Totais da sessão'), false);
});

test('error state shows only the banner and header', () => {
  const html = view.renderPanel({ snapshot: null, error: 'Python 3.10+ não encontrado.', mode: 'auto', now: 1 });
  assert.match(html, /Indisponível: Python 3.10\+ não encontrado\./);
  assert.equal(html.includes('Histórico de prompts'), false);
  const model = view.statusBarModel({ snapshot: null, error: 'x', now: 1 });
  assert.equal(model.warning, true);
});

test('request detail shows scope, latency, TTFT, TPS basis and cache creation', () => {
  const delegated = request({
    id: 'r2',
    scope: 'delegated',
    tpsKind: 'request',
    tps: 0,
    tokens: tokens({ cacheWrite: 7, total: 22 }),
  });
  const data = snapshot({ turns: [turn({ requests: [request(), delegated], lastRequest: delegated })] });
  const html = view.renderPanel({ snapshot: data, mode: 'manual', now: 20000 });
  assert.match(html, /Cache criado/);
  assert.match(html, /<td>Delegada<\/td>/);
  assert.match(html, /requisição, inclui espera/);
  assert.match(html, /sessão fixada/);
});

test('stableSignature removes only live text', () => {
  assert.equal(
    view.stableSignature('<span data-live-elapsed>1,0 s</span>'),
    '<span data-live-elapsed></span>',
  );
});

test('document shell has a strict CSP, nonce-only script and no inline handlers', () => {
  const html = view.buildDocument({
    nonce: 'abc123==',
    cspSource: 'vscode-webview://fixture',
    styleUri: 'https://fixture.invalid/media/panel.css',
    scriptUri: 'https://fixture.invalid/media/panel.js',
  });
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-abc123==/);
  assert.equal(html.includes("'unsafe-inline'"), false);
  assert.match(html, /<script nonce="abc123==" src="https:\/\/fixture\.invalid\/media\/panel\.js"><\/script>/);
  assert.equal(/<script(?![^>]*\ssrc=)/.test(html), false);
  assert.equal(/\son[a-z]+=/i.test(html), false);
});

test('formatting helpers use pt-BR separators and readable durations', () => {
  assert.equal(view.formatNumber(1234.5, 1), '1.234,5');
  assert.equal(view.formatDuration(65000), '1 min 05 s');
  assert.equal(view.formatDuration(null), '—');
  assert.equal(view.formatCount(1234567), '1.234.567');
});

function modelEntry(overrides = {}) {
  return {
    model: 'model-a',
    roleCounts: { lead: 2, delegated: 1, unassigned: 0 },
    billing: { source: 'unknown', basis: 'unknown' },
    usage: { requests: 3, tokens: tokens({ input: 1200, output: 340, cacheRead: 9000, cacheWrite: 70, total: 10610 }), costUsd: null, pricedRequests: 0 },
    latestRequest: request({ tps: 100, tpsKind: 'reported' }),
    requestTps: { value: 12.5, sampleCount: 2, requests: 3 },
    ...overrides,
  };
}

function richSnapshot({ byModel, simulation, model = 'model-a' } = {}) {
  const data = snapshot({ turns: [turn()] });
  data.session.model = model;
  if (byModel !== undefined) {
    data.session.byModel = byModel;
  }
  if (simulation !== undefined) {
    data.session.simulation = simulation;
  }
  return data;
}

test('session totals are labelled as accumulated volume with every category visible', () => {
  const html = view.renderPanel({ snapshot: richSnapshot(), mode: 'auto', now: 20000 });
  assert.match(html, /Volume acumulado de tokens/);
  assert.match(html, /inclui releituras do contexto em cache; não é texto único nem percentual da cota/);
  for (const label of ['Entrada', 'Saída gerada (registrada)', 'Cache lido — acumulado por chamada', 'Cache criado']) {
    assert.match(html, new RegExp(label.replace(/[()]/g, '\\$&')));
  }
  assert.equal(/<span class="label">Total<\/span>/.test(html), false);
});

test('per-model rows are distinct and keep full model identifiers', () => {
  const long = 'fusion-gpt-6-astra-high-sidekick-swe-2-high-effort-max';
  const data = richSnapshot({
    byModel: [
      modelEntry({ model: long }),
      modelEntry({ model: 'gpt-6-astra-high', billing: { source: 'chatgpt', basis: 'declared' } }),
    ],
  });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  const tableBody = html.split('<tbody>')[1].split('</tbody>')[0];
  assert.equal((tableBody.match(/<tr>/g) || []).length, 2);
  assert.match(html, new RegExp(long));
  assert.match(html, /gpt-6-astra-high/);
});

test('ChatGPT origin shows the informed subscription route and never a default zero cost', () => {
  const data = richSnapshot({
    byModel: [modelEntry({ model: 'gpt-6-astra-high', billing: { source: 'chatgpt', basis: 'declared' } })],
  });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.match(html, /ChatGPT\/OAuth \(configuração informada\)/);
  assert.match(html, /Consumo por modelo/);
  const table = html.split('<table class="models">')[1].split('</table>')[0];
  assert.equal(table.includes('US$ 0'), false);
  assert.match(table, /Não configurado \/ indisponível/);
});

test('unknown or undeclared billing source stays unknown', () => {
  const data = richSnapshot({
    byModel: [
      modelEntry({ model: 'm-unknown', billing: { source: 'unknown', basis: 'unknown' } }),
      modelEntry({ model: 'm-undeclared', billing: { source: 'chatgpt', basis: 'unknown' } }),
    ],
  });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.equal((html.match(/Não informada/g) || []).length, 2);
  assert.equal(html.includes('ChatGPT/OAuth'), false);
});

test('per-model request TPS and latest reported TPS stay distinct with coverage', () => {
  const html = view.renderPanel({ snapshot: richSnapshot({ byModel: [modelEntry()] }), mode: 'auto', now: 20000 });
  assert.match(html, /TPS por tempo de chamadas \(inclui espera\)/);
  assert.match(html, /12,5 tok\/s · 2 de 3 requisições/);
  assert.match(html, /100,0 tok\/s · reportado pelo Devin/);
});

test('absent simulation baseline shows the configuration prompt without values', () => {
  const data = richSnapshot({
    byModel: [modelEntry()],
    simulation: {
      baselineModel: null,
      allRequests: 3,
      comparedRequests: 0,
      skippedRequests: 3,
      actualEquivalentUsd: null,
      baselineEquivalentUsd: null,
      differenceUsd: null,
      differencePercent: null,
    },
  });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.match(html, /Configure preços e um modelo de referência para simular\./);
  assert.equal(html.includes('Diferença simulada'), false);
});

test('populated simulation shows compared counts and signed differences without clamping', () => {
  const data = richSnapshot({
    byModel: [modelEntry()],
    simulation: {
      baselineModel: 'reference-model',
      allRequests: 4,
      comparedRequests: 3,
      skippedRequests: 1,
      actualEquivalentUsd: 4,
      baselineEquivalentUsd: 3,
      differenceUsd: -1,
      differencePercent: -33.3,
    },
  });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.match(html, /Requisições comparadas: 3 de 4 \(1 não comparadas: preços ou contadores incompletos\)/);
  assert.match(html, /Modelos observados \(equivalente API\)/);
  assert.match(html, /Mesmo volume à tarifa do modelo de referência/);
  assert.match(html, /Diferença simulada<\/span><span class="value">-US\$ 1,0000 \(-33,3%\)/);
  assert.match(html, /NÃO mede como a tarefa rodaria sem o Fusion/);

  const positive = view.renderPanel({
    snapshot: richSnapshot({
      byModel: [modelEntry()],
      simulation: { ...data.session.simulation, differenceUsd: 0.5, differencePercent: 25 },
    }),
    mode: 'auto',
    now: 20000,
  });
  assert.match(positive, /\+US\$ 0,5000 \(\+25,0%\)/);
});

test('malicious model and billing text cannot inject markup', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const data = richSnapshot({
    model: hostile,
    byModel: [modelEntry({ model: hostile, billing: { source: '<script>x</script>', basis: 'declared' } })],
    simulation: {
      baselineModel: '<script>alert(2)</script>',
      allRequests: 1,
      comparedRequests: 1,
      skippedRequests: 0,
      actualEquivalentUsd: 1,
      baselineEquivalentUsd: 1,
      differenceUsd: 0,
      differencePercent: 0,
    },
  });
  const html = view.renderPanel({ snapshot: data, mode: 'auto', now: 20000 });
  assert.equal(/<img/i.test(html), false);
  assert.equal(/<script/i.test(html), false);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Não informada/);
});

test('session configured model is shown in full and labelled as configuration', () => {
  const longModel = 'fusion-gpt-6-astra-high-sidekick-swe-2-high-effort-max';
  const html = view.renderPanel({ snapshot: richSnapshot({ model: longModel, byModel: [] }), mode: 'manual', now: 20000 });
  assert.match(html, new RegExp(longModel));
  assert.match(html, /configuração, não prova do modelo ativo/);
});

test('a collector without per-model or simulation fields degrades to unavailable notes', () => {
  const html = view.renderPanel({ snapshot: snapshot({ turns: [turn()] }), mode: 'auto', now: 20000 });
  assert.match(html, /Consumo por modelo indisponível nesta versão do coletor\./);
  assert.match(html, /Simulação indisponível nesta versão do coletor\./);
});
