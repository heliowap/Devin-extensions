'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const view = require('../src/view');

const REPO = path.join(__dirname, '..');
const SNAPSHOT_SCRIPT = [
  'import sys,json',
  "sys.path.insert(0,'test')",
  'from test_metrics import MetricsTests',
  "case=MetricsTests('test_api_simulation_uses_same_eligible_subset_and_all_four_categories')",
  'case.setUp()',
  'try:',
  "  rates=lambda n:dict.fromkeys(('input','output','cacheRead','cacheWrite'),n)",
  "  data=case.read(prices={'model-a':rates(1),'model-b':rates(3)},billing_sources={'model-a':'api','model-b':'devin'},simulation_model='model-a')",
  '  print(json.dumps(data))',
  'finally:',
  '  case.doCleanups()',
].join('\n');

test('collector snapshot feeds the panel simulation and per-model rows', () => {
  const result = spawnSync('python3', ['-c', SNAPSHOT_SCRIPT], { cwd: REPO, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const snapshot = JSON.parse(result.stdout);
  const simulation = snapshot.session.simulation;
  assert.equal(simulation.comparedRequests, 4);
  assert.ok(Math.abs(simulation.differenceUsd - -0.0002) < 1e-12, `differenceUsd was ${simulation.differenceUsd}`);

  const html = view.renderPanel({ snapshot, mode: 'auto', now: snapshot.observedAt });
  for (const text of [
    'Requisições comparadas: 4 de 4',
    '-US$ 0,0002 (-50,0%)',
    'Consumo por modelo',
    'model-a',
    'model-b',
  ]) {
    assert.ok(html.includes(text), `panel is missing ${text}`);
  }
});
