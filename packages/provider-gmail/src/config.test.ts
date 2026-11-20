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
  renameGmailMailbox,
  toFilesystemSafeKey,
  type GmailMailboxMetadata,
} from './config.js';

const fsFailure = vi.hoisted(() => ({
  rename: false,
  onRead: null as null | ((path: string) => Promise<void>),
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsFailure.rename) throw new Error('synthetic rename failure');
      return actual.rename(...args);
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (fsFailure.onRead && typeof args[0] === 'string') await fsFailure.onRead(args[0]);
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
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
  fsFailure.onRead = null;
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

describe('provider-gmail/Token Files Shared With Microsoft', () => {
  const microsoft = {
    provider: 'microsoft',
    mailboxName: 'default',
    emailAddress: 'jane@example.com',
    clientId: 'ms-client',
    authenticationRecord: { homeAccountId: 'home' },
    lastInteractiveAuthAt: '2026-04-08T12:00:00.000Z',
  };

  it('Scenario: Gmail save never overwrites a Microsoft record for the same address', async () => {
    const tokens = join(tempHome, 'tokens');
    await writeFile(join(tokens, 'jane-at-example-com.json'), JSON.stringify(microsoft));

    const path = await saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'jane-example', emailAddress: 'jane@example.com' }));

    expect(path).toBe(join(tokens, 'jane-at-example-com.gmail.json'));
    expect(JSON.parse(await readFile(join(tokens, 'jane-at-example-com.json'), 'utf-8'))).toEqual(microsoft);
    await expect(loadGmailMailboxMetadata('jane@example.com')).resolves.toMatchObject({ mailboxName: 'jane-example' });
    await expect(listConfiguredGmailMailboxes()).resolves.toHaveLength(1);

    // A re-save updates the same provider-scoped file in place.
    await saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'jane-example', emailAddress: 'jane@example.com', refreshToken: 'second' }));
    expect((await readdir(tokens)).sort()).toEqual(['jane-at-example-com.gmail.json', 'jane-at-example-com.json']);
    await expect(loadGmailMailboxMetadata('jane-example')).resolves.toMatchObject({ refreshToken: 'second' });
  });

  it('Scenario: Gmail token rotation finds a provider-scoped record', async () => {
    const tokens = join(tempHome, 'tokens');
    await writeFile(join(tokens, 'jane-at-example-com.json'), JSON.stringify(microsoft));
    const metadata = gmailMailbox({ mailboxName: 'jane-example', emailAddress: 'jane@example.com' });
    await saveGmailMailboxMetadata(metadata);

    await createGmailMetadataWriter(metadata)('rotated', metadata.refreshToken);

    expect(JSON.parse(await readFile(join(tokens, 'jane-at-example-com.gmail.json'), 'utf-8'))).toMatchObject({ refreshToken: 'rotated' });
    expect(JSON.parse(await readFile(join(tokens, 'jane-at-example-com.json'), 'utf-8'))).toEqual(microsoft);
  });

  it('Scenario: Gmail save never overwrites another account that shares a lossy safe key', async () => {
    // jane.doe@ and jane-doe@ both map to jane-doe-at-example-com.
    const tokens = join(tempHome, 'tokens');
    await writeFile(join(tokens, 'jane-doe-at-example-com.json'), JSON.stringify({ ...microsoft, emailAddress: 'jane.doe@example.com' }));

    const first = await saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'first', emailAddress: 'jane.doe@example.com', refreshToken: 'r1' }));
    const second = await saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'second', emailAddress: 'jane-doe@example.com', refreshToken: 'r2' }));

    expect(first).toBe(join(tokens, 'jane-doe-at-example-com.gmail.json'));
    expect(second).toBe(join(tokens, 'jane-doe-at-example-com.gmail-2.json'));
    expect((await listConfiguredGmailMailboxes()).map(m => m.emailAddress).sort())
      .toEqual(['jane-doe@example.com', 'jane.doe@example.com']);
    await expect(loadGmailMailboxMetadata('jane.doe@example.com')).resolves.toMatchObject({ mailboxName: 'first', refreshToken: 'r1' });
    await expect(loadGmailMailboxMetadata('jane-doe@example.com')).resolves.toMatchObject({ mailboxName: 'second', refreshToken: 'r2' });
  });

  it('Scenario: A Gmail save that loses the filename race picks another name', async () => {
    // Interleave a second save between choosing a free filename and publishing it.
    const tokens = join(tempHome, 'tokens');
    const canonical = join(tokens, 'jane-doe-at-example-com.json');
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    fsFailure.onRead = async path => {
      // Read 3 of the canonical path is the save's check after the resolver picked it.
      if (path === canonical && ++reads === 3) { reached(); await gate; }
    };

    const pending = saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'second', emailAddress: 'jane-doe@example.com', refreshToken: 'r2' }));
    await paused;
    fsFailure.onRead = null;
    await saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'first', emailAddress: 'jane.doe@example.com', refreshToken: 'r1' }));
    release();
    const second = await pending;

    expect(second).toBe(join(tokens, 'jane-doe-at-example-com.gmail.json'));
    await expect(loadGmailMailboxMetadata('jane.doe@example.com')).resolves.toMatchObject({ refreshToken: 'r1' });
    await expect(loadGmailMailboxMetadata('jane-doe@example.com')).resolves.toMatchObject({ refreshToken: 'r2' });
  });

  it('Scenario: Gmail lookup resolves stored names and addresses before filename stems', async () => {
    const tokens = join(tempHome, 'tokens');
    await writeFile(join(tokens, 'alice-at-example-com.json'), JSON.stringify(gmailMailbox({ mailboxName: 'alice', emailAddress: 'alice@example.com' })));
    await writeFile(join(tokens, 'bob-at-example-com.json'), JSON.stringify(gmailMailbox({ mailboxName: 'alice-at-example-com', emailAddress: 'bob@example.com' })));

    await expect(loadGmailMailboxMetadata('alice-at-example-com')).resolves.toMatchObject({ emailAddress: 'bob@example.com' });
    await expect(loadGmailMailboxMetadata('ALICE@example.com')).resolves.toMatchObject({ mailboxName: 'alice' });
    await expect(loadGmailMailboxMetadata('carol@example.com')).resolves.toBeNull();
  });

  it('Scenario: renameGmailMailbox rewrites only the matching account record', async () => {
    const tokens = join(tempHome, 'tokens');
    await writeFile(join(tokens, 'jane-at-example-com.json'), JSON.stringify(microsoft));
    await saveGmailMailboxMetadata(gmailMailbox({ mailboxName: 'default', emailAddress: 'jane@gmail.com' }));

    const rewritten = await renameGmailMailbox({ oldName: 'DEFAULT', newName: 'personal', emailAddress: 'jane@gmail.com' });

    expect(rewritten).toEqual([join(tokens, 'jane-at-gmail-com.json')]);
    await expect(loadGmailMailboxMetadata('personal')).resolves.toMatchObject({ emailAddress: 'jane@gmail.com' });
    expect(JSON.parse(await readFile(join(tokens, 'jane-at-example-com.json'), 'utf-8'))).toEqual(microsoft);
  });
});

