import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelegatedAuthManager, ClientCredentialsAuthManager, toFilesystemSafeKey, listConfiguredMailboxesWithMetadata } from './auth.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';

// Use a unique temp dir so tests never write to the real ~/.agent-email/
const testHome = join(tmpdir(), `agent-email-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const mockDeviceCodeState = vi.hoisted(() => ({
  authenticateCalls: 0,
  getTokenCalls: 0,
  constructorOptions: [] as Record<string, unknown>[],
}));

const mockClientSecretState = vi.hoisted(() => ({
  getTokenCalls: 0,
  constructorArgs: [] as unknown[][],
}));

// Mock @azure/identity to avoid real Azure calls in unit tests
vi.mock('@azure/identity', () => {
  class MockDeviceCodeCredential {
    constructor(options: Record<string, unknown> = {}) {
      mockDeviceCodeState.constructorOptions.push(options);
    }

    async getToken() {
      mockDeviceCodeState.getTokenCalls++;
      return { token: 'mock-access-token', expiresOnTimestamp: Date.now() + 3600000 };
    }

    async authenticate() {
      mockDeviceCodeState.authenticateCalls++;
      return { authority: 'https://login.microsoftonline.com', homeAccountId: 'test', clientId: 'test', tenantId: 'test' };
    }
  }

  class MockClientSecretCredential {
    constructor(tenantId: string, clientId: string, clientSecret: string) {
      mockClientSecretState.constructorArgs.push([tenantId, clientId, clientSecret]);
    }

    async getToken() {
      mockClientSecretState.getTokenCalls++;
      return { token: `mock-app-token-${mockClientSecretState.getTokenCalls}`, expiresOnTimestamp: Date.now() + 3600000 };
    }
  }

  return {
    DeviceCodeCredential: MockDeviceCodeCredential,
    ClientSecretCredential: MockClientSecretCredential,
    useIdentityPlugin: vi.fn(),
  };
});

vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: {},
}));

describe('provider-microsoft/Delegated OAuth Authentication', () => {
  let savedAgentEmailHome: string | undefined;

  beforeEach(() => {
    savedAgentEmailHome = process.env['AGENT_EMAIL_HOME'];
    process.env['AGENT_EMAIL_HOME'] = testHome;
    mockDeviceCodeState.authenticateCalls = 0;
    mockDeviceCodeState.getTokenCalls = 0;
    mockDeviceCodeState.constructorOptions.length = 0;
  });

  afterEach(async () => {
    if (savedAgentEmailHome === undefined) {
      delete process.env['AGENT_EMAIL_HOME'];
    } else {
      process.env['AGENT_EMAIL_HOME'] = savedAgentEmailHome;
    }
    await rm(testHome, { recursive: true, force: true });
  });

  it('Scenario: Device code flow', async () => {
    const auth = new DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'test-mailbox',
    );

    // connect() triggers device code flow (mocked) and saves AuthenticationRecord
    await auth.connect({});
    expect(mockDeviceCodeState.authenticateCalls).toBe(1);
    expect(mockDeviceCodeState.getTokenCalls).toBe(0);
    expect(mockDeviceCodeState.constructorOptions).toHaveLength(1);

    const [credentialOptions] = mockDeviceCodeState.constructorOptions;
    const persistenceOptions = credentialOptions?.tokenCachePersistenceOptions as { enabled?: boolean; name?: string } | undefined;
    expect(credentialOptions?.disableAutomaticAuthentication).toBe(true);
    expect(persistenceOptions?.enabled).toBe(true);
    expect(persistenceOptions?.name).toMatch(/^agent-email-test-mailbox-/);

    // Should be able to get an access token after connecting
    const token = await auth.getAccessToken();
    expect(token).toBe('mock-access-token');
    expect(mockDeviceCodeState.getTokenCalls).toBe(1);
    expect(auth.isTokenExpired()).toBe(false);
    expect(auth.needsReauth).toBe(false);
  });

  it('Scenario: Silent reconnect uses persisted cache name', async () => {
    const auth = new DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'work',
    );

    vi.spyOn(auth as unknown as { loadMetadata: () => Promise<unknown> }, 'loadMetadata').mockResolvedValue({
      authenticationRecord: {
        authority: 'https://login.microsoftonline.com',
        homeAccountId: 'test-home-id',
        clientId: 'test-client-id',
        tenantId: 'test-tenant',
      },
      cacheName: 'agent-email-work-cache-id',
      lastInteractiveAuthAt: new Date().toISOString(),
      clientId: 'test-client-id',
      tenantId: 'test-tenant',
      mailboxName: 'work',
    });

    await auth.reconnect();

    expect(mockDeviceCodeState.authenticateCalls).toBe(0);
    expect(mockDeviceCodeState.getTokenCalls).toBe(1);
    expect(mockDeviceCodeState.constructorOptions).toHaveLength(1);

    const [credentialOptions] = mockDeviceCodeState.constructorOptions;
    const persistenceOptions = credentialOptions?.tokenCachePersistenceOptions as { enabled?: boolean; name?: string } | undefined;
    // reconnect uses disableAutomaticAuthentication: false to allow silent token refresh via MSAL cache
    expect(credentialOptions?.disableAutomaticAuthentication).toBe(false);
    expect(persistenceOptions?.name).toBe('agent-email-work-cache-id');
    expect(auth.needsReauth).toBe(false);
  });

  it('Scenario: Refresh token persistence', async () => {
    // Create a metadata file simulating a previous auth session
    const testDir = join(tmpdir(), `agent-email-test-${Date.now()}`);
    const tokensDir = join(testDir, 'tokens');
    await mkdir(tokensDir, { recursive: true });

    const metadata = {
      authenticationRecord: {
        authority: 'https://login.microsoftonline.com',
        homeAccountId: 'test-home-id',
        clientId: 'test-client-id',
        tenantId: 'test-tenant',
      },
      lastInteractiveAuthAt: new Date().toISOString(),
      clientId: 'test-client-id',
      tenantId: 'test-tenant',
      mailboxName: 'work',
    };

    await writeFile(join(tokensDir, 'work.json'), JSON.stringify(metadata), 'utf-8');

    // Verify the saved metadata format directly
    const { readFile } = await import('node:fs/promises');
    const content = JSON.parse(await readFile(join(tokensDir, 'work.json'), 'utf-8'));
    expect(content.authenticationRecord).toBeDefined();
    expect(content.lastInteractiveAuthAt).toBeDefined();
    expect(content.clientId).toBe('test-client-id');

    // Token health warning — fresh token should have no warning
    const auth = new DelegatedAuthManager({ mode: 'delegated', clientId: 'test-client-id' }, 'work');
    await auth.connect({});
    expect(auth.getTokenHealthWarning()).toBeUndefined();

    await rm(testDir, { recursive: true, force: true });
  });
});

describe('provider-microsoft/Filesystem Safe Key', () => {
  it('Scenario: Email to filesystem-safe key', () => {
    expect(toFilesystemSafeKey('steven@usejunior.com')).toBe('steven-at-usejunior-com');
    expect(toFilesystemSafeKey('Steven@UseJunior.com')).toBe('steven-at-usejunior-com');
    expect(toFilesystemSafeKey('alice+tag@example.co.uk')).toBe('alicetag-at-example-co-uk');
    expect(toFilesystemSafeKey('user@domain.com')).toBe('user-at-domain-com');
  });

  it('Scenario: Strips invalid characters', () => {
    expect(toFilesystemSafeKey('a!b#c$d@test.com')).toBe('abcd-at-test-com');
  });

  it('Scenario: Email address stored in metadata', async () => {
    const auth = new DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'test-mailbox',
    );

    expect(auth.emailAddress).toBeNull();
    auth.setEmailAddress('steven@usejunior.com');
    expect(auth.emailAddress).toBe('steven@usejunior.com');
  });
});

describe('provider-microsoft/Client Credentials Authentication', () => {
  beforeEach(() => {
    mockClientSecretState.getTokenCalls = 0;
    mockClientSecretState.constructorArgs.length = 0;
  });

  it('Scenario: Client credentials', async () => {
    const auth = new ClientCredentialsAuthManager({
      mode: 'client_credentials',
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      tenantId: 'test-tenant',
    });

    await auth.connect({});
    expect(await auth.getAccessToken()).toBeDefined();
    expect(auth.isTokenExpired()).toBe(false);

    // Verify ClientSecretCredential was constructed with correct args
    expect(mockClientSecretState.constructorArgs).toHaveLength(1);
    expect(mockClientSecretState.constructorArgs[0]).toEqual(['test-tenant', 'test-client-id', 'test-secret']);

    const firstToken = await auth.getAccessToken();
    await auth.refresh();
    const refreshedToken = await auth.getAccessToken();
    expect(refreshedToken).toBeDefined();
    expect(refreshedToken).not.toBe(firstToken);
  });

  it('Scenario: Client credentials missing config', async () => {
    const auth = new ClientCredentialsAuthManager({
      mode: 'client_credentials',
      clientId: 'test-client-id',
    });

    await expect(auth.connect({})).rejects.toThrow('Client credentials require clientSecret and tenantId');
  });
});
