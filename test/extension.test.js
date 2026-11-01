'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const realBridge = require('../src/bridge');

const EXTENSION_PATH = path.join(__dirname, '..', 'src', 'extension.js');
const SELECTED_KEY = 'devinPulse.selectedSessionId';
const instances = [];
const controllers = [];

class FakeBridge {
  constructor() {
    this.requests = [];
    this.restarts = [];
    this.disposed = false;
    instances.push(this);
  }

  request(payload) {
    if (this.disposed) {
      return Promise.reject(Object.assign(new Error('Devin Pulse foi encerrado.'), { name: 'BridgeError', code: 'disposed' }));
    }
    return new Promise((resolve, reject) => {
      const record = { payload, done: false };
      record.resolve = (value) => {
        if (!record.done) {
          record.done = true;
          resolve(value);
        }
      };
      record.reject = (error) => {
        if (!record.done) {
          record.done = true;
          reject(error);
        }
      };
      this.requests.push(record);
    });
  }

  restart(commands) {
    this.restarts.push(commands);
    this.rejectOpen('restarted', 'Coletor reiniciado.');
  }

  dispose() {
    this.disposed = true;
    this.rejectOpen('disposed', 'Devin Pulse foi encerrado.');
  }

  rejectOpen(code, message) {
    for (const record of this.requests) {
      record.reject(Object.assign(new Error(message), { name: 'BridgeError', code }));
    }
  }
}

function createFakePanel(panels) {
  const messageListeners = [];
  const disposeListeners = [];
  let disposed = false;
  const panel = {
    webview: {
      html: '',
      cspSource: 'vscode-webview://fixture',
      posted: [],
      postMessage(message) {
        this.posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(listener) {
        messageListeners.push(listener);
        return { dispose() {} };
      },
      asWebviewUri(uri) {
        return { toString: () => `vscode-resource://fixture${uri.toString()}` };
      },
    },
    reveal() {},
    onDidDispose(listener) {
      disposeListeners.push(listener);
      return { dispose() {} };
    },
    dispose() {
      panel.close();
    },
    receive(message) {
      messageListeners.forEach((listener) => listener(message));
    },
    close() {
      if (!disposed) {
        disposed = true;
        disposeListeners.forEach((listener) => listener());
      }
    },
  };
  panels.push(panel);
  return panel;
}

function fakeVscode(settings) {
  const panels = [];
  const statusItems = [];
  const config = {
    get: (key, fallback) => (Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback),
  };
  return {
    panels,
    statusItems,
    workspace: {
      getConfiguration: () => config,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      workspaceFolders: [{ uri: { fsPath: '/fixture/work' } }],
    },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => {
        const item = {
          text: '',
          tooltip: '',
          command: '',
          backgroundColor: undefined,
          disposed: false,
          show() {},
          hide() {},
          dispose() {
            this.disposed = true;
          },
        };
        statusItems.push(item);
        return item;
      },
      createWebviewPanel: () => createFakePanel(panels),
      showQuickPick: async () => undefined,
      showInformationMessage() {},
    },
    commands: {
      registerCommand: () => ({ dispose() {} }),
    },
    StatusBarAlignment: { Right: 1 },
    ViewColumn: { Active: 1 },
    ThemeColor: class ThemeColor {
      constructor(id) {
        this.id = id;
      }
    },
    Uri: {
      joinPath: (base, ...parts) => ({ toString: () => [base.path, ...parts].join('/') }),
    },
  };
}

function fakeContext() {
  const values = new Map();
  const held = [];
  const context = {
    extensionPath: '/fixture/ext',
    extensionUri: { path: '/fixture/ext' },
    subscriptions: [],
    values,
    holdUpdates: false,
    workspaceState: {
      get: (key) => values.get(key),
      update(key, value) {
        return new Promise((resolve) => {
          const apply = () => {
            if (value === undefined) {
              values.delete(key);
            } else {
              values.set(key, value);
            }
            resolve();
          };
          if (context.holdUpdates) {
            held.push(apply);
          } else {
            apply();
          }
        });
      },
    },
    releaseUpdates() {
      while (held.length > 0) {
        held.shift()();
      }
    },
  };
  return context;
}

