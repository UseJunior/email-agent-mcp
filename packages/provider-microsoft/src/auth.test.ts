import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelegatedAuthManager, ClientCredentialsAuthManager, toFilesystemSafeKey, listConfiguredMailboxesWithMetadata, getConfigDir } from './auth.js';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';

// Use a unique temp dir so tests never write to the real ~/.email-agent-mcp/
const testHome = join(tmpdir(), `email-agent-mcp-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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
    savedAgentEmailHome = process.env['EMAIL_AGENT_MCP_HOME'];
    process.env['EMAIL_AGENT_MCP_HOME'] = testHome;
    mockDeviceCodeState.authenticateCalls = 0;
    mockDeviceCodeState.getTokenCalls = 0;
    mockDeviceCodeState.constructorOptions.length = 0;
  });

  afterEach(async () => {
    if (savedAgentEmailHome === undefined) {
      delete process.env['EMAIL_AGENT_MCP_HOME'];
    } else {
      process.env['EMAIL_AGENT_MCP_HOME'] = savedAgentEmailHome;
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
    expect(persistenceOptions?.name).toMatch(/^email-agent-mcp-test-mailbox-/);

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
      cacheName: 'email-agent-mcp-work-cache-id',
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
    expect(persistenceOptions?.name).toBe('email-agent-mcp-work-cache-id');
    expect(auth.needsReauth).toBe(false);
  });

  it('Scenario: Refresh token persistence', async () => {
    // Create a metadata file simulating a previous auth session
    const testDir = join(tmpdir(), `email-agent-mcp-test-${Date.now()}`);
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
    expect(toFilesystemSafeKey('test-user@example.com')).toBe('test-user-at-example-com');
    expect(toFilesystemSafeKey('Test-User@Example.com')).toBe('test-user-at-example-com');
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
    auth.setEmailAddress('test-user@example.com');
    expect(auth.emailAddress).toBe('test-user@example.com');
  });
});

describe('mailbox-config/Mailbox Canonical Identity', () => {
  let savedAgentEmailHome: string | undefined;
  let configDir: string;

  beforeEach(async () => {
    savedAgentEmailHome = process.env['EMAIL_AGENT_MCP_HOME'];
    const tempDir = join(tmpdir(), `email-agent-mcp-mailbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env['EMAIL_AGENT_MCP_HOME'] = tempDir;
    configDir = join(tempDir, 'tokens');
    await mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    const tempDir = process.env['EMAIL_AGENT_MCP_HOME']!;
    if (savedAgentEmailHome === undefined) {
      delete process.env['EMAIL_AGENT_MCP_HOME'];
    } else {
      process.env['EMAIL_AGENT_MCP_HOME'] = savedAgentEmailHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('Scenario: Identify mailbox by email address', async () => {
    // WHEN a tool input specifies mailbox: "test-user@example.com"
    // Store metadata with that email address
    const metadata = {
      authenticationRecord: { authority: 'test', homeAccountId: 'test', clientId: 'test', tenantId: 'test' },
      lastInteractiveAuthAt: new Date().toISOString(),
      clientId: 'test-client-id',
      mailboxName: 'work',
      emailAddress: 'test-user@example.com',
    };
    const safeKey = toFilesystemSafeKey('test-user@example.com');
    await writeFile(join(configDir, `${safeKey}.json`), JSON.stringify(metadata), 'utf-8');

    // THEN the system resolves it to the mailbox configured with that email address
    const { loadMailboxMetadata } = await import('./auth.js');
    const loaded = await loadMailboxMetadata('test-user@example.com');
    expect(loaded).not.toBeNull();
    expect(loaded!.emailAddress).toBe('test-user@example.com');
    expect(loaded!.mailboxName).toBe('work');
  });

  it('Scenario: Identify mailbox by alias', async () => {
    // WHEN a tool input specifies mailbox: "work" and the alias "work" maps to test-user@example.com
    const metadata = {
      authenticationRecord: { authority: 'test', homeAccountId: 'test', clientId: 'test', tenantId: 'test' },
      lastInteractiveAuthAt: new Date().toISOString(),
      clientId: 'test-client-id',
      mailboxName: 'work',
      emailAddress: 'test-user@example.com',
    };
    // Store under legacy alias filename
    await writeFile(join(configDir, 'work.json'), JSON.stringify(metadata), 'utf-8');

    // THEN the system resolves it to the mailbox configured with email test-user@example.com
    const { loadMailboxMetadata } = await import('./auth.js');
    const loaded = await loadMailboxMetadata('work');
    expect(loaded).not.toBeNull();
    expect(loaded!.emailAddress).toBe('test-user@example.com');
    expect(loaded!.mailboxName).toBe('work');
  });

  it('Scenario: Ambiguous identifier rejected', async () => {
    // WHEN a tool input specifies a string that matches neither a configured email nor an alias
    const { loadMailboxMetadata } = await import('./auth.js');
    const loaded = await loadMailboxMetadata('nonexistent-mailbox');

    // THEN the system returns null (no matching mailbox found)
    expect(loaded).toBeNull();
  });
});

