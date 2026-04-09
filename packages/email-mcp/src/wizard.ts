// Interactive setup wizard using @clack/prompts
// TTY-only — never loaded in MCP stdio path
import * as p from '@clack/prompts';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { CliOptions, ConfiguredMailboxSummary } from './cli.js';

/**
 * First-run wizard — guides user through email setup.
 */
export async function runWizardSetup(opts: CliOptions): Promise<number> {
  const { runConfigure, runWatch, loadConfig, saveConfig, getAgentEmailHome } = await import('./cli.js');

  p.intro('🦞 email-agent-mcp — Email connectivity for AI agents');

  p.note(
    'Outlook: interactive setup\nGmail:   interactive setup (Google OAuth client required)',
    'Email Accounts',
  );

  const provider = await p.select({
    message: 'Select a provider',
    options: [
      { value: 'microsoft', label: 'Outlook (Microsoft 365 / Office 365)' },
      { value: 'gmail', label: 'Gmail' },
    ],
  });

  if (p.isCancel(provider)) {
    p.outro('Setup cancelled.');
    return 0;
  }

  if (provider === 'gmail') {
    p.note(
      'Gmail setup uses a Google OAuth client and a local browser callback on 127.0.0.1.\n' +
      'Provide the client via --client-id / --client-secret or the env vars\n' +
      'AGENT_EMAIL_GMAIL_CLIENT_ID and AGENT_EMAIL_GMAIL_CLIENT_SECRET.\n' +
      `Credentials stored at ${getAgentEmailHome()}/tokens/`,
      'How Gmail auth works',
    );
  } else {
    p.note(
      "You'll see a code to enter at https://login.microsoft.com/device\n" +
      'This links your Outlook mailbox to email-agent-mcp.\n' +
      `Credentials stored at ${getAgentEmailHome()}/tokens/\n` +
      'Token refreshes automatically for ~90 days.',
      'How email auth works',
    );
  }

  const confirmLink = await p.confirm({ message: provider === 'gmail' ? 'Link Gmail now?' : 'Link Outlook now?' });
  if (p.isCancel(confirmLink) || !confirmLink) {
    p.outro('Setup cancelled.');
    return 0;
  }

  // Run the actual configure — Microsoft prints a device code; Gmail prints a browser URL.
  const configOpts: CliOptions = { ...opts, command: 'configure', provider };
  const exitCode = await runConfigure(configOpts);
  if (exitCode !== 0) {
    p.outro('Setup failed. Try again with: email-agent-mcp setup');
    return exitCode;
  }

  // Show send allowlist info
  try {
    const allowlistPath = join(getAgentEmailHome(), 'send-allowlist.json');
    const raw = await readFile(allowlistPath, 'utf-8');
    const data = JSON.parse(raw) as { entries?: string[] };
    const entries = data.entries ?? [];
    p.note(
      'email-agent-mcp blocks all outbound email by default.\n' +
      `Added to send allowlist: ${entries.join(', ')}\n` +
      `Edit: ${allowlistPath}`,
      'Send allowlist (outbound)',
    );
  } catch {
    p.note(
      'email-agent-mcp blocks all outbound email by default.\n' +
      'No send allowlist configured — all outbound blocked.\n' +
      'Run setup again or edit ~/.email-agent-mcp/send-allowlist.json',
      'Send allowlist (outbound)',
    );
  }

  // Show inbound security info
  p.note(
    'The watcher accepts ALL inbound email by default.\n' +
    'To restrict which senders can wake the agent,\n' +
    'create ~/.email-agent-mcp/receive-allowlist.json\n' +
    'Format: {"entries": ["*@yourdomain.com"]}',
    'Inbound security',
  );

  // Hooks token
  const config = await loadConfig();
  const existingToken = process.env['OPENCLAW_HOOKS_TOKEN'] ?? config.hooksToken;

  if (existingToken) {
    p.note(
      `Found existing hooks token: ${existingToken.substring(0, 8)}...`,
      'OpenClaw integration',
    );
  } else {
    const tokenInput = await p.text({
      message: 'Enter OpenClaw hooks token (from: openclaw config get hooks.token)',
      placeholder: 'Press Enter to skip',
    });

    if (!p.isCancel(tokenInput) && tokenInput && tokenInput.trim()) {
      await saveConfig({ hooksToken: tokenInput.trim() });
      p.log.success('Hooks token saved to ~/.email-agent-mcp/config.json');
    }
  }

  // Summary
  const providerLabel = provider === 'gmail' ? 'Gmail' : 'Outlook (Microsoft 365)';
  p.note(
    `Provider: ${providerLabel}\n` +
    `Tokens: ${getAgentEmailHome()}/tokens/\n` +
    `Config: ${getAgentEmailHome()}/config.json\n` +
    `Hooks: ${existingToken ? 'configured' : 'not configured'}`,
    'Configuration saved',
  );

  // Offer to start watching
  const startWatch = await p.confirm({ message: 'Start watching for new emails now?' });
  if (p.isCancel(startWatch) || !startWatch) {
    p.outro('Setup complete! Run: email-agent-mcp watch');
    return 0;
  }

  p.outro('Starting watcher...');
  return await runWatch(opts);
}

