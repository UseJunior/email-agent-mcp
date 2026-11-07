import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

export interface OAuthCallbackResult { code: string; state: string }
export interface LoopbackOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Dependency injection for listener error regression tests. */
  createServer?: typeof createServer;
}

/** One owner settles the result and closes every listener resource. */
export async function startLoopbackOAuthListener(expectedState: string, options: LoopbackOptions = {}): Promise<{
  redirectUri: string;
  waitForCallback: Promise<OAuthCallbackResult>;
  cancel: () => void;
}> {
  if (!expectedState) throw new Error('Expected OAuth state is required');
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid OAuth timeout');
  let phase: 'listening' | 'settling' | 'settled' = 'listening';
  let resolve!: (result: OAuthCallbackResult) => void;
  let reject!: (error: Error) => void;
  const waitForCallback = new Promise<OAuthCallbackResult>((yes, no) => { resolve = yes; reject = no; });
  // A configure failure before its first await of this promise must not create
  // an unhandled rejection. The original promise still rejects to its caller.
  void waitForCallback.catch(() => {});
  const sockets = new Set<Socket>();
  let server: Server;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = () => settle(new Error('Google OAuth callback cancelled'));
  function settle(outcome: Error | OAuthCallbackResult) {
    if (phase !== 'listening') return;
    phase = 'settling';
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', aborted);
    server.close();
    for (const socket of sockets) socket.destroy();
    phase = 'settled';
    if (outcome instanceof Error) reject(outcome);
    else resolve(outcome);
  }
  server = (options.createServer ?? createServer)((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth2callback') { res.writeHead(404).end('Not found.'); return; }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const outcome = state !== expectedState
      ? new Error('Google OAuth state mismatch')
      : error ? new Error('Google OAuth authorization denied')
      : !code ? new Error('Google OAuth callback did not include an authorization code')
      : { code, state };
    // Flush the browser response before destroying keepalive/slow connections.
    // Values from the callback are never rendered into HTML or logged.
    res.once('finish', () => settle(outcome));
    res.writeHead(outcome instanceof Error ? 400 : 200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><h1>Authentication ${outcome instanceof Error ? 'failed' : 'complete'}</h1><p>You can return to the terminal.</p></body></html>`);
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', error => settle(error));
  try {
    await new Promise<void>((yes, no) => {
      const onError = (error: Error) => no(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError);
        yes();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Could not determine the local OAuth callback port');
    timer = setTimeout(() => settle(new Error('Timed out waiting for the Google OAuth callback')), timeoutMs);
    timer.unref();
    options.signal?.addEventListener('abort', aborted, { once: true });
    if (options.signal?.aborted) aborted();
    return {
      redirectUri: `http://127.0.0.1:${address.port}/oauth2callback`,
      waitForCallback,
      cancel: aborted,
    };
  } catch (error) {
    settle(error instanceof Error ? error : new Error('OAuth listener failed'));
    throw error;
  }
}
