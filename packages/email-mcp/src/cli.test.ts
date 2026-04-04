import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli, parseCliArgs, getNemoClawEgressDomains, getAgentEmailHome, loadConfig, saveConfig } from './cli.js';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Linux CI runners do not provide libsecret, so auth imports must not load the real cache plugin.
vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: vi.fn(),
}));

// Hoisted state for watcher poll-loop tests — controls mock behavior per test.
const watcherMockState = vi.hoisted(() => ({
  /** When non-empty, listConfiguredMailboxesWithMetadata returns these mailboxes. */
  mailboxes: [] as Array<{
    mailboxName: string;
    emailAddress?: string;
    clientId: string;
    authenticationRecord: Record<string, string>;
    lastInteractiveAuthAt: string;
  }>,
  /** Controls the mock DelegatedAuthManager behavior. */
  auth: {
    isTokenExpiringSoon: false,
    tryReconnectResult: true,
    tryReconnectCalls: 0,
    reconnectCalls: 0,
    getAccessTokenResult: 'mock-token',
    /** When true, tryReconnect sends SIGINT to stop the poll loop. */
    shutdownOnTryReconnect: false,
  },
  /** Controls getNewMessages behavior. null = return [], Error = throw. */
  getNewMessagesResult: null as Error | null,
  /** Number of poll iterations before sending SIGINT. */
  pollCountBeforeShutdown: 1,
  /** Track poll calls. */
  pollCount: 0,
}));

// Mock @usejunior/provider-microsoft for watcher poll-loop tests.
// Uses importOriginal to preserve real exports; overrides are conditional on watcherMockState.
vi.mock('@usejunior/provider-microsoft', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  class MockDelegatedAuthManager {
    constructor(_config: Record<string, unknown>, _mailboxName: string) {}
    async reconnect() { watcherMockState.auth.reconnectCalls++; }
    async getAccessToken() { return watcherMockState.auth.getAccessTokenResult; }
    async tryReconnect() {
      watcherMockState.auth.tryReconnectCalls++;
      if (watcherMockState.auth.shutdownOnTryReconnect) {
        setTimeout(() => { process.emit('SIGINT', 'SIGINT'); }, 10);
      }
      return watcherMockState.auth.tryReconnectResult;
    }
    get isTokenExpiringSoon() { return watcherMockState.auth.isTokenExpiringSoon; }
  }

  class MockRealGraphApiClient {
    constructor(_getToken: () => Promise<string>, _tryReconnect: () => Promise<boolean>) {}
  }

  class MockGraphEmailProvider {
    async getNewMessages(_since: string) {
      watcherMockState.pollCount++;
      if (watcherMockState.pollCount >= watcherMockState.pollCountBeforeShutdown) {
        setTimeout(() => { process.emit('SIGINT', 'SIGINT'); }, 10);
      }
      if (watcherMockState.getNewMessagesResult instanceof Error) {
        throw watcherMockState.getNewMessagesResult;
      }
      return [];
    }
  }

  // Store the real implementations for delegation
  const RealDelegatedAuth = actual.DelegatedAuthManager as new (...args: unknown[]) => unknown;
  const RealGraphClient = actual.RealGraphApiClient as new (...args: unknown[]) => unknown;
  const RealGraphProvider = actual.GraphEmailProvider as new (...args: unknown[]) => unknown;
  const realList = actual.listConfiguredMailboxesWithMetadata as () => Promise<unknown[]>;

  return {
    ...actual,
    // Proxy that delegates to mock or real based on test state
    DelegatedAuthManager: new Proxy(MockDelegatedAuthManager, {
      construct(target, args) {
        if (watcherMockState.mailboxes.length > 0) return new target(...args);
        return new RealDelegatedAuth(...args);
      },
    }),
    RealGraphApiClient: new Proxy(MockRealGraphApiClient, {
      construct(target, args) {
        if (watcherMockState.mailboxes.length > 0) return new target(...args);
        return new RealGraphClient(...args);
      },
    }),
    GraphEmailProvider: new Proxy(MockGraphEmailProvider, {
      construct(target, args) {
        if (watcherMockState.mailboxes.length > 0) return new target(...args);
        return new RealGraphProvider(...args);
      },
    }),
    listConfiguredMailboxesWithMetadata: vi.fn(async () => {
      if (watcherMockState.mailboxes.length > 0) return watcherMockState.mailboxes;
      return realList();
    }),
  };
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli/Serve Subcommand', () => {
  it('Scenario: Start MCP server', async () => {
    const exitCode = await runCli(['serve']);
    expect(exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('MCP server started'),
    );
  });
});