/**
 * Returning user menu — show status and offer actions.
 */
export async function runWizardMenu(opts: CliOptions, mailboxes: ConfiguredMailboxSummary[]): Promise<number> {
  const { runWatch, runStatus, runConfigure, loadConfig, saveConfig } = await import('./cli.js');
  const { getAgentEmailHome } = await import('./cli.js');

  p.intro('🦞 email-agent-mcp — Email connectivity for AI agents');

  // Build status lines
  const statusLines = mailboxes.map(mb => {
    const email = mb.emailAddress ?? mb.mailboxName;
    const lastAuth = mb.lastInteractiveAuthAt
      ? new Date(mb.lastInteractiveAuthAt).toLocaleDateString()
      : 'unknown';
    return `• ${email} (${mb.provider}, last auth: ${lastAuth})`;
  }).join('\n');

  p.note(statusLines, 'Connected accounts');

  // Show send allowlist
  try {
    const allowlistPath = join(getAgentEmailHome(), 'send-allowlist.json');
    const raw = await readFile(allowlistPath, 'utf-8');
    const data = JSON.parse(raw) as { entries?: string[] };
    const entries = data.entries ?? [];
    if (entries.length > 0) {
      const shown = entries.slice(0, 10);
      const text = `Can email: ${shown.join(', ')}${entries.length > 10 ? ` +${entries.length - 10} more` : ''}`;
      p.note(text, 'Send allowlist');
    } else {
      p.note('Empty — all outbound blocked', 'Send allowlist');
    }
  } catch {
    p.note('Not configured — all outbound blocked', 'Send allowlist');
  }

  const choice = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'watch', label: 'Start watching for new emails' },
      { value: 'status', label: 'Show detailed status' },
      { value: 'add', label: 'Add another mailbox' },
      { value: 'reconnect', label: 'Reconnect a disconnected mailbox' },
      { value: 'hooks', label: 'Edit hooks token' },
    ],
  });

  if (p.isCancel(choice)) {
    p.outro('Goodbye!');
    return 0;
  }

  switch (choice) {
    case 'watch':
      // Check hooks token before starting
      {
        const config = await loadConfig();
        const hasToken = !!(process.env['OPENCLAW_HOOKS_TOKEN'] || config.hooksToken);
        if (!hasToken) {
          p.note(
            'No hooks token configured.\n' +
            'Wake POSTs will not be authenticated.\n' +
            'Set OPENCLAW_HOOKS_TOKEN or run: email-agent-mcp setup',
            '⚠️  Warning',
          );
        }
      }
      p.outro('Starting watcher...');
      return await runWatch(opts);

    case 'status':
      return await runStatus();

    case 'add':
      return await runWizardSetup(opts);

    case 'reconnect':
      return await runConfigure(opts);

    case 'hooks': {
      const config = await loadConfig();
      const current = config.hooksToken;
      if (current) {
        p.note(`Current: ${current.substring(0, 8)}...`, 'Hooks token');
      }
      const newToken = await p.text({
        message: 'Enter new OpenClaw hooks token',
        placeholder: current ? 'Press Enter to keep current' : 'Paste token here',
      });
      if (!p.isCancel(newToken) && newToken && newToken.trim()) {
        await saveConfig({ hooksToken: newToken.trim() });
        p.log.success('Hooks token updated.');
      }
      p.outro('Done.');
      return 0;
    }

    default:
      p.outro('Invalid choice.');
      return 1;
  }
}
