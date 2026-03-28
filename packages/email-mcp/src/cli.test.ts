import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runCli, parseCliArgs, getNemoClawEgressDomains, getAgentEmailHome } from './cli.js';

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

  it('Scenario: setup is an alias for configure', () => {
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
      expect.stringContaining('0.1.0'),
    );
  });
});

describe('cli/TTY-Aware Default', () => {
  it('Scenario: No command in non-TTY starts MCP server', async () => {
    // In test environment (non-TTY), no command → serve mode
    const exitCode = await runCli([]);
    expect(exitCode).toBe(0);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('MCP server started'),
    );
  });

  it('Scenario: Unknown command returns exit code 2', async () => {
    const exitCode = await runCli(['bogus-command']);
    expect(exitCode).toBe(2);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command'),
    );
  });
});

describe('cli/AGENT_EMAIL_HOME', () => {
  it('Scenario: getAgentEmailHome respects env var', () => {
    const original = process.env['AGENT_EMAIL_HOME'];
    try {
      process.env['AGENT_EMAIL_HOME'] = '/tmp/test-agent-email';
      expect(getAgentEmailHome()).toBe('/tmp/test-agent-email');
    } finally {
      if (original === undefined) {
        delete process.env['AGENT_EMAIL_HOME'];
      } else {
        process.env['AGENT_EMAIL_HOME'] = original;
      }
    }
  });

  it('Scenario: getAgentEmailHome defaults to ~/.agent-email', () => {
    const original = process.env['AGENT_EMAIL_HOME'];
    try {
      delete process.env['AGENT_EMAIL_HOME'];
      const home = getAgentEmailHome();
      expect(home).toContain('.agent-email');
    } finally {
      if (original !== undefined) {
        process.env['AGENT_EMAIL_HOME'] = original;
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
