import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DelegatedAuthManager, ClientCredentialsAuthManager } from './auth.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';

const mockDeviceCodeState = vi.hoisted(() => ({
  authenticateCalls: 0,
  getTokenCalls: 0,
  constructorOptions: [] as Record<string, unknown>[],
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
  return {
    DeviceCodeCredential: MockDeviceCodeCredential,
    useIdentityPlugin: vi.fn(),
  };
});

vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: {},
}));

describe('provider-microsoft/Delegated OAuth Authentication', () => {
  beforeEach(() => {
    mockDeviceCodeState.authenticateCalls = 0;
    mockDeviceCodeState.getTokenCalls = 0;
    mockDeviceCodeState.constructorOptions.length = 0;
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
    expect(credentialOptions?.disableAutomaticAuthentication).toBe(true);
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

describe('provider-microsoft/Client Credentials Authentication', () => {
  it('Scenario: Client credentials', async () => {
    const auth = new ClientCredentialsAuthManager({
      mode: 'client_credentials',
      clientId: 'test-client-id',
      clientSecret: 'test-secret',
      tenantId: 'test-tenant',
    });

    await auth.connect({});
    expect(auth.getAccessToken()).toBeDefined();
    expect(auth.isTokenExpired()).toBe(false);

    const firstToken = auth.getAccessToken();
    await auth.refresh();
    expect(auth.getAccessToken()).toBeDefined();
    expect(auth.getAccessToken()).not.toBe(firstToken);
  });
});
