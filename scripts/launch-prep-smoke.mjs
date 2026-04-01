#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function parseArgs(argv) {
  const opts = {
    liveWrite: false,
    safeSender: 'notifications@github.com',
    replySender: '',
    label: 'email-agent-mcp-demo',
    secondLabel: 'launch-prep',
    sendTo: '',
    mailbox: '',
    limit: 25,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--live-write':
        opts.liveWrite = true;
        break;
      case '--safe-sender':
        opts.safeSender = argv[++i] ?? opts.safeSender;
        break;
      case '--reply-sender':
        opts.replySender = argv[++i] ?? '';
        break;
      case '--label':
        opts.label = argv[++i] ?? opts.label;
        break;
      case '--second-label':
        opts.secondLabel = argv[++i] ?? opts.secondLabel;
        break;
      case '--send-to':
        opts.sendTo = argv[++i] ?? '';
        break;
      case '--mailbox':
        opts.mailbox = argv[++i] ?? '';
        break;
      case '--limit':
        opts.limit = Number(argv[++i] ?? opts.limit);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`launch-prep-smoke — live MCP smoke test for launch prep

Usage:
  node scripts/launch-prep-smoke.mjs [options]

Options:
  --live-write            Run mutating actions (mark, label, draft, send)
  --safe-sender <email>   Sender filter for safe demo candidate (default: notifications@github.com)
  --reply-sender <email>  Sender filter for reply-draft candidate
  --label <name>          Label/category for safe candidate (default: email-agent-mcp-demo)
  --second-label <name>   Second label/category for sent candidate (default: launch-prep)
  --send-to <email>       Recipient for draft/send smoke test
  --mailbox <name>        Mailbox override
  --limit <n>             Inbox/sent scan limit (default: 25)
`);
}

function buildServerEnv() {
  return {
    ...process.env,
  };
}

function getRepoRoot() {
  return new URL('..', import.meta.url).pathname;
}

function getMailboxArg(mailbox) {
  return mailbox ? { mailbox } : {};
}

function extractEmailAddress(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() ?? null;
}

