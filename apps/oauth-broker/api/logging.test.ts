import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import callbackHandler from './callback.js';
import refreshHandler from './refresh.js';
import sessionsHandler from './sessions.js';
import startHandler from './start.js';
import claimHandler from './tickets/claim.js';
import { _resetConfigForTests } from '../lib/config.js';
import { _resetStoreForTests, getStore } from '../lib/store.js';

const SESSION_ID = 'SessionCorrelationId_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PICKUP_SECRET = 'PickupSecretValue_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const PICKUP_HASH = createHash('sha256').update(PICKUP_SECRET).digest('hex');
const AUTH_CODE = 'OAuthAuthorizationCodeValue';
const CALLBACK_ACCESS_TOKEN = 'CallbackAccessTokenValue';
const CALLBACK_REFRESH_TOKEN = 'CallbackRefreshTokenValue';
const REFRESH_REQUEST_TOKEN = 'RefreshRequestTokenValue';
const REFRESH_ACCESS_TOKEN = 'RefreshAccessTokenValue';
const ROTATED_REFRESH_TOKEN = 'RotatedRefreshTokenValue';
const CLIENT_SECRET = 'BrokerClientSecretValue';
const AUTHORIZATION = 'Bearer AuthorizationHeaderValue';
const CLIENT_IP = '192.0.2.123';
const HOST = 'oauth.usejunior.com';
const USER_AGENT = 'oauth-broker-observability-test';

const ENV = {
  GMAIL_OAUTH_CLIENT_ID: 'fake-client',
  GMAIL_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  BROKER_PUBLIC_ORIGIN: `https://${HOST}`,
  KV_REST_API_URL: undefined as string | undefined,
  BROKER_REQUIRE_KV: 'false',
};

interface MockResShape {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  redirect?: string;
  logCountAtResponse: number;
}

interface LogRecord {
  raw: string;
  event: Record<string, unknown>;
  response: MockResShape;
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else process.env[key] = value;
  }
  _resetConfigForTests();
  _resetStoreForTests();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const key of Object.keys(ENV)) {
    delete (process.env as Record<string, string | undefined>)[key];
  }
  _resetConfigForTests();
  _resetStoreForTests();
  vi.restoreAllMocks();
});

function makeReq(opts: {
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  url?: string;
}): VercelRequest {
  return {
    method: opts.method,
    query: opts.query ?? {},
    body: opts.body,
    url: opts.url,
    headers: {
      host: HOST,
      'user-agent': USER_AGENT,
      authorization: AUTHORIZATION,
      'x-forwarded-for': CLIENT_IP,
    },
  } as unknown as VercelRequest;
}

function makeRes(): { res: VercelResponse; captured: MockResShape } {
  const captured: MockResShape = {
    statusCode: 0,
    headers: {},
    body: undefined,
    logCountAtResponse: -1,
  };
  const markResponse = (): void => {
    captured.logCountAtResponse = logSpy.mock.calls.length;
  };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    json(data: unknown) {
      markResponse();
      captured.body = data;
    },
    send(data: unknown) {
      markResponse();
      captured.body = data;
    },
    redirect(status: number, location: string) {
      markResponse();
      captured.statusCode = status;
      captured.redirect = location;
    },
  };
  return { res: res as unknown as VercelResponse, captured };
}

async function invokeHandler(
  handler: (req: VercelRequest, res: VercelResponse) => Promise<void>,
  req: VercelRequest,
): Promise<LogRecord> {
  const logCountBefore = logSpy.mock.calls.length;
  const { res, captured } = makeRes();

  await handler(req, res);

  expect(logSpy.mock.calls.length).toBe(logCountBefore + 1);
  expect(captured.logCountAtResponse).toBe(logCountBefore + 1);
  expect(logSpy.mock.calls[logCountBefore]).toEqual([expect.any(String)]);
  const raw = String(logSpy.mock.calls[logCountBefore]![0]);
  return {
    raw,
    event: JSON.parse(raw) as Record<string, unknown>,
    response: captured,
  };
}

function mockTokenResponses(): void {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: CALLBACK_ACCESS_TOKEN,
          refresh_token: CALLBACK_REFRESH_TOKEN,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.modify',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: REFRESH_ACCESS_TOKEN,
          refresh_token: ROTATED_REFRESH_TOKEN,
          expires_in: 3600,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
}

