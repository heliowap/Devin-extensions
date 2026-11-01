'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  LineReader,
  WorkerBridge,
  createBoundedSink,
  pythonCommandsFor,
} = require('../src/bridge');

const WORKER = '/fixture/collector/worker.py';

function fakeSpawner({ missing = [], delaySpawn = false, throwOnWrite = false } = {}) {
  const children = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new EventEmitter();
    child.stdin.writes = [];
    child.stdin.write = (data) => {
      if (throwOnWrite) {
        throw new Error('write failed');
      }
      child.stdin.writes.push(data);
      return true;
    };
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    };
    children.push(child);
    if (!delaySpawn) setImmediate(() => {
      if (missing.includes(command)) {
        const error = new Error(`spawn ${command} ENOENT`);
        error.code = 'ENOENT';
        child.emit('error', error);
      } else {
        child.emit('spawn');
      }
    });
    return child;
  };
  return { spawn, children };
}

function bridgeWith(spawner, options = {}) {
  return new WorkerBridge({
    pythonCommands: options.pythonCommands || ['python3'],
    workerPath: WORKER,
    timeoutMs: options.timeoutMs || 1000,
    spawn: spawner.spawn,
    onStderrLine: options.onStderrLine,
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) {
    await tick();
  }
  assert.equal(condition(), true);
}

async function waitForChild(spawner, count = 1) {
  await waitFor(() => spawner.children.length >= count && spawner.children[count - 1].stdin.writes.length > 0);
  return spawner.children[count - 1];
}

test('resolves once when a response line arrives split across chunks', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  assert.deepEqual(child.args, ['-u', WORKER]);
  assert.match(child.stdin.writes[0], /"action":"snapshot"/);
  assert.equal(child.stdin.writes[0].endsWith('\n'), true);

  child.stdout.write('{"id":1,"ok":true,"res');
  await tick();
  child.stdout.write('ult":{"schemaVersion":1,"sessions":[]}}\n{"id":1,"ok":true,"result":{"schemaVersion":1}}\n');
  const result = await request;

  assert.deepEqual(result, { schemaVersion: 1, sessions: [] });
  const next = bridge.request({ id: 2, action: 'snapshot' });
  child.stdout.write('{"id":2,"ok":true,"result":{"schemaVersion":1}}\n');
  assert.deepEqual(await next, { schemaVersion: 1 });
  assert.equal(spawner.children.length, 1);
});

test('rejects a worker error with its safe message', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  child.stdout.write('{"id":1,"ok":false,"error":"Solicitação de métricas inválida."}\n');
  await assert.rejects(request, (error) => error.code === 'worker' && error.message === 'Solicitação de métricas inválida.');
});

test('malformed JSON rejects and terminates the child', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  child.stdout.write('not json\n');
  await assert.rejects(request, (error) => error.code === 'protocol');
  assert.equal(child.killed, true);
});

test('response with a different id is a protocol error', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 7, action: 'snapshot' });
  const child = await waitForChild(spawner);
  child.stdout.write('{"id":8,"ok":true,"result":{"schemaVersion":1}}\n');
  await assert.rejects(request, (error) => error.code === 'protocol');
});

test('timeout rejects, stops the child, and the next request starts a new one', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner, { timeoutMs: 20 });
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const first = await waitForChild(spawner);
  await assert.rejects(request, (error) => error.code === 'timeout');
  assert.equal(first.killed, true);

  const retry = bridge.request({ id: 2, action: 'snapshot' });
  const second = await waitForChild(spawner, 2);
  assert.notEqual(second, first);
  second.stdout.write('{"id":2,"ok":true,"result":{"schemaVersion":1}}\n');
  assert.deepEqual(await retry, { schemaVersion: 1 });
});

test('disposal rejects the pending request and terminates the child', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  bridge.dispose();
  await assert.rejects(request, (error) => error.code === 'disposed');
  assert.equal(child.killed, true);
  await assert.rejects(bridge.request({ id: 2, action: 'snapshot' }), (error) => error.code === 'disposed');
  assert.equal(spawner.children.length, 1);
});

test('disposal during spawn kills the child once it starts and never sends a request', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  await waitFor(() => spawner.children.length === 1);
  bridge.dispose();
  await assert.rejects(request, (error) => error.code === 'disposed');
  await waitFor(() => spawner.children[0].killed);
  assert.equal(spawner.children[0].stdin.writes.length, 0);
});

test('child exit while a request is pending rejects it', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  child.emit('exit', 1, null);
  await assert.rejects(request, (error) => error.code === 'exited');
});

test('a second request while one is in flight is rejected as busy', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const first = bridge.request({ id: 1, action: 'snapshot' });
  await assert.rejects(bridge.request({ id: 2, action: 'snapshot' }), (error) => error.code === 'busy');
  const child = await waitForChild(spawner);
  child.stdout.write('{"id":1,"ok":true,"result":{"schemaVersion":1}}\n');
  await first;
});

test('restart rejects the pending request and kills the child', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  bridge.restart(['python3.12']);
  await assert.rejects(request, (error) => error.code === 'restarted');
  assert.equal(child.killed, true);
});

