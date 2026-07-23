import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfiguredMailboxSummary } from './cli.js';

// Linux CI runners do not provide libsecret; match cli.test.ts pattern.
vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: vi.fn(),
}));

const CANCEL_TOKEN = Symbol.for('email-agent-mcp/test-cancel');

const promptMockState = vi.hoisted(() => ({
  selectResults: [] as unknown[],
  confirmResults: [] as boolean[],
  textResults: [] as string[],
  passwordResults: [] as string[],
  confirmResult: false as boolean,
  textResult: '' as string,
  passwordResult: '' as string,
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
    confirm: vi.fn(async () =>
      promptMockState.confirmResults.length > 0
        ? promptMockState.confirmResults.shift()!
        : promptMockState.confirmResult),
    text: vi.fn(async () =>
      promptMockState.textResults.length > 0
        ? promptMockState.textResults.shift()!
        : promptMockState.textResult),
    password: vi.fn(async () =>
      promptMockState.passwordResults.length > 0
        ? promptMockState.passwordResults.shift()!
        : promptMockState.passwordResult),
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
    promptMockState.confirmResults = [];
    promptMockState.textResults = [];
    promptMockState.passwordResults = [];
    promptMockState.confirmResult = false;
    promptMockState.textResult = '';
    promptMockState.passwordResult = '';
    cliMockState.runConfigureCalls = [];
    cliMockState.runConfigureResult = 0;
    vi.clearAllMocks();
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

  it('Scenario: Gmail wizard reconnect preserves saved credentials', async () => {
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
    const clackPrompts = await import('@clack/prompts');
    expect(vi.mocked(clackPrompts.select)).toHaveBeenCalledTimes(1);
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

describe('wizard/Gmail Authentication Choice', () => {
  beforeEach(() => {
    promptMockState.selectResults = [];
    promptMockState.confirmResults = [];
    promptMockState.textResults = [];
    promptMockState.passwordResults = [];
    promptMockState.confirmResult = false;
    promptMockState.textResult = '';
    promptMockState.passwordResult = '';
    cliMockState.runConfigureCalls = [];
    cliMockState.runConfigureResult = 0;
    vi.clearAllMocks();
  });

  it('Scenario: Gmail wizard offers both authentication modes', async () => {
    promptMockState.selectResults = ['gmail', 'broker'];
    promptMockState.confirmResults = [true, false];
    promptMockState.textResults = [''];

    const { runWizardSetup } = await import('./wizard.js');
    const exit = await runWizardSetup({});

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls).toHaveLength(1);
    expect(cliMockState.runConfigureCalls[0]).toMatchObject({
      command: 'configure',
      provider: 'gmail',
    });
    expect(cliMockState.runConfigureCalls[0]).not.toHaveProperty('clientId');
    expect(cliMockState.runConfigureCalls[0]).not.toHaveProperty('clientSecret');

    const clackPrompts = await import('@clack/prompts');
    const authPrompt = vi.mocked(clackPrompts.select).mock.calls[1]?.[0];
    expect(authPrompt?.options.map(option => option.value)).toEqual(['byok', 'broker']);

    const notes = JSON.stringify(vi.mocked(clackPrompts.note).mock.calls);
    expect(notes).toContain('Testing status');
    expect(notes).toContain('100 test users');
    expect(notes).toContain('unverified-app');
    expect(notes).toContain('7 days');
  });

  it('Scenario: Gmail wizard collects BYOK credentials confidentially', async () => {
    const clientSecret = 'wizard-client-secret';
    promptMockState.selectResults = ['gmail', 'byok'];
    promptMockState.confirmResults = [true, false];
    promptMockState.textResults = ['wizard-client-id', ''];
    promptMockState.passwordResults = [clientSecret];

    const { runWizardSetup } = await import('./wizard.js');
    const exit = await runWizardSetup({});

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls).toHaveLength(1);
    expect(cliMockState.runConfigureCalls[0]).toMatchObject({
      command: 'configure',
      provider: 'gmail',
      clientId: 'wizard-client-id',
      clientSecret,
    });

    const clackPrompts = await import('@clack/prompts');
    expect(vi.mocked(clackPrompts.password)).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Google OAuth client secret' }),
    );
    const notes = JSON.stringify(vi.mocked(clackPrompts.note).mock.calls);
    expect(notes).toContain('Desktop app');
    expect(notes).toContain('#gmail-setup');

    const renderedOutput = JSON.stringify([
      ...vi.mocked(clackPrompts.intro).mock.calls,
      ...vi.mocked(clackPrompts.outro).mock.calls,
      ...vi.mocked(clackPrompts.note).mock.calls,
      ...vi.mocked(clackPrompts.log.error).mock.calls,
      ...vi.mocked(clackPrompts.log.success).mock.calls,
    ]);
    expect(renderedOutput).not.toContain(clientSecret);
  });

  it('Scenario: Gmail wizard rejects incomplete BYOK credentials', async () => {
    promptMockState.selectResults = ['gmail', 'byok'];
    promptMockState.textResults = ['wizard-client-id'];
    promptMockState.passwordResults = [''];

    const { runWizardSetup } = await import('./wizard.js');
    const exit = await runWizardSetup({});

    expect(exit).toBe(2);
    expect(cliMockState.runConfigureCalls).toHaveLength(0);

    const clackPrompts = await import('@clack/prompts');
    expect(vi.mocked(clackPrompts.log.error)).toHaveBeenCalledWith(
      'Gmail BYOK requires both the client ID and client secret.',
    );
  });

  it('Scenario: Gmail wizard preserves explicit credentials', async () => {
    const clientSecret = 'explicit-client-secret';
    promptMockState.selectResults = ['gmail'];
    promptMockState.confirmResults = [true, false];
    promptMockState.textResults = [''];

    const { runWizardSetup } = await import('./wizard.js');
    const exit = await runWizardSetup({
      clientId: 'explicit-client-id',
      clientSecret,
    });

    expect(exit).toBe(0);
    expect(cliMockState.runConfigureCalls[0]).toMatchObject({
      command: 'configure',
      provider: 'gmail',
      clientId: 'explicit-client-id',
      clientSecret,
    });

    const clackPrompts = await import('@clack/prompts');
    expect(vi.mocked(clackPrompts.select)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(clackPrompts.password)).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(clackPrompts.note).mock.calls)).not.toContain(clientSecret);
  });
});