describe('mailbox-config/Configure Mailbox', () => {
  it('rotates a valid alias despite an unrelated malformed profile', async () => {
    const metadata = gmailMailbox({ emailAddress: 'synthetic@example.com' });
    const path = join(tempHome, 'tokens', 'personal.json');
    await writeFile(path, JSON.stringify(metadata));
    await writeFile(join(tempHome, 'tokens', 'aaa-unrelated.json'), '{bad');
    expect(await listConfiguredGmailMailboxes()).toHaveLength(1);
    await createGmailMetadataWriter(metadata)('rotated', metadata.refreshToken);
    expect(JSON.parse(await readFile(path, 'utf8')).refreshToken).toBe('rotated');
    expect(await readdir(join(tempHome, 'tokens'))).toEqual(['aaa-unrelated.json', 'personal.json']);
  });

  it('refuses to overwrite a corrupt canonical target while scanning aliases', async () => {
    const metadata = gmailMailbox({ emailAddress: 'synthetic@example.com' });
    const path = join(tempHome, 'tokens', `${toFilesystemSafeKey(metadata.emailAddress)}.json`);
    await writeFile(path, '{bad');
    await writeFile(join(tempHome, 'tokens', 'personal.json'), JSON.stringify(metadata));
    await expect(createGmailMetadataWriter(metadata)('rotated', metadata.refreshToken)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{bad');
  });
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