test('falls back to the next Python command when the first is missing', async () => {
  const spawner = fakeSpawner({ missing: ['python3'] });
  const bridge = bridgeWith(spawner, { pythonCommands: ['python3', 'python'] });
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner, 2);
  assert.equal(child.command, 'python');
  child.stdout.write('{"id":1,"ok":true,"result":{"schemaVersion":1}}\n');
  assert.deepEqual(await request, { schemaVersion: 1 });
});

test('reports Python as missing when no command exists', async () => {
  const spawner = fakeSpawner({ missing: ['python3'] });
  const bridge = bridgeWith(spawner);
  await assert.rejects(bridge.request({ id: 1, action: 'snapshot' }), (error) => error.code === 'python-missing');
});

test('pythonCommandsFor keeps the configured command and adds a Windows fallback only for the default', () => {
  assert.deepEqual(pythonCommandsFor('', 'darwin'), ['python3']);
  assert.deepEqual(pythonCommandsFor('python3', 'darwin'), ['python3']);
  assert.deepEqual(pythonCommandsFor('python3', 'win32'), ['python3', 'python']);
  assert.deepEqual(pythonCommandsFor('C:\\Py\\python.exe', 'win32'), ['C:\\Py\\python.exe']);
  assert.deepEqual(pythonCommandsFor(undefined, 'linux'), ['python3']);
});

test('LineReader splits CRLF lines, skips empty ones, and reports overflow', () => {
  const lines = [];
  let overflowed = 0;
  const reader = new LineReader({
    onLine: (line) => lines.push(line),
    onOverflow: () => { overflowed += 1; },
    maxLength: 10,
  });
  reader.push('ab\r\n\r\ncd');
  reader.push('\n');
  assert.deepEqual(lines, ['ab', 'cd']);
  reader.push('0123456789ABCDEF');
  assert.equal(overflowed, 1);
});

test('bounded sink writes at most the limit and one notice', () => {
  const written = [];
  const sink = createBoundedSink((line) => written.push(line), 2);
  sink('one');
  sink('two');
  sink('three');
  sink('four');
  assert.equal(written.length, 3);
  assert.equal(written[0], 'one');
  assert.equal(written[1], 'two');
  assert.match(written[2], /Limite de linhas/);
});

test('stdin error kills the current child and rejects the pending request', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  child.stdin.emit('error', new Error('EPIPE'));
  await assert.rejects(request, (error) => error.code === 'exited');
  assert.equal(child.killed, true);
});

test('timeout during delayed spawn kills only the stale child and sends it no payload', async () => {
  const spawner = fakeSpawner({ delaySpawn: true });
  const bridge = bridgeWith(spawner, { timeoutMs: 20 });
  const first = bridge.request({ id: 1, action: 'snapshot' });
  const stale = spawner.children[0];
  await assert.rejects(first, (error) => error.code === 'timeout');
  stale.emit('spawn');
  await waitFor(() => stale.killed);
  assert.deepEqual(stale.stdin.writes, []);

  const second = bridge.request({ id: 2, action: 'snapshot' });
  await waitFor(() => spawner.children.length === 2);
  spawner.children[1].emit('spawn');
  const fresh = await waitForChild(spawner, 2);
  assert.deepEqual(stale.stdin.writes, []);
  assert.match(fresh.stdin.writes[0], /"id":2/);
  fresh.stdout.write('{"id":2,"ok":true,"result":{"schemaVersion":1}}\n');
  assert.deepEqual(await second, { schemaVersion: 1 });
  assert.equal(fresh.killed, false);
});

test('restart during delayed spawn kills only the stale child and sends it no payload', async () => {
  const spawner = fakeSpawner({ delaySpawn: true });
  const bridge = bridgeWith(spawner);
  const first = bridge.request({ id: 1, action: 'snapshot' });
  const stale = spawner.children[0];
  bridge.restart(['python3']);
  await assert.rejects(first, (error) => error.code === 'restarted');
  stale.emit('spawn');
  await waitFor(() => stale.killed);
  assert.deepEqual(stale.stdin.writes, []);
  assert.equal(spawner.children.length, 1);
});

test('synchronous stdin write failure rejects without an unhandled rejection and kills the child', async () => {
  const spawner = fakeSpawner({ throwOnWrite: true });
  const bridge = bridgeWith(spawner);
  await assert.rejects(bridge.request({ id: 1, action: 'snapshot' }), (error) => error.code === 'write');
  await waitFor(() => spawner.children[0].killed);
});

test('a complete oversized line triggers overflow without reaching onLine', () => {
  const lines = [];
  let overflowed = 0;
  const reader = new LineReader({
    onLine: (line) => lines.push(line),
    onOverflow: () => { overflowed += 1; },
    maxLength: 10,
  });
  reader.push(`${'x'.repeat(11)}\n`);
  assert.equal(overflowed, 1);
  assert.deepEqual(lines, []);
});

test('response with an incompatible schema version is rejected and terminates the child', async () => {
  const spawner = fakeSpawner();
  const bridge = bridgeWith(spawner);
  const request = bridge.request({ id: 1, action: 'snapshot' });
  const child = await waitForChild(spawner);
  child.stdout.write('{"id":1,"ok":true,"result":{"schemaVersion":2}}\n');
  await assert.rejects(request, (error) => error.code === 'protocol');
  assert.equal(child.killed, true);
});