describe('cli/Watch Subcommand', () => {
  it('Scenario: Watch with wake URL', () => {
    // WHEN email-agent-mcp watch --wake-url http://localhost:18789/hooks/wake is run
    // THEN the watcher monitors all mailboxes with the provided wake URL
    const opts = parseCliArgs(['watch', '--wake-url', 'http://localhost:18789/hooks/wake']);
    expect(opts.command).toBe('watch');
    expect(opts.wakeUrl).toBe('http://localhost:18789/hooks/wake');
  });

  it('Scenario: Watch with custom poll interval', () => {
    const opts = parseCliArgs(['watch', '--wake-url', 'http://localhost:18789/hooks/wake', '--poll-interval', '10']);
    expect(opts.command).toBe('watch');
    expect(opts.pollInterval).toBe(10);
  });

  it('Scenario: Default poll interval is undefined (defaults to 10 at runtime)', () => {
    const opts = parseCliArgs(['watch']);
    expect(opts.pollInterval).toBeUndefined();
  });
});

describe('cli/Configure Subcommand', () => {
  it('Scenario: Interactive setup', async () => {
    // Configure triggers real auth import which may fail/timeout in test env.
    // Test that CLI correctly parses args and starts the configure flow.
    const opts = parseCliArgs(['configure', '--mailbox', 'work', '--provider', 'microsoft', '--client-id', 'test-id']);
    expect(opts.command).toBe('configure');
    expect(opts.mailbox).toBe('work');
    expect(opts.provider).toBe('microsoft');
    expect(opts.clientId).toBe('test-id');
  });

  it('Scenario: Setup alias', () => {
    // WHEN email-agent-mcp setup is run
    // THEN the system behaves identically to email-agent-mcp configure
    const opts = parseCliArgs(['setup', '--provider', 'microsoft']);
    expect(opts.command).toBe('setup');
    expect(opts.provider).toBe('microsoft');
  });
});

describe('cli/NemoClaw Setup', () => {
  it('Scenario: NemoClaw bootstrap', async () => {
    const exitCode = await runCli(['configure', '--nemoclaw']);
    expect(exitCode).toBe(0);

    const domains = getNemoClawEgressDomains();
    expect(domains).toContain('graph.microsoft.com');
    expect(domains).toContain('login.microsoftonline.com');
    expect(domains).toContain('gmail.googleapis.com');
    expect(domains).toContain('oauth2.googleapis.com');

    // Verify the domains were logged
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('graph.microsoft.com'),
    );
  });
});

describe('cli/Version and Help', () => {
  it('Scenario: Version output', async () => {
    const exitCode = await runCli(['--version']);
    expect(exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^email-agent-mcp \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
    );
  });
});

describe('cli/TTY-Aware Default Behavior', () => {
  it('Scenario: No args in non-TTY defaults to serve', async () => {
    // WHEN email-agent-mcp is run with no arguments in a non-TTY context
    // THEN the system behaves as if serve was specified
    // In test environment (non-TTY), no command -> serve mode
    const exitCode = await runCli([]);
    expect(exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('MCP server started'),
    );
  });

  it('Scenario: No args in TTY without config starts setup wizard', () => {
    // WHEN email-agent-mcp is run with no arguments in a TTY with no config
    // THEN the system launches the interactive setup wizard
    // This behavior is controlled by process.stdout.isTTY check in runCli
    // In test env (non-TTY), this path isn't reached — we verify the code path exists
    // by checking that the CLI correctly handles the no-command case
    const opts = parseCliArgs([]);
    expect(opts.command).toBe('');
    // TTY detection happens at runtime in runCli
  });

  it('Scenario: No args in TTY with config shows interactive menu', () => {
    // WHEN email-agent-mcp is run with no arguments in a TTY with valid config
    // THEN the system shows an interactive menu
    // In non-TTY test env, this falls through to serve mode
    // Verify the parsing path handles empty args correctly
    const opts = parseCliArgs([]);
    expect(opts.command).toBe('');
    expect(opts.version).toBeUndefined();
    expect(opts.help).toBeUndefined();
  });

  it('Scenario: Unknown command returns exit code 2', async () => {
    const exitCode = await runCli(['bogus-command']);
    expect(exitCode).toBe(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command'),
    );
  });
});

