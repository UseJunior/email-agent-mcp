import { describe, it, expect, vi } from 'vitest';
import { GmailEmailProvider, type GmailApiClient } from './email-gmail-provider.js';
import { AttachmentNotFoundError } from '@usejunior/email-core';

function createMockGmailClient(overrides: Partial<GmailApiClient> = {}): GmailApiClient {
  return {
    listMessages: vi.fn().mockResolvedValue({ messages: [] }),
    getMessage: vi.fn().mockResolvedValue({
      id: 'msg-1',
      threadId: 'thread-1',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: '"Alice" <alice@corp.com>' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Subject', value: 'Test Email' },
          { name: 'Date', value: '2024-03-15T10:00:00Z' },
        ],
        body: { data: Buffer.from('Hello world').toString('base64url') },
      },
      internalDate: String(new Date('2024-03-15T10:00:00Z').getTime()),
    }),
    getAttachment: vi.fn().mockResolvedValue({
      data: Buffer.from('attachment bytes').toString('base64url'),
      size: 16,
    }),
    sendMessage: vi.fn().mockResolvedValue({ id: 'sent-1', threadId: 'thread-1' }),
    modifyMessage: vi.fn().mockResolvedValue(undefined),
    getThread: vi.fn().mockResolvedValue({ id: 'thread-1', messages: [] }),
    createDraft: vi.fn().mockResolvedValue({ id: 'draft-abc', message: { id: 'msg-draft', threadId: 'thread-draft' } }),
    sendDraft: vi.fn().mockResolvedValue({ id: 'draft-abc', message: { id: 'sent-draft-msg', threadId: 'thread-draft' } }),
    updateDraft: vi.fn().mockResolvedValue({ id: 'draft-abc', message: { id: 'msg-updated', threadId: 'thread-draft' } }),
    ...overrides,
  };
}

describe('provider-gmail/Message Mapping', () => {
  it('Scenario: Gmail message to EmailMessage', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const msg = await provider.getMessage('msg-1');

    expect(msg.id).toBe('msg-1');
    expect(msg.threadId).toBe('thread-1');
    expect(msg.subject).toBe('Test Email');
    expect(msg.from.email).toBe('alice@corp.com');
    expect(msg.from.name).toBe('Alice');
    expect(msg.labels).toContain('INBOX');
    expect(msg.isRead).toBe(false); // Has UNREAD label
  });

  it('Scenario: multipart Gmail messages expose attachment metadata and inline content ids', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-attachments',
        threadId: 'thread-attachments',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Subject', value: 'Attachments' },
            { name: 'Date', value: '2026-04-09T12:00:00Z' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            {
              mimeType: 'multipart/alternative',
              parts: [
                {
                  mimeType: 'text/plain',
                  body: { data: Buffer.from('Plain body').toString('base64url') },
                },
                {
                  mimeType: 'text/html',
                  body: { data: Buffer.from('<p>HTML body</p>').toString('base64url') },
                },
              ],
            },
            {
              mimeType: 'application/pdf',
              filename: 'contract.pdf',
              body: { attachmentId: 'att-pdf', size: 245000 },
              headers: [{ name: 'Content-Disposition', value: 'attachment; filename="contract.pdf"' }],
            },
            {
              mimeType: 'image/png',
              filename: 'inline.png',
              body: { attachmentId: 'att-inline', size: 1024 },
              headers: [
                { name: 'Content-Disposition', value: 'inline; filename="inline.png"' },
                { name: 'Content-ID', value: '<image001>' },
              ],
            },
          ],
        },
        internalDate: String(new Date('2026-04-09T12:00:00Z').getTime()),
      }),
    });
    const provider = new GmailEmailProvider(client);

    const msg = await provider.getMessage('msg-attachments');

    expect(msg.body).toBe('Plain body');
    expect(msg.bodyHtml).toBe('<p>HTML body</p>');
    expect(msg.hasAttachments).toBe(true);
    expect(msg.attachments).toEqual([
      {
        id: 'att-pdf',
        filename: 'contract.pdf',
        mimeType: 'application/pdf',
        size: 245000,
        contentId: undefined,
        isInline: false,
      },
      {
        id: 'att-inline',
        filename: 'inline.png',
        mimeType: 'image/png',
        size: 1024,
        contentId: 'image001',
        isInline: true,
      },
    ]);
  });

  it('Scenario: inline body-only attachment parts get synthetic ids for later download', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-inline-body',
        threadId: 'thread-inline-body',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Subject', value: 'Inline image' },
          ],
          parts: [
            {
              mimeType: 'image/png',
              body: { data: Buffer.from('tiny-image').toString('base64url') },
              headers: [{ name: 'Content-ID', value: '<image002>' }],
            },
          ],
        },
      }),
    });
    const provider = new GmailEmailProvider(client);

    const msg = await provider.getMessage('msg-inline-body');

    expect(msg.attachments).toEqual([
      {
        id: 'part:0',
        filename: 'image002',
        mimeType: 'image/png',
        size: Buffer.from('tiny-image').byteLength,
        contentId: 'image002',
        isInline: true,
      },
    ]);
  });
});

