import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MatonGmailApiClient,
  loadMatonGmailConnections,
  parseMatonGmailAccounts,
  resolveMatonGmailConnection,
} from './maton.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Maton Gmail connection isolation', () => {
  it('loads only exact ACTIVE google-mail accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maton-gmail-'));
    const path = join(dir, 'connections.json');
    await writeFile(path, JSON.stringify({
      connections: [
        { app: 'google-mail', account: 'User@Example.com', connection_id: 'gmail-1', status: 'ACTIVE' },
        { app: 'outlook', account: 'user@example.com', connection_id: 'wrong', status: 'ACTIVE' },
        { app: 'google-mail', account: 'other@example.com', connection_id: 'unscoped', status: 'EXPIRED' },
      ],
    }));

    const connections = await loadMatonGmailConnections(path, ['user@example.com']);
    expect([...connections.keys()]).toEqual(['user@example.com']);
    expect(resolveMatonGmailConnection(connections, ' USER@example.com ')).toEqual({
      account: 'user@example.com',
      connectionId: 'gmail-1',
    });
  });

  it('fails closed on missing, duplicate, or inactive expected accounts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maton-gmail-'));
    const path = join(dir, 'connections.json');
    await writeFile(path, JSON.stringify({
      connections: [
        { app: 'google-mail', account: 'user@example.com', connection_id: 'a', status: 'ACTIVE' },
        { app: 'google-mail', account: 'USER@example.com', connection_id: 'b', status: 'ACTIVE' },
      ],
    }));
    await expect(loadMatonGmailConnections(path, ['user@example.com'])).rejects.toThrow('Duplicate');

    await writeFile(path, JSON.stringify({
      connections: [
        { app: 'google-mail', account: 'user@example.com', connection_id: 'a', status: 'EXPIRED' },
      ],
    }));
    await expect(loadMatonGmailConnections(path, ['user@example.com'])).rejects.toThrow('not ACTIVE');

    await writeFile(path, JSON.stringify({ connections: [] }));
    const connections = await loadMatonGmailConnections(path, ['user@example.com']);
    expect(() => resolveMatonGmailConnection(connections, 'user@example.com')).toThrow('No ACTIVE');
  });

  it('requires an explicit unique account allowlist', () => {
    expect(parseMatonGmailAccounts('USER@example.com,other@example.com')).toEqual([
      'user@example.com',
      'other@example.com',
    ]);
    expect(() => parseMatonGmailAccounts(undefined)).toThrow('is required');
    expect(() => parseMatonGmailAccounts('user@example.com,USER@example.com')).toThrow('Duplicate');
  });
});

describe('MatonGmailApiClient', () => {
  it('preserves list query semantics and sends credentials only to the fixed gateway', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ id: 'm-1', threadId: 't-1' }],
      nextPageToken: 'next',
      resultSizeEstimate: 2,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MatonGmailApiClient('secret-key', 'connection-1', 1000);

    await expect(client.listMessages({
      labelIds: ['INBOX', 'STARRED'],
      maxResults: 10,
      q: 'from:a+b@example.com',
      pageToken: 'page/2',
    })).resolves.toEqual({
      messages: [{ id: 'm-1', threadId: 't-1' }],
      nextPageToken: 'next',
      resultSizeEstimate: 2,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    const parsed = new URL(String(url));
    expect(parsed.origin + parsed.pathname).toBe(
      'https://gateway.maton.ai/google-mail/gmail/v1/users/me/messages',
    );
    expect(parsed.searchParams.getAll('labelIds')).toEqual(['INBOX', 'STARRED']);
    expect(parsed.searchParams.get('q')).toBe('from:a+b@example.com');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer secret-key',
      'Maton-Connection': 'connection-1',
    });
  });

  it('preserves draft fallback, thread association, attachment bytes, and mutation methods', async () => {
    const responses = [
      new Response(JSON.stringify({ error: { message: 'Invalid id value' } }), { status: 400 }),
      new Response(JSON.stringify({ id: 'd-1', message: { id: 'm-draft', threadId: 't-1' } }), { status: 200 }),
      new Response(JSON.stringify({ id: 'd-1', message: { id: 'm-draft', threadId: 't-1' } }), { status: 200 }),
      new Response(JSON.stringify({ data: 'YWJj', size: 3 }), { status: 200 }),
      new Response(JSON.stringify({ id: 'd-1', message: { id: 'm-draft', threadId: 't-1' } }), { status: 200 }),
      new Response(JSON.stringify({ id: 'd-1', message: { id: 'm-updated', threadId: 't-1' } }), { status: 200 }),
      new Response(JSON.stringify({ id: 'm-sent', threadId: 't-1' }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    const client = new MatonGmailApiClient('secret-key', 'connection-1', 1000);

    await expect(client.getMessage('d/1')).resolves.toMatchObject({ id: 'm-draft', threadId: 't-1' });
    await expect(client.getDraft('d/1')).resolves.toMatchObject({
      id: 'd-1',
      message: { id: 'm-draft', threadId: 't-1' },
    });
    await expect(client.getAttachment('m/1', 'a/1')).resolves.toEqual({ data: 'YWJj', size: 3 });
    await client.createDraft('raw', 't-1');
    await client.updateDraft('d/1', 'updated', 't-1');
    await expect(client.sendDraft('d-1')).resolves.toEqual({ id: 'm-sent', threadId: 't-1' });

    expect(String(fetchMock.mock.calls[0]![0])).toContain('/messages/d%2F1?format=full');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/drafts/d%2F1?format=full');
    expect(fetchMock.mock.calls[4]![1].method).toBe('POST');
    expect(fetchMock.mock.calls[5]![1].method).toBe('PUT');
    expect(fetchMock.mock.calls[6]![1].method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[4]![1].body))).toEqual({
      message: { raw: 'raw', threadId: 't-1' },
    });
  });

  it('does not retry failed mutations or expose credentials echoed by an upstream error', async () => {
    const fetchMock = vi.fn(async () => new Response(
      'upstream unavailable for secret-key and connection-1',
      { status: 503 },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const client = new MatonGmailApiClient('secret-key', 'connection-1', 1000);

    await expect(client.sendMessage('raw')).rejects.toThrow('Gmail API error 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    try {
      await client.sendMessage('raw');
    } catch (err) {
      expect(String(err)).not.toContain('secret-key');
      expect(String(err)).not.toContain('connection-1');
    }
  });
});