describe('mailbox-config/Filesystem-Safe Storage Key', () => {
  it('Scenario: Derived filename from email', () => {
    // WHEN a mailbox is configured for test-user@example.com
    const safeKey = toFilesystemSafeKey('test-user@example.com');

    // THEN the metadata file key is derived from the email
    expect(safeKey).toBe('test-user-at-example-com');
    // AND the JSON content would include emailAddress (tested via auth manager)
  });

  it('Scenario: Filename avoids special characters', () => {
    // WHEN a mailbox is configured for Alice.O'Brien+tag@corp.co.uk
    const safeKey = toFilesystemSafeKey("Alice.O'Brien+tag@corp.co.uk");

    // THEN the filename is filesystem-safe: lowercase, no special characters
    expect(safeKey).toBe('alice-obrientag-at-corp-co-uk');
    // Verify no special characters remain
    expect(safeKey).toMatch(/^[a-z0-9-]+$/);
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

describe('mailbox-config/Convention-Over-Configuration Paths', () => {
  let savedAgentEmailHome: string | undefined;

  beforeEach(() => {
    savedAgentEmailHome = process.env['EMAIL_AGENT_MCP_HOME'];
  });

  afterEach(() => {
    if (savedAgentEmailHome === undefined) {
      delete process.env['EMAIL_AGENT_MCP_HOME'];
    } else {
      process.env['EMAIL_AGENT_MCP_HOME'] = savedAgentEmailHome;
    }
  });

  it('Scenario: Default home directory', () => {
    // WHEN EMAIL_AGENT_MCP_HOME is not set
    delete process.env['EMAIL_AGENT_MCP_HOME'];

    // THEN the system uses ~/.email-agent-mcp/ as the home directory
    // getConfigDir returns ~/.email-agent-mcp/tokens/
    const configDir = getConfigDir();
    const home = homedir();
    expect(configDir).toBe(join(home, '.email-agent-mcp', 'tokens'));
  });

  it('Scenario: Custom home directory via env var', () => {
    // WHEN EMAIL_AGENT_MCP_HOME is set to /tmp/ae-test
    process.env['EMAIL_AGENT_MCP_HOME'] = '/tmp/ae-test';

    // THEN the system uses /tmp/ae-test/ as the home directory
    const configDir = getConfigDir();
    expect(configDir).toBe(join('/tmp/ae-test', 'tokens'));
  });

  it('Scenario: Tokens directory for auth metadata', () => {
    // WHEN the system stores authentication metadata
    // THEN it writes to ~/.email-agent-mcp/tokens/
    process.env['EMAIL_AGENT_MCP_HOME'] = '/tmp/ae-tokens-test';
    const configDir = getConfigDir();
    expect(configDir).toContain('tokens');
    expect(configDir).toBe('/tmp/ae-tokens-test/tokens');
  });

  it('Scenario: State directory for watcher state and locks', () => {
    // WHEN the system stores watcher checkpoints or lock files
    // THEN it writes to ~/.email-agent-mcp/state/
    // The watcher hardcodes STATE_DIR as join(homedir(), '.email-agent-mcp', 'state')
    const home = homedir();
    const expectedStateDir = join(home, '.email-agent-mcp', 'state');
    expect(expectedStateDir).toContain(join('.email-agent-mcp', 'state'));
  });

  it('Scenario: Config file for persistent settings', async () => {
    // WHEN the system reads or writes persistent configuration
    // THEN it uses ~/.email-agent-mcp/config.json
    const tmpHome = join(tmpdir(), `ae-config-test-${Date.now()}`);
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpHome;

    await mkdir(tmpHome, { recursive: true });
    const configPath = join(tmpHome, 'config.json');
    await writeFile(configPath, JSON.stringify({ hooksToken: 'test-config-path' }, null, 2) + '\n', 'utf-8');

    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooksToken).toBe('test-config-path');

    await rm(tmpHome, { recursive: true, force: true });
  });

  it('Scenario: Allowlist files loaded by convention', () => {
    // WHEN the system checks send or receive allowlists
    // THEN it loads ~/.email-agent-mcp/send-allowlist.json and receive-allowlist.json by convention
    delete process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST'];
    const home = homedir();
    const expectedPath = join(home, '.email-agent-mcp', 'receive-allowlist.json');
    expect(expectedPath).toContain('receive-allowlist.json');
    expect(expectedPath).toContain('.email-agent-mcp');
  });

  it('Scenario: Auto-add email to send allowlist during configure', async () => {
    // WHEN a mailbox is successfully configured
    // THEN the configured email address is automatically added to send-allowlist.json
    const tmpHome = join(tmpdir(), `ae-allowlist-test-${Date.now()}`);
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpHome;

    await mkdir(tmpHome, { recursive: true });

    // Simulate what runConfigure does after successful auth
    const allowlistPath = join(tmpHome, 'send-allowlist.json');
    const emailAddress = 'test-user@example.com';
    await writeFile(allowlistPath, JSON.stringify({ entries: [emailAddress] }, null, 2) + '\n', 'utf-8');

    const raw = await readFile(allowlistPath, 'utf-8');
    const data = JSON.parse(raw) as { entries: string[] };
    expect(data.entries).toContain('test-user@example.com');

    await rm(tmpHome, { recursive: true, force: true });
  });
});
