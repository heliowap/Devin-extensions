'use strict';

const { spawn: spawnProcess } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_STDERR_LINE_LENGTH = 500;
const SUPPORTED_SCHEMA_VERSION = 1;

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

class LineReader {
  constructor({ onLine, onOverflow, maxLength }) {
    this.buffer = '';
    this.onLine = onLine;
    this.onOverflow = onOverflow;
    this.maxLength = maxLength;
  }

  push(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > this.maxLength) {
        this.buffer = '';
        this.onOverflow();
        return;
      }
      if (line.length > 0) {
        this.onLine(line);
      }
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxLength) {
      this.buffer = '';
      this.onOverflow();
    }
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError() {
  return new BridgeError('protocol', 'Resposta inválida do coletor local.');
}

function exitedError() {
  return new BridgeError('exited', 'O coletor local encerrou inesperadamente.');
}

function pythonCommandsFor(configured, platform = process.platform) {
  const command = typeof configured === 'string' && configured.trim() ? configured.trim() : 'python3';
  return platform === 'win32' && command === 'python3' ? ['python3', 'python'] : [command];
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('spawn', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function terminate(child) {
  try {
    child.kill('SIGTERM');
  } catch {
    // The process is already gone.
  }
}

function createBoundedSink(write, maxLines = 200) {
  let count = 0;
  return (line) => {
    if (count < maxLines) {
      count += 1;
      write(line.slice(0, MAX_STDERR_LINE_LENGTH));
    } else if (count === maxLines) {
      count += 1;
      write('Limite de linhas de diagnóstico atingido; as saídas seguintes foram omitidas.');
    }
  };
}

class WorkerBridge {
  constructor({
    pythonCommands,
    workerPath,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawn = spawnProcess,
    onStderrLine = () => {},
  }) {
    this.pythonCommands = [...pythonCommands];
    this.workerPath = workerPath;
    this.timeoutMs = timeoutMs;
    this.spawn = spawn;
    this.onStderrLine = onStderrLine;
    this.child = null;
    this.pending = null;
    this.disposed = false;
  }

  request(payload) {
    if (this.disposed) {
      return Promise.reject(new BridgeError('disposed', 'Devin Pulse foi encerrado.'));
    }
    if (this.pending) {
      return Promise.reject(new BridgeError('busy', 'Já existe uma coleta em andamento.'));
    }
    return new Promise((resolve, reject) => {
      const pending = { id: payload.id, resolve, reject, timer: null };
      this.pending = pending;
      pending.timer = setTimeout(
        () => this.fail(pending, new BridgeError('timeout', 'A coleta local excedeu o tempo limite.')),
        this.timeoutMs,
      );
      this.ensureChild(pending).then(
        (child) => {
          if (this.pending !== pending) {
            return;
          }
          try {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
          } catch {
            this.fail(pending, new BridgeError('write', 'Falha ao enviar a requisição ao coletor local.'));
          }
        },
        (error) => this.fail(pending, error),
      );
    });
  }

  restart(pythonCommands) {
    if (pythonCommands) {
      this.pythonCommands = [...pythonCommands];
    }
    if (this.pending) {
      this.fail(this.pending, new BridgeError('restarted', 'Coletor reiniciado.'));
    } else {
      this.killChild();
    }
  }

  dispose() {
    this.disposed = true;
    if (this.pending) {
      this.fail(this.pending, new BridgeError('disposed', 'Devin Pulse foi encerrado.'));
    } else {
      this.killChild();
    }
  }

  async ensureChild(pending) {
    if (this.child) {
      return this.child;
    }
    for (const command of this.pythonCommands) {
      if (this.disposed || this.pending !== pending) {
        throw new BridgeError('cancelled', 'Coleta cancelada antes de iniciar o coletor.');
      }
      const child = this.spawn(command, ['-u', this.workerPath], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      try {
        await waitForSpawn(child);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          continue;
        }
        throw new BridgeError('spawn', 'Não foi possível iniciar o Python configurado.');
      }
      if (this.disposed || this.pending !== pending) {
        terminate(child);
        throw new BridgeError(this.disposed ? 'disposed' : 'cancelled', 'Coleta cancelada antes de iniciar o coletor.');
      }
      this.attach(child);
      return child;
    }
    throw new BridgeError('python-missing', 'Python 3.10+ não encontrado. Ajuste devinPulse.pythonPath.');
  }

  attach(child) {
    this.child = child;
    const lost = () => this.childLost(child);
    const stdout = new LineReader({
      onLine: (line) => this.handleLine(child, line),
      onOverflow: () => this.childLost(child, protocolError()),
      maxLength: MAX_LINE_LENGTH,
    });
    const stderr = new LineReader({
      onLine: (line) => this.onStderrLine(line),
      onOverflow: () => {},
      maxLength: MAX_LINE_LENGTH,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child === child) {
        stdout.push(chunk);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', lost);
    child.on('error', lost);
    child.on('exit', lost);
  }

  childLost(child, error = exitedError()) {
    if (this.child !== child) {
      return;
    }
    if (this.pending) {
      this.fail(this.pending, error);
    } else {
      this.killChild();
    }
  }

  handleLine(child, line) {
    const pending = this.pending;
    if (this.child !== child || !pending) {
      return;
    }
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      this.fail(pending, protocolError());
      return;
    }
    if (!isObject(data) || data.id !== pending.id) {
      this.fail(pending, protocolError());
      return;
    }
    if (data.ok === true && isObject(data.result)) {
      if (data.result.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        this.fail(pending, new BridgeError('protocol', 'Versão incompatível do coletor local.'));
        return;
      }
      this.finish(pending, null, data.result);
    } else if (data.ok === false) {
      const message = typeof data.error === 'string' ? data.error.slice(0, 300) : 'Falha ao coletar métricas locais.';
      this.finish(pending, new BridgeError('worker', message), undefined);
    } else {
      this.fail(pending, protocolError());
    }
  }

  finish(pending, error, value) {
    if (this.pending !== pending) {
      return;
    }
    this.pending = null;
    clearTimeout(pending.timer);
    if (error) {
      pending.reject(error);
    } else {
      pending.resolve(value);
    }
  }

  fail(pending, error) {
    if (this.pending !== pending) {
      return;
    }
    this.finish(pending, error, undefined);
    this.killChild();
  }

  killChild() {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    terminate(child);
  }
}

module.exports = {
  BridgeError,
  LineReader,
  WorkerBridge,
  createBoundedSink,
  pythonCommandsFor,
};