describe('provider-gmail/Label Mapping', () => {
  it('Scenario: Label as folder', async () => {
    const client = createMockGmailClient({
      listMessages: vi.fn().mockResolvedValue({
        messages: [{ id: 'spam-1', threadId: 'thread-spam' }],
      }),
      getMessage: vi.fn().mockResolvedValue({
        id: 'spam-1',
        threadId: 'thread-spam',
        labelIds: ['SPAM'],
        payload: {
          headers: [
            { name: 'From', value: 'spammer@evil.com' },
            { name: 'Subject', value: 'Buy now!' },
            { name: 'Date', value: '2024-03-15T10:00:00Z' },
          ],
        },
        internalDate: String(Date.now()),
      }),
    });
    const provider = new GmailEmailProvider(client);

    // WHEN list_emails is called with {folder: "junk"}
    await provider.listMessages({ folder: 'junk' });

    // THEN the system queries messages with the SPAM label
    expect(client.listMessages).toHaveBeenCalledWith(
      expect.objectContaining({ labelIds: ['SPAM'] }),
    );
  });
});

describe('provider-gmail/Draft Operations', () => {
  it('Scenario: createDraft sends raw message to Gmail API', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const result = await provider.createDraft({
      to: [{ email: 'bob@corp.com', name: 'Bob' }],
      subject: 'Draft subject',
      body: '<p>Draft body</p>',
    });

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-abc');
    // Interface now accepts optional threadId; absent here because ComposeMessage.threadId is unset.
    expect(client.createDraft).toHaveBeenCalledWith(expect.any(String), undefined);
  });

  it('Scenario: sendDraft calls Gmail API with draft ID', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const result = await provider.sendDraft('draft-abc');

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sent-draft-msg');
    expect(client.sendDraft).toHaveBeenCalledWith('draft-abc');
  });
});

describe('provider-gmail/NemoClaw Compatibility', () => {
  it('Scenario: NemoClaw egress', () => {
    const domains = GmailEmailProvider.egressDomains;
    expect(domains).toContain('gmail.googleapis.com');
    expect(domains).toContain('oauth2.googleapis.com');
    expect(domains).toContain('pubsub.googleapis.com');
  });
});