function loadExtension(vscodeFake) {
  delete require.cache[EXTENSION_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeFake;
    }
    if (request === './bridge' && parent && parent.filename === EXTENSION_PATH) {
      return { ...realBridge, WorkerBridge: FakeBridge };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(EXTENSION_PATH);
  } finally {
    Module._load = originalLoad;
  }
}

function createController(settings = { pollIntervalMs: 500 }) {
  const vscodeFake = fakeVscode(settings);
  const extension = loadExtension(vscodeFake);
  const context = fakeContext();
  const controller = new extension.PulseController(context);
  controllers.push(controller);
  const bridge = instances[instances.length - 1];
  return { controller, bridge, context, vscodeFake, extension };
}

function usage() {
  return {
    requests: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, unknown: [] },
    costUsd: null,
    pricedRequests: 0,
  };
}

function snapshot({ selected = null, sessionId = 'a', sessionTitle = 'Sessão A', turns = [] } = {}) {
  return {
    schemaVersion: 1,
    observedAt: Date.now(),
    source: { state: 'ready', message: null },
    sessions: [
      { id: 'a', title: 'Sessão A', directory: '/fixture/work', model: 'model-a', updatedAt: 1 },
      { id: 'b', title: 'Sessão B', directory: '/fixture/work', model: 'model-b', updatedAt: 2 },
    ],
    selectedSessionId: selected,
    session: {
      id: sessionId,
      title: sessionTitle,
      directory: '/fixture/work',
      model: 'model-a',
      warnings: [],
      totals: usage(),
      unassignedRequests: 0,
      turns,
    },
  };
}

function openTurn() {
  return {
    id: 't1',
    index: 1,
    startedAt: Date.now() - 1000,
    endedAt: null,
    state: 'open',
    elapsedMs: null,
    lead: usage(),
    delegated: usage(),
    lastRequest: null,
    requests: [],
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(condition, message = 'condition not reached') {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), message);
}

async function primeSnapshot(controller, bridge, data = snapshot()) {
  const first = controller.pollNow(true);
  await waitFor(() => bridge.requests.length === 1, 'first poll not sent');
  bridge.requests[0].resolve(data);
  await first;
}

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose();
  }
  instances.length = 0;
});

test('a manual selection is saved before the next poll uses it', async () => {
  const { controller, bridge, context } = createController();
  await primeSnapshot(controller, bridge);
  context.holdUpdates = true;
  const selection = controller.handleMessage({ action: 'selectSession', id: 'b' });
  await tick();
  await tick();
  assert.equal(bridge.requests.length, 1);
  context.releaseUpdates();
  await selection;
  assert.equal(bridge.requests.length, 2);
  assert.equal(bridge.requests[1].payload.sessionId, 'b');
});

test('a delayed snapshot from before a selection change cannot replace the new selection', async () => {
  const { controller, bridge } = createController();
  await primeSnapshot(controller, bridge);
  const old = controller.pollNow(true);
  await waitFor(() => bridge.requests.length === 2, 'old poll not sent');
  await controller.handleMessage({ action: 'selectSession', id: 'b' });
  assert.equal(controller.latest.snapshot, null);

  bridge.requests[1].resolve(snapshot({ selected: null, sessionId: 'a' }));
  await old;
  await tick();
  assert.equal(controller.latest.snapshot, null);

  await waitFor(() => bridge.requests.length === 3, 'next poll not scheduled after the old one');
  assert.equal(bridge.requests[2].payload.sessionId, 'b');
  bridge.requests[2].resolve(snapshot({ selected: 'b', sessionId: 'b', sessionTitle: 'Sessão B' }));
  await waitFor(() => controller.latest.snapshot !== null, 'new snapshot not displayed');
  assert.equal(controller.latest.snapshot.selectedSessionId, 'b');
});

test('a config change restarts the worker and a stale rejection cannot clear the next snapshot', async () => {
  const { controller, bridge } = createController();
  await primeSnapshot(controller, bridge);
  const old = controller.pollNow(true);
  await waitFor(() => bridge.requests.length === 2, 'old poll not sent');
  controller.onConfigChanged();
  assert.equal(bridge.restarts.length, 1);
  await old;
  await tick();
  assert.equal(controller.latest.error, null);

  await waitFor(() => bridge.requests.length === 3, 'poll not rescheduled after config change');
  bridge.requests[2].resolve(snapshot());
  await waitFor(() => controller.latest.snapshot !== null, 'new snapshot not displayed');
  assert.equal(controller.latest.error, null);
});

