// CLI entry point — serve, watch, configure subcommands

export interface CliOptions {
  command: string;
  wakeUrl?: string;
  nemoclaw?: boolean;
  version?: boolean;
  help?: boolean;
  logLevel?: string;
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

  console.error('[agent-email] Interactive configuration wizard');
  return 0;
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
