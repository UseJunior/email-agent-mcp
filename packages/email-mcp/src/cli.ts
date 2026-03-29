// CLI entry point — serve, watch, configure, setup subcommands + TTY-aware default

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

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
 * Resolve the agent-email home directory.
 * Respects AGENT_EMAIL_HOME env var for test isolation.
 */
export function getAgentEmailHome(): string {
  return process.env['AGENT_EMAIL_HOME'] ?? join(homedir(), '.agent-email');
}

export interface AgentEmailConfig {
  wakeUrl?: string;
  hooksToken?: string;
  pollIntervalSeconds?: number;
}

/**
 * Get the config file path: ~/.agent-email/config.json
 */
function getConfigPath(): string {
  return join(getAgentEmailHome(), 'config.json');
}

/**
 * Load persisted config from ~/.agent-email/config.json.
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
 * Save config to ~/.agent-email/config.json.
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
 * Prompt user for a single line of input via readline (stderr for prompt, stdin for input).
 */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Run the CLI with the given arguments.
 * Returns exit code.
 */
export async function runCli(args: string[]): Promise<number> {
  const opts = parseCliArgs(args);

  if (opts.version) {
    console.error('agent-email 0.1.0');
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
    console.error(`[agent-email] WARNING: --poll-interval ${pollIntervalSec}s is too low, clamping to 2s`);
    pollIntervalSec = 2;
  } else if (pollIntervalSec < 5) {
    console.error(`[agent-email] WARNING: --poll-interval ${pollIntervalSec}s is aggressive — may cause rate limiting`);
  }

  const pollIntervalMs = pollIntervalSec * 1000;

  console.error(`[agent-email] Watching mailboxes, wake URL: ${wakeUrl}`);
  console.error(`[agent-email] Poll interval: ${pollIntervalSec}s`);

  // Dynamic imports to avoid loading heavy dependencies at parse time
  const {
    DelegatedAuthManager,
    RealGraphApiClient,
    GraphEmailProvider,
    listConfiguredMailboxesWithMetadata,
    toFilesystemSafeKey,
  } = await import('@usejunior/provider-microsoft');
  const {
    isAllowedSender,
    loadReceiveAllowlist,
    getReceiveAllowlistPath,
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

  // Load receive allowlist
  const allowlistPath = getReceiveAllowlistPath();
  const allowlist = await loadReceiveAllowlist(allowlistPath);
  if (!allowlist) {
    console.error('[agent-email] WARNING: No receive allowlist configured — accepting all senders');
  }

  // Get wake token: env var > config > undefined
  const token = process.env['OPENCLAW_HOOKS_TOKEN'] ?? config.hooksToken;

  // Load all configured mailboxes
  const allMailboxes = await listConfiguredMailboxesWithMetadata();
  if (allMailboxes.length === 0) {
    console.error('[agent-email] No configured mailboxes found. Run: agent-email configure');
    return 1;
  }

  console.error(`[agent-email] Found ${allMailboxes.length} configured mailbox(es)`);

  // Track which mailboxes we successfully set up for cleanup
  interface MailboxWatchState {
    safeKey: string;
    emailAddress: string;
    provider: InstanceType<typeof GraphEmailProvider>;
    lastCheckedAt: string;
  }

  const watchStates: MailboxWatchState[] = [];
  let shuttingDown = false;

  // Graceful shutdown handler
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error('\n[agent-email] Shutting down watcher...');
    await releaseAllLocks();
    console.error('[agent-email] Lock files cleaned up. Goodbye.');
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

    console.error(`[agent-email] Setting up mailbox: ${emailAddress} (key: ${safeKey})`);

    // Acquire lock
    const gotLock = await acquireLock(safeKey);
    if (!gotLock) {
      console.error(`[agent-email] ERROR: Mailbox ${emailAddress} is already being watched by another process. Skipping.`);
      continue;
    }

    try {
      // Create auth manager and reconnect
      const auth = new DelegatedAuthManager(
        { mode: 'delegated', clientId: metadata.clientId },
        metadata.mailboxName,
      );
      await auth.reconnect();

      // Create Graph client and provider
      const graphClient = new RealGraphApiClient(() => auth.getAccessToken());
      const provider = new GraphEmailProvider(graphClient);

      // Load last checked timestamp or start from now
      const savedState = await loadDeltaState(safeKey);
      let lastCheckedAt: string;

      if (savedState) {
        lastCheckedAt = savedState.lastUpdated;
        console.error(`[agent-email] Resuming watch for ${emailAddress} (last checked: ${lastCheckedAt})`);
      } else {
        // First run: start from NOW — no historical sync needed
        lastCheckedAt = new Date().toISOString();
        await saveDeltaState(safeKey, { deltaLink: '', lastUpdated: lastCheckedAt });
        console.error(`[agent-email] Watching ${emailAddress} for new emails starting now`);
      }

      watchStates.push({ safeKey, emailAddress, provider, lastCheckedAt });
    } catch (err) {
      console.error(`[agent-email] WARNING: Failed to set up ${emailAddress}: ${err instanceof Error ? err.message : err}`);
      await releaseLock(safeKey);
      continue;
    }
  }

  if (watchStates.length === 0) {
    console.error('[agent-email] No mailboxes could be set up for watching.');
    await releaseAllLocks();
    return 1;
  }

  console.error(`[agent-email] Watching ${watchStates.length} mailbox(es). Starting poll loop...`);

  // Poll loop — uses simple timestamp filtering instead of Delta Query.
  // Delta Query requires paging through the ENTIRE inbox on first use (even with $deltatoken=latest).
  // Timestamp-based polling is instant: only fetch emails received after lastCheckedAt.
  const poll = async () => {
    for (const state of watchStates) {
      if (shuttingDown) break;

      const now = new Date().toISOString();
      console.error(`[agent-email] [${now}] Polling ${state.emailAddress} (since ${state.lastCheckedAt})...`);

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
          if (!isAllowedSender(senderEmail, allowlist)) {
            skippedAllowlist++;
            markProcessed(msg.id);
            console.error(`[agent-email] Skipping email from ${senderEmail} (not on receive allowlist)`);
            continue;
          }

          // Build and send wake
          const payload = buildWakePayload(state.emailAddress, msg);
          console.error(`[agent-email] WAKE: ${payload.text.split('\n')[0]}`);

          const result = await sendWake(wakeUrl, payload, token);
          if (result.success) {
            markProcessed(msg.id);
            wakeCount++;
          } else {
            console.error(`[agent-email] WARNING: Wake POST failed for ${msg.id}: ${result.error} — will retry next poll`);
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
            `[agent-email] Poll: ${newMessages.length} new, ${wakeCount} wakes, ` +
            `${skippedDedup} dedup, ${skippedAllowlist} allowlist-blocked`,
          );
        }
      } catch (err) {
        // Handle token errors gracefully
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('interaction_required') || errMsg.includes('invalid_grant')) {
          console.error(`[agent-email] WARNING: Token error for ${state.emailAddress}: ${errMsg}. Run: agent-email configure`);
          continue;
        }

        console.error(`[agent-email] WARNING: Poll error for ${state.emailAddress}: ${errMsg}`);
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
    console.error('[agent-email] NemoClaw bootstrap — adding egress domains:');
    for (const domain of NEMOCLAW_EGRESS_DOMAINS) {
      console.error(`  ✓ ${domain}`);
    }
    return 0;
  }

  const mailboxName = opts.mailbox ?? 'default';
  const provider = opts.provider ?? 'microsoft';

  if (provider !== 'microsoft') {
    console.error(`[agent-email] Provider "${provider}" not yet supported for configure. Use --provider microsoft`);
    return 1;
  }

  // Get client ID from flag, env var, or use Junior local app default
  const clientId = opts.clientId
    ?? process.env['AGENT_EMAIL_CLIENT_ID']
    ?? 'c4f91d3e-d2d9-4f8b-826f-6a3c19280241'; // Junior local app

  console.error(`[agent-email] Configuring mailbox "${mailboxName}" with Microsoft Graph`);
  console.error(`[agent-email] Client ID: ${clientId}`);
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
        // This handles: work.json -> steven-at-usejunior-com.json migration
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
                  console.error(`[agent-email] Removing superseded token file: ${file}`);
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
            console.error(`[agent-email] Send allowlist: ${emailAddress} (outbound email enabled to this address)`);
          } catch (allowlistErr) {
            console.error(`[agent-email] WARNING: Could not update send allowlist: ${allowlistErr instanceof Error ? allowlistErr.message : allowlistErr}`);
          }
        }

        console.error('');
        console.error(`✅ Connected as: ${profile.displayName ?? 'Unknown'} (${emailAddress})`);
        console.error(`   Mailbox saved to ~/.agent-email/tokens/${safeKey}.json`);
      } else {
        console.error('');
        console.error(`✅ Connected as: ${profile.displayName ?? 'Unknown'} (no email found)`);
        console.error(`   Mailbox "${mailboxName}" saved to ~/.agent-email/tokens/${mailboxName}.json`);
      }
      console.error('');
      console.error('To start the MCP server, run:');
      console.error('   npx tsx packages/email-mcp/src/cli.ts serve   # from source');
      console.error('   npx @usejunior/agent-email serve             # after npm publish');
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
 * Guided setup for first-time users (TTY, no mailboxes configured).
 */
