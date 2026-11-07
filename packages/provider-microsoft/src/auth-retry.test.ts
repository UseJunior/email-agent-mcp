import { afterEach, describe, expect, it, vi } from 'vitest';
import { GraphApiError, RealGraphApiClient } from './email-graph-provider.js';

afterEach(() => vi.unstubAllGlobals());
const response = (status: number, body = '') => new Response(body || null, { status });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};

describe('provider-microsoft/Explicit Graph Auth Retry', () => {
  it.each(['read', 'bytes', 'sendMail', 'send', 'draft', 'patch', 'delete'] as const)(
    'Scenario: Explicit 401 recovery for %s is limited to one replay', async method => {
      const fetch = vi.fn().mockImplementation(async () => response(401, 'rejected'));
      vi.stubGlobal('fetch', fetch);
      const reconnect = vi.fn(async () => true);
      const client = new RealGraphApiClient(async () => 'token', reconnect);
      const call = () => {
        switch (method) {
          case 'read': return client.get('/me/messages');
          case 'bytes': return client.getBytes('/me/messages/id/$value');
          case 'sendMail': return client.post('/me/sendMail', {});
          case 'send': return client.post('/me/messages/id/send', {});
          case 'draft': return client.post('/me/messages', {});
          case 'patch': return client.patch('/me/messages/id', {});
          case 'delete': return client.delete('/me/messages/id');
        }
      };
      await expect(call()).rejects.toMatchObject({ status: 401, body: 'rejected' });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(reconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('Scenario: Delivery 401 permits one recovery retry with fresh credentials', async () => {
    let token = 'old';
    const fetch = vi.fn().mockResolvedValueOnce(response(401, 'auth rejected')).mockResolvedValueOnce(response(202));
    vi.stubGlobal('fetch', fetch);
    const reconnect = vi.fn(async () => { token = 'new'; return true; });
    await expect(new RealGraphApiClient(async () => token, reconnect).post('/me/sendMail', { message: {} })).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { Authorization: 'Bearer new' }, body: '{"message":{}}' });
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it.each(['timeout', '500', '503', '429'] as const)('Scenario: Delivery %s dispatches once', async failure => {
    const timeout = new Error('timeout after dispatch');
    const fetch = failure === 'timeout' ? vi.fn().mockRejectedValue(timeout) : vi.fn().mockImplementation(async () => response(Number(failure), 'failed'));
    vi.stubGlobal('fetch', fetch);
    const reconnect = vi.fn(async () => true);
    const call = new RealGraphApiClient(async () => 'token', reconnect).post('/me/sendMail', {});
    if (failure === 'timeout') await expect(call).rejects.toBe(timeout);
    else await expect(call).rejects.toBeInstanceOf(GraphApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it.each(['false', 'throws', 'absent'] as const)('Scenario: Reconnect %s never replays delivery', async failure => {
    const fetch = vi.fn().mockImplementation(async () => response(401, 'auth rejected'));
    vi.stubGlobal('fetch', fetch);
    const error = new Error('recovery failed');
    const reconnect = vi.fn(async () => { if (failure === 'throws') throw error; return false; });
    const call = new RealGraphApiClient(async () => 'token', failure === 'absent' ? undefined : reconnect).post('/me/sendMail', {});
    if (failure === 'throws') await expect(call).rejects.toBe(error);
    else await expect(call).rejects.toMatchObject({ status: 401, body: 'auth rejected' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Concurrent auth recovery survives cancellation of one waiter', async () => {
    const recovering = deferred();
    const bothDispatched = deferred();
    const release = deferred();
    let dispatched = 0;
    let token = 'old';
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const bearer = (init.headers as Record<string, string>).Authorization;
      if (bearer === 'Bearer old') {
        if (++dispatched === 2) bothDispatched.resolve();
        return response(401, 'auth rejected');
      }
      return response(202);
    });
    vi.stubGlobal('fetch', fetch);
    const reconnect = vi.fn(async () => {
      recovering.resolve();
      await release.promise;
      token = 'new';
      return true;
    });
    const controller = new AbortController();
    const client = new RealGraphApiClient(async () => token, reconnect);
    const cancelled = client.post('/me/sendMail', {}, controller.signal);
    const assertion = expect(cancelled).rejects.toBeInstanceOf(Error);
    const survivor = client.post('/me/messages/id/send', {});
    await Promise.all([recovering.promise, bothDispatched.promise]);
    // Let both received rejections enter the shared recovery wait.
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await assertion;
    expect(reconnect).toHaveBeenCalledTimes(1);
    release.resolve();
    await expect(survivor).resolves.toEqual({});
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('Scenario: Cancellation interrupts token waiting before delivery dispatch', async () => {
    const entered = deferred();
    const controller = new AbortController();
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const client = new RealGraphApiClient(async () => { entered.resolve(); return new Promise<string>(() => {}); });
    const call = client.post('/me/sendMail', {}, controller.signal);
    const assertion = expect(call).rejects.toBeInstanceOf(Error);
    await entered.promise;
    controller.abort();
    await assertion;
    expect(fetch).not.toHaveBeenCalled();
  });
});