describe('provider-gmail/Attachment Retrieval', () => {
  it('Scenario: downloadAttachment fetches Gmail attachment bytes by attachment id and returns metadata', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const result = await provider.downloadAttachment('msg-1', 'att-1');

    expect(client.getAttachment).toHaveBeenCalledWith('msg-1', 'att-1');
    expect(result.content.toString('utf-8')).toBe('attachment bytes');
    expect(result.size).toBe(result.content.length);
  });

  it('Scenario: downloadAttachment falls back to inline part data for synthetic ids', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-inline-body',
        threadId: 'thread-inline-body',
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'To', value: 'recipient@example.com' },
            { name: 'Subject', value: 'Inline image' },
          ],
          parts: [
            {
              mimeType: 'image/png',
              filename: 'logo.png',
              body: { data: Buffer.from('tiny-image').toString('base64url') },
              headers: [{ name: 'Content-ID', value: '<image002>' }],
            },
          ],
        },
      }),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.downloadAttachment('msg-inline-body', 'part:0');

    expect(client.getAttachment).not.toHaveBeenCalled();
    expect(result.content.toString('utf-8')).toBe('tiny-image');
    expect(result.filename).toBe('logo.png');
    expect(result.mimeType).toBe('image/png');
  });

  it('Scenario: downloadAttachment falls back to Content-ID when an inline part has no filename', async () => {
    // Mirrors collectPayloadContent's filename derivation — without this, the
    // post-#67 contract reshape regressed CID-only inline parts to empty names.
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-cid',
        threadId: 'thread-cid',
        payload: {
          headers: [],
          parts: [
            {
              mimeType: 'image/png',
              body: { data: Buffer.from('cid-image').toString('base64url') },
              headers: [{ name: 'Content-ID', value: '<image003>' }],
            },
          ],
        },
      }),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.downloadAttachment('msg-cid', 'part:0');
    expect(result.filename).toBe('image003');
  });

  it('Scenario: downloadAttachment falls back to attachment-<path> when neither filename nor Content-ID exists', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-bare',
        threadId: 'thread-bare',
        payload: {
          headers: [],
          parts: [
            {
              mimeType: 'application/octet-stream',
              body: { attachmentId: 'att-bare-1', size: 4 },
              headers: [],
            },
          ],
        },
      }),
      getAttachment: vi.fn().mockResolvedValue({ data: Buffer.from('bare').toString('base64url') }),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.downloadAttachment('msg-bare', 'att-bare-1');
    expect(result.filename).toBe('attachment-0');
  });

  it('Scenario: downloadAttachment maps Gmail 404 on the attachment endpoint to AttachmentNotFoundError', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-1',
        threadId: 'thread-1',
        payload: { headers: [], parts: [{ mimeType: 'application/pdf', body: { attachmentId: 'att-gone' }, headers: [] }] },
      }),
      getAttachment: vi.fn().mockRejectedValue({ code: 404, message: 'Requested entity was not found' }),
    });
    const provider = new GmailEmailProvider(client);

    await expect(provider.downloadAttachment('msg-1', 'att-gone'))
      .rejects.toBeInstanceOf(AttachmentNotFoundError);
  });

  it('Scenario: downloadAttachment maps Gmail 404 on the message endpoint to AttachmentNotFoundError (part:* synthetic id)', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockRejectedValue({ response: { status: 404 } }),
    });
    const provider = new GmailEmailProvider(client);

    await expect(provider.downloadAttachment('msg-deleted', 'part:0'))
      .rejects.toBeInstanceOf(AttachmentNotFoundError);
  });

  it('Scenario: downloadAttachment propagates non-404 errors unchanged (action layer maps to PROVIDER_UNAVAILABLE)', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockRejectedValue({ code: 500, message: 'Internal error' }),
    });
    const provider = new GmailEmailProvider(client);

    await expect(provider.downloadAttachment('msg-1', 'att-1'))
      .rejects.toMatchObject({ code: 500 });
  });
});

// ---------------------------------------------------------------------------
// MIME composition, threading, reply-all drafts, and draft updates.
//
// These tests lock in Gmail provider parity with Microsoft after the
// multipart/alternative rewrite. The shape of the raw message is verified
// by decoding the base64url blob that the provider passes to the client
// and asserting specific headers, boundary placement, and part ordering.
// ---------------------------------------------------------------------------

function decodeRaw(base64url: string): string {
  return Buffer.from(base64url, 'base64url').toString('utf-8');
}

function lastRaw(fn: ReturnType<typeof vi.fn>, argIndex = 0): string {
  const call = fn.mock.calls[fn.mock.calls.length - 1];
  if (!call) throw new Error('mock was never called');
  return decodeRaw(call[argIndex] as string);
}