async function runSetup(opts: CliOptions): Promise<number> {
  console.error('');
  console.error('  \uD83E\uDD9E agent-email \u2014 Email connectivity for AI agents');
  console.error('');
  console.error('  No mailboxes configured. Let\'s set one up!');
  console.error('');
  console.error('  Which email provider?');
  console.error('    1) Outlook');
  console.error('    2) Gmail');
  console.error('');

  const choice = await prompt('  Enter 1 or 2: ');

  let provider: string;
  if (choice === '1') {
    provider = 'microsoft';
  } else if (choice === '2') {
    provider = 'gmail';
  } else {
    console.error(`  Invalid choice "${choice}". Please run again and enter 1 or 2.`);
    return 1;
  }

  // Run configure with the chosen provider
  const configOpts: CliOptions = { ...opts, command: 'configure', provider };
  const exitCode = await runConfigure(configOpts);
  if (exitCode !== 0) return exitCode;

  // Prompt for hooks token
  console.error('');
  const envToken = process.env['OPENCLAW_HOOKS_TOKEN'];
  if (envToken) {
    // Auto-save from env var
    await saveConfig({ hooksToken: envToken });
    console.error('  OpenClaw hooks token saved from OPENCLAW_HOOKS_TOKEN env var.');
  } else {
    const tokenInput = await prompt('  Enter your OpenClaw hooks token (or press Enter to skip): ');
    if (tokenInput) {
      await saveConfig({ hooksToken: tokenInput });
      console.error('  Hooks token saved to ~/.agent-email/config.json');
    }
  }

  // Ask if they want to start watching
  console.error('');
  const watchAnswer = await prompt('  Start watching for new emails now? [Y/n] ');
  if (watchAnswer === '' || watchAnswer.toLowerCase() === 'y' || watchAnswer.toLowerCase() === 'yes') {
    return await runWatch(opts);
  }

  return 0;
}

