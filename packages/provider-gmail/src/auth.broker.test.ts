// Regression tests for the broker-mode refresh path. Uses the real
// OAuth2Client (no library mock) so the credential-shape invariants
// that defeat google-auth-library's auto-refresh path can be checked
// directly. Without these the previously-shipped refreshHandler hook
// was silently bypassed on token expiry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GmailAuthManager } from './auth.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('provider-gmail/broker-mode credential discipline', () => {
  it('connect() in broker mode does NOT put refresh_token onto OAuth2Client.credentials', async () => {
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    await auth.connect({ access_token: 'at', refresh_token: 'rt' });

    const client = auth.getOAuth2Client();
    // If refresh_token leaks into the library, google-auth-library prefers
    // refreshAccessTokenAsync() on 401 and bypasses refreshHandler — which
    // is exactly the bug we're guarding against.
    expect(client.credentials.refresh_token).toBeUndefined();
    expect(client.credentials.access_token).toBe('at');
    // expiry_date must be set, otherwise isTokenExpiring() returns false
    // and the library never proactively triggers refreshHandler.
    expect(client.credentials.expiry_date).toBeTypeOf('number');
  });

  it('refresh() in broker mode hits the broker, never Google', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://broker.test/api/refresh') {
        return new Response(
          JSON.stringify({ access_token: 'fresh-from-broker', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request to ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    await auth.connect({ refresh_token: 'rt' });
    await auth.refresh();

    expect(auth.getAccessToken()).toBe('fresh-from-broker');
    // Most important assertion: our broker was the only network target.
    const targets = fetchMock.mock.calls.map(c => String(c[0]));
    expect(targets).toEqual(['https://broker.test/api/refresh']);
    expect(targets.some(u => u.includes('oauth2.googleapis.com'))).toBe(false);
  });

  it('refreshHandler hook is wired so OAuth2Client.request() can refresh through us', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://broker.test/api/refresh') {
        return new Response(
          JSON.stringify({ access_token: 'handler-fresh', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected request to ${url}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    await auth.connect({ refresh_token: 'rt' });

    // Force-call the refreshHandler the way OAuth2Client would internally.
    // If the field is missing or unbound, this throws — which means our
    // hook is no longer where the library will look.
    const client = auth.getOAuth2Client() as unknown as {
      refreshHandler?: () => Promise<{ access_token: string; expiry_date: number }>;
    };
    expect(typeof client.refreshHandler).toBe('function');
    const result = await client.refreshHandler!();
    expect(result.access_token).toBe('handler-fresh');
    expect(result.expiry_date).toBeTypeOf('number');
  });

  it('rejects construction with both brokerUrl and clientSecret', () => {
    expect(
      () => new GmailAuthManager({ brokerUrl: 'https://broker.test', clientSecret: 'x' }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects construction with neither broker nor full BYOK credentials', () => {
    expect(() => new GmailAuthManager({ clientId: 'only-id' })).toThrow();
    expect(() => new GmailAuthManager({})).toThrow();
  });

  it('startBrokerSession registers the session with /api/sessions before returning the URL', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    const session = await auth.startBrokerSession({ loginHint: 'user@gmail.com' });

    expect(session.sessionId).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(session.pickupSecret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(session.pickupSecret).not.toBe(session.sessionId);
    expect(session.authorizationUrl).toBe(
      `https://broker.test/api/start?session=${session.sessionId}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://broker.test/api/sessions');
    const body = JSON.parse(calls[0]!.body) as { session_id: string; pickup_hash: string; login_hint: string };
    expect(body.session_id).toBe(session.sessionId);
    // pickup_hash must be SHA-256 hex of the pickup_secret, never the secret itself.
    expect(body.pickup_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.pickup_hash).not.toBe(session.pickupSecret);
    expect(body.login_hint).toBe('user@gmail.com');
  });
});
