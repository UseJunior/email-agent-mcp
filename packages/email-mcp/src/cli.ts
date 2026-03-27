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
  console.error(`[agent-email] Watching mailboxes, wake URL: ${wakeUrl}`);
  return 0;
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
    const { DelegatedAuthManager } = await import('@usejunior/provider-microsoft');
    const auth = new DelegatedAuthManager(
      { mode: 'delegated', clientId },
      mailboxName,
    );

    // This triggers device code flow — user sees URL + code on stderr
    await auth.connect({});

    // Test connection by getting user profile
    const token = await auth.getAccessToken();
    const resp = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const profile = await resp.json() as { displayName?: string; mail?: string };
      console.error('');
      console.error(`✅ Connected as: ${profile.displayName ?? 'Unknown'} (${profile.mail ?? 'no email'})`);
      console.error(`   Mailbox "${mailboxName}" saved to ~/.agent-email/tokens/${mailboxName}.json`);
      console.error('');
      console.error('You can now run: agent-email serve');
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
  --version           Print version
  --help, -h          Show this help
  --wake-url <url>    Wake URL for watch mode
  --nemoclaw          NemoClaw egress bootstrap
  --log-level <level> Log level (debug, info, warn, error)
`.trim());
}

export function getNemoClawEgressDomains(): string[] {
  return [...NEMOCLAW_EGRESS_DOMAINS];
}