describe('provider-gmail/buildRawMessage', () => {
  it('Scenario: multipart/alternative when bodyHtml is set, plain first then html', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'HTML body',
      body: '### Hi',
      bodyHtml: '<h3>Hi</h3>',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    // Top-level content type is multipart/alternative, not text/html directly.
    expect(raw).toMatch(/^MIME-Version: 1\.0/m);
    expect(raw).toMatch(/Content-Type: multipart\/alternative; boundary="=_Part_[a-f0-9]{24}"/);

    // Extract the boundary and assert part ordering: plain first, html second.
    const boundaryMatch = raw.match(/boundary="(=_Part_[a-f0-9]{24})"/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;

    const plainIdx = raw.indexOf(`--${boundary}\r\nContent-Type: text/plain`);
    const htmlIdx = raw.indexOf(`--${boundary}\r\nContent-Type: text/html`);
    expect(plainIdx).toBeGreaterThan(-1);
    expect(htmlIdx).toBeGreaterThan(-1);
    expect(plainIdx).toBeLessThan(htmlIdx);

    // Both parts carry their respective content.
    expect(raw).toContain('### Hi');
    expect(raw).toContain('<h3>Hi</h3>');

    // Closing boundary is present.
    expect(raw).toContain(`--${boundary}--`);
  });

  it('Scenario: single-part text/plain fallback when bodyHtml is absent', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Plain body',
      body: 'line one\nline two',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
    expect(raw).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(raw).not.toContain('multipart/alternative');
    // Body line breaks are normalized to canonical CRLF inside the part.
    expect(raw).toContain('line one\r\nline two');
  });

  it('Scenario: Cc and Bcc headers emitted when recipients supplied', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com', name: 'Bob' }],
      cc: [{ email: 'carol@corp.com' }, { email: 'dave@corp.com' }],
      bcc: [{ email: 'legal@corp.com' }],
      subject: 'Meeting notes',
      body: 'See attached',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('To: "Bob" <bob@corp.com>');
    expect(raw).toContain('Cc: carol@corp.com, dave@corp.com');
    expect(raw).toContain('Bcc: legal@corp.com');
  });

  it('Scenario: Cc with display name emits quoted name-address form', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      cc: [{ name: 'Jane Doe', email: 'jane@corp.com' }],
      subject: 'Hi',
      body: 'Hello',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('Cc: "Jane Doe" <jane@corp.com>');
  });

  it('Scenario: Cc and Bcc headers omitted when no recipients', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Solo message',
      body: 'hi',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).not.toMatch(/^Cc:/m);
    expect(raw).not.toMatch(/^Bcc:/m);
  });

  it('Scenario: Subject is truncated to 255 chars and CRLF stripped', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const longSubject = 'A'.repeat(500);
    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: `${longSubject}\r\nInjected-Header: evil`,
      body: 'hi',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    // The 'A's are truncated; 'Injected-Header' never makes it into the output.
    expect(raw).not.toContain('Injected-Header: evil');
    // Subject length is capped at 255 (one line, no CRLF).
    const subjectMatch = raw.match(/^Subject: (.*)$/m);
    expect(subjectMatch).not.toBeNull();
    expect(subjectMatch![1]!.length).toBeLessThanOrEqual(255);
  });

  it('Scenario: boundary does not collide with body content (collision retry)', async () => {
    // Build a body that intentionally does NOT contain =_Part_ so the first
    // boundary generation succeeds. The collision path is exercised in the
    // unit test for generateBoundary; here we just confirm normal bodies
    // assemble cleanly without throwing.
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Collision check',
      body: 'No boundary markers here',
      bodyHtml: '<p>And none here</p>',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    const boundaryMatch = raw.match(/boundary="(=_Part_[a-f0-9]{24})"/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;
    // Boundary should appear exactly 3 times in the body: open, open, close.
    const occurrences = raw.split(`--${boundary}`).length - 1;
    expect(occurrences).toBe(3);
  });
});

