#!/usr/bin/env node
// CLI entry point — serve, watch, configure, setup subcommands + TTY-aware default

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { startLoopbackOAuthListener } from './oauth-loopback.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

export interface CliOptions {
  command: string;
  wakeUrl?: string;
  nemoclaw?: boolean;
  version?: boolean;
  help?: boolean;
  logLevel?: string;
  mailbox?: string;
  provider?: string;
  clientId?: string;
  clientSecret?: string;
  brokerUrl?: string;
  pollInterval?: number; // seconds
  // `call` subcommand options
  callTool?: string;          // first positional after `call` — the tool name
  callArgs?: string;          // raw JSON string from --args
  callArgsFile?: string;      // path passed via --args-file
  callArgsStdin?: boolean;    // read JSON args from stdin
  callList?: boolean;         // --list — enumerate tools
  callSchema?: boolean;       // --schema — print input schema for a tool
}

// NemoClaw egress domains for all providers
const NEMOCLAW_EGRESS_DOMAINS = [
  'graph.microsoft.com',
  'login.microsoftonline.com',
  'gmail.googleapis.com',
  'oauth2.googleapis.com',
  'pubsub.googleapis.com',
];

/**
 * Resolve the email-agent-mcp home directory.
 * Respects EMAIL_AGENT_MCP_HOME env var for test isolation.
 */
export function getAgentEmailHome(): string {
  return process.env['EMAIL_AGENT_MCP_HOME'] ?? join(homedir(), '.email-agent-mcp');
}

export interface AgentEmailConfig {
  wakeUrl?: string;
  hooksToken?: string;
  pollIntervalSeconds?: number;
}

export interface ConfiguredMailboxSummary {
  provider: 'microsoft' | 'gmail';
  mailboxName: string;
  emailAddress?: string;
  lastInteractiveAuthAt?: string;
}

export function shouldShowConfigureMailboxPicker(
  opts: CliOptions,
  mailboxCount: number,
  isTTY = Boolean(process.stdout.isTTY),
): boolean {
  return (
    isTTY &&
    mailboxCount > 1 &&
    !opts.provider &&
    !opts.mailbox &&
    !opts.nemoclaw
  );
}

/**
 * Get the config file path: ~/.email-agent-mcp/config.json
 */
function getConfigPath(): string {
  return join(getAgentEmailHome(), 'config.json');
}

/**
 * Load persisted config from ~/.email-agent-mcp/config.json.
 * Returns empty config if file doesn't exist or is invalid.
 */
export async function loadConfig(): Promise<AgentEmailConfig> {
  try {
    const raw = await readFile(getConfigPath(), 'utf-8');
    return JSON.parse(raw) as AgentEmailConfig;
  } catch {
    return {};
  }
}

/**
 * Save config to ~/.email-agent-mcp/config.json.
 * Merges with existing config so callers only need to pass changed fields.
 */
