import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfiguredMailboxSummary } from './cli.js';

// Linux CI runners do not provide libsecret; match cli.test.ts pattern.
vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: vi.fn(),
}));

const CANCEL_TOKEN = Symbol.for('email-agent-mcp/test-cancel');

const promptMockState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  confirmResult: false as boolean,
  textResult: '' as string,
}));

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const CANCEL = Symbol.for('email-agent-mcp/test-cancel');
  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    log: {
      success: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      message: vi.fn(),
      step: vi.fn(),
    },
    select: vi.fn(async () => {
      if (promptMockState.selectResults.length === 0) {
        throw new Error('select() called more times than test primed');
      }
      return promptMockState.selectResults.shift();
    }),
    confirm: vi.fn(async () => promptMockState.confirmResult),
    text: vi.fn(async () => promptMockState.textResult),
    isCancel: vi.fn((v: unknown) => v === CANCEL),
  };
});

const cliMockState = vi.hoisted(() => ({
  runConfigureCalls: [] as unknown[],
  runConfigureResult: 0,
}));

vi.mock('./cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli.js')>();
  return {
    ...actual,
    runConfigure: vi.fn(async (opts: unknown) => {
      cliMockState.runConfigureCalls.push(opts);
      return cliMockState.runConfigureResult;
    }),
    runWatch: vi.fn(async () => 0),
    runStatus: vi.fn(async () => 0),
    loadConfig: vi.fn(async () => ({})),
    saveConfig: vi.fn(async () => {}),
    getAgentEmailHome: vi.fn(() => '/tmp/email-agent-mcp-wizard-test-home'),
  };
});

describe('wizard/Reconnect Picker', () => {
  beforeEach(() => {
    promptMockState.selectResults = [];
    promptMockState.confirmResult = false;
    promptMockState.textResult = '';
    cliMockState.runConfigureCalls = [];
    cliMockState.runConfigureResult = 0;
  });

  it('Scenario: Multiple mailboxes — picker dispatches runConfigure with selected provider/mailbox', async () => {
    const msft: ConfiguredMailboxSummary = {
      provider: 'microsoft',
      mailboxName: 'default',
      emailAddress: 'user@contoso.com',
    };
    const gmail: ConfiguredMailboxSummary = {
      provider: 'gmail',
      mailboxName: 'user@gmail.com',
      emailAddress: 'user@gmail.com',
    };

    // Two select calls in sequence: top-level menu choice, then the mailbox picker.
    promptMockState.selectResults = ['reconnect', gmail];

    const { runWizardMenu } = await import('./wizard.js');
    const exit = await runWizardMenu({}, [msft, gmail]);

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls).toHaveLength(1);
    expect(cliMockState.runConfigureCalls[0]).toMatchObject({
      provider: 'gmail',
      mailbox: 'user@gmail.com',
    });
  });

  it('Scenario: Single mailbox — picker skipped, runConfigure called directly', async () => {
    const gmail: ConfiguredMailboxSummary = {
      provider: 'gmail',
      mailboxName: 'user@gmail.com',
      emailAddress: 'user@gmail.com',
    };
    // Only the top-level menu choice — picker should not be called.
    promptMockState.selectResults = ['reconnect'];

    const { runWizardMenu } = await import('./wizard.js');
    const exit = await runWizardMenu({}, [gmail]);

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls).toHaveLength(1);
    expect(cliMockState.runConfigureCalls[0]).toMatchObject({
      provider: 'gmail',
      mailbox: 'user@gmail.com',
    });
  });

  it('Scenario: Picker cancelled — exits 0 without calling runConfigure', async () => {
    const msft: ConfiguredMailboxSummary = {
      provider: 'microsoft',
      mailboxName: 'default',
      emailAddress: 'user@contoso.com',
    };
    const gmail: ConfiguredMailboxSummary = {
      provider: 'gmail',
      mailboxName: 'user@gmail.com',
      emailAddress: 'user@gmail.com',
    };

    promptMockState.selectResults = ['reconnect', CANCEL_TOKEN];

    const { runWizardMenu } = await import('./wizard.js');
    const exit = await runWizardMenu({}, [msft, gmail]);

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls).toHaveLength(0);
  });

  it('Scenario: Uses emailAddress when available, falls back to mailboxName', async () => {
    // Mailbox with no emailAddress — verify mailboxName is used as the --mailbox arg.
    const msftDefault: ConfiguredMailboxSummary = {
      provider: 'microsoft',
      mailboxName: 'default',
    };
    promptMockState.selectResults = ['reconnect'];

    const { runWizardMenu } = await import('./wizard.js');
    const exit = await runWizardMenu({}, [msftDefault]);

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls[0]).toMatchObject({
      provider: 'microsoft',
      mailbox: 'default',
    });
  });
});
