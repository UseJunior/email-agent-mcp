import { mkdtemp, mkdir, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuth2Client } from 'google-auth-library';
import { GmailAuthManager } from './auth.js';
import {
  listConfiguredGmailMailboxes,
  loadGmailMailboxMetadata,
  saveGmailMailboxMetadata,
  createGmailMetadataWriter,
  toFilesystemSafeKey,
  type GmailMailboxMetadata,
} from './config.js';

const fsFailure = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fsFailure.rename) throw new Error('synthetic rename failure');
    return actual.rename(...args);
  } };
});

let tempHome: string;

function gmailMailbox(overrides: Partial<GmailMailboxMetadata> = {}): GmailMailboxMetadata {
  return {
    provider: 'gmail',
    source: 'byok',
    mailboxName: 'personal',
    emailAddress: 'steven.obiajulu@gmail.com',
    clientId: 'gmail-client',
    clientSecret: 'gmail-secret',
    refreshToken: 'gmail-refresh',
    lastInteractiveAuthAt: '2026-04-08T12:00:00.000Z',
    ...overrides,
  } as GmailMailboxMetadata;
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'email-agent-mcp-gmail-config-'));
  process.env['EMAIL_AGENT_MCP_HOME'] = tempHome;
  await mkdir(join(tempHome, 'tokens'), { recursive: true });
});

afterEach(async () => {
  fsFailure.rename = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env['EMAIL_AGENT_MCP_HOME'];
  await rm(tempHome, { recursive: true, force: true });
});

describe('provider-gmail/Config Discovery', () => {
  it('Scenario: Gmail failed atomic rotation preserves metadata and removes temporary files', async () => {
    const metadata = gmailMailbox();
    await saveGmailMailboxMetadata(metadata);
    const writer = createGmailMetadataWriter(metadata);
    fsFailure.rename = true;
    await expect(writer('rotation-1', metadata.refreshToken)).rejects.toThrow('synthetic rename failure');
    expect((await loadGmailMailboxMetadata('personal'))?.refreshToken).toBe(metadata.refreshToken);
    expect(await readdir(join(tempHome, 'tokens'))).toEqual([`${toFilesystemSafeKey(metadata.emailAddress)}.json`]);
    fsFailure.rename = false;
    // A later runtime rotation can recover after the first write failed.
    await writer('rotation-2', 'rotation-1');
    expect((await loadGmailMailboxMetadata('personal'))?.refreshToken).toBe('rotation-2');
  });

  it('Scenario: Gmail rotations atomically replace the existing metadata route', async () => {
    const metadata = gmailMailbox();
    // Legacy alias filenames remain the storage route; do not fork credentials.
    const path = join(tempHome, 'tokens', 'personal.json');
    await writeFile(path, JSON.stringify(metadata));
    const writer = createGmailMetadataWriter(metadata);
    await Promise.all([writer('rotation-1', metadata.refreshToken), writer('rotation-2', 'rotation-1')]);
    expect((await loadGmailMailboxMetadata('personal'))?.refreshToken).toBe('rotation-2');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(tempHome, 'tokens'))).toEqual(['personal.json']);
  });

  it('Scenario: Gmail stale writers cannot overwrite newer rotations', async () => {
    const metadata = gmailMailbox();
    await saveGmailMailboxMetadata(metadata);
    const first = createGmailMetadataWriter(metadata);
    const stale = createGmailMetadataWriter(metadata);
    await first('newer', metadata.refreshToken);
    await expect(stale('stale', metadata.refreshToken)).rejects.toThrow('refusing stale');
    expect((await loadGmailMailboxMetadata('personal'))?.refreshToken).toBe('newer');
    await first('newest', 'newer');
    expect((await loadGmailMailboxMetadata('personal'))?.refreshToken).toBe('newest');
    const files = await readdir(join(tempHome, 'tokens'));
    expect(files).toEqual([`${toFilesystemSafeKey(metadata.emailAddress)}.json`]);
  });

  it('Scenario: Gmail rotations preserve broker and BYOK metadata isolation', async () => {
    const broker: GmailMailboxMetadata = {
      provider: 'gmail', source: 'broker', mailboxName: 'broker', emailAddress: 'broker@example.com',
      brokerUrl: 'https://broker.test', refreshToken: 'old',
    };
    for (const metadata of [gmailMailbox(), broker]) {
      await saveGmailMailboxMetadata(metadata);
      vi.spyOn(OAuth2Client.prototype, 'refreshAccessToken').mockImplementation(async function(this: OAuth2Client) {
        this.emit('tokens', { access_token: 'new-access', refresh_token: 'rotated', expiry_date: Date.now() + 3600000 });
        return { credentials: { access_token: 'new-access', refresh_token: metadata.refreshToken }, res: null };
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'new-access', refresh_token: 'rotated', expires_in: 3600,
      })));
      vi.stubGlobal('fetch', fetchMock);
      const auth = new GmailAuthManager({
        ...(metadata.source === 'broker' ? { brokerUrl: metadata.brokerUrl } :
          { clientId: metadata.clientId, clientSecret: metadata.clientSecret }),
        metadataWriter: createGmailMetadataWriter(metadata),
      });
      await auth.connect({ refresh_token: metadata.refreshToken });
      await auth.refresh();
      expect(auth.getRefreshToken()).toBe('rotated');
      expect(auth.getOAuth2Client().credentials.refresh_token).toBe(metadata.source === 'broker' ? undefined : 'rotated');
      expect(fetchMock).toHaveBeenCalledTimes(metadata.source === 'broker' ? 1 : 0);
      expect(await loadGmailMailboxMetadata(metadata.emailAddress)).toEqual({ ...metadata, refreshToken: 'rotated' });
    }
  });

  it('Scenario: listConfiguredGmailMailboxes ignores Microsoft token files', async () => {
    const tokensDir = join(tempHome, 'tokens');

    await writeFile(
      join(tokensDir, 'steven-obiajulu-at-gmail-com.json'),
      JSON.stringify(gmailMailbox(), null, 2),
      'utf-8',
    );
    await writeFile(
      join(tokensDir, 'work.json'),
      JSON.stringify({
        provider: 'microsoft',
        mailboxName: 'work',
        emailAddress: 'steven@usejunior.com',
        clientId: 'graph-client',
        authenticationRecord: { tenantId: 'tenant', clientId: 'graph-client' },
        lastInteractiveAuthAt: '2026-04-08T10:00:00.000Z',
      }, null, 2),
      'utf-8',
    );

    const results = await listConfiguredGmailMailboxes();

    expect(results).toHaveLength(1);
    expect(results[0]!.provider).toBe('gmail');
    expect(results[0]!.emailAddress).toBe('steven.obiajulu@gmail.com');
  });

  it('Scenario: loadGmailMailboxMetadata resolves by alias and email', async () => {
    await saveGmailMailboxMetadata(gmailMailbox());

    const byAlias = await loadGmailMailboxMetadata('personal');
    const byEmail = await loadGmailMailboxMetadata('steven.obiajulu@gmail.com');

    expect(byAlias?.emailAddress).toBe('steven.obiajulu@gmail.com');
    expect(byEmail?.mailboxName).toBe('personal');
  });

  it('Scenario: saveGmailMailboxMetadata uses the filesystem-safe email key', async () => {
    const metadata = gmailMailbox({
      emailAddress: 'Steven.Obiajulu+mail@gmail.com',
    });
    await saveGmailMailboxMetadata(metadata);

    const path = join(
      tempHome,
      'tokens',
      `${toFilesystemSafeKey('Steven.Obiajulu+mail@gmail.com')}.json`,
    );
    const saved = JSON.parse(await readFile(path, 'utf-8')) as GmailMailboxMetadata;

    expect(saved.provider).toBe('gmail');
    expect(saved.emailAddress).toBe('Steven.Obiajulu+mail@gmail.com');
  });
});

