import { describe, it, expect, vi } from 'vitest';
import { GraphEmailProvider, type GraphApiClient } from './email-graph-provider.js';

function provider(get: GraphApiClient['get']) { return new GraphEmailProvider({ get } as GraphApiClient); }
describe('provider-microsoft/Bounded delta lifecycle', () => {
  it('returns a cursor only after the terminal page', async () => {
    const get = vi.fn().mockResolvedValueOnce({ value: [], '@odata.nextLink': 'page2' })
      .mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'terminal' });
    await expect(provider(get).getDeltaMessages('start')).resolves.toEqual({ messages: [], nextDeltaLink: 'terminal' });
    expect(get.mock.calls).toEqual([['start'], ['page2']]);
  });
  it('rejects missing terminal cursors and partial retrieval failure', async () => {
    await expect(provider(vi.fn().mockResolvedValue({ value: [] })).getDeltaMessages('start')).rejects.toHaveProperty('code', 'INVALID_DELTA_RESPONSE');
    const get = vi.fn().mockResolvedValueOnce({ value: [], '@odata.nextLink': 'next' }).mockRejectedValue(new Error('page failed'));
    await expect(provider(get).getDeltaMessages('start')).rejects.toThrow('page failed');
  });
  it('rejects repeated URLs and bounds unique pages', async () => {
    const repeated = vi.fn().mockResolvedValue({ '@odata.nextLink': 'same' });
    await expect(provider(repeated).getDeltaMessages('same')).rejects.toHaveProperty('code', 'PAGINATION_LIMIT');
    expect(repeated).toHaveBeenCalledTimes(1);
    let count = 0;
    const get = vi.fn(async () => ({ '@odata.nextLink': `page-${++count}` }));
    await expect(provider(get).getDeltaMessages('start')).rejects.toHaveProperty('code', 'PAGINATION_LIMIT');
    expect(get).toHaveBeenCalledTimes(100);
  });
});
