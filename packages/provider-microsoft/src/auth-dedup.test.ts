import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';

// Use a unique temp dir per test run — set AGENT_EMAIL_HOME so CONFIG_DIR resolves here
const testHome = join(tmpdir(), `agent-email-dedup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const tokensDir = join(testHome, 'tokens');

// Set AGENT_EMAIL_HOME BEFORE any import of auth.ts so getConfigDir() resolves to our temp dir
process.env['AGENT_EMAIL_HOME'] = testHome;

// Mock Azure identity to avoid real Azure calls
vi.mock('@azure/identity', () => ({
  DeviceCodeCredential: vi.fn(),
  ClientSecretCredential: vi.fn(),
  useIdentityPlugin: vi.fn(),
}));

vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: {},
}));

// Now import the functions under test — getConfigDir() will use AGENT_EMAIL_HOME
const { listConfiguredMailboxesWithMetadata, toFilesystemSafeKey } = await import('./auth.js');

function makeMetadata(overrides: Record<string, unknown>) {
  return {
    authenticationRecord: {
      authority: 'https://login.microsoftonline.com',
      homeAccountId: 'test',
      clientId: 'test',
      tenantId: 'test',
    },
    cacheName: 'test-cache',
    lastInteractiveAuthAt: '2025-01-01T00:00:00.000Z',
    clientId: 'test-client-id',
    tenantId: 'test-tenant',
    mailboxName: 'default',
    ...overrides,
  };
}

describe('provider-microsoft/Mailbox Deduplication', () => {
  beforeEach(async () => {
    process.env['AGENT_EMAIL_HOME'] = testHome;
    await mkdir(tokensDir, { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('Scenario: Two files with same emailAddress — only the most recent is kept', async () => {
    // Write an old alias-based file
    await writeFile(
      join(tokensDir, 'work.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
        emailAddress: 'test-user@example.com',
        lastInteractiveAuthAt: '2025-01-01T00:00:00.000Z',
      })),
    );

    // Write a newer email-based file for the same email
    const safeKey = toFilesystemSafeKey('test-user@example.com');
    await writeFile(
      join(tokensDir, `${safeKey}.json`),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
        emailAddress: 'test-user@example.com',
        lastInteractiveAuthAt: '2025-06-15T12:00:00.000Z',
      })),
    );

    const results = await listConfiguredMailboxesWithMetadata();

    // Should return exactly one entry
    expect(results).toHaveLength(1);
    expect(results[0]!.emailAddress).toBe('test-user@example.com');
    // The kept entry should be the more recent one
    expect(results[0]!.lastInteractiveAuthAt).toBe('2025-06-15T12:00:00.000Z');

    // The old file should have been deleted from disk
    const remainingFiles = await readdir(tokensDir);
    expect(remainingFiles).toHaveLength(1);
    expect(remainingFiles[0]).toBe(`${safeKey}.json`);
  });

  it('Scenario: Two files with different emails — both are kept', async () => {
    await writeFile(
      join(tokensDir, 'test-user-at-example-com.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
        emailAddress: 'test-user@example.com',
      })),
    );

    await writeFile(
      join(tokensDir, 'alice-at-example-com.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'personal',
        emailAddress: 'alice@example.com',
      })),
    );

    const results = await listConfiguredMailboxesWithMetadata();
    expect(results).toHaveLength(2);
    const emails = results.map(r => r.emailAddress).sort();
    expect(emails).toEqual(['alice@example.com', 'test-user@example.com']);
  });

  it('Scenario: Legacy file without emailAddress is removed when email-based file exists for same mailboxName', async () => {
    // Legacy file: no emailAddress
    await writeFile(
      join(tokensDir, 'work.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
      })),
    );

    // New email-based file with same mailboxName
    await writeFile(
      join(tokensDir, 'test-user-at-example-com.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
        emailAddress: 'test-user@example.com',
      })),
    );

    const results = await listConfiguredMailboxesWithMetadata();
    expect(results).toHaveLength(1);
    expect(results[0]!.emailAddress).toBe('test-user@example.com');

    // Legacy file should be deleted
    const remainingFiles = await readdir(tokensDir);
    expect(remainingFiles).toHaveLength(1);
    expect(remainingFiles[0]).toBe('test-user-at-example-com.json');
  });

  it('Scenario: Legacy file without emailAddress is kept when no email-based file exists', async () => {
    await writeFile(
      join(tokensDir, 'work.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
      })),
    );

    const results = await listConfiguredMailboxesWithMetadata();
    expect(results).toHaveLength(1);
    expect(results[0]!.mailboxName).toBe('work');

    const remainingFiles = await readdir(tokensDir);
    expect(remainingFiles).toHaveLength(1);
  });

  it('Scenario: Three files for same email — keeps most recent, deletes two', async () => {
    await writeFile(
      join(tokensDir, 'work.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
        emailAddress: 'test-user@example.com',
        lastInteractiveAuthAt: '2024-06-01T00:00:00.000Z',
      })),
    );

    await writeFile(
      join(tokensDir, 'old-alias.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'old-alias',
        emailAddress: 'test-user@example.com',
        lastInteractiveAuthAt: '2024-12-01T00:00:00.000Z',
      })),
    );

    await writeFile(
      join(tokensDir, 'test-user-at-example-com.json'),
      JSON.stringify(makeMetadata({
        mailboxName: 'work',
        emailAddress: 'test-user@example.com',
        lastInteractiveAuthAt: '2025-06-15T12:00:00.000Z',
      })),
    );

    const results = await listConfiguredMailboxesWithMetadata();
    expect(results).toHaveLength(1);
    expect(results[0]!.lastInteractiveAuthAt).toBe('2025-06-15T12:00:00.000Z');

    const remainingFiles = await readdir(tokensDir);
    expect(remainingFiles).toHaveLength(1);
    expect(remainingFiles[0]).toBe('test-user-at-example-com.json');
  });

  it('Scenario: Empty tokens directory returns empty array', async () => {
    const results = await listConfiguredMailboxesWithMetadata();
    expect(results).toEqual([]);
  });
});
