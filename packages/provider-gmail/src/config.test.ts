import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listConfiguredGmailMailboxes,
  loadGmailMailboxMetadata,
  saveGmailMailboxMetadata,
  toFilesystemSafeKey,
  type GmailMailboxMetadata,
} from './config.js';

let tempHome: string;

function gmailMailbox(overrides: Partial<GmailMailboxMetadata> = {}): GmailMailboxMetadata {
  return {
    provider: 'gmail',
    mailboxName: 'personal',
    emailAddress: 'steven.obiajulu@gmail.com',
    clientId: 'gmail-client',
    clientSecret: 'gmail-secret',
    refreshToken: 'gmail-refresh',
    lastInteractiveAuthAt: '2026-04-08T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'email-agent-mcp-gmail-config-'));
  process.env['EMAIL_AGENT_MCP_HOME'] = tempHome;
  await mkdir(join(tempHome, 'tokens'), { recursive: true });
});

afterEach(async () => {
  delete process.env['EMAIL_AGENT_MCP_HOME'];
  await rm(tempHome, { recursive: true, force: true });
});

describe('provider-gmail/Config Discovery', () => {
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