test('webview ready receives the current render, and reopening receives it again', async () => {
  const { controller, bridge, vscodeFake } = createController();
  await primeSnapshot(controller, bridge);
  controller.openPanel();
  const first = vscodeFake.panels[0];
  first.receive({ action: 'ready' });
  const firstRender = first.webview.posted.find((message) => message.type === 'render');
  assert.ok(firstRender && firstRender.html.includes('Sessão A'));

  first.close();
  assert.equal(controller.panel, null);
  controller.openPanel();
  const second = vscodeFake.panels[1];
  second.receive({ action: 'ready' });
  const secondRender = second.webview.posted.find((message) => message.type === 'render');
  assert.ok(secondRender && secondRender.html.includes('Sessão A'));
});

test('unknown webview actions and session or turn ids are ignored', async () => {
  const { controller, bridge, context } = createController();
  await primeSnapshot(controller, bridge);
  const requestsBefore = bridge.requests.length;
  const epochBefore = controller.epoch;

  await controller.handleMessage({ action: 'shell', id: 'x' });
  await controller.handleMessage({ action: 'selectSession', id: 'ghost' });
  await controller.handleMessage({ action: 'selectTurn', id: 'nope' });
  await controller.handleMessage({ action: 'selectSession' });
  await controller.handleMessage('selectSession');
  await controller.handleMessage(null);

  assert.equal(context.values.has(SELECTED_KEY), false);
  assert.equal(bridge.requests.length, requestsBefore);
  assert.equal(controller.epoch, epochBefore);
  assert.equal(controller.selectedTurnId, null);
});

test('deactivate clears timers and disposes the worker', async () => {
  const vscodeFake = fakeVscode({ pollIntervalMs: 500 });
  const extension = loadExtension(vscodeFake);
  const context = fakeContext();
  extension.activate(context);
  const bridge = instances[instances.length - 1];
  await waitFor(() => bridge.requests.length === 1, 'activation did not poll');
  bridge.requests[0].resolve(snapshot({ turns: [openTurn()] }));
  await waitFor(() => vscodeFake.statusItems[0].text.includes('desde envio'), 'status bar not updated');

  extension.deactivate();
  assert.equal(bridge.disposed, true);
  assert.equal(vscodeFake.statusItems[0].disposed, true);
  const requestsAtDispose = bridge.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(bridge.requests.length, requestsAtDispose);
});

test('snapshot payload carries billing routes and simulation settings', async () => {
  const { controller, bridge } = createController({
    pollIntervalMs: 500,
    billingSources: { 'model-a': 'api' },
    openAiBilling: 'chatgpt',
    simulationModel: 'reference-model',
  });
  const first = controller.pollNow(true);
  await waitFor(() => bridge.requests.length === 1, 'poll not sent');
  const { payload } = bridge.requests[0];
  assert.deepEqual(payload.billingSources, { 'model-a': 'api' });
  assert.equal(payload.openAiBilling, 'chatgpt');
  assert.equal(payload.simulationModel, 'reference-model');
  bridge.requests[0].resolve(snapshot());
  await first;
});

test('unset billing and simulation settings default to undeclared values', async () => {
  const { controller, bridge } = createController({ pollIntervalMs: 500 });
  const first = controller.pollNow(true);
  await waitFor(() => bridge.requests.length === 1, 'poll not sent');
  const { payload } = bridge.requests[0];
  assert.deepEqual(payload.billingSources, {});
  assert.equal(payload.openAiBilling, 'unknown');
  assert.equal(payload.simulationModel, '');
  bridge.requests[0].resolve(snapshot());
  await first;
});

test('non-object billing sources are replaced with an empty declaration', async () => {
  const { controller, bridge } = createController({ pollIntervalMs: 500, billingSources: ['api'] });
  const first = controller.pollNow(true);
  await waitFor(() => bridge.requests.length === 1, 'poll not sent');
  assert.deepEqual(bridge.requests[0].payload.billingSources, {});
  bridge.requests[0].resolve(snapshot());
  await first;
});
