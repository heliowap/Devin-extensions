'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const vscode = require('vscode');
const { WorkerBridge, createBoundedSink, pythonCommandsFor } = require('./bridge');
const view = require('./view');

const SELECTED_SESSION_KEY = 'devinPulse.selectedSessionId';
const TICK_MS = 1000;
const MIN_POLL_MS = 500;
const MAX_POLL_MS = 60000;
const DEFAULT_POLL_MS = 1000;
const SAVE_ERROR_MESSAGE = 'Não foi possível salvar a sessão escolhida.';

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readSettings() {
  const config = vscode.workspace.getConfiguration('devinPulse');
  const pollInterval = Number(config.get('pollIntervalMs', DEFAULT_POLL_MS));
  const databasePath = config.get('databasePath', '');
  const simulationModel = config.get('simulationModel', '');
  return {
    databasePath: typeof databasePath === 'string' ? databasePath : '',
    pythonCommands: pythonCommandsFor(config.get('pythonPath', 'python3')),
    pollIntervalMs: Number.isFinite(pollInterval)
      ? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, pollInterval))
      : DEFAULT_POLL_MS,
    showStatusBar: config.get('showStatusBar', true) !== false,
    prices: plainObject(config.get('prices', {})),
    billingSources: plainObject(config.get('billingSources', {})),
    openAiBilling: config.get('openAiBilling', 'unknown'),
    simulationModel: typeof simulationModel === 'string' ? simulationModel : '',
  };
}

function describeError(error) {
  if (error && error.name === 'BridgeError') {
    return error.message;
  }
  return 'Falha inesperada ao coletar métricas locais.';
}

function workspacePaths() {
  return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
}

function createNonce() {
  return crypto.randomBytes(16).toString('base64');
}

class PulseController {
  constructor(context) {
    this.context = context;
    this.disposables = [];
    this.output = vscode.window.createOutputChannel('Devin Pulse');
    this.stderrSink = createBoundedSink((line) => this.output.appendLine(line));
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'devinPulse.open';
    this.workerPath = path.join(context.extensionPath, 'collector', 'worker.py');
    this.settings = readSettings();
    this.bridge = this.createBridge();
    this.latest = { snapshot: null, error: null };
    this.panel = null;
    this.panelListeners = [];
    this.selectedTurnId = null;
    this.lastSignature = null;
    this.inFlight = false;
    this.selectionPending = false;
    this.epoch = 0;
    this.nextRequestId = 1;
    this.pollTimer = null;
    this.tickTimer = null;
    this.disposed = false;
  }

  createBridge() {
    return new WorkerBridge({
      pythonCommands: this.settings.pythonCommands,
      workerPath: this.workerPath,
      onStderrLine: this.stderrSink,
    });
  }

