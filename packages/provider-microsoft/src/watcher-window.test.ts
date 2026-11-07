import { describe, expect, it, vi, afterEach } from 'vitest';
import { GraphEmailProvider, RealGraphApiClient, type GraphApiClient } from './email-graph-provider.js';

const since = '2026-01-01T00:00:00Z';
const end = '2026-01-01T00:01:00Z';
const provider = (get: GraphApiClient['get']) => new GraphEmailProvider({ get } as GraphApiClient);
afterEach(() => vi.unstubAllGlobals());

describe('provider-microsoft/Watcher complete windows', () => {
  it('filters both inclusive boundaries and follows every nextLink', async () => {
    const get = vi.fn().mockResolvedValueOnce({
      value: Array.from({ length: 50 }, (_, i) => ({ id: String(i), receivedDateTime: since })), '@odata.nextLink': 'next',
    }).mockResolvedValueOnce({ value: [{ id: 'end', receivedDateTime: end }, { id: 'future', receivedDateTime: '2026-01-01T00:01:01Z' }] });
    const signal = new AbortController().signal;
    const messages = await provider(get).getNewMessages(since, end, signal);
    expect(messages).toHaveLength(51);
    expect(messages.at(-1)?.id).toBe('end');
    expect(decodeURIComponent(get.mock.calls[0]![0])).toContain(`receivedDateTime ge ${since} and receivedDateTime le ${end}`);
    expect(get.mock.calls[1]).toEqual(['next', signal]);
  });

  it('rejects failed later pages instead of publishing partial results', async () => {
    const get = vi.fn().mockResolvedValueOnce({ value: [{ id: '1', receivedDateTime: since }], '@odata.nextLink': 'next' })
      .mockRejectedValueOnce(new Error('503'));
    await expect(provider(get).getNewMessages(since, end)).rejects.toThrow('503');
  });

  it('rejects repeated links and excessive paging', async () => {
    const repeat = vi.fn().mockResolvedValue({ value: [], '@odata.nextLink': 'next' });
    await expect(provider(repeat).getNewMessages(since, end)).rejects.toThrow('pagination');
    expect(repeat).toHaveBeenCalledTimes(2);
    let page = 0;
    const excessive = vi.fn(async () => ({ value: [], '@odata.nextLink': `page-${++page}` }));
    await expect(provider(excessive).getNewMessages(since, end)).rejects.toThrow('1000');
    expect(excessive).toHaveBeenCalledTimes(1000);
  });

  it('rejects malformed pages, timestamps and inverted windows', async () => {
    for (const result of [{}, { value: [], '@odata.nextLink': 42 }, { value: [{ id: 'x', receivedDateTime: 'bad' }] }]) {
      await expect(provider(vi.fn().mockResolvedValue(result)).getNewMessages(since, end)).rejects.toThrow();
    }
    await expect(provider(vi.fn()).getNewMessages(end, since)).rejects.toThrow('window');
  });

  it('cancels between pages without returning partial results', async () => {
    const abort = new AbortController();
    const get = vi.fn(async () => {
      abort.abort(); return { value: [], '@odata.nextLink': 'next' };
    });
    await expect(provider(get).getNewMessages(since, end, abort.signal)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation to token acquisition, reconnect and fetch', async () => {
    const abort = new AbortController();
    const token = vi.fn(async () => 'token');
    const reconnect = vi.fn(async () => true);
    const fetch = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) });
    vi.stubGlobal('fetch', fetch);
    await new RealGraphApiClient(token, reconnect).get('/me/messages', abort.signal);
    expect(token.mock.calls).toEqual([[abort.signal], [abort.signal]]);
    expect(reconnect).toHaveBeenCalledWith(abort.signal);
    for (const call of fetch.mock.calls) expect(call[1].signal).toBe(abort.signal);
    abort.abort();
    await expect(new RealGraphApiClient(token).get('/me/messages', abort.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never dispatches fetch after a token request is cancelled', async () => {
    const abort = new AbortController();
    const token = vi.fn(async () => { abort.abort(); return 'token'; });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(new RealGraphApiClient(token).get('/me/messages', abort.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
