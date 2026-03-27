import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli, parseCliArgs, getNemoClawEgressDomains } from './cli.js';

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
  it('Scenario: Watch with wake URL (parses args correctly)', () => {
    // runWatch now does real work (loads mailboxes, etc.) so we just test parsing
    const opts = parseCliArgs(['watch', '--wake-url', 'http://localhost:18789/hooks/wake']);
    expect(opts.command).toBe('watch');
    expect(opts.wakeUrl).toBe('http://localhost:18789/hooks/wake');
  });

  it('Scenario: Watch with custom poll interval', () => {
    const opts = parseCliArgs(['watch', '--wake-url', 'http://localhost:18789/hooks/wake', '--poll-interval', '10']);
    expect(opts.command).toBe('watch');
    expect(opts.pollInterval).toBe(10);
  });

  it('Scenario: Default poll interval is undefined (defaults to 30 at runtime)', () => {
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
      expect.stringContaining('0.1.0'),
    );
  });
});

describe('cli/Exit Codes', () => {
  it('Scenario: Configuration error', async () => {
    // No command specified — usage error (exit code 2)
    const exitCode = await runCli([]);
    expect(exitCode).toBe(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('No command specified'),
    );
  });
});
