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
  it('Scenario: Watch with wake URL', async () => {
    const exitCode = await runCli(['watch', '--wake-url', 'http://localhost:18789/hooks/wake']);
    expect(exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:18789/hooks/wake'),
    );
  });
});

describe('cli/Configure Subcommand', () => {
  it('Scenario: Interactive setup', async () => {
    // Configure without --nemoclaw attempts real auth, which will fail in test env
    // but should print the mailbox/provider info before failing
    const exitCode = await runCli(['configure', '--mailbox', 'work', '--provider', 'microsoft']);
    // Will fail due to no real Azure credentials in test, but should show config output
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Configuring mailbox'),
    );
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
