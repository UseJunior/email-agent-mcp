#!/usr/bin/env node
// CLI entry point — serve, watch, configure, setup subcommands + TTY-aware default

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

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
  pollInterval?: number; // seconds
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
    if (arg === '--poll-interval' && i + 1 < args.length) {
      opts.pollInterval = parseInt(args[++i]!, 10);
      continue;
    }

    // First positional arg is the command
    if (!opts.command && !arg.startsWith('-')) {
      opts.command = arg;
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
    case 'configure':
      return await runConfigure(opts);
    case 'status':
      return await runStatus();
    case 'token':
      return await runToken(opts);
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
        const { listConfiguredMailboxesWithMetadata } = await import('@usejunior/provider-microsoft');
        const mailboxes = await listConfiguredMailboxesWithMetadata();

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
  const {
    buildWakePayload,
    sendWake,
    isProcessed,
    markProcessed,
    loadDeltaState,
    saveDeltaState,
    acquireLock,
    releaseLock,
    releaseAllLocks,
  } = await import('./watcher.js');

  // Load receive allowlist with hot-reload
  const allowlistPath = getReceiveAllowlistPath();
  const receiveWatcher = new WatchedAllowlist(allowlistPath, loadReceiveAllowlist);
  await receiveWatcher.start();
  if (!receiveWatcher.config) {
    console.error('[email-agent-mcp] WARNING: No receive allowlist configured — accepting all senders');
  }

  // Get wake token: env var > config > undefined
  const token = process.env['OPENCLAW_HOOKS_TOKEN'] ?? config.hooksToken;

  // Load all configured mailboxes
  const allMailboxes = await listConfiguredMailboxesWithMetadata();
  if (allMailboxes.length === 0) {
    console.error('[email-agent-mcp] No configured mailboxes found. Run: email-agent-mcp configure');
    return 1;
  }

  console.error(`[email-agent-mcp] Found ${allMailboxes.length} configured mailbox(es)`);

  // Track which mailboxes we successfully set up for cleanup
  interface MailboxWatchState {
    safeKey: string;
    emailAddress: string;
    provider: InstanceType<typeof GraphEmailProvider>;
    lastCheckedAt: string;
    auth: InstanceType<typeof DelegatedAuthManager>;
  }

  const watchStates: MailboxWatchState[] = [];
  let shuttingDown = false;

  // Graceful shutdown handler
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('\n[email-agent-mcp] Shutting down watcher...');
    receiveWatcher.close();
    await releaseAllLocks();
    console.error('[email-agent-mcp] Lock files cleaned up. Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  // Set up each mailbox
  for (const metadata of allMailboxes) {
    const emailAddress = metadata.emailAddress ?? metadata.mailboxName;
    const safeKey = metadata.emailAddress
      ? toFilesystemSafeKey(metadata.emailAddress)
      : metadata.mailboxName;

    console.error(`[email-agent-mcp] Setting up mailbox: ${emailAddress} (key: ${safeKey})`);

    // Acquire lock
    const gotLock = await acquireLock(safeKey);
    if (!gotLock) {
      console.error(`[email-agent-mcp] ERROR: Mailbox ${emailAddress} is already being watched by another process. Skipping.`);
      continue;
    }

    try {
      // Create auth manager and reconnect
      const auth = new DelegatedAuthManager(
        { mode: 'delegated', clientId: metadata.clientId },
        metadata.mailboxName,
      );
      await auth.reconnect();

      // Create Graph client and provider (with auth-aware retry on 401)
      const graphClient = new RealGraphApiClient(() => auth.getAccessToken(), () => auth.tryReconnect());
      const provider = new GraphEmailProvider(graphClient);

      // Load last checked timestamp or start from now
      const savedState = await loadDeltaState(safeKey);
      let lastCheckedAt: string;

      if (savedState) {
        lastCheckedAt = savedState.lastUpdated;
        console.error(`[email-agent-mcp] Resuming watch for ${emailAddress} (last checked: ${lastCheckedAt})`);
      } else {
        // First run: start from NOW — no historical sync needed
        lastCheckedAt = new Date().toISOString();
        await saveDeltaState(safeKey, { deltaLink: '', lastUpdated: lastCheckedAt });
        console.error(`[email-agent-mcp] Watching ${emailAddress} for new emails starting now`);
      }

      watchStates.push({ safeKey, emailAddress, provider, lastCheckedAt, auth });
    } catch (err) {
      console.error(`[email-agent-mcp] WARNING: Failed to set up ${emailAddress}: ${err instanceof Error ? err.message : err}`);
      await releaseLock(safeKey);
      continue;
    }
  }

  if (watchStates.length === 0) {
    console.error('[email-agent-mcp] No mailboxes could be set up for watching.');
    await releaseAllLocks();
    return 1;
  }

  console.error(`[email-agent-mcp] Watching ${watchStates.length} mailbox(es). Starting poll loop...`);

  // Poll loop — uses simple timestamp filtering instead of Delta Query.
  // Delta Query requires paging through the ENTIRE inbox on first use (even with $deltatoken=latest).
  // Timestamp-based polling is instant: only fetch emails received after lastCheckedAt.
  const poll = async () => {
    for (const state of watchStates) {
      if (shuttingDown) break;

      const now = new Date().toISOString();
      console.error(`[email-agent-mcp] [${now}] Polling ${state.emailAddress} (since ${state.lastCheckedAt})...`);

      // Proactive token refresh if expiring soon
      if (state.auth.isTokenExpiringSoon) {
        console.error(`[email-agent-mcp] Token expiring soon for ${state.emailAddress}, refreshing...`);
        const ok = await state.auth.tryReconnect();
        if (!ok) {
          console.error(`[email-agent-mcp] WARNING: Proactive refresh failed for ${state.emailAddress}. Run: email-agent-mcp configure`);
          continue;
        }
      }

      try {
        const newMessages = await state.provider.getNewMessages(state.lastCheckedAt);

        let wakeCount = 0;
        let skippedDedup = 0;
        let skippedAllowlist = 0;
        let wakeFailed = false;

        for (const msg of newMessages) {
          // Dedup
          if (isProcessed(msg.id)) {
            skippedDedup++;
            continue;
          }

          // Receive allowlist check
          const senderEmail = msg.from?.email ?? '';
          if (!isAllowedSender(senderEmail, receiveWatcher.config)) {
            skippedAllowlist++;
            markProcessed(msg.id);
            console.error(`[email-agent-mcp] Skipping email from ${senderEmail} (not on receive allowlist)`);
            continue;
          }

          // Build and send wake
          const payload = buildWakePayload(state.emailAddress, msg);
          console.error(`[email-agent-mcp] WAKE: ${payload.text.split('\n')[0]}`);

          const result = await sendWake(wakeUrl, payload, token);
          if (result.success) {
            markProcessed(msg.id);
            wakeCount++;
          } else {
            console.error(`[email-agent-mcp] WARNING: Wake POST failed for ${msg.id}: ${result.error} — will retry next poll`);
            wakeFailed = true;
          }
        }

        // Only advance timestamp if all wakes succeeded
        if (!wakeFailed) {
          state.lastCheckedAt = now;
          await saveDeltaState(state.safeKey, {
            deltaLink: '', // Not using delta anymore — kept for interface compat
            lastUpdated: now,
          });
        }

        if (newMessages.length > 0) {
          console.error(
            `[email-agent-mcp] Poll: ${newMessages.length} new, ${wakeCount} wakes, ` +
            `${skippedDedup} dedup, ${skippedAllowlist} allowlist-blocked`,
          );
        }
      } catch (err) {
        if (isAuthError(err)) {
          console.error(`[email-agent-mcp] Token error for ${state.emailAddress}, attempting reconnect...`);
          const ok = await state.auth.tryReconnect();
          if (ok) {
            console.error(`[email-agent-mcp] Reconnect succeeded for ${state.emailAddress}`);
          } else {
            console.error(`[email-agent-mcp] WARNING: Reconnect failed for ${state.emailAddress}. Run: email-agent-mcp configure`);
          }
          continue;
        }
        console.error(`[email-agent-mcp] WARNING: Poll error for ${state.emailAddress}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  // Recursive poll loop — schedules next poll only after the current one completes,
  // preventing overlapping polls that can cause duplicate wakes and state corruption.
  async function pollLoop() {
    await poll();
    if (!shuttingDown) {
      setTimeout(() => { void pollLoop(); }, pollIntervalMs);
    }
  }

  // Start the poll loop
  void pollLoop();

  // Keep the process alive — wait for shutdown signal
  return new Promise<number>((resolve) => {
    const checkShutdown = () => {
      if (shuttingDown) {
        resolve(0);
      } else {
        setTimeout(checkShutdown, 500);
      }
    };
    checkShutdown();
  });
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
  const provider = opts.provider ?? 'microsoft';

  if (provider !== 'microsoft') {
    console.error(`[email-agent-mcp] Provider "${provider}" not yet supported for configure. Use --provider microsoft`);
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
          const { unlink, readdir, readFile: readFileAsync, writeFile: writeFileAsync, mkdir } = await import('node:fs/promises');
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
          const allowlistPath = join(agentHome, 'send-allowlist.json');
          try {
            // Ensure directory exists
            await mkdir(agentHome, { recursive: true });

            // Read existing allowlist or start empty
            let entries: string[] = [];
            try {
              const raw = await readFileAsync(allowlistPath, 'utf-8');
              const data = JSON.parse(raw) as { entries?: string[] };
              entries = data.entries ?? [];
            } catch {
              // File doesn't exist yet — start fresh
            }

            // Dedupe-add (case-insensitive)
            const lowerEmail = emailAddress.toLowerCase();
            if (!entries.some(e => e.toLowerCase() === lowerEmail)) {
              entries.push(emailAddress);
            }

            // Write back pretty-printed
            await writeFileAsync(allowlistPath, JSON.stringify({ entries }, null, 2) + '\n', 'utf-8');
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
      console.error('');
      console.error('To start the MCP server, run:');
      console.error('   npx tsx packages/email-mcp/src/cli.ts serve   # from source');
      console.error('   npx email-agent-mcp serve             # after npm publish');
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
  const { listConfiguredMailboxesWithMetadata } = await import('@usejunior/provider-microsoft');
  const mailboxes = await listConfiguredMailboxesWithMetadata();

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
    console.error(`    Last authenticated: ${lastAuth}`);
    if (daysSinceAuth !== null) {
      if (daysSinceAuth > 80) {
        console.error(`    \u26A0\uFE0F  Token may expire soon (${daysSinceAuth} days old)`);
      } else {
        console.error(`    Token age: ${daysSinceAuth} days (healthy)`);
      }
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

    // Await stdout flush — the CLI wrapper calls process.exit() after runCli()
    // resolves, which can truncate piped output if the write hasn't drained.
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
`.trim());
}

export function getNemoClawEgressDomains(): string[] {
  return [...NEMOCLAW_EGRESS_DOMAINS];
}

// Auto-execute when run directly (not imported as a module in tests)
const isDirectRun = process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js');
if (isDirectRun) {
  runCli(process.argv.slice(2)).then(code => {
    process.exit(code);
  }).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
