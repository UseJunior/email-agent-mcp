import { describe, it, expect } from 'vitest';

// Spec: cli — All requirements
// Tests written FIRST (spec-driven). Implementation pending.

describe('cli/Serve Subcommand', () => {
  it('Scenario: Start MCP server', async () => {
    // WHEN npx @usejunior/agent-email serve is run
    // THEN the MCP server starts on stdio and lists all 14 email tools
    expect.fail('Not implemented — awaiting CLI serve');
  });
});

describe('cli/Watch Subcommand', () => {
  it('Scenario: Watch with wake URL', async () => {
    // WHEN agent-email watch --wake-url http://localhost:18789/hooks/wake is run
    // THEN the watcher monitors all mailboxes and sends authenticated wake POSTs on new email
    expect.fail('Not implemented — awaiting CLI watch');
  });
});

describe('cli/Configure Subcommand', () => {
  it('Scenario: Interactive setup', async () => {
    // WHEN agent-email configure is run
    // THEN prompts for provider (microsoft/gmail), credentials, and tests the connection
    expect.fail('Not implemented — awaiting CLI configure');
  });
});

describe('cli/NemoClaw Setup', () => {
  it('Scenario: NemoClaw bootstrap', async () => {
    // WHEN agent-email configure --nemoclaw is run
    // THEN adds graph.microsoft.com, login.microsoftonline.com, gmail.googleapis.com,
    //      oauth2.googleapis.com to the sandbox egress policy
    // AND tests connectivity to each domain before proceeding
    expect.fail('Not implemented — awaiting NemoClaw setup');
  });
});

describe('cli/Version and Help', () => {
  it('Scenario: Version output', async () => {
    // WHEN agent-email --version is run
    // THEN prints the package version
    expect.fail('Not implemented — awaiting CLI version');
  });
});

describe('cli/Exit Codes', () => {
  it('Scenario: Configuration error', async () => {
    // WHEN agent-email serve fails due to missing configuration
    // THEN the process exits with code 1 and a clear error message on stderr
    expect.fail('Not implemented — awaiting CLI exit codes');
  });
});
