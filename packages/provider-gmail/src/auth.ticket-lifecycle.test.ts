import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { GmailAuthManager } from './auth.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const ticket = { sessionId: 'synthetic-session', pickupSecret: 'synthetic-pickup-secret' };

describe('provider-gmail/Ticket acquisition lifecycle', () => {
  it('publishes a claimed ticket without leaking its refresh token into the broker client', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 1234 })));
    vi.stubGlobal('fetch', fetch);
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    await auth.pickUpTicket(ticket);
    expect(auth.getAccessToken()).toBe('synthetic-access');
    expect(auth.getRefreshToken()).toBe('synthetic-refresh');
    expect(auth.getOAuth2Client().credentials.refresh_token).toBeUndefined();
    expect(await auth.tryReconnect()).toBe(true);
  });

  it('waits on pending and accepts the next ticket exactly once', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' })));
    vi.stubGlobal('fetch', fetch);
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    const pending = auth.pickUpTicket(ticket, { intervalMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(auth.getAccessToken()).toBe('synthetic-access');
  });

  it('does not publish a ticket received after disconnect', async () => {
    let respond!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { respond = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response));
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    const pending = auth.pickUpTicket(ticket);
    const rejected = expect(pending).rejects.toThrow('superseded');
    await auth.disconnect();
    respond(new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late' })));
    await rejected;
    expect(auth.getAccessToken()).toBeUndefined();
    expect(auth.getRefreshToken()).toBeUndefined();
  });

  it('surfaces each terminal ticket failure without retaining a session', async () => {
    for (const [status, expected] of [[403, 'pickup secret'], [410, 'denied'], [404, 'no record'], [502, 'claim failed']] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'denied' }), { status })));
      const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
      await expect(auth.pickUpTicket(ticket)).rejects.toThrow(expected);
      expect(auth.getAccessToken()).toBeUndefined();
      expect(auth.getRefreshToken()).toBeUndefined();
    }
  });

  it('cancels an already-aborted pickup before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    const auth = new GmailAuthManager({ brokerUrl: 'https://broker.test' });
    await expect(auth.pickUpTicket(ticket, { signal: controller.signal })).rejects.toThrow('aborted');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('records failed code exchange coherently for terminal and transient errors', async () => {
    const exchange = vi.spyOn(OAuth2Client.prototype, 'getToken');
    for (const message of ['invalid_grant', 'temporary transport failure']) {
      exchange.mockRejectedValueOnce(new Error(message));
      const auth = new GmailAuthManager({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret' });
      await expect(auth.exchangeCode('synthetic-code')).rejects.toThrow(message);
      expect(auth.getAccessToken()).toBeUndefined();
      expect(auth.getRefreshToken()).toBeUndefined();
      expect(Boolean(auth.getTokenHealthWarning())).toBe(message === 'invalid_grant');
    }
  });
});