describe('provider-gmail/mapGmailMessage threading headers', () => {
  it('Scenario: Message-ID / In-Reply-To / References populate when headers present', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-thread',
        threadId: 'thread-abc',
        labelIds: ['INBOX'],
        payload: {
          headers: [
            { name: 'From', value: 'alice@corp.com' },
            { name: 'To', value: 'bob@corp.com' },
            { name: 'Cc', value: 'carol@corp.com, dave@corp.com' },
            { name: 'Subject', value: 'Original thread' },
            { name: 'Date', value: '2026-01-15T10:00:00Z' },
            { name: 'Message-ID', value: '<msg-original@corp.com>' },
            { name: 'In-Reply-To', value: '<msg-parent@corp.com>' },
            { name: 'References', value: '<msg-r1@corp.com> <msg-r2@corp.com> <msg-parent@corp.com>' },
          ],
        },
        internalDate: String(Date.now()),
      }),
    });
    const provider = new GmailEmailProvider(client);

    const msg = await provider.getMessage('msg-thread');

    expect(msg.messageId).toBe('<msg-original@corp.com>');
    expect(msg.inReplyTo).toBe('<msg-parent@corp.com>');
    expect(msg.references).toEqual([
      '<msg-r1@corp.com>',
      '<msg-r2@corp.com>',
      '<msg-parent@corp.com>',
    ]);
    expect(msg.cc).toHaveLength(2);
    expect(msg.cc![0]!.email).toBe('carol@corp.com');
  });

  it('Scenario: threading headers are undefined when absent', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    const msg = await provider.getMessage('msg-1');

    expect(msg.messageId).toBeUndefined();
    expect(msg.inReplyTo).toBeUndefined();
    expect(msg.references).toBeUndefined();
  });
});

