// End-to-end protocol test: drives the four routes via direct handler
// invocation so we exercise the real session state machine without
// having to run a Vercel server.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import sessionsHandler from './sessions.js';
import startHandler from './start.js';
import callbackHandler from './callback.js';
import claimHandler from './tickets/claim.js';
import refreshHandler from './refresh.js';
import { _resetStoreForTests } from '../lib/store.js';
import { _resetConfigForTests } from '../lib/config.js';

const ENV = {
  GMAIL_OAUTH_CLIENT_ID: 'fake-client',
  GMAIL_OAUTH_CLIENT_SECRET: 'fake-secret',
  BROKER_PUBLIC_ORIGIN: 'https://broker.test',
  KV_REST_API_URL: undefined as string | undefined,
  BROKER_REQUIRE_KV: 'false',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete (process.env as Record<string, string | undefined>)[k];
    else process.env[k] = v;
  }
  _resetConfigForTests();
  _resetStoreForTests();
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete (process.env as Record<string, string | undefined>)[k];
  _resetConfigForTests();
  _resetStoreForTests();
  vi.restoreAllMocks();
});

interface MockResShape {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  redirect?: string;
}

function makeRes() {
  const captured: MockResShape = { statusCode: 0, headers: {}, body: undefined };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    json(data: unknown) {
      captured.body = data;
    },
    send(data: unknown) {
      captured.body = data;
    },
    redirect(_status: number, location: string) {
      captured.redirect = location;
    },
  };
  return { res, captured };
}

function makeReq(opts: { method: string; query?: Record<string, string>; body?: unknown }) {
  return { method: opts.method, query: opts.query ?? {}, body: opts.body };
}