describe('mailbox-config/Configure Mailbox', () => {
  async function writeRaw(filename: string, body: Record<string, unknown>): Promise<void> {
    await writeFile(join(tempHome, 'tokens', filename), JSON.stringify(body, null, 2) + '\n');
  }

  it('Scenario: Pre-broker metadata is parsed as BYOK only when unambiguous', async () => {
    await writeRaw('legacy.json', {
      provider: 'gmail',
      mailboxName: 'legacy',
      emailAddress: 'legacy-user@gmail.com',
      clientId: 'old-client',
      clientSecret: 'old-secret',
      refreshToken: 'old-refresh',
    });
    const loaded = await loadGmailMailboxMetadata('legacy');
    expect(loaded?.source).toBe('byok');
    if (loaded?.source !== 'byok') throw new Error('expected byok');
    expect(loaded.clientId).toBe('old-client');
  });

  it('Scenario: Gmail mailbox metadata is mode-discriminated', async () => {
    await writeRaw('broker.json', {
      provider: 'gmail',
      source: 'broker',
      mailboxName: 'broker-user',
      emailAddress: 'broker-user@gmail.com',
      brokerUrl: 'https://oauth.example.com',
      refreshToken: 'broker-refresh',
    });
    const loaded = await loadGmailMailboxMetadata('broker-user');
    expect(loaded?.source).toBe('broker');
    if (loaded?.source !== 'broker') throw new Error('expected broker');
    expect(loaded.brokerUrl).toBe('https://oauth.example.com');
    // No accidental BYOK fields surface on a broker record.
    expect((loaded as unknown as { clientSecret?: string }).clientSecret).toBeUndefined();
  });

  it('Scenario: Ambiguous mixed-shape metadata is rejected', async () => {
    // Could equally describe either mode; refuse to guess and force a re-configure.
    await writeRaw('ambiguous.json', {
      provider: 'gmail',
      mailboxName: 'ambiguous',
      emailAddress: 'ambiguous@gmail.com',
      clientId: 'mixed-client',
      clientSecret: 'mixed-secret',
      brokerUrl: 'https://oauth.example.com',
      refreshToken: 'mixed-refresh',
    });
    const loaded = await loadGmailMailboxMetadata('ambiguous');
    expect(loaded).toBeNull();
  });

  it('rejects no-source records that only carry brokerUrl', async () => {
    await writeRaw('partial-broker.json', {
      provider: 'gmail',
      mailboxName: 'partial',
      emailAddress: 'partial@gmail.com',
      brokerUrl: 'https://oauth.example.com',
      refreshToken: 'partial-refresh',
    });
    const loaded = await loadGmailMailboxMetadata('partial');
    expect(loaded).toBeNull();
  });

  it('rejects source=broker records that lack brokerUrl', async () => {
    await writeRaw('bad-broker.json', {
      provider: 'gmail',
      source: 'broker',
      mailboxName: 'bad',
      emailAddress: 'bad@gmail.com',
      refreshToken: 'bad-refresh',
    });
    const loaded = await loadGmailMailboxMetadata('bad');
    expect(loaded).toBeNull();
  });
});