export async function saveConfig(updates: Partial<AgentEmailConfig>): Promise<void> {
  const existing = await loadConfig();
  const merged = { ...existing, ...updates };
  const dir = getAgentEmailHome();
  await mkdir(dir, { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

function getAuthTimestamp(value?: string): number {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function listConfiguredMailboxSummaries(): Promise<ConfiguredMailboxSummary[]> {
  const summaries: ConfiguredMailboxSummary[] = [];

  try {
    const { listConfiguredMailboxesWithMetadata } = await import('@usejunior/provider-microsoft');
    const mailboxes = await listConfiguredMailboxesWithMetadata();
    summaries.push(
      ...mailboxes.map(mailbox => ({
        provider: 'microsoft' as const,
        mailboxName: mailbox.mailboxName,
        emailAddress: mailbox.emailAddress,
        lastInteractiveAuthAt: mailbox.lastInteractiveAuthAt,
      })),
    );
  } catch {
    // Provider package may not be installed.
  }

  try {
    const { listConfiguredGmailMailboxes } = await import('@usejunior/provider-gmail');
    const mailboxes = await listConfiguredGmailMailboxes();
    summaries.push(
      ...mailboxes.map(mailbox => ({
        provider: 'gmail' as const,
        mailboxName: mailbox.mailboxName,
        emailAddress: mailbox.emailAddress,
        lastInteractiveAuthAt: mailbox.lastInteractiveAuthAt,
      })),
    );
  } catch {
    // Provider package may not be installed.
  }

  summaries.sort((a, b) => getAuthTimestamp(b.lastInteractiveAuthAt) - getAuthTimestamp(a.lastInteractiveAuthAt));
  return summaries;
}

async function getGmailReauthWarning(summary: ConfiguredMailboxSummary): Promise<string | undefined> {
  if (summary.provider !== 'gmail') return undefined;

  const gmail = await import('@usejunior/provider-gmail');

  try {
    const metadata = await gmail.loadGmailMailboxMetadata(summary.emailAddress ?? summary.mailboxName);
    if (!metadata) return undefined;

    const mailboxRef = metadata.emailAddress ?? metadata.mailboxName;
    const auth = new gmail.GmailAuthManager(
      metadata.source === 'broker'
        ? {
            brokerUrl: metadata.brokerUrl,
            metadataWriter: gmail.createGmailMetadataWriter(metadata),
            mailboxName: mailboxRef,
            lastInteractiveAuthAt: metadata.lastInteractiveAuthAt,
          }
        : {
            clientId: metadata.clientId,
            metadataWriter: gmail.createGmailMetadataWriter(metadata),
            clientSecret: metadata.clientSecret,
            redirectUri: metadata.redirectUri,
            mailboxName: mailboxRef,
            lastInteractiveAuthAt: metadata.lastInteractiveAuthAt,
          },
    );

    await auth.connect({ refresh_token: metadata.refreshToken });
    await auth.refresh();

    return auth.getTokenHealthWarning();
  } catch (err) {
    if (!gmail.isGmailReauthError(err)) {
      return undefined;
    }
    return gmail.formatGmailAuthError(err, summary.emailAddress ?? summary.mailboxName);
  }
}

export async function getEffectiveSendAllowlistPath(): Promise<string> {
  const { getSendAllowlistPath } = await import('@usejunior/email-core');
  return getSendAllowlistPath();
}

function normalizeMailboxValue(value: string): string {
  return value.trim().toLowerCase();
}

export async function ensureGmailProfileMatchesIntent(
  mailboxName: string,
  emailAddress: string,
): Promise<void> {
  const normalizedMailboxName = normalizeMailboxValue(mailboxName);
  const normalizedEmailAddress = normalizeMailboxValue(emailAddress);

  if (mailboxName.includes('@')) {
    if (normalizedMailboxName !== normalizedEmailAddress) {
      throw new Error(
        `Google authenticated ${emailAddress}, but configure was asked to link ${mailboxName}. Re-run configure and choose the intended Google account.`,
      );
    }
    return;
  }

  const existingMailbox = (await listConfiguredMailboxSummaries()).find(summary =>
    summary.provider === 'gmail' &&
    normalizeMailboxValue(summary.mailboxName) === normalizedMailboxName &&
    summary.emailAddress,
  );

  if (existingMailbox?.emailAddress) {
    if (normalizeMailboxValue(existingMailbox.emailAddress) !== normalizedEmailAddress) {
      throw new Error(
        `Mailbox "${mailboxName}" is already linked to ${existingMailbox.emailAddress}, but Google authenticated ${emailAddress}. Use a different mailbox name or re-run configure with the intended Google account.`,
      );
    }
    return;
  }

  if (!process.stdout.isTTY) {
    throw new Error(
      `Google authenticated ${emailAddress} for mailbox alias "${mailboxName}", but the alias does not prove which account you intended. Re-run in a TTY to confirm, or pass --mailbox ${emailAddress}.`,
    );
  }

  const p = await import('@clack/prompts');
  const confirmed = await p.confirm({
    message: `Google authenticated ${emailAddress}. Save it as mailbox "${mailboxName}"?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    throw new Error('Gmail configuration cancelled because the authenticated account was not confirmed');
  }
}

async function addEmailToSendAllowlist(emailAddress: string): Promise<void> {
  // Keep CLI writes aligned with the runtime/server path resolution so
  // configure-time edits land in the file the MCP server will actually watch.
  const allowlistPath = await getEffectiveSendAllowlistPath();
  const agentHome = dirname(allowlistPath);

  await mkdir(agentHome, { recursive: true });

  let entries: string[] = [];
  try {
    const raw = await readFile(allowlistPath, 'utf-8');
    const data = JSON.parse(raw) as { entries?: string[] };
    entries = data.entries ?? [];
  } catch {
    // Start with a new allowlist file.
  }

  const lowerEmail = emailAddress.toLowerCase();
  if (!entries.some(entry => entry.toLowerCase() === lowerEmail)) {
    entries.push(emailAddress);
  }

  await writeFile(allowlistPath, JSON.stringify({ entries }, null, 2) + '\n', 'utf-8');
}


export function parseCliArgs(args: string[]): CliOptions {
  const opts: CliOptions = { command: '' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--version') {
      opts.version = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    if (arg === '--nemoclaw') {
      opts.nemoclaw = true;
      continue;
    }
    if (arg === '--wake-url' && i + 1 < args.length) {
      opts.wakeUrl = args[++i];
      continue;
    }
    if (arg === '--log-level' && i + 1 < args.length) {
      opts.logLevel = args[++i];
      continue;
    }
    if (arg === '--mailbox' && i + 1 < args.length) {
      opts.mailbox = args[++i];
      continue;
    }
    if (arg === '--provider' && i + 1 < args.length) {
      opts.provider = args[++i];
      continue;
    }
    if (arg === '--client-id' && i + 1 < args.length) {
      opts.clientId = args[++i];
      continue;
    }
    if (arg === '--client-secret' && i + 1 < args.length) {
      opts.clientSecret = args[++i];
      continue;
    }
    if (arg === '--broker-url' && i + 1 < args.length) {
      opts.brokerUrl = args[++i];
      continue;
    }
    if (arg === '--poll-interval' && i + 1 < args.length) {
      opts.pollInterval = parseInt(args[++i]!, 10);
      continue;
    }
    // `call` subcommand flags
    if (arg === '--args' && i + 1 < args.length) {
      opts.callArgs = args[++i];
      continue;
    }
    if (arg === '--args-file' && i + 1 < args.length) {
      opts.callArgsFile = args[++i];
      continue;
    }
    if (arg === '--args-stdin') {
      opts.callArgsStdin = true;
      continue;
    }
    if (arg === '--list') {
      opts.callList = true;
      continue;
    }
    if (arg === '--schema') {
      opts.callSchema = true;
      continue;
    }

    // First positional arg is the command
    if (!opts.command && !arg.startsWith('-')) {
      opts.command = arg;
      continue;
    }
    // Second positional (only meaningful for `call`) is the tool name
    if (opts.command === 'call' && !opts.callTool && !arg.startsWith('-')) {
      opts.callTool = arg;
      continue;
    }
  }

  return opts;
}


/**
 * Run the CLI with the given arguments.
 * Returns exit code.
 */
export async function runCli(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);

  if (opts.version) {
    console.error(`email-agent-mcp ${PACKAGE_VERSION}`);
    return 0;
  }

  if (opts.help) {
    printHelp();
    return 0;
  }

  switch (opts.command) {
    case 'serve':
      return await runServe(opts);
    case 'watch':
      return await runWatch(opts);
    case 'setup':
    case 'configure': {
      if (process.stdout.isTTY && !opts.provider && !opts.mailbox && !opts.nemoclaw) {
        const mailboxes = await listConfiguredMailboxSummaries();
        if (shouldShowConfigureMailboxPicker(opts, mailboxes.length)) {
          const { runWizardConfigurePicker } = await import('./wizard.js');
          return await runWizardConfigurePicker(opts, mailboxes);
        }
      }
      return await runConfigure(opts);
    }
    case 'status':
      return await runStatus();
    case 'token':
      return await runToken(opts);
    case 'call':
      return await runCall(opts);
    case 'help':
      printHelp();
      return 0;
    default:
      if (!opts.command) {
        // TTY-aware smart default
        if (!process.stdout.isTTY) {
          // Non-TTY: MCP serve mode (what hosts like OpenClaw/Claude Code expect)
          return await runServe(opts);
        }

        // TTY: check if any mailboxes are configured
        const mailboxes = await listConfiguredMailboxSummaries();

        if (mailboxes.length === 0) {
          // No config -> run guided setup wizard
          const { runWizardSetup } = await import('./wizard.js');
          return await runWizardSetup(opts);
        }

        // Has config -> show status menu wizard
        const { runWizardMenu } = await import('./wizard.js');
        return await runWizardMenu(opts, mailboxes);
      }
      console.error(`Error: Unknown command "${opts.command}". Use --help for usage.`);
      return 2;
  }
}

async function runServe(_opts: CliOptions): Promise<number> {
  try {
    const { runServer } = await import('./server.js');
    await runServer();
    return 0;
  } catch (err) {
    console.error('Error starting MCP server:', err instanceof Error ? err.message : err);
    return 1;
  }
}

/**
 * Read JSON args for `call` from --args, --args-file, or --args-stdin.
 * Returns the parsed object, or `{}` when no source is provided. Throws on
 * source conflict or JSON parse failure (caller maps to exit code 2).
 */
async function readCallArgs(opts: CliOptions): Promise<Record<string, unknown>> {
  const sources = [opts.callArgs !== undefined, opts.callArgsFile !== undefined, opts.callArgsStdin === true]
    .filter(Boolean).length;
  if (sources > 1) {
    throw new Error('Pass at most one of --args, --args-file, --args-stdin');
  }

  let raw: string | undefined;
  if (opts.callArgs !== undefined) {
    raw = opts.callArgs;
  } else if (opts.callArgsFile !== undefined) {
    raw = await readFile(opts.callArgsFile, 'utf-8');
  } else if (opts.callArgsStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON args: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Args must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Format a JSON value for CLI output. Pretty-prints with 2-space indentation
 * when the destination is a TTY (human session); emits compact JSON when piped
 * so downstream tools like `jq` consume it cleanly. Exported for testability.
 */
export function formatJsonForOutput(value: unknown, isTty: boolean): string {
  return isTty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

function printJsonResult(value: unknown): void {
  process.stdout.write(formatJsonForOutput(value, !!process.stdout.isTTY) + '\n');
}

/**
 * Run a single tool invocation as a one-shot CLI command. Eagerly initializes
 * the provider (no demo-mode fallback) so auth failures surface as exit codes
 * rather than masquerading as `connecting` results.
 *
 * Exit codes:
 *   0 — tool ran and returned a non-failure result
 *   2 — CLI/argument/schema/unknown-tool error
 *   3 — tool returned a typed failure ({ success: false, error: ... }) or threw
 */
export async function runCall(opts: CliOptions): Promise<number> {
  const { createLazyProviderState, buildLazyActions, ensureProvider, executeTool, getActionInputJsonSchema } =
    await import('./server.js');
  const { loadSendAllowlist, getSendAllowlistPath, getDeletePolicyFromEnv } = await import('@usejunior/email-core');

  // Match `serve`'s allowlist setup, but DON'T spawn a watcher in a one-shot
  // process — load once and snapshot. (`serve` uses `WatchedAllowlist` for
  // hot-reload; `call` exits before any reload could fire.)
  const sendAllowlistPath = getSendAllowlistPath();
  const snapshot = await loadSendAllowlist(sendAllowlistPath);
  const getSendAllowlist = () => snapshot;

  // Resolve delete policy from env once. getDeletePolicyFromEnv emits its own
  // stderr warnings for misconfigured envs. Status line is printed only when
  // the invoked tool is delete_email — other tools shouldn't see this noise.
  const deletePolicy = getDeletePolicyFromEnv();
  const getDeletePolicy = () => deletePolicy;
  if (opts.callTool === 'delete_email') {
    console.error(
      deletePolicy
        ? `[email-agent-mcp] Delete policy: enabled (hard_delete=${deletePolicy.hardDeleteAllowed})`
        : '[email-agent-mcp] Delete policy: disabled (set AGENT_EMAIL_DELETE_ENABLED=true to enable)',
    );
  }

  const state = createLazyProviderState();
  const actions = await buildLazyActions(state, getSendAllowlist, getDeletePolicy);

  // --list: enumerate tools and exit
  if (opts.callList) {
    const summary = actions.map(a => ({
      name: a.name,
      description: a.description,
      annotations: a.annotations ?? {},
    }));
    printJsonResult(summary);
    return 0;
  }

  if (!opts.callTool) {
    console.error('Error: `call` requires a tool name. Usage: email-agent-mcp call <tool> [--args \'<json>\' | --args-file <path> | --args-stdin]');
    console.error('       email-agent-mcp call --list                # enumerate tools');
    console.error('       email-agent-mcp call <tool> --schema       # print input schema');
    return 2;
  }

  const action = actions.find(a => a.name === opts.callTool);
  if (!action) {
    console.error(`Error: unknown tool "${opts.callTool}". Run \`email-agent-mcp call --list\` to see available tools.`);
    return 2;
  }

  // --schema: print input JSON Schema and exit
  if (opts.callSchema) {
    printJsonResult(getActionInputJsonSchema(action));
    return 0;
  }

  // Read args
  let args: Record<string, unknown>;
  try {
    args = await readCallArgs(opts);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  // The general-purpose `--mailbox` flag (also used by `serve`/`watch`) routes
  // mailbox-sensitive tools to a specific account. If the caller passed it AND
  // didn't already encode it in --args, forward it into the tool input — without
  // this merge, `call delete_email --mailbox personal --args '{...}'` would
  // silently target the default mailbox.
  if (opts.mailbox && args['mailbox'] === undefined) {
    args['mailbox'] = opts.mailbox;
  }

  // `get_mailbox_status` and `list_mailboxes` are diagnostics: they report
  // state (including "nothing connected" / per-mailbox auth failures) as their
  // RESULT rather than requiring a connected provider. Skip the eager-init gate
  // for them so a broken setup can still be diagnosed from the one-shot CLI —
  // gating them behind ensureProvider would make them exit 3 in exactly the
  // misconfigured case they exist to explain.
  const DIAGNOSTIC_TOOLS = new Set(['get_mailbox_status', 'list_mailboxes']);
  if (!DIAGNOSTIC_TOOLS.has(opts.callTool)) {
    // Eagerly initialize the provider — no demo-mode fallback for one-shot CLI.
    // ensureProvider() awaits init internally, so no separate waitForInit() needed.
    try {
      await ensureProvider(state);
    } catch (err) {
      console.error(`Error: provider initialization failed — ${err instanceof Error ? err.message : String(err)}`);
      return 3;
    }
    if (state.status === 'error') {
      console.error(`Error: provider error — ${state.error ?? 'unknown'}`);
      return 3;
    }
  }

  // Execute
  const { z } = await import('zod');
  try {
    const { result } = await executeTool(actions, {}, opts.callTool, args);
    printJsonResult(result);
    // Map typed-failure results to exit code 3 so shell consumers can detect failure
    if (result !== null && typeof result === 'object' && (result as { success?: unknown }).success === false) {
      return 3;
    }
    return 0;
  } catch (err) {
    // ZodError = schema validation failure (CLI/user error); everything else is runtime
    if (err instanceof z.ZodError) {
      console.error(`Error: ${err.message}`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('Unknown tool:')) {
      console.error(`Error: ${message}`);
      return 2;
    }
    console.error(`Error: ${message}`);
    return 3;
  }
}

export async function runWatch(opts: CliOptions): Promise<number> {
  // Load persisted config for defaults
  const config = await loadConfig();

  const wakeUrl = opts.wakeUrl ?? config.wakeUrl ?? 'http://localhost:18789/hooks/wake';
  let pollIntervalSec = opts.pollInterval ?? config.pollIntervalSeconds ?? 10;

  // Poll interval validation
  if (pollIntervalSec < 2) {
    console.error(`[email-agent-mcp] WARNING: --poll-interval ${pollIntervalSec}s is too low, clamping to 2s`);
    pollIntervalSec = 2;
  } else if (pollIntervalSec < 5) {
    console.error(`[email-agent-mcp] WARNING: --poll-interval ${pollIntervalSec}s is aggressive — may cause rate limiting`);
  }

  const pollIntervalMs = pollIntervalSec * 1000;

  console.error(`[email-agent-mcp] Watching mailboxes, wake URL: ${wakeUrl}`);
  console.error(`[email-agent-mcp] Poll interval: ${pollIntervalSec}s`);

  // Dynamic imports to avoid loading heavy dependencies at parse time
  const {
    DelegatedAuthManager,
    RealGraphApiClient,
    GraphEmailProvider,
    listConfiguredMailboxesWithMetadata,
    toFilesystemSafeKey,
    isAuthError,
  } = await import('@usejunior/provider-microsoft');
  const {
    isAllowedSender,
    loadReceiveAllowlist,
    getReceiveAllowlistPath,
    WatchedAllowlist,
  } = await import('@usejunior/email-core');
  const { sendWake, acquireMailboxLease, releaseLock } = await import('./watcher.js');
  const { MailboxRunner, WatchShutdown } = await import('./watcher-runner.js');
  const receiveWatcher = new WatchedAllowlist(getReceiveAllowlistPath(), loadReceiveAllowlist);
  const token = process.env['OPENCLAW_HOOKS_TOKEN'] ?? config.hooksToken;
  const shutdown = new WatchShutdown(code => process.exit(code));
  process.on('SIGINT', shutdown.signal);
  process.on('SIGTERM', shutdown.signal);
  try {
    await receiveWatcher.start();
    if (shutdown.stopping) return 0;
    if (!receiveWatcher.config) {
      console.error('[email-agent-mcp] WARNING: No receive allowlist configured — accepting all senders');
    }
    const allMailboxes = await listConfiguredMailboxesWithMetadata();
    if (shutdown.stopping) return 0;
    if (allMailboxes.length === 0) {
      console.error('[email-agent-mcp] No configured mailboxes found. Run: email-agent-mcp configure');
      return 1;
    }
    const runners = allMailboxes.map(metadata => {
      const emailAddress = metadata.emailAddress ?? metadata.mailboxName;
      const safeKey = metadata.emailAddress ? toFilesystemSafeKey(metadata.emailAddress) : metadata.mailboxName;
      const runner = new MailboxRunner({
        provider: 'microsoft', mailbox: safeKey, receivingEmail: emailAddress, intervalMs: pollIntervalMs,
        acquire: async () => {
          const lease = await acquireMailboxLease(safeKey);
          return lease ? {
            signal: lease.signal, assertHeld: () => lease.assertHeld(), release: () => releaseLock(safeKey),
          } : null;
        },
        setup: async (signal, assertHeld) => {
          const auth = new DelegatedAuthManager(
            { mode: 'delegated', clientId: metadata.clientId }, metadata.mailboxName,
          );
          try {
            assertHeld();
            await auth.reconnect(signal);
            assertHeld();
            const graphClient = new RealGraphApiClient(
              requestSignal => { assertHeld(); return auth.getAccessToken(requestSignal); },
              requestSignal => { assertHeld(); return auth.tryReconnect(requestSignal); },
            );
            const provider = new GraphEmailProvider(graphClient);
            return {
              prepare: async (requestSignal) => {
                assertHeld();
                if (!auth.isTokenExpiringSoon) return;
                console.error(`[email-agent-mcp] Token expiring soon for ${emailAddress}, refreshing...`);
                if (!await auth.tryReconnect(requestSignal)) {
                  throw new Error(`WARNING: Proactive refresh failed for ${emailAddress}. Run: email-agent-mcp configure`);
                }
              },
              getNewMessages: (since, end, requestSignal) => provider.getNewMessages(since, end, requestSignal),
              recover: async (error, requestSignal) => {
                if (!isAuthError(error)) return;
                assertHeld();
                console.error(`[email-agent-mcp] Token error for ${emailAddress}, attempting reconnect...`);
                const recovered = await auth.tryReconnect(requestSignal);
                console.error(recovered
                  ? `[email-agent-mcp] Reconnect succeeded for ${emailAddress}`
                  : `[email-agent-mcp] WARNING: Reconnect failed for ${emailAddress}. Run: email-agent-mcp configure`);
              },
              close: () => auth.disconnect(),
            };
          } catch (error) {
            await auth.disconnect();
            throw error;
          }
        },
        allowed: message => isAllowedSender(message.from?.email ?? '', receiveWatcher.config),
        wake: (payload, signal) => sendWake(wakeUrl, payload, token, signal),
        onError: error => console.error(
          `[email-agent-mcp] Watcher ${emailAddress}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      });
      shutdown.add(runner);
      return runner;
    });
    const results = await Promise.all(runners.map(runner => runner.start()));
    return shutdown.stopping || results.some(result => result.kind === 'stopped') ? 0 : 1;
  } finally {
    // All setup/poll/wake/checkpoint work has settled before shared cleanup.
    receiveWatcher.close();
    shutdown.dispose();
    process.removeListener('SIGINT', shutdown.signal);
    process.removeListener('SIGTERM', shutdown.signal);
  }
}

type GmailAuthSetup =
  | { mode: 'byok'; clientId: string; clientSecret: string; source: 'explicit' | 'saved' }
  | { mode: 'broker'; brokerUrl: string; source: 'explicit' | 'saved' | 'default' };

async function resolveGmailAuthSetup(opts: CliOptions): Promise<GmailAuthSetup> {
  // Only honour our namespaced env vars. Fallback to GOOGLE_CLIENT_ID /
  // GOOGLE_CLIENT_SECRET would silently collide with other developer
  // tools (gcloud, oauth2l, etc.) on the same shell.
  const explicitClientId = opts.clientId ?? process.env['AGENT_EMAIL_GMAIL_CLIENT_ID'];
  const explicitClientSecret = opts.clientSecret ?? process.env['AGENT_EMAIL_GMAIL_CLIENT_SECRET'];
  const explicitBroker = opts.brokerUrl ?? process.env['AGENT_EMAIL_GMAIL_BROKER_URL'];

  // 1. Explicit BYOK wins. Forces broker→BYOK migration on re-run.
  if (explicitClientId && explicitClientSecret) {
    return { mode: 'byok', clientId: explicitClientId, clientSecret: explicitClientSecret, source: 'explicit' };
  }
  if (explicitClientId || explicitClientSecret) {
    throw new Error(
      'Gmail BYOK requires BOTH --client-id and --client-secret (or AGENT_EMAIL_GMAIL_CLIENT_ID and AGENT_EMAIL_GMAIL_CLIENT_SECRET). To use the hosted broker instead, omit both.',
    );
  }

  // 2. Explicit broker URL wins over saved.
  if (explicitBroker) {
    return { mode: 'broker', brokerUrl: validateBrokerUrl(explicitBroker), source: 'explicit' };
  }

  // 3. Reuse whatever was previously saved for this mailbox — preserves
  //    #44 reconnect behaviour and lets returning BYOK users skip the
  //    broker path silently.
  const mailboxIdentifier = opts.mailbox ?? 'default';
  const { loadGmailMailboxMetadata } = await import('@usejunior/provider-gmail');
  const saved = await loadGmailMailboxMetadata(mailboxIdentifier);
  if (saved?.source === 'byok') {
    return { mode: 'byok', clientId: saved.clientId, clientSecret: saved.clientSecret, source: 'saved' };
  }
  if (saved?.source === 'broker') {
    return { mode: 'broker', brokerUrl: validateBrokerUrl(saved.brokerUrl), source: 'saved' };
  }

  // 4. New mailbox, no creds → broker default.
  return { mode: 'broker', brokerUrl: '', source: 'default' };
}

function validateBrokerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid broker URL: ${url}`);
  }
  // Allow https:// for production and http:// only for loopback so
  // `vercel dev` and self-hosted localhost setups work.
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback)) {
    return parsed.origin + parsed.pathname.replace(/\/$/, '');
  }
  throw new Error(
    `Broker URL must be https:// (or http:// on loopback for local dev). Got: ${url}`,
  );
}

async function runGmailConfigure(opts: CliOptions): Promise<number> {
  const mailboxName = opts.mailbox ?? 'default';
  const setup = await resolveGmailAuthSetup(opts);

  const provider = await import('@usejunior/provider-gmail');
  const {
    GmailAuthManager,
    saveGmailMailboxMetadata,
    toFilesystemSafeKey,
    DEFAULT_GMAIL_BROKER_URL,
  } = provider;

  console.error(`[email-agent-mcp] Configuring mailbox "${mailboxName}" with Gmail`);

  if (setup.mode === 'broker') {
    const brokerUrl = validateBrokerUrl(setup.brokerUrl || DEFAULT_GMAIL_BROKER_URL);
    console.error(`[email-agent-mcp] Using OAuth broker: ${brokerUrl}`);
    console.error('[email-agent-mcp] The broker holds the OAuth client_secret server-side; this CLI never sees it.');
    console.error('[email-agent-mcp] To bring your own OAuth client instead, pass --client-id and --client-secret.');
    console.error('');
    return await runGmailBrokerConfigure({
      mailboxName,
      brokerUrl,
      provider,
    });
  }

  console.error(`[email-agent-mcp] OAuth client ID: ${setup.clientId}`);
  console.error('');

  const auth = new GmailAuthManager({
    clientId: setup.clientId,
    clientSecret: setup.clientSecret,
    mailboxName,
  });
  const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
  const state = randomUUID();
  const listener = await startLoopbackOAuthListener(state);
  const { redirectUri, waitForCallback } = listener;
  try {
  const authUrl = auth.generateAuthUrl({
    scopes: provider.GMAIL_OAUTH_SCOPES,
    redirectUri,
    state,
    codeChallenge,
    loginHint: mailboxName.includes('@') ? mailboxName : undefined,
  });

  console.error('[email-agent-mcp] Open this URL in your browser to authorize Gmail access:');
  console.error(`  ${authUrl}`);
  console.error(`[email-agent-mcp] Waiting for Google OAuth callback on ${redirectUri}`);

  const callback = await waitForCallback;
  if (callback.state !== state) {
    throw new Error('Google OAuth state mismatch');
  }

  await auth.exchangeCode(callback.code, { codeVerifier, redirectUri });

  const refreshToken = auth.getRefreshToken();
  if (!refreshToken) {
    throw new Error(
      'Google OAuth did not return a refresh token. Re-run configure after revoking the prior grant or forcing consent.',
    );
  }

  const profile = await auth.fetchProfile();
  const emailAddress = profile.emailAddress;
  if (!emailAddress) {
    throw new Error('Gmail profile did not include an email address');
  }

  await ensureGmailProfileMatchesIntent(mailboxName, emailAddress);

  const lastInteractiveAuthAt = new Date().toISOString();
  await saveGmailMailboxMetadata({
    provider: 'gmail',
    source: 'byok',
    mailboxName,
    emailAddress,
    clientId: setup.clientId,
    clientSecret: setup.clientSecret,
    refreshToken,
    lastInteractiveAuthAt,
  });

  await finalizeGmailMailbox(emailAddress, toFilesystemSafeKey);
  return 0;
  } finally {
    listener.cancel();
  }
}

async function runGmailBrokerConfigure(args: {
  mailboxName: string;
  brokerUrl: string;
  provider: typeof import('@usejunior/provider-gmail');
}): Promise<number> {
  const { mailboxName, brokerUrl, provider } = args;
  const { GmailAuthManager, saveGmailMailboxMetadata, toFilesystemSafeKey } = provider;

  const auth = new GmailAuthManager({
    brokerUrl,
    mailboxName,
  });

  const session = await auth.startBrokerSession({
    loginHint: mailboxName.includes('@') ? mailboxName : undefined,
  });

  console.error('[email-agent-mcp] Open this URL in your browser to authorize Gmail access:');
  console.error(`  ${session.authorizationUrl}`);
  console.error('[email-agent-mcp] You are authorizing the OAuth client operated by the broker above.');
  console.error('[email-agent-mcp] Future token refreshes will go through that broker.');
  console.error('');

  await auth.pickUpTicket({
    sessionId: session.sessionId,
    pickupSecret: session.pickupSecret,
  });

  const refreshToken = auth.getRefreshToken();
  if (!refreshToken) {
    throw new Error(
      'Broker did not return a refresh token. Ensure the OAuth client requests offline access, then retry.',
    );
  }

  const profile = await auth.fetchProfile();
  const emailAddress = profile.emailAddress;
  if (!emailAddress) {
    throw new Error('Gmail profile did not include an email address');
  }

  await ensureGmailProfileMatchesIntent(mailboxName, emailAddress);

  await saveGmailMailboxMetadata({
    provider: 'gmail',
    source: 'broker',
    mailboxName,
    emailAddress,
    brokerUrl,
    refreshToken,
    lastInteractiveAuthAt: new Date().toISOString(),
  });

  await finalizeGmailMailbox(emailAddress, toFilesystemSafeKey);
  return 0;
}

async function finalizeGmailMailbox(
  emailAddress: string,
  toFilesystemSafeKey: (email: string) => string,
): Promise<void> {
  try {
    await addEmailToSendAllowlist(emailAddress);
    console.error(`[email-agent-mcp] Send allowlist: ${emailAddress} (outbound email enabled to this address)`);
  } catch (allowlistErr) {
    console.error(`[email-agent-mcp] WARNING: Could not update send allowlist: ${allowlistErr instanceof Error ? allowlistErr.message : allowlistErr}`);
  }

  const safeKey = toFilesystemSafeKey(emailAddress);

  console.error('');
  console.error(`✅ Connected as: ${emailAddress}`);
  console.error(`   Mailbox saved to ~/.email-agent-mcp/tokens/${safeKey}.json`);
}

export function inferProviderFromMailbox(
  mailbox: string | undefined,
): 'gmail' | 'microsoft' | undefined {
  if (!mailbox) return undefined;
  const normalized = normalizeMailboxValue(mailbox);
  if (!normalized.includes('@')) return undefined;
  const domain = normalized.split('@').pop();
  if (!domain) return undefined;

  const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
  const MICROSOFT_CONSUMER_DOMAINS = new Set([
    'outlook.com',
    'hotmail.com',
    'live.com',
    'msn.com',
  ]);

  if (GMAIL_DOMAINS.has(domain)) return 'gmail';
  if (MICROSOFT_CONSUMER_DOMAINS.has(domain)) return 'microsoft';
  return undefined;
}

export async function runConfigure(opts: CliOptions): Promise<number> {
  if (opts.nemoclaw) {
    console.error('[email-agent-mcp] NemoClaw bootstrap — adding egress domains:');
    for (const domain of NEMOCLAW_EGRESS_DOMAINS) {
      console.error(`  ✓ ${domain}`);
    }
    return 0;
  }

  const mailboxName = opts.mailbox ?? 'default';
  const inferredProvider = opts.provider ? undefined : inferProviderFromMailbox(opts.mailbox);
  const provider = opts.provider ?? inferredProvider ?? 'microsoft';

  if (inferredProvider && !opts.provider) {
    const domain = normalizeMailboxValue(opts.mailbox ?? '').split('@').pop();
    console.error(
      `[email-agent-mcp] Inferred provider "${inferredProvider}" from mailbox domain "${domain}". Pass --provider to override.`,
    );
  }

  if (provider === 'gmail') {
    try {
      return await runGmailConfigure(opts);
    } catch (err) {
      console.error(`\n❌ Configuration failed: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  if (provider !== 'microsoft') {
    console.error(`[email-agent-mcp] Provider "${provider}" not yet supported for configure. Use --provider microsoft or --provider gmail`);
    return 1;
  }

  // Get client ID from flag, env var, or use Junior local app default
  const clientId = opts.clientId
    ?? process.env['AGENT_EMAIL_CLIENT_ID']
    ?? 'c4f91d3e-d2d9-4f8b-826f-6a3c19280241'; // Junior local app

  console.error(`[email-agent-mcp] Configuring mailbox "${mailboxName}" with Microsoft Graph`);
  console.error(`[email-agent-mcp] Client ID: ${clientId}`);
  console.error('');

  try {
    const { DelegatedAuthManager, toFilesystemSafeKey } = await import('@usejunior/provider-microsoft');
    const auth = new DelegatedAuthManager(
      { mode: 'delegated', clientId },
      mailboxName,
    );

    // This triggers device code flow — user sees URL + code on stderr
    await auth.connect({});

    // Test connection by getting user profile and extract email address
    const token = await auth.getAccessToken();
    const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const profile = await resp.json() as { displayName?: string; mail?: string; userPrincipalName?: string };
      const emailAddress = profile.mail ?? profile.userPrincipalName;

      if (emailAddress) {
        // Set email on the auth manager and re-save metadata with email-based filename
        auth.setEmailAddress(emailAddress);
        await auth.saveMetadata();
        const safeKey = toFilesystemSafeKey(emailAddress);

        // Clean up ALL files that have the same emailAddress but a different filename
        // This handles: work.json -> test-user-at-example-com.json migration
        // and any other stale alias files
        {
          const { unlink, readdir, readFile: readFileAsync } = await import('node:fs/promises');
          const agentHome = getAgentEmailHome();
          const tokensDir = join(agentHome, 'tokens');
          const newFilename = `${safeKey}.json`;

          try {
            const allFiles = await readdir(tokensDir);
            for (const file of allFiles) {
              if (!file.endsWith('.json') || file === newFilename) continue;
              try {
                const content = await readFileAsync(join(tokensDir, file), 'utf-8');
                const meta = JSON.parse(content) as { emailAddress?: string };
                if (meta.emailAddress && meta.emailAddress.toLowerCase() === emailAddress.toLowerCase()) {
                  console.error(`[email-agent-mcp] Removing superseded token file: ${file}`);
                  await unlink(join(tokensDir, file));
                }
              } catch {
                // Skip unreadable files
              }
            }
          } catch {
            // tokens dir may not exist yet — that's fine
          }

          // Auto-add the authenticated email to the send allowlist
          try {
            await addEmailToSendAllowlist(emailAddress);
            console.error(`[email-agent-mcp] Send allowlist: ${emailAddress} (outbound email enabled to this address)`);
          } catch (allowlistErr) {
            console.error(`[email-agent-mcp] WARNING: Could not update send allowlist: ${allowlistErr instanceof Error ? allowlistErr.message : allowlistErr}`);
          }
        }

        console.error('');
        console.error(`✅ Connected as: ${profile.displayName ?? 'Unknown'} (${emailAddress})`);
        console.error(`   Mailbox saved to ~/.email-agent-mcp/tokens/${safeKey}.json`);
      } else {
        console.error('');
        console.error(`✅ Connected as: ${profile.displayName ?? 'Unknown'} (no email found)`);
        console.error(`   Mailbox "${mailboxName}" saved to ~/.email-agent-mcp/tokens/${mailboxName}.json`);
      }
    } else {
      console.error('');
      console.error(`⚠️  Authentication succeeded but profile fetch failed (${resp.status})`);
      console.error('   The mailbox is configured but may have limited permissions.');
    }

    return 0;
  } catch (err) {
    console.error(`\n❌ Configuration failed: ${err instanceof Error ? err.message : err}`);
    return 1;
  }
}

/**
 * Show detailed status of all configured mailboxes.
 */
export async function runStatus(): Promise<number> {
  const mailboxes = await listConfiguredMailboxSummaries();

  console.error('');
  console.error('  \uD83E\uDD9E email-agent-mcp status');
  console.error('');

  if (mailboxes.length === 0) {
    console.error('  No mailboxes configured. Run: email-agent-mcp setup');
    return 0;
  }

  for (const mb of mailboxes) {
    const name = mb.emailAddress ?? mb.mailboxName;
    const lastAuth = mb.lastInteractiveAuthAt
      ? new Date(mb.lastInteractiveAuthAt).toLocaleString()
      : 'unknown';
    const daysSinceAuth = mb.lastInteractiveAuthAt
      ? Math.round((Date.now() - new Date(mb.lastInteractiveAuthAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    console.error(`  Account: ${name}`);
    console.error(`    Provider: ${mb.provider}`);
    console.error(`    Last authenticated: ${lastAuth}`);
    if (daysSinceAuth !== null) {
      if (daysSinceAuth > 80) {
        console.error(`    \u26A0\uFE0F  Token may expire soon (${daysSinceAuth} days old)`);
      } else {
        console.error(`    Token age: ${daysSinceAuth} days (healthy)`);
      }
    }

    const gmailWarning = await getGmailReauthWarning(mb);
    if (gmailWarning) {
      console.error(`    \u26A0\uFE0F  ${gmailWarning}`);
    }

    console.error('');
  }

  // Send allowlist
  try {
    const { readFile } = await import('node:fs/promises');
    const allowlistPath = join(getAgentEmailHome(), 'send-allowlist.json');
    const raw = await readFile(allowlistPath, 'utf-8');
    const data = JSON.parse(raw) as { entries?: string[] };
    if (data.entries && data.entries.length > 0) {
      console.error('  Send allowlist:');
      for (const entry of data.entries) {
        console.error(`    \u2022 ${entry}`);
      }
    } else {
      console.error('  Send allowlist: empty');
    }
  } catch {
    console.error('  Send allowlist: not configured');
  }
  console.error('');

  return 0;
}

async function runToken(opts: CliOptions): Promise<number> {
  const {
    DelegatedAuthManager,
    listConfiguredMailboxesWithMetadata,
    loadMailboxMetadata,
  } = await import('@usejunior/provider-microsoft');

  let metadata;

  if (opts.mailbox) {
    metadata = await loadMailboxMetadata(opts.mailbox);
    if (!metadata) {
      process.stderr.write(`Error: mailbox "${opts.mailbox}" not found.\n`);
      return 2;
    }
  } else {
    const mailboxes = await listConfiguredMailboxesWithMetadata();
    if (mailboxes.length === 0) {
      process.stderr.write('Error: no mailboxes configured. Run: npx email-agent-mcp configure\n');
      return 1;
    }
    if (mailboxes.length > 1) {
      process.stderr.write('Error: multiple mailboxes configured. Use --mailbox to select:\n');
      for (const m of mailboxes) {
        process.stderr.write(`  ${m.emailAddress ?? m.mailboxName}\n`);
      }
      return 2;
    }
    metadata = mailboxes[0]!;
  }

  const auth = new DelegatedAuthManager(
    { mode: 'delegated', clientId: metadata.clientId },
    metadata.mailboxName,
  );

  try {
    await auth.reconnect();
    const token = await auth.getAccessToken();

    // Await stdout flush so short-lived invocations can exit naturally only
    // after the token has fully reached stdout.
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(token, (err) => err ? reject(err) : resolve());
    });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('interaction_required') || msg.includes('invalid_grant')) {
      process.stderr.write('Error: authentication expired. Run: npx email-agent-mcp configure\n');
    } else {
      process.stderr.write(`Error: ${msg}\n`);
    }
    return 1;
  }
}

function printHelp(): void {
  console.error(`
email-agent-mcp — Email connectivity for AI agents

USAGE:
  email-agent-mcp [command] [options]

COMMANDS:
  email-agent-mcp              Set up (first run) or show status (TTY)
                           Start MCP server (non-TTY / when spawned by host)
  email-agent-mcp watch        Start email watcher (long-running)
  email-agent-mcp setup        Configure a mailbox (interactive)
  email-agent-mcp configure    Configure a mailbox (interactive, alias for setup)
  email-agent-mcp status       Show account + connection health
  email-agent-mcp token        Print a Graph API bearer token to stdout
  email-agent-mcp serve        Force MCP server mode
  email-agent-mcp call <tool>  Invoke a single MCP tool one-shot (no long-lived server)
                              See \`call\` examples below
  email-agent-mcp help         Show this help

OPTIONS:
  --version              Print version
  --help, -h             Show this help
  --wake-url <url>       Wake URL for watch mode
  --poll-interval <sec>  Poll interval in seconds (default 10, min 2)
  --nemoclaw             NemoClaw egress bootstrap
  --log-level <level>    Log level (debug, info, warn, error)
  --mailbox <name>       Mailbox alias or email address (required if multiple configured)
  --provider <name>      Auth provider (microsoft, gmail)
  --client-id <id>       OAuth client ID override
  --client-secret <val>  OAuth client secret override (used for Gmail configure)

CALL OPTIONS (used with \`call <tool>\`):
  --args '<json>'        Inline JSON args for the tool
  --args-file <path>     Read JSON args from a file
  --args-stdin           Read JSON args from stdin
  --list                 (with \`call\`) List available tools and exit
  --schema               Print the input JSON Schema for the named tool

CALL EXAMPLES:
  email-agent-mcp call --list
  email-agent-mcp call list_emails --schema
  email-agent-mcp call list_emails --args '{"limit":5,"unread":true}'
  echo '{"limit":5}' | email-agent-mcp call list_emails --args-stdin
  email-agent-mcp call list_emails --args '{"limit":5}' | jq '.emails[].subject'

CALL EXIT CODES:
  0  Tool ran and returned a non-failure result
  2  CLI / argument / unknown-tool / schema-validation error
  3  Tool returned a typed failure ({success:false,...}) or threw at runtime
`.trim());
}

export function getNemoClawEgressDomains(): string[] {
  return [...NEMOCLAW_EGRESS_DOMAINS];
}

/**
 * Direct entrypoint adapter used by `node dist/cli.js ...`.
 *
 * Important: successful runs must not force `process.exit()`. `serve` resolves
 * once stdio transport is connected, but the MCP process must stay alive for
 * the client handshake and subsequent tool calls.
 */
export async function runCliDirect(args: string[]): Promise<void> {
  try {
    const code = await runCli(args);
    process.exitCode = code;
  } catch (err) {
    console.error('Fatal:', err);
    process.exit(1);
  }
}

export function isDirectCliRun(argv1: string | undefined, moduleUrl: string = import.meta.url): boolean {
  if (!argv1) return false;

  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Auto-execute when run directly (including npm bin symlinks and shims)
const isDirectRun = isDirectCliRun(process.argv[1]);
if (isDirectRun) {
  void runCliDirect(process.argv.slice(2));
}