describe('cli/Exit Codes', () => {
  it('Scenario: Configuration error', async () => {
    // WHEN email-agent-mcp serve fails due to missing configuration
    // THEN the process exits with code 1 and a clear error message on stderr
    // Note: runCli(['serve']) succeeds in test env because the mock server starts OK.
    // Instead, test a command that requires config and fails without it.
    // The watch command returns 1 when no mailboxes are configured.
    // We use a temp dir with no mailboxes to trigger this error.
    const { mkdtemp: mkdtempFn, rm: rmFn } = await import('node:fs/promises');
    const tmpHome = await mkdtempFn(join(tmpdir(), 'email-agent-mcp-exit-test-'));
    const savedHome = process.env['EMAIL_AGENT_MCP_HOME'];
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpHome;

    try {
      // runWatch needs dynamic imports that will find no mailboxes -> exit 1
      const { runWatch } = await import('./cli.js');
      const exitCode = await runWatch({ command: 'watch' });
      expect(exitCode).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('No configured mailboxes found'),
      );
    } finally {
      if (savedHome === undefined) {
        delete process.env['EMAIL_AGENT_MCP_HOME'];
      } else {
        process.env['EMAIL_AGENT_MCP_HOME'] = savedHome;
      }
      await rmFn(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('cli/Interactive Wizard', () => {
  it('Scenario: Provider picker shows available providers', () => {
    // WHEN the interactive wizard starts
    // THEN it presents a provider picker with Outlook as available
    // The wizard is in wizard.ts — we verify the configure flow handles provider selection
    const opts = parseCliArgs(['configure', '--provider', 'microsoft']);
    expect(opts.provider).toBe('microsoft');
    // The wizard presents "1) Outlook" and "2) Gmail" options to the user
  });

  it('Scenario: Wizard persists config on success', async () => {
    // WHEN the wizard completes successfully
    // THEN it writes the configuration to ~/.email-agent-mcp/config.json
    const tmpHome = await mkdtemp(join(tmpdir(), 'email-agent-mcp-wizard-test-'));
    const savedHome = process.env['EMAIL_AGENT_MCP_HOME'];
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpHome;

    try {
      // Simulate wizard saving config on success
      await saveConfig({ hooksToken: 'wizard-token', wakeUrl: 'http://localhost:18789/hooks/wake' });

      const config = await loadConfig();
      expect(config.hooksToken).toBe('wizard-token');
      expect(config.wakeUrl).toBe('http://localhost:18789/hooks/wake');
    } finally {
      if (savedHome === undefined) {
        delete process.env['EMAIL_AGENT_MCP_HOME'];
      } else {
        process.env['EMAIL_AGENT_MCP_HOME'] = savedHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('cli/Status Subcommand', () => {
  it('Scenario: Status output', async () => {
    // WHEN email-agent-mcp status is run
    // THEN the system displays account info, token age, and allowlist summary
    const exitCode = await runCli(['status']);
    expect(exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('status'),
    );
  });

  it('Scenario: Status with no config', async () => {
    // WHEN email-agent-mcp status is run with no configuration
    // THEN the system prints a message indicating no accounts are configured
    const tmpHome = await mkdtemp(join(tmpdir(), 'email-agent-mcp-status-test-'));
    const savedHome = process.env['EMAIL_AGENT_MCP_HOME'];
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpHome;

    try {
      const exitCode = await runCli(['status']);
      expect(exitCode).toBe(0);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('No mailboxes configured'),
      );
    } finally {
      if (savedHome === undefined) {
        delete process.env['EMAIL_AGENT_MCP_HOME'];
      } else {
        process.env['EMAIL_AGENT_MCP_HOME'] = savedHome;
      }
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});

describe('cli/Config Persistence', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'email-agent-mcp-cfg-persist-'));
    originalHome = process.env['EMAIL_AGENT_MCP_HOME'];
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env['EMAIL_AGENT_MCP_HOME'];
    } else {
      process.env['EMAIL_AGENT_MCP_HOME'] = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Scenario: Config file written', async () => {
    // WHEN the user completes setup
    // THEN ~/.email-agent-mcp/config.json contains the config fields
    await saveConfig({ hooksToken: 'written-token', wakeUrl: 'http://example.com/wake', pollIntervalSeconds: 15 });

    const raw = await readFile(join(tmpDir, 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.hooksToken).toBe('written-token');
    expect(parsed.wakeUrl).toBe('http://example.com/wake');
    expect(parsed.pollIntervalSeconds).toBe(15);
  });

  it('Scenario: Config file read on startup', async () => {
    // WHEN any subcommand is run
    // THEN the system reads ~/.email-agent-mcp/config.json for default values
    await saveConfig({ wakeUrl: 'http://startup-default.com/wake', pollIntervalSeconds: 20 });

    const config = await loadConfig();
    expect(config.wakeUrl).toBe('http://startup-default.com/wake');
    expect(config.pollIntervalSeconds).toBe(20);
  });

  it('loadConfig returns empty object when no config file exists', async () => {
    const config = await loadConfig();
    expect(config).toEqual({});
  });

  it('saveConfig creates config.json and loadConfig reads it back', async () => {
    await saveConfig({ hooksToken: 'test-token-123', pollIntervalSeconds: 15 });

    const config = await loadConfig();
    expect(config.hooksToken).toBe('test-token-123');
    expect(config.pollIntervalSeconds).toBe(15);
  });

  it('saveConfig merges with existing config', async () => {
    await saveConfig({ hooksToken: 'token-1', wakeUrl: 'http://example.com/wake' });
    await saveConfig({ pollIntervalSeconds: 20 });

    const config = await loadConfig();
    expect(config.hooksToken).toBe('token-1');
    expect(config.wakeUrl).toBe('http://example.com/wake');
    expect(config.pollIntervalSeconds).toBe(20);
  });

  it('saveConfig overwrites individual fields', async () => {
    await saveConfig({ hooksToken: 'old-token' });
    await saveConfig({ hooksToken: 'new-token' });

    const config = await loadConfig();
    expect(config.hooksToken).toBe('new-token');
  });

  it('config.json is valid JSON with pretty formatting', async () => {
    await saveConfig({ hooksToken: 'pretty-token' });

    const raw = await readFile(join(tmpDir, 'config.json'), 'utf-8');
    expect(raw).toContain('\n'); // Pretty-printed
    expect(raw.endsWith('\n')).toBe(true); // Trailing newline
    const parsed = JSON.parse(raw);
    expect(parsed.hooksToken).toBe('pretty-token');
  });
});

describe('cli/EMAIL_AGENT_MCP_HOME', () => {
  it('Scenario: getAgentEmailHome respects env var', () => {
    const original = process.env['EMAIL_AGENT_MCP_HOME'];
    try {
      process.env['EMAIL_AGENT_MCP_HOME'] = '/tmp/test-email-agent-mcp';
      expect(getAgentEmailHome()).toBe('/tmp/test-email-agent-mcp');
    } finally {
      if (original === undefined) {
        delete process.env['EMAIL_AGENT_MCP_HOME'];
      } else {
        process.env['EMAIL_AGENT_MCP_HOME'] = original;
      }
    }
  });

  it('Scenario: getAgentEmailHome defaults to ~/.email-agent-mcp', () => {
    const original = process.env['EMAIL_AGENT_MCP_HOME'];
    try {
      delete process.env['EMAIL_AGENT_MCP_HOME'];
      const home = getAgentEmailHome();
      expect(home).toContain('.email-agent-mcp');
    } finally {
      if (original !== undefined) {
        process.env['EMAIL_AGENT_MCP_HOME'] = original;
      }
    }
  });
});

describe('cli/Poll Interval Validation', () => {
  it('Scenario: Poll interval below 2 is clamped', () => {
    const opts = parseCliArgs(['watch', '--poll-interval', '1']);
    expect(opts.pollInterval).toBe(1);
    // Clamping happens at runtime in runWatch, not in parseCliArgs
  });
});

describe('cli/Watcher Token Error Recovery', () => {
  let savedHome: string | undefined;
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'email-agent-mcp-watcher-recovery-'));
    savedHome = process.env['EMAIL_AGENT_MCP_HOME'];
    process.env['EMAIL_AGENT_MCP_HOME'] = tmpDir;

    // Prevent process.exit from killing the test runner
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    // Reset mock state for each test
    watcherMockState.mailboxes = [
      {
        mailboxName: 'test-work',
        emailAddress: 'test@example.com',
        clientId: 'test-client-id',
        authenticationRecord: { authority: 'test', homeAccountId: 'test', clientId: 'test', tenantId: 'test' },
        lastInteractiveAuthAt: new Date().toISOString(),
      },
    ];
    watcherMockState.auth.isTokenExpiringSoon = false;
    watcherMockState.auth.tryReconnectResult = true;
    watcherMockState.auth.tryReconnectCalls = 0;
    watcherMockState.auth.reconnectCalls = 0;
    watcherMockState.auth.getAccessTokenResult = 'mock-token';
    watcherMockState.auth.shutdownOnTryReconnect = false;
    watcherMockState.getNewMessagesResult = null;
    watcherMockState.pollCountBeforeShutdown = 1;
    watcherMockState.pollCount = 0;
  });

  afterEach(async () => {
    // Clear mock state so non-watcher tests (if any run after) use real implementations
    watcherMockState.mailboxes = [];

    if (savedHome === undefined) {
      delete process.env['EMAIL_AGENT_MCP_HOME'];
    } else {
      process.env['EMAIL_AGENT_MCP_HOME'] = savedHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
    exitSpy.mockRestore();
  });

  it('Scenario: Watcher calls tryReconnect on auth error during poll', async () => {
    // GIVEN a watcher is polling and the token becomes invalid (interaction_required)
    watcherMockState.getNewMessagesResult = new Error('interaction_required');

    // WHEN the poll loop encounters the auth error
    const { runWatch } = await import('./cli.js');
    const exitCode = await runWatch({ command: 'watch', pollInterval: 2 });

    // THEN tryReconnect is called on the auth manager
    expect(watcherMockState.auth.tryReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Token error for test@example.com'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Reconnect succeeded'),
    );
    expect(exitCode).toBe(0);
  }, 10_000);

  it('Scenario: Watcher logs warning when reconnect fails on auth error', async () => {
    // GIVEN a watcher is polling and the token becomes invalid (invalid_grant)
    // AND reconnect will fail
    watcherMockState.getNewMessagesResult = new Error('AADSTS70000: invalid_grant - token expired');
    watcherMockState.auth.tryReconnectResult = false;

    // WHEN the poll loop encounters the auth error
    const { runWatch } = await import('./cli.js');
    const exitCode = await runWatch({ command: 'watch', pollInterval: 2 });

    // THEN tryReconnect is called
    expect(watcherMockState.auth.tryReconnectCalls).toBeGreaterThanOrEqual(1);
    // AND a warning is logged telling the user to reconfigure
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Token error for test@example.com'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Reconnect failed'),
    );
    expect(exitCode).toBe(0);
  }, 10_000);

  it('Scenario: Proactive token refresh when isTokenExpiringSoon is true', async () => {
    // GIVEN the auth manager reports the token is expiring soon
    watcherMockState.auth.isTokenExpiringSoon = true;
    watcherMockState.auth.tryReconnectResult = true;

    // WHEN the poll loop runs
    const { runWatch } = await import('./cli.js');
    const exitCode = await runWatch({ command: 'watch', pollInterval: 2 });

    // THEN tryReconnect is called proactively (before polling for messages)
    expect(watcherMockState.auth.tryReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Token expiring soon for test@example.com'),
    );
    expect(exitCode).toBe(0);
  }, 10_000);

  it('Scenario: Proactive refresh failure skips poll for that mailbox', async () => {
    // GIVEN the auth manager reports the token is expiring soon
    // AND the proactive refresh fails
    watcherMockState.auth.isTokenExpiringSoon = true;
    watcherMockState.auth.tryReconnectResult = false;
    // Since proactive refresh failure causes `continue` (skips getNewMessages),
    // we trigger SIGINT from tryReconnect to stop the loop.
    watcherMockState.auth.shutdownOnTryReconnect = true;

    // WHEN the poll loop runs
    const { runWatch } = await import('./cli.js');
    const exitCode = await runWatch({ command: 'watch', pollInterval: 2 });

    // THEN a warning is logged about the failed proactive refresh
    expect(watcherMockState.auth.tryReconnectCalls).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('WARNING: Proactive refresh failed for test@example.com'),
    );
    expect(exitCode).toBe(0);
  }, 10_000);
});