async function readAllowlistEntries() {
  const allowlistPath = process.env.AGENT_EMAIL_SEND_ALLOWLIST;
  if (!allowlistPath) return [];

  try {
    const raw = await readFile(allowlistPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.entries)) return [];
    return parsed.entries
      .map(entry => extractEmailAddress(entry))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function connectClient() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/email-agent-mcp/bin/email-agent-mcp.js', 'serve'],
    cwd: getRepoRoot(),
    env: buildServerEnv(),
    stderr: 'pipe',
  });

  if (transport.stderr) {
    transport.stderr.on('data', chunk => process.stderr.write(chunk));
  }

  const client = new Client(
    { name: 'launch-prep-smoke', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find(item => item.type === 'text')?.text;
  if (!text) {
    throw new Error(`${name} returned no text content`);
  }
  return JSON.parse(text);
}

function requireSuccess(name, result) {
  if (result?.success === false) {
    throw new Error(`${name} failed: ${result.error?.message ?? 'unknown error'}`);
  }
  return result;
}

function requireLiveMailbox(status) {
  if (!status || typeof status !== 'object') {
    throw new Error('get_mailbox_status returned an invalid payload');
  }

  if (
    status.provider === 'none' ||
    status.status === 'not configured' ||
    String(status.provider).toLowerCase() === 'demo'
  ) {
    throw new Error(
      'Live mailbox not configured. Set EMAIL_AGENT_MCP_HOME and allowlist env vars for a real mailbox before running launch-prep-smoke.',
    );
  }

  if (String(status.status).toLowerCase() !== 'connected') {
    throw new Error(`Mailbox is not connected: ${status.status ?? 'unknown status'}`);
  }
}

async function resolveReplySender(opts, status) {
  if (opts.replySender) return opts.replySender.toLowerCase();

  const envReplySender = extractEmailAddress(process.env.EMAIL_AGENT_MCP_REPLY_SENDER);
  if (envReplySender) return envReplySender;

  const mailboxAddress = extractEmailAddress(status.name);
  if (mailboxAddress) {
    return mailboxAddress;
  }

  const allowlistEntries = await readAllowlistEntries();
  if (allowlistEntries.length > 0) {
    return allowlistEntries[0];
  }

  throw new Error(
    'Unable to infer reply sender. Re-run with --reply-sender <email> or set EMAIL_AGENT_MCP_REPLY_SENDER.',
  );
}

function findSafeCandidate(messages, safeSender) {
  const safe = messages.find(message =>
    typeof message.from === 'string' &&
    message.from.toLowerCase().includes(safeSender.toLowerCase()),
  );
  if (!safe) {
    throw new Error(`No inbox message matched safe sender filter: ${safeSender}. Re-run with --safe-sender <email> or raise --limit.`);
  }
  return safe;
}

function findReplyCandidate(messages, replySender) {
  const selfSent = messages.find(message =>
    typeof message.from === 'string' &&
    message.from.toLowerCase().includes(replySender.toLowerCase()),
  );
  if (!selfSent) {
    throw new Error(`No self-sent message found in Sent folder for reply-draft smoke test: ${replySender}. Re-run with --reply-sender <email> or raise --limit.`);
  }
  return selfSent;
}

function buildSendSubject(prefix) {
  return `${prefix} ${new Date().toISOString()}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readBackMessage(client, mailbox, id) {
  return callJson(client, 'read_email', {
    ...getMailboxArg(mailbox),
    id,
  });
}

async function waitForSentSubject(client, mailbox, subject, limit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const sent = await callJson(client, 'list_emails', {
      ...getMailboxArg(mailbox),
      folder: 'sent',
      limit,
    });
    const match = (sent.emails ?? []).find(message => message.subject === subject);
    if (match) {
      return match;
    }

    if (attempt < 2) {
      await sleep(1500);
    }
  }

  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = await connectClient();

  try {
    const summary = {
      status: null,
      safeCandidate: null,
      replyCandidate: null,
      readPreview: null,
      liveWrite: opts.liveWrite,
      mutations: [],
    };

    const status = await callJson(client, 'get_mailbox_status', getMailboxArg(opts.mailbox));
    requireLiveMailbox(status);
    summary.status = status;
    summary.replySender = await resolveReplySender(opts, status);

    const inbox = await callJson(client, 'list_emails', {
      ...getMailboxArg(opts.mailbox),
      folder: 'inbox',
      limit: opts.limit,
    });
    const safeCandidate = findSafeCandidate(inbox.emails ?? [], opts.safeSender);
    summary.safeCandidate = safeCandidate;

    const safeRead = await callJson(client, 'read_email', {
      ...getMailboxArg(opts.mailbox),
      id: safeCandidate.id,
    });
    summary.readPreview = {
      id: safeRead.id,
      subject: safeRead.subject,
      from: safeRead.from,
      bodyPreview: String(safeRead.body ?? '').split('\n').slice(0, 3).join('\n'),
    };

    const sent = await callJson(client, 'list_emails', {
      ...getMailboxArg(opts.mailbox),
      folder: 'sent',
      limit: opts.limit,
    });
    const replyCandidate = findReplyCandidate(sent.emails ?? [], summary.replySender);
    summary.replyCandidate = replyCandidate;

    if (opts.liveWrite) {
      const markedRead = requireSuccess('mark_read(true)', await callJson(client, 'mark_read', {
        ...getMailboxArg(opts.mailbox),
        id: safeCandidate.id,
        is_read: true,
      }));
      summary.mutations.push({ action: 'mark_read_true', result: markedRead });

      const markedUnread = requireSuccess('mark_read(false)', await callJson(client, 'mark_read', {
        ...getMailboxArg(opts.mailbox),
        id: safeCandidate.id,
        is_read: false,
      }));
      summary.mutations.push({ action: 'mark_read_false', result: markedUnread });

      const labeledSafe = requireSuccess('label_email(safe)', await callJson(client, 'label_email', {
        ...getMailboxArg(opts.mailbox),
        id: safeCandidate.id,
        labels: [opts.label],
      }));
      summary.mutations.push({ action: 'label_safe_candidate', labels: [opts.label], result: labeledSafe });

      const labeledReply = requireSuccess('label_email(reply)', await callJson(client, 'label_email', {
        ...getMailboxArg(opts.mailbox),
        id: replyCandidate.id,
        labels: [opts.label, opts.secondLabel],
      }));
      summary.mutations.push({
        action: 'label_reply_candidate',
        labels: [opts.label, opts.secondLabel],
        result: labeledReply,
      });

      if (opts.sendTo) {
        const draftSubject = buildSendSubject('email-agent-mcp launch prep draft');
        const draft = requireSuccess('create_draft', await callJson(client, 'create_draft', {
          ...getMailboxArg(opts.mailbox),
          to: opts.sendTo,
          subject: draftSubject,
          body: 'Draft created by scripts/launch-prep-smoke.mjs during launch prep.',
        }));
        summary.mutations.push({ action: 'create_draft', to: opts.sendTo, draftId: draft.draftId, result: draft });

        if (draft.draftId) {
          const draftReadBack = await readBackMessage(client, opts.mailbox, draft.draftId);
          summary.mutations.push({
            action: 'verify_create_draft',
            draftId: draft.draftId,
            subject: draftReadBack.subject,
          });
        }
      }

      const replyDraft = requireSuccess('reply_to_email(draft)', await callJson(client, 'reply_to_email', {
        ...getMailboxArg(opts.mailbox),
        message_id: replyCandidate.id,
        body: 'Draft-only reply created by scripts/launch-prep-smoke.mjs during launch prep.',
        draft: true,
      }));
      summary.mutations.push({
        action: 'reply_draft',
        messageId: replyCandidate.id,
        draftId: replyDraft.draftId,
        result: replyDraft,
      });

      if (replyDraft.draftId) {
        const replyDraftReadBack = await readBackMessage(client, opts.mailbox, replyDraft.draftId);
        summary.mutations.push({
          action: 'verify_reply_draft',
          draftId: replyDraft.draftId,
          subject: replyDraftReadBack.subject,
        });
      }

      if (opts.sendTo) {
        const sendSubject = buildSendSubject('email-agent-mcp live smoke');
        const sentMessage = requireSuccess('send_email', await callJson(client, 'send_email', {
          ...getMailboxArg(opts.mailbox),
          to: opts.sendTo,
          subject: sendSubject,
          body: 'Live send smoke test from scripts/launch-prep-smoke.mjs.',
        }));
        const sentFolderMatch = await waitForSentSubject(client, opts.mailbox, sendSubject, Math.max(opts.limit, 50));
        summary.mutations.push({
          action: 'send_email',
          to: opts.sendTo,
          subject: sendSubject,
          messageId: sentMessage.messageId,
          sentFolderMatch,
          result: sentMessage,
        });
      }
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
