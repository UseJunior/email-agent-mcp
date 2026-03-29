import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';

// Use a unique temp dir per test run — set AGENT_EMAIL_HOME so all path derivations use our temp dir
const testHome = join(tmpdir(), `agent-email-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const tokensDir = join(testHome, 'tokens');

// Set AGENT_EMAIL_HOME BEFORE any import
process.env['AGENT_EMAIL_HOME'] = testHome;

// Track what DelegatedAuthManager does
const mockAuthState = vi.hoisted(() => ({
  emailAddress: null as string | null,
  savedMetadata: false,
}));

// Mock @usejunior/provider-microsoft
vi.mock('@usejunior/provider-microsoft', () => {
  function toFilesystemSafeKey(email: string): string {
    return email
      .toLowerCase()
      .replace(/@/g, '-at-')
      .replace(/\./g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  class DelegatedAuthManager {
    private _emailAddress: string | null = null;

    constructor(_config: unknown, _mailboxName: string) {}

    async connect() {
      // No-op in test — simulates successful auth
    }

    async getAccessToken() {
      return 'mock-token';
    }

    setEmailAddress(email: string) {
      this._emailAddress = email;
      mockAuthState.emailAddress = email;
    }

    async saveMetadata() {
      // Write the metadata file to the tokens dir using the email-based filename
      if (this._emailAddress) {
        const safeKey = toFilesystemSafeKey(this._emailAddress);
        const path = join(tokensDir, `${safeKey}.json`);
        const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
        await mk(tokensDir, { recursive: true });
        await wf(path, JSON.stringify({
          emailAddress: this._emailAddress,
          mailboxName: 'work',
          clientId: 'test-client-id',
          lastInteractiveAuthAt: new Date().toISOString(),
          authenticationRecord: {},
        }), 'utf-8');
      }
      mockAuthState.savedMetadata = true;
    }
  }

  return {
    DelegatedAuthManager,
    toFilesystemSafeKey,
  };
});

// Mock fetch to return a fake Graph API profile response
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Now import the function under test
const { runCli } = await import('./cli.js');

describe('cli/Configure Cleanup of Superseded Files', () => {
  beforeEach(async () => {
    process.env['AGENT_EMAIL_HOME'] = testHome;
    await mkdir(tokensDir, { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockAuthState.emailAddress = null;
    mockAuthState.savedMetadata = false;

    // Set up fetch mock to return a profile with an email
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        displayName: 'Test User',
        mail: 'test-user@example.com',
      }),
    });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('Scenario: Configure deletes old alias file with same emailAddress', async () => {
    // Pre-create an old alias file with the same email that will be configured
    await writeFile(
      join(tokensDir, 'work.json'),
      JSON.stringify({
        emailAddress: 'test-user@example.com',
        mailboxName: 'work',
        clientId: 'old-client',
        lastInteractiveAuthAt: '2024-01-01T00:00:00.000Z',
        authenticationRecord: {},
      }),
    );

    // Also pre-create another alias file with the same email
    await writeFile(
      join(tokensDir, 'my-email.json'),
      JSON.stringify({
        emailAddress: 'test-user@example.com',
        mailboxName: 'my-email',
        clientId: 'old-client-2',
        lastInteractiveAuthAt: '2024-06-01T00:00:00.000Z',
        authenticationRecord: {},
      }),
    );

    // Pre-create a file with a DIFFERENT email (should NOT be deleted)
    await writeFile(
      join(tokensDir, 'alice-at-example-com.json'),
      JSON.stringify({
        emailAddress: 'alice@example.com',
        mailboxName: 'alice',
        clientId: 'other-client',
        lastInteractiveAuthAt: '2024-06-01T00:00:00.000Z',
        authenticationRecord: {},
      }),
    );

    // Run configure — this will: connect, fetch profile, save new file, clean up old ones
    const exitCode = await runCli(['configure', '--mailbox', 'work', '--provider', 'microsoft']);
    expect(exitCode).toBe(0);

    // Check remaining files
    const remainingFiles = (await readdir(tokensDir)).sort();

    // Should have: alice-at-example-com.json (different email, kept)
    //              test-user-at-example-com.json (newly created by saveMetadata)
    // Should NOT have: work.json, my-email.json (both had same emailAddress)
    expect(remainingFiles).toContain('alice-at-example-com.json');
    expect(remainingFiles).toContain('test-user-at-example-com.json');
    expect(remainingFiles).not.toContain('work.json');
    expect(remainingFiles).not.toContain('my-email.json');
    expect(remainingFiles).toHaveLength(2);
  });

  it('Scenario: Configure with no pre-existing files works cleanly', async () => {
    const exitCode = await runCli(['configure', '--mailbox', 'work', '--provider', 'microsoft']);
    expect(exitCode).toBe(0);

    const remainingFiles = await readdir(tokensDir);
    expect(remainingFiles).toContain('test-user-at-example-com.json');
    expect(remainingFiles).toHaveLength(1);
  });
});