  register() {
    this.disposables.push(
      vscode.commands.registerCommand('devinPulse.open', () => this.openPanel()),
      vscode.commands.registerCommand('devinPulse.refresh', () => this.pollNow(true)),
      vscode.commands.registerCommand('devinPulse.selectSession', () => this.chooseSession()),
      vscode.commands.registerCommand('devinPulse.autoSession', () => this.useAutoSession()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('devinPulse')) {
          this.onConfigChanged();
        }
      }),
    );
  }

  start() {
    this.refreshViews();
    this.schedulePoll(0);
  }

  schedulePoll(delay = this.settings.pollIntervalMs) {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.disposed) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollNow();
    }, delay);
  }

  isUiVisible() {
    return this.settings.showStatusBar || this.panel !== null;
  }

  async pollNow(force = false) {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.disposed || this.inFlight || this.selectionPending) {
      return;
    }
    if (!force && !this.isUiVisible()) {
      this.schedulePoll();
      return;
    }
    this.inFlight = true;
    const epoch = this.epoch;
    try {
      const snapshot = await this.bridge.request({
        id: this.nextRequestId++,
        action: 'snapshot',
        databasePath: this.settings.databasePath,
        sessionId: this.persistedSessionId(),
        workspacePaths: workspacePaths(),
        prices: this.settings.prices,
        billingSources: this.settings.billingSources,
        openAiBilling: this.settings.openAiBilling,
        simulationModel: this.settings.simulationModel,
      });
      if (epoch === this.epoch) {
        this.setLatest({ snapshot, error: null });
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.setLatest({ snapshot: null, error: describeError(error) });
      }
    } finally {
      this.inFlight = false;
      this.schedulePoll(epoch === this.epoch ? this.settings.pollIntervalMs : 0);
    }
  }

  setLatest(next) {
    this.latest = next;
    this.refreshViews();
  }

  persistedSessionId() {
    const value = this.context.workspaceState.get(SELECTED_SESSION_KEY);
    return typeof value === 'string' ? value : null;
  }

  mode() {
    return this.persistedSessionId() ? 'manual' : 'auto';
  }

  openTurn() {
    const turns = this.latest.snapshot && this.latest.snapshot.session ? this.latest.snapshot.session.turns || [] : [];
    return turns.find((turn) => turn.state === 'open') || null;
  }

  refreshViews() {
    if (this.disposed) {
      return;
    }
    const now = Date.now();
    const mode = this.mode();
    const status = view.statusBarModel({
      snapshot: this.latest.snapshot,
      error: this.latest.error,
      mode,
      now,
    });
    this.statusItem.text = status.text;
    this.statusItem.tooltip = status.tooltip;
    this.statusItem.backgroundColor = status.warning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    if (this.settings.showStatusBar) {
      this.statusItem.show();
    } else {
      this.statusItem.hide();
    }
    if (this.panel) {
      this.updatePanel(now, mode);
    }
    this.syncTicker();
  }

  updatePanel(now, mode) {
    const html = view.renderPanel({
      snapshot: this.latest.snapshot,
      error: this.latest.error,
      mode,
      selectedTurnId: this.selectedTurnId,
      now,
    });
    const signature = view.stableSignature(html);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.panel.webview.postMessage({ type: 'render', html });
      return;
    }
    const open = this.openTurn();
    if (open) {
      this.panel.webview.postMessage({ type: 'tick', text: view.liveElapsedText(open, now) });
    }
  }

  syncTicker() {
    const hasOpen = this.openTurn() !== null;
    if (hasOpen && !this.tickTimer) {
      this.tickTimer = setInterval(() => this.refreshViews(), TICK_MS);
    } else if (!hasOpen && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  openPanel() {
    if (this.disposed) {
      return;
    }
    if (this.panel) {
      this.panel.reveal();
      this.pollNow(true);
      return;
    }
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('devinPulse', 'Devin Pulse', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [mediaRoot],
    });
    panel.webview.html = view.buildDocument({
      nonce: createNonce(),
      cspSource: panel.webview.cspSource,
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css')).toString(),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js')).toString(),
    });
    this.panel = panel;
    this.lastSignature = null;
    this.panelListeners = [panel.webview.onDidReceiveMessage((message) => this.handleMessage(message))];
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = null;
        this.lastSignature = null;
        this.panelListeners.forEach((listener) => listener.dispose());
        this.panelListeners = [];
      }
    });
    this.pollNow(true);
  }

  async handleMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.action !== 'string') {
      return;
    }
    switch (message.action) {
      case 'ready':
        this.lastSignature = null;
        this.refreshViews();
        break;
      case 'refresh':
        this.pollNow(true);
        break;
      case 'chooseSession':
        await this.chooseSession();
        break;
      case 'autoSession':
        await this.useAutoSession();
        break;
      case 'selectSession':
        if (this.hasSession(message.id)) {
          await this.setSessionSelection(message.id);
        }
        break;
      case 'selectTurn':
        if (this.hasTurn(message.id)) {
          this.selectedTurnId = message.id;
          this.refreshViews();
        }
        break;
      default:
        break;
    }
  }

  hasSession(id) {
    const sessions = this.latest.snapshot && Array.isArray(this.latest.snapshot.sessions)
      ? this.latest.snapshot.sessions
      : [];
    return typeof id === 'string' && sessions.some((session) => session.id === id);
  }

  hasTurn(id) {
    const turns = this.latest.snapshot && this.latest.snapshot.session ? this.latest.snapshot.session.turns || [] : [];
    return typeof id === 'string' && turns.some((turn) => turn.id === id);
  }

  setSessionSelection(id) {
    return this.updateSelection(id);
  }

  useAutoSession() {
    return this.updateSelection(undefined);
  }

  async updateSelection(value) {
    if (this.disposed) {
      return;
    }
    this.epoch += 1;
    this.selectionPending = true;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.selectedTurnId = null;
    this.latest = { snapshot: null, error: null };
    this.refreshViews();
    try {
      await this.context.workspaceState.update(SELECTED_SESSION_KEY, value);
    } catch {
      this.selectionPending = false;
      this.setLatest({ snapshot: null, error: SAVE_ERROR_MESSAGE });
      this.schedulePoll();
      return;
    }
    this.selectionPending = false;
    this.pollNow(true);
  }

  async chooseSession() {
    try {
      const sessions = this.latest.snapshot && Array.isArray(this.latest.snapshot.sessions)
        ? this.latest.snapshot.sessions
        : [];
      if (sessions.length === 0) {
        vscode.window.showInformationMessage('Devin Pulse: nenhuma sessão disponível. Atualize primeiro.');
        return;
      }
      const items = sessions.map((session) => ({
        label: session.title || '(sem título)',
        description: session.model || '',
        detail: session.directory || '',
        sessionId: session.id,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Escolha a sessão do Devin a acompanhar',
      });
      if (picked && this.hasSession(picked.sessionId)) {
        await this.setSessionSelection(picked.sessionId);
      }
    } catch {
      this.setLatest({ snapshot: null, error: SAVE_ERROR_MESSAGE });
    }
  }

  onConfigChanged() {
    if (this.disposed) {
      return;
    }
    this.epoch += 1;
    this.settings = readSettings();
    this.selectedTurnId = null;
    this.latest = { snapshot: null, error: null };
    this.bridge.restart(this.settings.pythonCommands);
    this.refreshViews();
    this.pollNow(true);
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.tickTimer);
    this.bridge.dispose();
    this.panelListeners.forEach((listener) => listener.dispose());
    this.panelListeners = [];
    if (this.panel) {
      this.panel.dispose();
      this.panel = null;
    }
    this.disposables.forEach((item) => item.dispose());
    this.disposables = [];
    this.statusItem.dispose();
    this.output.dispose();
  }
}

let controller = null;

function activate(context) {
  controller = new PulseController(context);
  controller.register();
  context.subscriptions.push(controller);
  controller.start();
}

function deactivate() {
  if (controller) {
    controller.dispose();
    controller = null;
  }
}

module.exports = { activate, deactivate, PulseController };
