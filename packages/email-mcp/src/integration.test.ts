/**
 * Integration tests — cross-module tests that catch stale builds and
 * verify contracts between packages.
 *
 * These tests import from dist paths and source modules to ensure
 * the full build pipeline produces correct artifacts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { EmailMessage } from '@usejunior/email-core';

// ─── Spec: provider-interface/Dynamic discovery ─────────────────────
// Importing from the dist path catches stale builds: if the build is
// missing an export, these tests fail immediately.

describe('provider-interface/Dynamic discovery — dist exports', () => {
  it('Scenario: Microsoft provider exports all public symbols', async () => {
    // Dynamic import to match how the CLI and server load the provider
    const msProvider = await import('@usejunior/provider-microsoft');

    // Classes
    expect(msProvider.DelegatedAuthManager).toBeDefined();
    expect(typeof msProvider.DelegatedAuthManager).toBe('function');

    expect(msProvider.RealGraphApiClient).toBeDefined();
    expect(typeof msProvider.RealGraphApiClient).toBe('function');

    expect(msProvider.GraphEmailProvider).toBeDefined();
    expect(typeof msProvider.GraphEmailProvider).toBe('function');

    expect(msProvider.ClientCredentialsAuthManager).toBeDefined();
    expect(typeof msProvider.ClientCredentialsAuthManager).toBe('function');

    // Utility function
    expect(msProvider.toFilesystemSafeKey).toBeDefined();
    expect(typeof msProvider.toFilesystemSafeKey).toBe('function');
  });

  it('Scenario: toFilesystemSafeKey produces safe filenames', async () => {
    const { toFilesystemSafeKey } = await import('@usejunior/provider-microsoft');

    const safeKey = toFilesystemSafeKey('steven@usejunior.com');
    // Must be lowercase, @ replaced with -at-, dots replaced with hyphens
    expect(safeKey).toBe('steven-at-usejunior-com');
    expect(safeKey).not.toContain('@');
    expect(safeKey).not.toContain('.');
    // Must only contain filesystem-safe characters
    expect(safeKey).toMatch(/^[a-z0-9-]+$/);
  });

  it('Scenario: GraphApiError is exported for catch handling', async () => {
    const { GraphApiError } = await import('@usejunior/provider-microsoft');
    expect(GraphApiError).toBeDefined();
    expect(typeof GraphApiError).toBe('function');
  });

  it('Scenario: Subscription utilities are exported', async () => {
    const msProvider = await import('@usejunior/provider-microsoft');
    expect(msProvider.handleValidationToken).toBeDefined();
    expect(msProvider.isDuplicateNotification).toBeDefined();
    expect(msProvider.checkSubscriptionExists).toBeDefined();
    expect(msProvider.createInboxSubscription).toBeDefined();
    expect(msProvider.healthCheckEndpoint).toBeDefined();
  });
});

// ─── Spec: email-watcher/Delta State Persistence — cross-module ─────
// This tests the delta state round-trip across module boundaries.

describe('email-watcher/Delta State Persistence — cross-module', () => {
  const TEST_KEY = '__integration-test-delta__';

  afterEach(async () => {
    const { deleteDeltaState } = await import('./watcher.js');
    await deleteDeltaState(TEST_KEY);
  });

  it('Scenario: Delta state round-trip preserves format', async () => {
    const { saveDeltaState, loadDeltaState } = await import('./watcher.js');

    const original = {
      deltaLink: 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$deltatoken=integration-test-token',
      lastUpdated: new Date().toISOString(),
    };

    await saveDeltaState(TEST_KEY, original);
    const loaded = await loadDeltaState(TEST_KEY);

    expect(loaded).not.toBeNull();
    expect(loaded!.deltaLink).toBe(original.deltaLink);
    expect(loaded!.lastUpdated).toBe(original.lastUpdated);

    // Verify it is valid JSON with exactly the expected fields
    expect(Object.keys(loaded!).sort()).toEqual(['deltaLink', 'lastUpdated']);
  });

  it('Scenario: Delta state is valid JSON on disk', async () => {
    const { readFile } = await import('node:fs/promises');
    const { saveDeltaState, getDeltaStatePath } = await import('./watcher.js');

    const state = {
      deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=json-test',
      lastUpdated: '2024-06-01T12:00:00Z',
    };

    await saveDeltaState(TEST_KEY, state);

    // Read raw file and verify it is valid JSON
    const rawContent = await readFile(getDeltaStatePath(TEST_KEY), 'utf-8');
    const parsed = JSON.parse(rawContent);
    expect(parsed.deltaLink).toBe(state.deltaLink);
    expect(parsed.lastUpdated).toBe(state.lastUpdated);
  });
});

// ─── Spec: email-watcher/Wake Payload — cross-module ────────────────
// Verify wake payload is text-only with the correct format using a
// realistic EmailMessage from email-core types.

describe('email-watcher/Wake Payload — integration', () => {
  it('Scenario: Realistic EmailMessage produces correct text payload', async () => {
    const { buildWakePayload } = await import('./watcher.js');

    // Realistic message with all fields populated
    const message: EmailMessage = {
      id: 'AAMkAGI2TG93AAA=',
      subject: 'Contract Review \u2014 Q1 2024',
      from: { email: 'alice@corp.com', name: 'Alice Smith' },
      to: [
        { email: 'steven@usejunior.com', name: 'Steven O.' },
        { email: 'bob@corp.com' },
      ],
      cc: [{ email: 'team@corp.com', name: 'Team DL' }],
      receivedAt: '2024-03-15T10:00:00Z',
      isRead: false,
      hasAttachments: true,
      body: 'Please review the attached contract.',
      snippet: 'Please review the attached...',
      folder: 'Inbox',
      threadId: 'thread-abc-123',
    };

    const payload = buildWakePayload('steven@usejunior.com', message);

    // WakePayload must have exactly {text, mode} — no structured email object
    expect(Object.keys(payload).sort()).toEqual(['mode', 'text']);
    expect(payload.mode).toBe('now');

    // Text must be self-contained for LLM readability
    expect(payload.text).toContain('New email to steven@usejunior.com');
    expect(payload.text).toContain('Alice Smith <alice@corp.com>');
    expect(payload.text).toContain('Contract Review');
    expect(payload.text).toContain('To: steven@usejunior.com, bob@corp.com');
    expect(payload.text).toContain('Cc: team@corp.com');
    expect(payload.text).toContain('Attachments: yes');

    // Must NOT contain raw email body or structured data
    expect(payload.text).not.toContain('Please review the attached');
    expect(payload.text).not.toContain('AAMkAGI2TG93AAA=');
  });

  it('Scenario: Payload text has no structured email object (OpenClaw normalizeWakePayload compatibility)', async () => {
    const { buildWakePayload } = await import('./watcher.js');

    const message: EmailMessage = {
      id: 'msg-simple',
      subject: 'Simple Test',
      from: { email: 'sender@example.com' },
      to: [{ email: 'receiver@example.com' }],
      receivedAt: '2024-06-01T12:00:00Z',
      isRead: false,
      hasAttachments: false,
    };

    const payload = buildWakePayload('receiver@example.com', message);

    // OpenClaw's normalizeWakePayload strips everything except text and mode.
    // Verify the payload is compatible.
    expect(typeof payload.text).toBe('string');
    expect(payload.text.length).toBeGreaterThan(0);
    expect(payload.mode).toBe('now');

    // No JSON in the text field
    expect(() => JSON.parse(payload.text)).toThrow();
  });
});

// ─── Spec: mcp-transport/Action to Tool Mapping — integration ───────
// Verify actionsToMcpTools produces valid JSON Schema for all tool
// input schemas, matching what MCP clients expect.

describe('mcp-transport/Action to Tool Mapping — integration', () => {
  it('Scenario: All demo action schemas produce valid JSON Schema objects', async () => {
    const { actionsToMcpTools } = await import('./server.js');

    // Build a representative set of actions with various Zod types
    const actions: Parameters<typeof actionsToMcpTools>[0] = [
      {
        name: 'list_emails',
        description: 'List recent emails',
        input: z.object({
          mailbox: z.string().optional(),
          unread: z.boolean().optional(),
          limit: z.number().optional(),
          folder: z.string().optional(),
        }),
        output: z.object({ emails: z.array(z.object({ id: z.string() })) }),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({ emails: [] }),
      },
      {
        name: 'read_email',
        description: 'Read email by ID',
        input: z.object({ id: z.string(), mailbox: z.string().optional() }),
        output: z.object({ id: z.string(), body: z.string() }),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({ id: '', body: '' }),
      },
      {
        name: 'send_email',
        description: 'Send a new email',
        input: z.object({
          to: z.string(),
          subject: z.string(),
          body: z.string(),
          cc: z.string().optional(),
        }),
        output: z.object({ success: z.boolean(), messageId: z.string().optional() }),
        annotations: { readOnlyHint: false, destructiveHint: false },
        run: async () => ({ success: true }),
      },
      {
        name: 'search_emails',
        description: 'Search emails',
        input: z.object({ query: z.string(), limit: z.number().optional() }),
        output: z.object({ emails: z.array(z.object({ id: z.string() })) }),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({ emails: [] }),
      },
    ];

    const tools = actionsToMcpTools(actions);

    expect(tools).toHaveLength(4);

    for (const tool of tools) {
      // Every tool must have a name and description
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();

      // Input schema must be a valid JSON Schema object
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(typeof tool.inputSchema.properties).toBe('object');

      // Properties must be non-empty
      const props = tool.inputSchema.properties as Record<string, unknown>;
      expect(Object.keys(props).length).toBeGreaterThan(0);

      // Each property must have a type
      for (const [_propName, propSchema] of Object.entries(props)) {
        expect(propSchema).toBeDefined();
        expect(typeof propSchema).toBe('object');
        const schema = propSchema as Record<string, unknown>;
        expect(schema.type).toBeDefined();
      }

      // Annotations must be present
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations!.readOnlyHint).toBe('boolean');
      expect(typeof tool.annotations!.destructiveHint).toBe('boolean');
    }
  });

  it('Scenario: Required fields are correctly identified in JSON Schema', async () => {
    const { actionsToMcpTools } = await import('./server.js');

    const actions: Parameters<typeof actionsToMcpTools>[0] = [
      {
        name: 'test_action',
        description: 'Test',
        input: z.object({
          required_field: z.string(),
          optional_field: z.string().optional(),
        }),
        output: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
        run: async () => ({}),
      },
    ];

    const tools = actionsToMcpTools(actions);
    const schema = tools[0]!.inputSchema;

    // Required array should contain required_field but not optional_field
    const required = schema.required as string[] | undefined;
    expect(required).toBeDefined();
    expect(required).toContain('required_field');
    expect(required).not.toContain('optional_field');
  });
});

// ─── Spec: cli/Exit Codes — integration ─────────────────────────────
// Verify each CLI subcommand returns expected exit code.

describe('cli/Exit Codes — integration', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Scenario: --version returns exit code 0', async () => {
    const { runCli } = await import('./cli.js');
    const exitCode = await runCli(['--version']);
    expect(exitCode).toBe(0);
  });

  it('Scenario: No args in non-TTY starts MCP server (exit code 0)', async () => {
    const { runCli } = await import('./cli.js');
    const exitCode = await runCli([]);
    // In non-TTY (test environment), no command → serve mode
    expect(exitCode).toBe(0);
  });

  it('Scenario: Unknown command returns exit code 2', async () => {
    const { runCli } = await import('./cli.js');
    const exitCode = await runCli(['nonexistent-command']);
    expect(exitCode).toBe(2);
  });

  it('Scenario: --help returns exit code 0', async () => {
    const { runCli } = await import('./cli.js');
    const exitCode = await runCli(['--help']);
    expect(exitCode).toBe(0);
  });
});