function urlSafeRandom(): string {
  return randomBytes(32).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function stubFetchOnce(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(((input, init) => impl(String(input), init as RequestInit | undefined)) as typeof fetch);
}

describe('broker/routes happy path', () => {
  it('register → start → callback → claim returns tokens once', async () => {
    const sessionId = urlSafeRandom();
    const pickupSecret = urlSafeRandom();
    const pickupHash = createHash('sha256').update(pickupSecret).digest('hex');

    // 1. POST /api/sessions
    {
      const { res, captured } = makeRes();
      await sessionsHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_hash: pickupHash } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(201);
    }

    // 2. GET /api/start should redirect to Google with state=session_id
    {
      const { res, captured } = makeRes();
      await startHandler(
        makeReq({ method: 'GET', query: { session: sessionId } }) as never,
        res as never,
      );
      expect(captured.redirect).toBeDefined();
      expect(captured.redirect).toContain('accounts.google.com');
      expect(captured.redirect).toContain(`state=${sessionId}`);
    }

    // 3. GET /api/callback exchanges code for tokens. Stub Google's response.
    stubFetchOnce(async (url) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      return new Response(
        JSON.stringify({
          access_token: 'broker-access',
          refresh_token: 'broker-refresh',
          expires_in: 3600,
          scope: 'https://mail.google.com/',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    {
      const { res, captured } = makeRes();
      await callbackHandler(
        makeReq({ method: 'GET', query: { code: 'auth-code', state: sessionId } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(200);
      expect(String(captured.body)).toContain('Authentication complete');
    }

    // 4. POST /api/tickets/claim with the secret returns tokens.
    {
      const { res, captured } = makeRes();
      await claimHandler(
        makeReq({
          method: 'POST',
          body: { session_id: sessionId, pickup_secret: pickupSecret },
        }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(200);
      expect((captured.body as { access_token: string }).access_token).toBe('broker-access');
    }

    // 5. Second claim attempt with the same correct secret must fail —
    //    one-shot semantics enforced atomically.
    {
      const { res, captured } = makeRes();
      await claimHandler(
        makeReq({
          method: 'POST',
          body: { session_id: sessionId, pickup_secret: pickupSecret },
        }) as never,
        res as never,
      );
      expect([404, 410]).toContain(captured.statusCode);
    }
  });
});

describe('broker/routes failure modes', () => {
  it('claim before callback returns 202 pending', async () => {
    const sessionId = urlSafeRandom();
    const pickupSecret = urlSafeRandom();
    const pickupHash = createHash('sha256').update(pickupSecret).digest('hex');

    {
      const { res } = makeRes();
      await sessionsHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_hash: pickupHash } }) as never,
        res as never,
      );
    }

    const { res, captured } = makeRes();
    await claimHandler(
      makeReq({ method: 'POST', body: { session_id: sessionId, pickup_secret: pickupSecret } }) as never,
      res as never,
    );
    expect(captured.statusCode).toBe(202);
    expect((captured.body as { status: string }).status).toBe('pending');
  });

  it('claim with wrong secret returns 403 and does not destroy session', async () => {
    const sessionId = urlSafeRandom();
    const pickupSecret = urlSafeRandom();
    const wrongSecret = urlSafeRandom();
    const pickupHash = createHash('sha256').update(pickupSecret).digest('hex');

    {
      const { res } = makeRes();
      await sessionsHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_hash: pickupHash } }) as never,
        res as never,
      );
    }
    stubFetchOnce(async () =>
      new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    {
      const { res } = makeRes();
      await callbackHandler(
        makeReq({ method: 'GET', query: { code: 'c', state: sessionId } }) as never,
        res as never,
      );
    }

    // Wrong secret: 403, session NOT consumed.
    {
      const { res, captured } = makeRes();
      await claimHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_secret: wrongSecret } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(403);
    }
    // Right secret still works.
    {
      const { res, captured } = makeRes();
      await claimHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_secret: pickupSecret } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(200);
    }
  });

  it('callback with error= advances session to denied; claim surfaces it as 410', async () => {
    const sessionId = urlSafeRandom();
    const pickupSecret = urlSafeRandom();
    const pickupHash = createHash('sha256').update(pickupSecret).digest('hex');

    {
      const { res } = makeRes();
      await sessionsHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_hash: pickupHash } }) as never,
        res as never,
      );
    }
    {
      const { res } = makeRes();
      await callbackHandler(
        makeReq({ method: 'GET', query: { error: 'access_denied', state: sessionId } }) as never,
        res as never,
      );
    }
    {
      const { res, captured } = makeRes();
      await claimHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_secret: pickupSecret } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(410);
      expect((captured.body as { status: string }).status).toBe('denied');
    }
  });

  it('refresh relays refresh_token to Google with the broker-held secret', async () => {
    let captured: { url?: string; body?: string } = {};
    stubFetchOnce(async (url, init) => {
      captured = { url, body: init?.body as string };
      return new Response(
        JSON.stringify({ access_token: 'fresh', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const { res, captured: resCaptured } = makeRes();
    await refreshHandler(
      makeReq({ method: 'POST', body: { refresh_token: 'rt-from-cli' } }) as never,
      res as never,
    );
    expect(resCaptured.statusCode).toBe(200);
    expect(captured.url).toBe('https://oauth2.googleapis.com/token');
    // Body must include the server-held secret AND the CLI's refresh_token.
    expect(captured.body).toContain('refresh_token=rt-from-cli');
    expect(captured.body).toContain('client_secret=fake-secret');
  });

  it('start refuses unknown sessions with 410', async () => {
    const { res, captured } = makeRes();
    await startHandler(
      makeReq({ method: 'GET', query: { session: 'a'.repeat(40) } }) as never,
      res as never,
    );
    expect(captured.statusCode).toBe(410);
  });

  it('sessions rejects collision with 409', async () => {
    const sessionId = urlSafeRandom();
    const hash = createHash('sha256').update('s').digest('hex');
    {
      const { res, captured } = makeRes();
      await sessionsHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_hash: hash } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(201);
    }
    {
      const { res, captured } = makeRes();
      await sessionsHandler(
        makeReq({ method: 'POST', body: { session_id: sessionId, pickup_hash: hash } }) as never,
        res as never,
      );
      expect(captured.statusCode).toBe(409);
    }
  });
});
