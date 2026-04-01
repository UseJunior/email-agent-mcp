#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function getRepoRoot() {
  return new URL('..', import.meta.url).pathname;
}

async function connectClient() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/email-agent-mcp/bin/email-agent-mcp.js', 'serve'],
    cwd: getRepoRoot(),
    env: { ...process.env },
    stderr: 'pipe',
  });

  if (transport.stderr) {
    transport.stderr.on('data', chunk => process.stderr.write(chunk));
  }

  const client = new Client(
    { name: 'extended-live-test', version: '1.0.0' },
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

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} returned non-JSON content: ${text}`);
  }
}

function requireSuccess(name, result) {
  if (result?.success === false) {
    throw new Error(`${name} failed: ${result.error?.code ?? 'UNKNOWN'} ${result.error?.message ?? ''}`.trim());
  }
  return result;
}

function requireBlocked(name, result, code) {
  if (result?.success !== false || result?.error?.code !== code) {
    throw new Error(`${name} expected ${code}, got ${JSON.stringify(result)}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSentMessage(client, subject) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const sent = await callJson(client, 'list_emails', { folder: 'sent', limit: 25 });
    const match = (sent.emails ?? []).find(message => message.subject === subject);
    if (match) {
      return match;
    }
    await sleep(1500);
  }

  throw new Error(`Sent message not found in Sent folder: ${subject}`);
}

async function main() {
  const client = await connectClient();

  try {
    const now = new Date().toISOString();
    const draftSubject = `email-agent-mcp draft lifecycle ${now}`;
    const updatedSubject = `${draftSubject} updated`;
    const blockedSubject = `email-agent-mcp blocked send ${now}`;
    const summary = {
      status: null,
      search: null,
      thread: null,
      draftLifecycle: {},
      moveCycle: {},
      blocked: {},
    };

    summary.status = await callJson(client, 'get_mailbox_status', {});

    const search = await callJson(client, 'search_emails', { query: 'email-agent-mcp live smoke' });
    summary.search = {
      count: search.emails?.length ?? 0,
      topSubjects: (search.emails ?? []).slice(0, 5).map(message => message.subject),
    };

    const sentList = await callJson(client, 'list_emails', { folder: 'sent', limit: 25 });
    const existingSent = (sentList.emails ?? []).find(message =>
      String(message.subject).includes('email-agent-mcp live smoke'),
    );
    if (!existingSent) {
      throw new Error('Could not find an existing live smoke message in Sent Items');
    }

    const thread = await callJson(client, 'get_thread', { message_id: existingSent.id });
    summary.thread = {
      id: thread.id,
      subject: thread.subject,
      messageCount: thread.messageCount,
    };

    const createdDraft = requireSuccess('create_draft', await callJson(client, 'create_draft', {
      to: 'beta@usejunior.com',
      subject: draftSubject,
      body: 'Initial body from extended live MCP test.',
    }));
    summary.draftLifecycle.create = createdDraft;

    const updatedDraft = requireSuccess('update_draft', await callJson(client, 'update_draft', {
      draft_id: createdDraft.draftId,
      subject: updatedSubject,
      body: 'Updated body from extended live MCP test.',
    }));
    summary.draftLifecycle.update = updatedDraft;

    const updatedDraftRead = await callJson(client, 'read_email', { id: createdDraft.draftId });
    summary.draftLifecycle.readBack = {
      id: updatedDraftRead.id,
      subject: updatedDraftRead.subject,
      bodyPreview: String(updatedDraftRead.body ?? '').slice(0, 120),
    };

    const sentDraft = requireSuccess('send_draft', await callJson(client, 'send_draft', {
      draft_id: createdDraft.draftId,
    }));
    summary.draftLifecycle.send = sentDraft;

    const sentFromDraft = await waitForSentMessage(client, updatedSubject);
    summary.draftLifecycle.sentFolderMatch = sentFromDraft;

    const movedToArchive = requireSuccess('move_to_folder archive', await callJson(client, 'move_to_folder', {
      id: sentFromDraft.id,
      folder: 'archive',
    }));
    summary.moveCycle.archive = movedToArchive;

    const movedBackToSent = requireSuccess('move_to_folder sent', await callJson(client, 'move_to_folder', {
      id: movedToArchive.newId,
      folder: 'sent',
    }));
    summary.moveCycle.restore = movedBackToSent;

    const blockedSend = await callJson(client, 'send_email', {
      to: 'not-allowlisted@example.com',
      subject: blockedSubject,
      body: 'This should be blocked by the send allowlist.',
    });
    summary.blocked.send = requireBlocked('send_email', blockedSend, 'ALLOWLIST_BLOCKED');

    const inbox = await callJson(client, 'list_emails', { folder: 'inbox', limit: 25 });
    const githubMessage = (inbox.emails ?? []).find(message =>
      String(message.from).toLowerCase().includes('notifications@github.com'),
    );
    if (!githubMessage) {
      throw new Error('Could not find a GitHub notification in Inbox for blocked reply/delete checks');
    }

    const blockedReply = await callJson(client, 'reply_to_email', {
      message_id: githubMessage.id,
      body: 'This should be blocked by the send allowlist.',
      draft: true,
    });
    summary.blocked.reply = requireBlocked('reply_to_email', blockedReply, 'ALLOWLIST_BLOCKED');

    const blockedDelete = await callJson(client, 'delete_email', {
      id: githubMessage.id,
      user_explicitly_requested_deletion: true,
    });
    summary.blocked.delete = requireBlocked('delete_email', blockedDelete, 'DELETE_DISABLED');

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