describe('observability/Broker Request Logging', () => {
  it('Scenario: One line per broker request', async () => {
    mockTokenResponses();

    const records = [
      await invokeHandler(
        sessionsHandler,
        makeReq({
          method: 'POST',
          body: { session_id: SESSION_ID, pickup_hash: PICKUP_HASH },
        }),
      ),
      await invokeHandler(
        startHandler,
        makeReq({ method: 'GET', query: { session: SESSION_ID } }),
      ),
      await invokeHandler(
        callbackHandler,
        makeReq({
          method: 'GET',
          query: { code: AUTH_CODE, state: SESSION_ID },
          url: `/api/callback?code=${AUTH_CODE}&state=${SESSION_ID}`,
        }),
      ),
      await invokeHandler(
        claimHandler,
        makeReq({
          method: 'POST',
          body: { session_id: SESSION_ID, pickup_secret: PICKUP_SECRET },
        }),
      ),
      await invokeHandler(
        refreshHandler,
        makeReq({ method: 'POST', body: { refresh_token: REFRESH_REQUEST_TOKEN } }),
      ),
    ];

    expect(
      records.map(({ event }) => ({
        route: event['route'],
        method: event['method'],
        status: event['status'],
        outcome: event['outcome'],
      })),
    ).toEqual([
      { route: '/api/sessions', method: 'POST', status: 201, outcome: 'created' },
      { route: '/api/start', method: 'GET', status: 302, outcome: 'redirected' },
      { route: '/api/callback', method: 'GET', status: 200, outcome: 'ready' },
      { route: '/api/tickets/claim', method: 'POST', status: 200, outcome: 'claimed' },
      { route: '/api/refresh', method: 'POST', status: 200, outcome: 'refreshed' },
    ]);

    for (const { event } of records) {
      expect(Object.keys(event).sort()).toEqual(
        ['dur_ms', 'host', 'method', 'outcome', 'route', 'sid', 'status', 't', 'ua'].sort(),
      );
      expect(event['t']).toBe('broker_request');
      expect(event['host']).toBe(HOST);
      expect(event['ua']).toBe(USER_AGENT);
      expect(event['dur_ms']).toEqual(expect.any(Number));
      expect(event['dur_ms']).toBeGreaterThanOrEqual(0);
    }
    expect(records.slice(0, 4).map(({ event }) => event['sid'])).toEqual(
      Array.from({ length: 4 }, () => SESSION_ID.slice(0, 8)),
    );
    expect(records[4]!.event['sid']).toBeNull();
  });

  it('Scenario: Sensitive OAuth material is never logged', async () => {
    mockTokenResponses();

    const records = [
      await invokeHandler(
        sessionsHandler,
        makeReq({
          method: 'POST',
          body: { session_id: SESSION_ID, pickup_hash: PICKUP_HASH },
        }),
      ),
      await invokeHandler(
        startHandler,
        makeReq({ method: 'GET', query: { session: SESSION_ID } }),
      ),
      await invokeHandler(
        callbackHandler,
        makeReq({
          method: 'GET',
          query: { code: AUTH_CODE, state: SESSION_ID },
          url: `/api/callback?code=${AUTH_CODE}&state=${SESSION_ID}`,
        }),
      ),
      await invokeHandler(
        claimHandler,
        makeReq({
          method: 'POST',
          body: { session_id: SESSION_ID, pickup_secret: PICKUP_SECRET },
        }),
      ),
      await invokeHandler(
        refreshHandler,
        makeReq({ method: 'POST', body: { refresh_token: REFRESH_REQUEST_TOKEN } }),
      ),
    ];

    const joined = records.map(({ raw }) => raw).join('\n');
    for (const forbiddenName of [
      'code',
      'state',
      'access_token',
      'refresh_token',
      'client_secret',
      'pickup_secret',
      'pickup_hash',
      'session_id',
      'authorization',
      'x-forwarded-for',
    ]) {
      expect(joined).not.toContain(forbiddenName);
    }
    for (const forbiddenValue of [
      SESSION_ID,
      PICKUP_SECRET,
      PICKUP_HASH,
      AUTH_CODE,
      CALLBACK_ACCESS_TOKEN,
      CALLBACK_REFRESH_TOKEN,
      REFRESH_REQUEST_TOKEN,
      REFRESH_ACCESS_TOKEN,
      ROTATED_REFRESH_TOKEN,
      CLIENT_SECRET,
      AUTHORIZATION,
      CLIENT_IP,
    ]) {
      expect(joined).not.toContain(forbiddenValue);
    }
  });

  it('Scenario: Failure outcomes are distinguishable', async () => {
    const deniedSession = 'DeniedSessionCorrelation_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const failedSession = 'FailedSessionCorrelation_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const invalidHashSession = 'InvalidHashSessionCorrelation_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const unknownSession = 'UnknownSessionCorrelation_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const malformedSession = 'private-short-session';
    const invalidPickupHash = 'private-invalid-pickup-hash';
    const denialDetail = 'private_denial_detail';
    const exchangeFailureDetail = `private exchange failure ${CLIENT_SECRET}`;
    const invalidPickupSecret = 'private/invalid/pickup/secret';
    const refreshFailureDetail = `private refresh failure ${REFRESH_REQUEST_TOKEN}`;
    const store = getStore();
    await store.create(deniedSession, {
      state: 'pending',
      pickupHash: PICKUP_HASH,
      createdAt: Date.now(),
    });
    await store.create(failedSession, {
      state: 'pending',
      pickupHash: PICKUP_HASH,
      createdAt: Date.now(),
    });

    const invalidHash = await invokeHandler(
      sessionsHandler,
      makeReq({
        method: 'POST',
        body: {
          session_id: invalidHashSession,
          pickup_hash: invalidPickupHash,
        },
      }),
    );
    const invalidSession = await invokeHandler(
      startHandler,
      makeReq({ method: 'GET', query: { session: malformedSession } }),
    );
    const startFailure = await invokeHandler(
      startHandler,
      makeReq({ method: 'GET', query: { session: unknownSession } }),
    );
    const denied = await invokeHandler(
      callbackHandler,
      makeReq({
        method: 'GET',
        query: { error: denialDetail, state: deniedSession },
      }),
    );
    const terminalClaim = await invokeHandler(
      claimHandler,
      makeReq({
        method: 'POST',
        body: { session_id: deniedSession, pickup_secret: PICKUP_SECRET },
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error(exchangeFailureDetail),
    );
    const exchangeFailed = await invokeHandler(
      callbackHandler,
      makeReq({
        method: 'GET',
        query: { code: AUTH_CODE, state: failedSession },
      }),
    );
    const invalidSecret = await invokeHandler(
      claimHandler,
      makeReq({
        method: 'POST',
        body: { session_id: deniedSession, pickup_secret: invalidPickupSecret },
      }),
    );
    fetchSpy.mockRejectedValueOnce(new Error(refreshFailureDetail));
    const refreshFailed = await invokeHandler(
      refreshHandler,
      makeReq({ method: 'POST', body: { refresh_token: REFRESH_REQUEST_TOKEN } }),
    );

    expect(
      [
        invalidHash,
        invalidSession,
        startFailure,
        denied,
        terminalClaim,
        exchangeFailed,
        invalidSecret,
        refreshFailed,
      ].map(({ event }) => [event['status'], event['outcome']]),
    ).toEqual([
      [400, 'invalid_pickup_hash'],
      [400, 'invalid_session'],
      [410, 'session_expired_or_unknown'],
      [400, 'denied'],
      [410, 'denied'],
      [502, 'exchange_failed'],
      [400, 'invalid_pickup_secret'],
      [502, 'refresh_failed'],
    ]);

    const joined = [
      invalidHash,
      invalidSession,
      startFailure,
      denied,
      terminalClaim,
      exchangeFailed,
      invalidSecret,
      refreshFailed,
    ].map(({ raw }) => raw).join('\n');
    for (const forbiddenValue of [
      invalidHashSession,
      invalidPickupHash,
      malformedSession,
      unknownSession,
      deniedSession,
      failedSession,
      denialDetail,
      PICKUP_SECRET,
      AUTH_CODE,
      exchangeFailureDetail,
      CLIENT_SECRET,
      invalidPickupSecret,
      REFRESH_REQUEST_TOKEN,
      refreshFailureDetail,
    ]) {
      expect(joined).not.toContain(forbiddenValue);
    }
  });

  it('logs an internal error once before rethrowing an unexpected failure', async () => {
    const failureMessage = 'private store failure detail';
    vi.spyOn(getStore(), 'get').mockRejectedValueOnce(new Error(failureMessage));
    const logCountBefore = logSpy.mock.calls.length;
    const { res, captured } = makeRes();

    await expect(
      startHandler(
        makeReq({
          method: 'GET',
          query: { session: 'UnexpectedFailureSession_ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
        }),
        res,
      ),
    ).rejects.toThrow(failureMessage);

    expect(logSpy.mock.calls.length).toBe(logCountBefore + 1);
    expect(captured.logCountAtResponse).toBe(-1);
    const raw = String(logSpy.mock.calls[logCountBefore]![0]);
    expect(JSON.parse(raw)).toEqual({
      t: 'broker_request',
      route: '/api/start',
      method: 'GET',
      status: 500,
      outcome: 'internal_error',
      host: HOST,
      ua: USER_AGENT,
      sid: 'Unexpect',
      dur_ms: expect.any(Number),
    });
    expect(raw).not.toContain(failureMessage);
  });

  it('logs method rejections exactly once for every route', async () => {
    const records: LogRecord[] = [];
    records.push(await invokeHandler(sessionsHandler, makeReq({ method: 'GET' })));
    records.push(await invokeHandler(startHandler, makeReq({ method: 'POST' })));
    records.push(await invokeHandler(callbackHandler, makeReq({ method: 'POST' })));
    records.push(await invokeHandler(claimHandler, makeReq({ method: 'GET' })));
    records.push(await invokeHandler(refreshHandler, makeReq({ method: 'GET' })));

    expect(records.map(({ event }) => [event['status'], event['outcome']])).toEqual(
      Array.from({ length: 5 }, () => [405, 'method_not_allowed']),
    );
  });
});