/**
 * Interactive menu for TTY users who have configured mailboxes.
 */
async function runInteractiveMenu(opts: CliOptions, mailboxes: Array<{ emailAddress?: string; mailboxName: string; lastInteractiveAuthAt?: string }>): Promise<number> {
  console.error('');
  console.error('  \uD83E\uDD9E agent-email \u2014 Email connectivity for AI agents');
  console.error('');

  // Show connected accounts
  console.error('  Connected accounts:');
  for (const mb of mailboxes) {
    const name = mb.emailAddress ?? mb.mailboxName;
    const lastAuth = mb.lastInteractiveAuthAt
      ? new Date(mb.lastInteractiveAuthAt).toLocaleDateString()
      : 'unknown';
    console.error(`    \u2022 ${name} (last auth: ${lastAuth})`);
  }
  console.error('');

  // Load and display send allowlist
  try {
    const { readFile } = await import('node:fs/promises');
    const allowlistPath = join(getAgentEmailHome(), 'send-allowlist.json');
    const raw = await readFile(allowlistPath, 'utf-8');
    const data = JSON.parse(raw) as { entries?: string[] };
    const entries = data.entries ?? [];
    if (entries.length === 0) {
      console.error('  Send allowlist: empty (all outbound blocked)');
    } else {
      const shown = entries.slice(0, 10);
      console.error(`  Send allowlist (can email): ${shown.join(', ')}${entries.length > 10 ? ` +${entries.length - 10} more` : ''}`);
      if (entries.length > 10) {
        console.error(`    Full list: ${allowlistPath}`);
      }
    }
  } catch {
    console.error('  Send allowlist: not configured (all outbound blocked)');
  }
  console.error('');

  // Menu
  console.error('  What would you like to do?');
  console.error('    1) Start watching for new emails');
  console.error('    2) Show detailed status');
  console.error('    3) Add another mailbox');
  console.error('    4) Reconnect a disconnected mailbox');
  console.error('');

  const choice = await prompt('  Enter 1-4: ');

  switch (choice) {
    case '1': {
      // Load config and warn if no hooks token is available
      const config = await loadConfig();
      const hasToken = !!(process.env['OPENCLAW_HOOKS_TOKEN'] || config.hooksToken);
      if (!hasToken) {
        console.error('');
        console.error('  WARNING: No hooks token configured. Wake POSTs will not be authenticated.');
        console.error('  Set OPENCLAW_HOOKS_TOKEN or run: agent-email setup');
        console.error('');
      }
      return await runWatch(opts);
    }
    case '2':
      return await runStatus();
    case '3':
      return await runSetup(opts);
    case '4':
      return await runConfigure(opts);
    default:
      console.error(`  Invalid choice "${choice}".`);
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
  console.error('  \uD83E\uDD9E agent-email status');
  console.error('');

  if (mailboxes.length === 0) {
    console.error('  No mailboxes configured. Run: agent-email setup');
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

function printHelp(): void {
  console.error(`
agent-email — Email connectivity for AI agents

USAGE:
  agent-email [command] [options]

COMMANDS:
  agent-email              Set up (first run) or show status (TTY)
                           Start MCP server (non-TTY / when spawned by host)
  agent-email watch        Start email watcher (long-running)
  agent-email setup        Configure a mailbox (interactive)
  agent-email configure    Configure a mailbox (interactive, alias for setup)
  agent-email status       Show account + connection health
  agent-email serve        Force MCP server mode
  agent-email help         Show this help

OPTIONS:
  --version              Print version
  --help, -h             Show this help
  --wake-url <url>       Wake URL for watch mode
  --poll-interval <sec>  Poll interval in seconds (default 10, min 2)
  --nemoclaw             NemoClaw egress bootstrap
  --log-level <level>    Log level (debug, info, warn, error)
  --mailbox <name>       Mailbox name (default: "default")
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