describe('provider-gmail/Reply Drafts', () => {
  function originalMessageMock() {
    return {
      id: 'msg-original',
      threadId: 'thread-abc',
      labelIds: ['INBOX'],
      payload: {
        headers: [
          { name: 'From', value: '"Alice" <alice@corp.com>' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Cc', value: 'carol@corp.com' },
          { name: 'Subject', value: 'Original thread' },
          { name: 'Date', value: '2026-01-15T10:00:00Z' },
          { name: 'Message-ID', value: '<msg-a@corp.com>' },
          { name: 'References', value: '<msg-r1@corp.com>' },
        ],
      },
      internalDate: String(Date.now()),
    };
  }

  it('Scenario: createReplyDraft emits In-Reply-To and References with thread ancestry', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(originalMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.createReplyDraft('msg-original', 'Thanks for the update.');

    expect(result.success).toBe(true);
    expect(result.draftId).toBe('draft-abc');
    // Client was called with the original threadId.
    expect(client.createDraft).toHaveBeenCalledWith(expect.any(String), 'thread-abc');

    const raw = lastRaw(client.createDraft as ReturnType<typeof vi.fn>);
    // Reply-all semantics: to=original.from, cc=original.to+original.cc.
    expect(raw).toContain('To: "Alice" <alice@corp.com>');
    expect(raw).toMatch(/Cc: .*bob@corp\.com.*carol@corp\.com/);
    expect(raw).toContain('Subject: Re: Original thread');
    expect(raw).toContain('In-Reply-To: <msg-a@corp.com>');
    // References appends the original's Message-ID to its existing list.
    expect(raw).toContain('References: <msg-r1@corp.com> <msg-a@corp.com>');
    expect(raw).toContain('Thanks for the update.');
  });

  it('Scenario: subject prefixed with Re: is not double-prefixed', async () => {
    const already = {
      ...originalMessageMock(),
      payload: {
        ...originalMessageMock().payload,
        headers: [
          ...originalMessageMock().payload.headers.filter(h => h.name !== 'Subject'),
          { name: 'Subject', value: 'Re: Original thread' },
        ],
      },
    };
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(already),
    });
    const provider = new GmailEmailProvider(client);

    await provider.createReplyDraft('msg-original', 'ack');

    const raw = lastRaw(client.createDraft as ReturnType<typeof vi.fn>);
    expect(raw).toContain('Subject: Re: Original thread');
    expect(raw).not.toContain('Subject: Re: Re:');
  });

  it('Scenario: createReplyDraft returns structured DRAFT_FAILED on error', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(originalMessageMock()),
      createDraft: vi.fn().mockRejectedValue(new Error('quota exceeded')),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.createReplyDraft('msg-original', 'body');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DRAFT_FAILED');
    expect(result.error?.message).toMatch(/quota exceeded/);
  });

  it('Scenario: replyAll: false omits thread To/Cc from Cc header', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(originalMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    await provider.createReplyDraft('msg-original', 'sender-only reply', { replyAll: false });

    const raw = lastRaw(client.createDraft as ReturnType<typeof vi.fn>);
    // To: still the original sender.
    expect(raw).toContain('To: "Alice" <alice@corp.com>');
    // Cc: must not contain the thread's To/Cc participants.
    expect(raw).not.toContain('bob@corp.com');
    expect(raw).not.toContain('carol@corp.com');
    // No Cc header at all when there are no recipients.
    expect(raw).not.toMatch(/^Cc:/m);
  });

  it('Scenario: replyAll: false still honors caller-supplied opts.cc', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(originalMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    await provider.createReplyDraft('msg-original', 'reply', {
      replyAll: false,
      cc: [{ email: 'manager@corp.com', name: 'Manager' }],
    });

    const raw = lastRaw(client.createDraft as ReturnType<typeof vi.fn>);
    expect(raw).toContain('To: "Alice" <alice@corp.com>');
    // Cc contains only the caller's address — thread participants excluded.
    expect(raw).toMatch(/^Cc: .*manager@corp\.com/m);
    expect(raw).not.toContain('bob@corp.com');
    expect(raw).not.toContain('carol@corp.com');
  });

  it('Scenario: replyAll omitted preserves reply-all behavior (regression guard)', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(originalMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    await provider.createReplyDraft('msg-original', 'reply');

    const raw = lastRaw(client.createDraft as ReturnType<typeof vi.fn>);
    expect(raw).toMatch(/Cc: .*bob@corp\.com.*carol@corp\.com/);
  });
});

describe('provider-gmail/Reply Threading on Send', () => {
  function ccThreadMessageMock() {
    return {
      id: 'msg-original',
      threadId: 'thread-xyz',
      labelIds: [],
      payload: {
        headers: [
          { name: 'From', value: '"Alice" <alice@corp.com>' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Cc', value: 'carol@corp.com' },
          { name: 'Subject', value: 'Urgent' },
          { name: 'Date', value: '2026-01-15T10:00:00Z' },
          { name: 'Message-ID', value: '<msg-xyz@corp.com>' },
        ],
      },
      internalDate: String(Date.now()),
    };
  }

  it('Scenario: replyToMessage sends with threadId and In-Reply-To header', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-original',
        threadId: 'thread-xyz',
        labelIds: [],
        payload: {
          headers: [
            { name: 'From', value: 'alice@corp.com' },
            { name: 'To', value: 'bob@corp.com' },
            { name: 'Subject', value: 'Urgent' },
            { name: 'Date', value: '2026-01-15T10:00:00Z' },
            { name: 'Message-ID', value: '<msg-xyz@corp.com>' },
          ],
        },
        internalDate: String(Date.now()),
      }),
    });
    const provider = new GmailEmailProvider(client);

    await provider.replyToMessage('msg-original', 'on it');

    // Assert send routed to the original thread.
    expect(client.sendMessage).toHaveBeenCalledWith(expect.any(String), 'thread-xyz');
    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('In-Reply-To: <msg-xyz@corp.com>');
    expect(raw).toContain('References: <msg-xyz@corp.com>');
    expect(raw).toContain('Subject: Re: Urgent');
  });

  it('Scenario: replyToMessage with replyAll: false omits thread participants from Cc', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(ccThreadMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    await provider.replyToMessage('msg-original', 'sender-only reply', { replyAll: false });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('To: "Alice" <alice@corp.com>');
    expect(raw).not.toContain('bob@corp.com');
    expect(raw).not.toContain('carol@corp.com');
    expect(raw).not.toMatch(/^Cc:/m);
  });

  it('Scenario: replyToMessage default (replyAll omitted) preserves reply-all', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(ccThreadMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    await provider.replyToMessage('msg-original', 'reply');

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toMatch(/Cc: .*bob@corp\.com.*carol@corp\.com/);
  });
});

