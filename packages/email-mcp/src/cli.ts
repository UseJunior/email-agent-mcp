// CLI entry point — serve, watch, configure subcommands

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
    case 'configure':
      return await runConfigure(opts);
    default:
      if (!opts.command) {
        console.error('Error: No command specified. Use --help for usage.');
        return 2;
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

async function runWatch(opts: CliOptions): Promise<number> {
  const wakeUrl = opts.wakeUrl ?? 'http://localhost:18789/hooks/wake';
  const pollIntervalSec = opts.pollInterval ?? 30;
  const pollIntervalMs = pollIntervalSec * 1000;

  console.error(`[agent-email] Watching mailboxes, wake URL: ${wakeUrl}`);
  console.error(`[agent-email] Poll interval: ${pollIntervalSec}s`);

  // Dynamic imports to avoid loading heavy dependencies at parse time
  const {
    DelegatedAuthManager,
    RealGraphApiClient,
    GraphEmailProvider,
    GraphApiError,
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
    getWakeToken,
    isProcessed,
    markProcessed,
    loadDeltaState,
    saveDeltaState,
    deleteDeltaState,
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

  // Get wake token
  const token = getWakeToken();

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
    deltaLink: string | undefined;
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

      // Load delta state
      const savedState = await loadDeltaState(safeKey);
      let deltaLink: string | undefined;

      if (savedState) {
        console.error(`[agent-email] Loaded delta state for ${emailAddress} (last updated: ${savedState.lastUpdated})`);
        deltaLink = savedState.deltaLink;
      } else {
        // Baseline sync — consume all pages silently, save deltaLink, don't wake
        console.error(`[agent-email] No delta state for ${emailAddress} — performing baseline sync...`);
        try {
          const baseline = await provider.getDeltaMessages();
          deltaLink = baseline.nextDeltaLink;
          await saveDeltaState(safeKey, {
            deltaLink,
            lastUpdated: new Date().toISOString(),
          });
          // Mark all baseline messages as processed to prevent wakes on restart
          for (const msg of baseline.messages) {
            markProcessed(msg.id);
          }
          console.error(`[agent-email] Baseline sync complete for ${emailAddress}: ${baseline.messages.length} existing messages consumed`);
        } catch (err) {
          console.error(`[agent-email] WARNING: Baseline sync failed for ${emailAddress}: ${err instanceof Error ? err.message : err}`);
          await releaseLock(safeKey);
          continue;
        }
      }

      watchStates.push({ safeKey, emailAddress, provider, deltaLink });
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

  // Poll loop
  const poll = async () => {
    for (const state of watchStates) {
      if (shuttingDown) break;

      const now = new Date().toISOString();
      console.error(`[agent-email] [${now}] Polling ${state.emailAddress}...`);

      try {
        const delta = await state.provider.getDeltaMessages(state.deltaLink);

        let newCount = 0;
        let skippedDedup = 0;
        let skippedAllowlist = 0;
        let skippedRead = 0;
        let wakeFailed = false;

        for (const msg of delta.messages) {
          // Dedup
          if (isProcessed(msg.id)) {
            skippedDedup++;
            continue;
          }

          // Only wake for unread messages — filters out read-status changes,
          // flag changes, and other updates to existing messages from delta results.
          if (msg.isRead) {
            skippedRead++;
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
            // Only mark processed AFTER successful wake — if wake fails,
            // the message will be re-processed on the next poll.
            markProcessed(msg.id);
            newCount++;
          } else {
            console.error(`[agent-email] WARNING: Wake POST failed for ${msg.id}: ${result.error} — will retry next poll`);
            wakeFailed = true;
          }
        }

        // Only advance delta state if all wakes succeeded.
        // If any wake failed, keep the old deltaLink so failed messages are re-processed.
        if (!wakeFailed) {
          state.deltaLink = delta.nextDeltaLink;
          await saveDeltaState(state.safeKey, {
            deltaLink: delta.nextDeltaLink,
            lastUpdated: new Date().toISOString(),
          });
        } else {
          console.error(`[agent-email] WARNING: Delta state NOT advanced for ${state.emailAddress} due to wake failure(s)`);
        }

        console.error(
          `[agent-email] Poll complete for ${state.emailAddress}: ` +
          `${delta.messages.length} changes, ${newCount} wakes, ` +
          `${skippedDedup} dedup, ${skippedRead} already-read, ${skippedAllowlist} allowlist-blocked`,
        );
      } catch (err) {
        // Handle 410 Gone — delta token expired, do fresh baseline sync
        if (err instanceof GraphApiError && err.status === 410) {
          console.error(`[agent-email] 410 Gone for ${state.emailAddress} — delta token expired. Performing fresh baseline sync...`);
          await deleteDeltaState(state.safeKey);
          try {
            const baseline = await state.provider.getDeltaMessages();
            state.deltaLink = baseline.nextDeltaLink;
            await saveDeltaState(state.safeKey, {
              deltaLink: baseline.nextDeltaLink,
              lastUpdated: new Date().toISOString(),
            });
            for (const msg of baseline.messages) {
              markProcessed(msg.id);
            }
            console.error(`[agent-email] Fresh baseline sync complete for ${state.emailAddress}: ${baseline.messages.length} messages consumed`);
          } catch (resyncErr) {
            console.error(`[agent-email] WARNING: Fresh baseline sync failed for ${state.emailAddress}: ${resyncErr instanceof Error ? resyncErr.message : resyncErr}`);
          }
          continue;
        }

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

async function runConfigure(opts: CliOptions): Promise<number> {
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

        // Clean up the old mailbox-name-based file if the new filename is different
        if (safeKey !== mailboxName) {
          const { join } = await import('node:path');
          const { homedir } = await import('node:os');
          const { unlink } = await import('node:fs/promises');
          const oldPath = join(homedir(), '.agent-email', 'tokens', `${mailboxName}.json`);
          try { await unlink(oldPath); } catch { /* may not exist */ }
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
      console.error('   npx @usejunior/agent-email serve');
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

function printHelp(): void {
  console.error(`
agent-email — Email connectivity for AI agents

USAGE:
  agent-email <command> [options]

COMMANDS:
  serve       Start MCP server on stdio
  watch       Monitor mailboxes and wake on new email
  configure   Interactive setup wizard

OPTIONS:
  --version              Print version
  --help, -h             Show this help
  --wake-url <url>       Wake URL for watch mode
  --poll-interval <sec>  Poll interval in seconds (default 30)
  --nemoclaw             NemoClaw egress bootstrap
  --log-level <level>    Log level (debug, info, warn, error)
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
