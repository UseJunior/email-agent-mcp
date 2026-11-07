import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { startLoopbackOAuthListener } from './oauth-loopback.js';

const listeners: Awaited<ReturnType<typeof startLoopbackOAuthListener>>[] = [];
afterEach(() => { for (const listener of listeners.splice(0)) listener.cancel(); });
async function listener(options: Parameters<typeof startLoopbackOAuthListener>[1] = {}) {
  const result = await startLoopbackOAuthListener('expected', options);
  listeners.push(result);
  return result;
}

describe('cli/Loopback OAuth lifecycle', () => {
  it('validates state before returning a code and closes idle connections', async () => {
    const l = await listener();
    const port = Number(new URL(l.redirectUri).port);
    const idle = connect(port, '127.0.0.1');
    await once(idle, 'connect');
    const closed = once(idle, 'close');
    const response = await fetch(`${l.redirectUri}?state=expected&code=synthetic`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('complete');
    expect(await l.waitForCallback).toEqual({ state: 'expected', code: 'synthetic' });
    await closed;
    // Repeated terminal events cannot replace the accepted result.
    l.cancel();
    expect(await l.waitForCallback).toHaveProperty('code', 'synthetic');
  });

  for (const query of ['code=synthetic', 'state=wrong&code=synthetic', 'state=expected', 'state=expected&error=access_denied']) {
    it(`rejects invalid callback ${query}`, async () => {
      const l = await listener();
      const failure = expect(l.waitForCallback).rejects.toThrow(/OAuth/);
      const response = await fetch(`${l.redirectUri}?${query}`);
      expect(response.status).toBe(400);
      await response.text();
      await failure;
    });
  }

  it('does not settle on another path', async () => {
    const l = await listener();
    expect((await fetch(l.redirectUri.replace('/oauth2callback', '/elsewhere'))).status).toBe(404);
    const failure = expect(l.waitForCallback).rejects.toThrow('cancelled');
    l.cancel();
    await failure;
  });

  it('times out despite a slow open connection', async () => {
    const l = await listener({ timeoutMs: 80 });
    const failure = expect(l.waitForCallback).rejects.toThrow('Timed out');
    const socket = connect(Number(new URL(l.redirectUri).port), '127.0.0.1');
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    socket.write('GET /oauth2callback HTTP/1.1\r\n');
    await failure;
    await closed;
  });

  it('cancels on AbortSignal including pre-aborted signals', async () => {
    for (const before of [false, true]) {
      const controller = new AbortController();
      if (before) controller.abort();
      const l = await listener({ signal: controller.signal });
      const failure = expect(l.waitForCallback).rejects.toThrow('cancelled');
      controller.abort();
      await failure;
    }
  });

  it('cleans up listen failure without an unhandled callback rejection', async () => {
    let closed = false;
    const factory: typeof createServer = ((...args: Parameters<typeof createServer>) => {
      const server = createServer(...args);
      server.listen = (() => { queueMicrotask(() => server.emit('error', new Error('listen failed'))); return server; }) as typeof server.listen;
      const close = server.close.bind(server);
      server.close = ((...params: Parameters<typeof server.close>) => { closed = true; return close(...params); }) as typeof server.close;
      return server;
    }) as typeof createServer;
    await expect(listener({ createServer: factory })).rejects.toThrow('listen failed');
    expect(closed).toBe(true);
  });
});