describe('provider-gmail/Update Draft', () => {
  function draftMessageMock() {
    return {
      id: 'draft-existing',
      threadId: 'thread-draft',
      labelIds: ['DRAFT'],
      payload: {
        headers: [
          { name: 'From', value: 'me@corp.com' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Subject', value: 'Original subject' },
          { name: 'Date', value: '2026-01-15T10:00:00Z' },
          { name: 'Message-ID', value: '<draft@corp.com>' },
          { name: 'In-Reply-To', value: '<parent@corp.com>' },
          { name: 'References', value: '<root@corp.com> <parent@corp.com>' },
        ],
        body: { data: Buffer.from('Original body').toString('base64url') },
      },
      internalDate: String(Date.now()),
    };
  }

  it('Scenario: updateDraft merges partial over current draft and preserves threading', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(draftMessageMock()),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.updateDraft('draft-existing', { subject: 'New subject' });

    expect(result.success).toBe(true);
    expect(client.updateDraft).toHaveBeenCalledWith('draft-existing', expect.any(String), 'thread-draft');

    // updateDraft signature is (draftId, raw, threadId) — raw is at index 1.
    const raw = lastRaw(client.updateDraft as ReturnType<typeof vi.fn>, 1);
    // Old recipients and body preserved
    expect(raw).toContain('To: bob@corp.com');
    expect(raw).toContain('Original body');
    // New subject applied
    expect(raw).toContain('Subject: New subject');
    // Threading preserved across the replace
    expect(raw).toContain('In-Reply-To: <parent@corp.com>');
    expect(raw).toContain('References: <root@corp.com> <parent@corp.com>');
  });

  it('Scenario: updateDraft returns NOT_SUPPORTED when concrete client lacks the method', async () => {
    // Simulate an older downstream client that hasn't adopted the widened
    // interface yet — the method is undefined on the mock.
    const client = createMockGmailClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (client as any).updateDraft;
    const provider = new GmailEmailProvider(client);

    const result = await provider.updateDraft('draft-existing', { subject: 'New' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_SUPPORTED');
    expect(result.error?.message).toMatch(/not yet supported/);
  });

  it('Scenario: updateDraft returns structured UPDATE_DRAFT_FAILED on error', async () => {
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(draftMessageMock()),
      updateDraft: vi.fn().mockRejectedValue(new Error('draft not found')),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.updateDraft('draft-existing', { body: 'updated' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UPDATE_DRAFT_FAILED');
    expect(result.error?.message).toMatch(/draft not found/);
  });

  it('Scenario: updateDraft preserves attachments using the backing message id', async () => {
    const attachmentBytes = Buffer.from('PDF-ATTACHMENT-BYTES');
    // Backing message id deliberately differs from the draft id passed in.
    const draftWithAttachment = {
      id: 'msg-backing-123',
      threadId: 'thread-draft',
      labelIds: ['DRAFT'],
      payload: {
        headers: [
          { name: 'From', value: 'me@corp.com' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Subject', value: 'Original subject' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Original body').toString('base64url') } },
          { mimeType: 'application/pdf', filename: 'r.pdf', body: { attachmentId: 'att-1', size: attachmentBytes.length } },
        ],
      },
      internalDate: String(Date.now()),
    };
    const getAttachment = vi.fn().mockResolvedValue({
      data: attachmentBytes.toString('base64url'),
      size: attachmentBytes.length,
    });
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(draftWithAttachment),
      getAttachment,
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.updateDraft('draft-existing', { subject: 'New subject' });

    expect(result.success).toBe(true);
    // Attachment bytes fetched with the backing message id, not the draft id.
    expect(getAttachment).toHaveBeenCalledWith('msg-backing-123', 'att-1');
    const raw = lastRaw(client.updateDraft as ReturnType<typeof vi.fn>, 1);
    expect(raw).toContain('filename="r.pdf"');
    expect(raw).toContain(attachmentBytes.toString('base64'));
  });

  it('Scenario: updateDraft fails closed when preserving a draft with inline attachments', async () => {
    const draftWithInline = {
      id: 'msg-backing-456',
      threadId: 'thread-draft',
      labelIds: ['DRAFT'],
      payload: {
        headers: [
          { name: 'From', value: 'me@corp.com' },
          { name: 'To', value: 'bob@corp.com' },
          { name: 'Subject', value: 'Has inline image' },
        ],
        mimeType: 'multipart/related',
        parts: [
          { mimeType: 'text/html', body: { data: Buffer.from('<img src="cid:x">').toString('base64url') } },
          {
            mimeType: 'image/png',
            filename: 'logo.png',
            headers: [{ name: 'Content-ID', value: '<x>' }],
            body: { attachmentId: 'inline-1', size: 4 },
          },
        ],
      },
      internalDate: String(Date.now()),
    };
    const client = createMockGmailClient({
      getMessage: vi.fn().mockResolvedValue(draftWithInline),
    });
    const provider = new GmailEmailProvider(client);

    const result = await provider.updateDraft('draft-existing', { subject: 'New subject' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INLINE_ATTACHMENTS_UNSUPPORTED');
  });
});

describe('provider-gmail/buildRawMessage attachments', () => {
  const PDF = Buffer.from('%PDF-1.4\nbinary\x00bytes', 'binary');

  it('Scenario: attachments produce multipart/mixed with a base64 file part', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'With file',
      body: 'see attached',
      attachments: [{ filename: 'report.pdf', content: PDF, mimeType: 'application/pdf' }],
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="=_Part_[a-f0-9]{24}"/);
    expect(raw).toContain('Content-Type: application/pdf; name="report.pdf"');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain('Content-Disposition: attachment; filename="report.pdf"');
    // The file bytes appear base64-encoded, not raw.
    expect(raw).toContain(PDF.toString('base64'));
  });

  it('Scenario: text body uses quoted-printable, not 7bit', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Unicode',
      body: 'Café — déjà vu',
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('Content-Transfer-Encoding: quoted-printable');
    expect(raw).not.toContain('Content-Transfer-Encoding: 7bit');
    // Non-ASCII bytes are =XX-encoded (é = UTF-8 0xC3 0xA9).
    expect(raw).toContain('=C3=A9');
  });

  it('Scenario: attachments + bodyHtml nest multipart/alternative inside multipart/mixed', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Rich',
      body: 'plain',
      bodyHtml: '<p>rich</p>',
      attachments: [{ filename: 'a.pdf', content: PDF, mimeType: 'application/pdf' }],
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('multipart/alternative');
    const mixedIdx = raw.indexOf('multipart/mixed');
    const altIdx = raw.indexOf('multipart/alternative');
    expect(mixedIdx).toBeLessThan(altIdx);
  });

  it('Scenario: long base64 payload is wrapped at 76 chars', async () => {
    const client = createMockGmailClient();
    const provider = new GmailEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'bob@corp.com' }],
      subject: 'Big-ish',
      body: 'body',
      attachments: [{ filename: 'big.bin', content: Buffer.alloc(1000, 0x41), mimeType: 'application/octet-stream' }],
    });

    const raw = lastRaw(client.sendMessage as ReturnType<typeof vi.fn>);
    for (const line of raw.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});
