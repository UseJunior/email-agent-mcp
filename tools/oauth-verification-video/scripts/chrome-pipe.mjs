import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout(promise, timeoutMs, description) {
  let timeout;

  const timed = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timed]).finally(() => clearTimeout(timeout));
}
function cdpError(method, error) {
  const detail = error?.message ?? JSON.stringify(error);
  return new Error(`CDP ${method} failed: ${detail}`);
}

export class ChromePipe {
  #child;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #readBuffer = Buffer.alloc(0);
  #defaultTimeoutMs;
  #closed = false;

  constructor(child, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#child = child;
    this.#defaultTimeoutMs = timeoutMs;

    const commandPipe = child.stdio[3];
    const eventPipe = child.stdio[4];

    if (!commandPipe || !eventPipe) {
      throw new Error('Chromium did not expose its DevTools pipe on file descriptors 3 and 4.');
    }

    eventPipe.on('data', chunk => this.#onData(chunk));
    eventPipe.on('error', error => this.#failAll(error));
    commandPipe.on('error', error => this.#failAll(error));

    child.on('error', error => this.#failAll(error));
    child.on('exit', (code, signal) => {
      this.#closed = true;
      this.#failAll(
        new Error(
          `Chromium exited${code === null ? '' : ` with code ${code}`}` +
          `${signal ? ` (${signal})` : ''}`,
        ),
      );
    });
  }

  static async launch({
    executablePath,
    args = [],
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onStderr = chunk => process.stderr.write(chunk),
  }) {
    if (!executablePath) {
      throw new Error('ChromePipe.launch requires executablePath.');
    }

    const child = spawn(
      executablePath,
      ['--remote-debugging-pipe', ...args],
      {
        cwd,
        env,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      },
    );

    child.stderr?.on('data', onStderr);

    const pipe = new ChromePipe(child, { timeoutMs });

    try {
      await pipe.send('Browser.getVersion');
      return pipe;
    } catch (error) {
      await pipe.close({ force: true });
      throw error;
    }
  }

  get process() {
    return this.#child;
  }

  async send(method, params = {}, { sessionId, timeoutMs = this.#defaultTimeoutMs } = {}) {
    if (this.#closed || this.#child.exitCode !== null) {
      throw new Error(`Cannot send CDP ${method}: Chromium is not running.`);
    }

    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    const response = new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
    });

    const commandPipe = this.#child.stdio[3];
    const payload = Buffer.from(`${JSON.stringify(message)}\0`);

    await new Promise((resolve, reject) => {
      commandPipe.write(payload, error => {
        if (error) {
          this.#pending.delete(id);
          reject(error);
          return;
        }
        resolve();
      });
    });

    return withTimeout(response, timeoutMs, `CDP ${method}`);
  }

  waitForEvent(
    method,
    {
      sessionId,
      predicate = () => true,
      timeoutMs = this.#defaultTimeoutMs,
    } = {},
  ) {
    const listener = { sessionId, predicate };
    const promise = new Promise((resolve, reject) => {
      listener.resolve = resolve;
      listener.reject = reject;

      const listeners = this.#listeners.get(method) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(method, listeners);
    });

    return withTimeout(promise, timeoutMs, `CDP event ${method}`).finally(() => {
      const listeners = this.#listeners.get(method);
      listeners?.delete(listener);
      if (listeners?.size === 0) this.#listeners.delete(method);
    });
  }

  async createPage() {
    const created = await this.send('Target.createTarget', { url: 'about:blank' });
    const attached = await this.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });

    await this.send('Page.enable', {}, { sessionId: attached.sessionId });
    await this.send('Runtime.enable', {}, { sessionId: attached.sessionId });

    return {
      targetId: created.targetId,
      sessionId: attached.sessionId,
    };
  }

  async setViewport(sessionId, { width, height, deviceScaleFactor = 1 }) {
    await this.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor,
        mobile: false,
        screenWidth: width,
        screenHeight: height,
      },
      { sessionId },
    );
  }

  async navigate(sessionId, url, { timeoutMs = this.#defaultTimeoutMs } = {}) {
    const loaded = this.waitForEvent('Page.loadEventFired', { sessionId, timeoutMs });
    const result = await this.send('Page.navigate', { url }, { sessionId, timeoutMs });

    if (result.errorText) {
      throw new Error(`Chromium failed to navigate to ${url}: ${result.errorText}`);
    }

    await loaded;
  }

  async evaluate(
    sessionId,
    expression,
    {
      awaitPromise = true,
      returnByValue = true,
      timeoutMs = this.#defaultTimeoutMs,
    } = {},
  ) {
    const response = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue,
        userGesture: false,
      },
      { sessionId, timeoutMs },
    );

    if (response.exceptionDetails) {
      const exception = response.exceptionDetails.exception?.description;
      const text = response.exceptionDetails.text;
      throw new Error(`Browser evaluation failed: ${exception ?? text ?? 'unknown exception'}`);
    }

    return response.result?.value;
  }

  async capturePng(sessionId) {
    const result = await this.send(
      'Page.captureScreenshot',
      {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
      },
      { sessionId },
    );

    if (!result.data) {
      throw new Error('Chromium returned an empty screenshot.');
    }

    return Buffer.from(result.data, 'base64');
  }

  async close({ force = false } = {}) {
    if (this.#closed) return;

    if (!force) {
      try {
        await this.send('Browser.close', {}, { timeoutMs: 2_000 });
      } catch {
        force = true;
      }
    }

    if (force && this.#child.exitCode === null) {
      this.#child.kill('SIGTERM');
    }

    if (this.#child.exitCode === null) {
      await withTimeout(
        new Promise(resolve => this.#child.once('exit', resolve)),
        5_000,
        'Chromium shutdown',
      ).catch(() => {
        this.#child.kill('SIGKILL');
      });
    }

    this.#closed = true;
  }

  #onData(chunk) {
    this.#readBuffer = Buffer.concat([this.#readBuffer, chunk]);

    while (true) {
      const delimiter = this.#readBuffer.indexOf(0);
      if (delimiter === -1) break;

      const payload = this.#readBuffer.subarray(0, delimiter).toString('utf8');
      this.#readBuffer = this.#readBuffer.subarray(delimiter + 1);
      if (!payload) continue;

      let message;
      try {
        message = JSON.parse(payload);
      } catch (error) {
        this.#failAll(new Error(`Chromium sent invalid CDP JSON: ${error.message}`));
        continue;
      }

      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) continue;

        this.#pending.delete(message.id);
        if (message.error) {
          pending.reject(cdpError(pending.method, message.error));
        } else {
          pending.resolve(message.result ?? {});
        }
        continue;
      }

      if (!message.method) continue;
      const listeners = this.#listeners.get(message.method);
      if (!listeners) continue;

      for (const listener of [...listeners]) {
        if (listener.sessionId && listener.sessionId !== message.sessionId) continue;

        try {
          if (!listener.predicate(message.params ?? {})) continue;
          listener.resolve(message.params ?? {});
        } catch (error) {
          listener.reject(error);
        }
      }
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();

    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) {
        listener.reject(error);
      }
    }
    this.#listeners.clear();
  }
}
