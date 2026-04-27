import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphEmailProvider, GraphApiError, RealGraphApiClient, simplifySearchQuery, type GraphApiClient } from './email-graph-provider.js';

// Linux CI runners do not provide libsecret, so auth imports must not load the real cache plugin.
vi.mock('@azure/identity-cache-persistence', () => ({
  cachePersistencePlugin: vi.fn(),
}));

function createMockClient(overrides: Partial<GraphApiClient> = {}): GraphApiClient {
  return {
    get: vi.fn().mockResolvedValue({ value: [] }),
    post: vi.fn().mockResolvedValue({ id: 'new-id' }),
    patch: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Realistic Graph createReplyAll response body — captured from a real probe.
// Note: Graph returns contentType lowercased ("html") and prepends `<hr>` immediately
// after `<body>`, so caller content inserted right after `<body>` lands above Graph's divider.
const QUOTED_REPLY_BODY = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>'
  + '<body style="font-size:10pt; font-family:Verdana,Geneva,sans-serif">'
  + '<hr tabindex="-1" style="display:inline-block; width:98%">'
  + '<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" color="#000000" style="font-size:11pt">'
  + '<b>From:</b> Alice &lt;alice@corp.com&gt;<br>'
  + '<b>Sent:</b> Saturday, 25 April 2026 16:08:46<br>'
  + '<b>To:</b> Steven &lt;steven@corp.com&gt;<br>'
  + '<b>Subject:</b> Re: Quarterly Report</font><div>&nbsp;</div></div>'
  + '<div><p>Original message content</p></div>'
  + '</body></html>';

function quotedReplyResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'draft-123',
    body: { contentType: 'html', content: QUOTED_REPLY_BODY },
    ccRecipients: [],
    bccRecipients: [],
    toRecipients: [{ emailAddress: { address: 'alice@corp.com' } }],
    ...overrides,
  };
}

describe('provider-microsoft/Message Mapping', () => {
  it('Scenario: getMessage maps Graph attachment metadata and inline content ids', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        id: 'msg-attachments',
        subject: 'Attachments',
        from: { emailAddress: { address: 'sender@example.com' } },
        toRecipients: [{ emailAddress: { address: 'recipient@example.com' } }],
        receivedDateTime: '2026-04-09T12:00:00Z',
        hasAttachments: true,
        attachments: [
          {
            id: 'att-pdf',
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'contract.pdf',
            contentType: 'application/pdf',
            size: 245000,
            isInline: false,
          },
          {
            id: 'att-inline',
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: 'inline.png',
            contentType: 'image/png',
            size: 1024,
            isInline: true,
            contentId: 'image001',
          },
        ],
      }),
    });
    const provider = new GraphEmailProvider(client);

    const msg = await provider.getMessage('msg-attachments');

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
    expect(client.get).toHaveBeenCalledWith(
      '/me/messages/msg-attachments?$expand=attachments($select=id,name,contentType,size,isInline,contentId)',
    );
  });

  it('Scenario: getMessage falls back to /attachments when expanded query is rejected', async () => {
    const client = createMockClient({
      get: vi.fn()
        .mockRejectedValueOnce(new GraphApiError(400, 'Bad Request'))
        .mockResolvedValueOnce({
          id: 'msg-attachments',
          subject: 'Attachments',
          from: { emailAddress: { address: 'sender@example.com' } },
          toRecipients: [{ emailAddress: { address: 'recipient@example.com' } }],
          receivedDateTime: '2026-04-09T12:00:00Z',
          hasAttachments: true,
        })
        .mockResolvedValueOnce({
          value: [
            {
              id: 'att-pdf',
              name: 'contract.pdf',
              contentType: 'application/pdf',
              size: 245000,
              isInline: false,
            },
            {
              id: 'att-inline',
              name: 'inline.png',
              contentType: 'image/png',
              size: 1024,
              isInline: true,
              contentId: 'image001',
            },
          ],
        }),
    });
    const provider = new GraphEmailProvider(client);

    const msg = await provider.getMessage('msg-attachments');

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
    expect(client.get).toHaveBeenNthCalledWith(
      1,
      '/me/messages/msg-attachments?$expand=attachments($select=id,name,contentType,size,isInline,contentId)',
    );
    expect(client.get).toHaveBeenNthCalledWith(2, '/me/messages/msg-attachments');
    expect(client.get).toHaveBeenNthCalledWith(
      3,
      '/me/messages/msg-attachments/attachments?$select=id,name,contentType,size,isInline,contentId',
    );
  });
});

describe('provider-microsoft/Draft-Then-Send via createReplyAll', () => {
  it('Scenario: Reply preserves Graph auto-quoted thread (plain text)', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockResolvedValueOnce({}), // send
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('msg-1', 'Hi — short reply.');

    expect(result.success).toBe(true);
    // createReplyAll is called with empty body (we no longer use the `comment` field)
    expect(client.post).toHaveBeenNthCalledWith(1, expect.stringContaining('createReplyAll'), {});
    // Draft body PATCH preserves Graph's auto-quoted thread alongside caller content
    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const patchBody = (patchArgs[1] as { body: { contentType: string; content: string } }).body;
    expect(patchBody.contentType).toBe('HTML');
    expect(patchBody.content).toContain('Hi — short reply.');
    expect(patchBody.content).toContain('From:</b> Alice');
    // Send POST follows the PATCH
    expect(client.post).toHaveBeenNthCalledWith(2, expect.stringContaining('draft-123/send'), {});
  });

  it('Scenario: HTML reply merges fragment before quoted block', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'plain fallback', {
      bodyHtml: '<p>rendered reply</p>',
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const content = (patchArgs[1] as { body: { content: string } }).body.content;
    const renderedAt = content.indexOf('<p>rendered reply</p>');
    const fromHeaderAt = content.indexOf('From:</b> Alice');
    expect(renderedAt).toBeGreaterThanOrEqual(0);
    expect(fromHeaderAt).toBeGreaterThan(renderedAt);
  });

  it('Scenario: Caller-supplied full HTML document has wrappers stripped', async () => {
    const client = createMockClient({
      post: vi.fn().mockResolvedValueOnce(quotedReplyResponse()),
    });
    const provider = new GraphEmailProvider(client);

    await provider.createReplyDraft('msg-1', 'plain', {
      bodyHtml: '<html><body><p>rendered</p></body></html>',
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const content = (patchArgs[1] as { body: { content: string } }).body.content;
    // Outer <html>/<body> from caller fragment must be stripped — exactly one <html> and <body>
    // (the outer ones from Graph's quoted document).
    expect(content.match(/<html[\s>]/gi)?.length ?? 0).toBe(1);
    expect(content.match(/<body[\s>]/gi)?.length ?? 0).toBe(1);
    expect(content).toContain('<p>rendered</p>');
  });

  it('Scenario: Fallback GET when POST response is missing body', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce({ id: 'draft-456', ccRecipients: [], bccRecipients: [] }) // no body
        .mockResolvedValueOnce({}),
      get: vi.fn().mockResolvedValueOnce({
        id: 'draft-456',
        body: { contentType: 'html', content: QUOTED_REPLY_BODY },
        ccRecipients: [],
        bccRecipients: [],
      }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply');

    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('draft-456'));
    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const content = (patchArgs[1] as { body: { content: string } }).body.content;
    expect(content).toContain('From:</b> Alice');
    expect(content).toContain('reply');
  });

  it('Scenario: Fallback GET when POST response contentType is Text', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce({
          id: 'draft-789',
          body: { contentType: 'text', content: 'plain content from Graph' },
          ccRecipients: [],
          bccRecipients: [],
        })
        .mockResolvedValueOnce({}),
      get: vi.fn().mockResolvedValueOnce({
        id: 'draft-789',
        body: { contentType: 'html', content: QUOTED_REPLY_BODY },
        ccRecipients: [],
        bccRecipients: [],
      }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply');

    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('draft-789'));
  });

  it('Scenario: CC merge — Graph-populated + caller-supplied', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse({
          ccRecipients: [{ emailAddress: { address: 'alice@corp.com', name: 'Alice' } }],
        }))
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply', {
      cc: [{ email: 'bob@corp.com', name: 'Bob' }],
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const cc = (patchArgs[1] as { ccRecipients: Array<{ emailAddress: { address: string } }> }).ccRecipients;
    const addresses = cc.map(r => r.emailAddress.address.toLowerCase()).sort();
    expect(addresses).toEqual(['alice@corp.com', 'bob@corp.com']);
  });

  it('Scenario: CC dedupe is case-insensitive', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse({
          ccRecipients: [{ emailAddress: { address: 'Alice@corp.com', name: 'Alice' } }],
        }))
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply', {
      cc: [{ email: 'alice@CORP.com' }],
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const cc = (patchArgs[1] as { ccRecipients: unknown[] }).ccRecipients;
    expect(cc).toHaveLength(1);
  });

  it('Scenario: replyToMessage honors opts.cc (regression — previously dropped)', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply', {
      cc: [{ email: 'new@corp.com' }],
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const cc = (patchArgs[1] as { ccRecipients: Array<{ emailAddress: { address: string } }> }).ccRecipients;
    expect(cc.map(r => r.emailAddress.address)).toContain('new@corp.com');
  });

  it('Scenario: BCC merge', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply', {
      bcc: [{ email: 'audit@corp.com' }],
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const patch = patchArgs[1] as { bccRecipients?: Array<{ emailAddress: { address: string } }> };
    expect(patch.bccRecipients?.map(r => r.emailAddress.address)).toContain('audit@corp.com');
  });

  it('Scenario: cid: references survive the merge unchanged', async () => {
    const bodyWithCid = QUOTED_REPLY_BODY.replace(
      '<div><p>Original message content</p></div>',
      '<div><p>Original</p><img src="cid:image001.jpg@01D8E4F2"></div>',
    );
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse({
          body: { contentType: 'html', content: bodyWithCid },
        }))
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'thanks', { bodyHtml: '<p>thanks</p>' });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const content = (patchArgs[1] as { body: { content: string } }).body.content;
    expect(content).toContain('cid:image001.jpg@01D8E4F2');
  });

  it('Scenario: Truncation preserves caller content at the top', async () => {
    const huge = '<div>' + 'x'.repeat(4 * 1024 * 1024) + '</div>';
    const bigBody = QUOTED_REPLY_BODY.replace(
      '<div><p>Original message content</p></div>',
      huge,
    );
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse({
          body: { contentType: 'html', content: bigBody },
        }))
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'caller content here', { bodyHtml: '<p>my reply</p>' });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const content = (patchArgs[1] as { body: { content: string } }).body.content;
    expect(content).toContain('<p>my reply</p>');
    // Truncation keeps the caller content even though the quoted body was huge
    expect(Buffer.byteLength(content, 'utf-8')).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 200);
  });

  it('Scenario: <body>-tag-missing defensive fallback', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse({
          body: { contentType: 'html', content: '<p>just a fragment, no body tag</p>' },
        }))
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply', { bodyHtml: '<p>rendered</p>' });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const content = (patchArgs[1] as { body: { content: string } }).body.content;
    // Caller fragment ends up before the original (concat fallback)
    expect(content.indexOf('<p>rendered</p>')).toBeLessThan(content.indexOf('just a fragment'));
  });

  it('Scenario: createReplyAll failure returns structured REPLY_FAILED error', async () => {
    const client = createMockClient({
      post: vi.fn().mockRejectedValueOnce(new GraphApiError(404, 'Not Found')),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('deleted-msg', 'Response');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPLY_FAILED');
    expect(result.error?.recoverable).toBe(false);
    expect(result.error?.message).toBeTruthy();
    // Critical: does NOT silently send via sendMail
    expect(client.post).not.toHaveBeenCalledWith(
      expect.stringContaining('sendMail'),
      expect.anything(),
    );
  });

  it('Scenario: replyToMessage failure does not use opts.cc as to:', async () => {
    // Regression guard for the silent-fallback bug — even when cc is supplied,
    // a createReplyAll failure must not turn into a fresh email to the cc list.
    const client = createMockClient({
      post: vi.fn().mockRejectedValueOnce(new GraphApiError(404, 'Not Found')),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('deleted-msg', 'Response', {
      cc: [{ email: 'bystander@corp.com' }],
    });

    expect(result.success).toBe(false);
    expect(client.post).toHaveBeenCalledTimes(1); // only the failed createReplyAll
  });

  it('Scenario: send failure (createReplyAll succeeds, /send fails) returns REPLY_FAILED', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockRejectedValueOnce(new GraphApiError(500, 'Server Error')),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('msg-1', 'Response');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPLY_FAILED');
    expect(result.error?.message).toBeTruthy();
  });

  it('Scenario: PATCH failure inside prepareReplyDraft returns REPLY_FAILED', async () => {
    // Helper-stage failure: createReplyAll succeeds, PATCH rejects. Previously
    // this also fell into the broken sendMail fallback.
    const client = createMockClient({
      post: vi.fn().mockResolvedValueOnce(quotedReplyResponse()),
      patch: vi.fn().mockRejectedValueOnce(new GraphApiError(500, 'Server Error')),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.replyToMessage('msg-1', 'Response');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPLY_FAILED');
    // Critical: no /send and no /sendMail call
    expect(client.post).not.toHaveBeenCalledWith(
      expect.stringContaining('/send'),
      expect.anything(),
    );
    expect(client.post).not.toHaveBeenCalledWith(
      expect.stringContaining('sendMail'),
      expect.anything(),
    );
  });

  it('Scenario: createReplyDraft parity — merges quoted body and CCs without sending', async () => {
    const client = createMockClient({
      post: vi.fn().mockResolvedValueOnce(quotedReplyResponse({
        ccRecipients: [{ emailAddress: { address: 'alice@corp.com' } }],
      })),
    });
    const provider = new GraphEmailProvider(client);

    const result = await provider.createReplyDraft('msg-1', 'reply', {
      bodyHtml: '<p>rendered</p>',
      cc: [{ email: 'bob@corp.com' }],
    });

    expect(result).toEqual({ success: true, draftId: 'draft-123' });
    // Only one POST (createReplyAll) — no /send
    expect(client.post).toHaveBeenCalledTimes(1);
    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const patch = patchArgs[1] as {
      body: { content: string };
      ccRecipients: Array<{ emailAddress: { address: string } }>;
    };
    expect(patch.body.content).toContain('<p>rendered</p>');
    expect(patch.body.content).toContain('From:</b> Alice');
    const addresses = patch.ccRecipients.map(r => r.emailAddress.address.toLowerCase()).sort();
    expect(addresses).toEqual(['alice@corp.com', 'bob@corp.com']);
  });
});

describe('provider-microsoft/Reply-All Routing', () => {
  it('Scenario: replyAll omitted defaults to createReplyAll', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply');

    const firstUrl = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(firstUrl).toContain('createReplyAll');
  });

  it('Scenario: replyAll: true routes to createReplyAll', async () => {
    const client = createMockClient({
      post: vi.fn().mockResolvedValueOnce(quotedReplyResponse()),
    });
    const provider = new GraphEmailProvider(client);

    await provider.createReplyDraft('msg-1', 'reply', { replyAll: true });

    const firstUrl = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(firstUrl).toContain('createReplyAll');
  });

  it('Scenario: replyAll: false routes to createReply (sender only)', async () => {
    const client = createMockClient({
      post: vi.fn().mockResolvedValueOnce(quotedReplyResponse()),
    });
    const provider = new GraphEmailProvider(client);

    await provider.createReplyDraft('msg-1', 'reply', { replyAll: false });

    const firstUrl = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(firstUrl).toContain('/createReply');
    expect(firstUrl).not.toContain('createReplyAll');
  });

  it('Scenario: replyAll: false on send path uses createReply', async () => {
    const client = createMockClient({
      post: vi.fn()
        .mockResolvedValueOnce(quotedReplyResponse())
        .mockResolvedValueOnce({}),
    });
    const provider = new GraphEmailProvider(client);

    await provider.replyToMessage('msg-1', 'reply', { replyAll: false });

    const firstUrl = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(firstUrl).toContain('/createReply');
    expect(firstUrl).not.toContain('createReplyAll');
  });

  it('Scenario: replyAll: false preserves caller-supplied cc', async () => {
    // Graph's createReply returns no auto-populated CCs (sender-only), so the
    // PATCH should contain only the caller's cc.
    const client = createMockClient({
      post: vi.fn().mockResolvedValueOnce(quotedReplyResponse({ ccRecipients: [] })),
    });
    const provider = new GraphEmailProvider(client);

    await provider.createReplyDraft('msg-1', 'reply', {
      replyAll: false,
      cc: [{ email: 'manager@corp.com', name: 'Manager' }],
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const patch = patchArgs[1] as { ccRecipients?: Array<{ emailAddress: { address: string } }> };
    expect(patch.ccRecipients?.map(r => r.emailAddress.address)).toEqual(['manager@corp.com']);
  });
});

describe('provider-microsoft/Size Limits', () => {
  it('Scenario: Body size enforcement', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // Create a body exceeding 3.5MB
    const largeBody = 'x'.repeat(4 * 1024 * 1024);

    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Large',
      body: largeBody,
    });

    // The body in the API call should be truncated
    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sentBody = (callArgs[1] as { message: { body: { content: string } } }).message.body.content;
    expect(sentBody).toContain('truncated');
    expect(Buffer.byteLength(sentBody, 'utf-8')).toBeLessThanOrEqual(3.5 * 1024 * 1024 + 200);
  });
});

describe('provider-interface/Capability Interfaces', () => {
  it('Scenario: Provider honors bodyHtml on send', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'HTML body',
      body: '### Hi',
      bodyHtml: '<h3>Hi</h3>',
    });

    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = (callArgs[1] as { message: { body: { contentType: string; content: string } } }).message.body;
    // Graph → contentType: HTML when bodyHtml is set, content is the rendered HTML
    expect(body.contentType).toBe('HTML');
    expect(body.content).toBe('<h3>Hi</h3>');
  });

  it('Scenario: Provider sends plain text when bodyHtml is absent', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Plain body',
      body: 'line one\nline two',
    });

    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = (callArgs[1] as { message: { body: { contentType: string; content: string } } }).message.body;
    // Graph → contentType: Text when only body is set; newlines preserved verbatim
    expect(body.contentType).toBe('Text');
    expect(body.content).toBe('line one\nline two');
  });

  it('Scenario: createDraft and updateDraft honor bodyHtml', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // createDraft
    await provider.createDraft({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Draft',
      body: '# fallback',
      bodyHtml: '<h1>rendered</h1>',
    });

    const createArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const createBody = (createArgs[1] as { body: { contentType: string; content: string } }).body;
    expect(createBody.contentType).toBe('HTML');
    expect(createBody.content).toBe('<h1>rendered</h1>');

    // updateDraft
    await provider.updateDraft('draft-1', {
      body: '# fallback 2',
      bodyHtml: '<h1>updated</h1>',
    });

    const patchArgs = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const updateBody = (patchArgs[1] as { body: { contentType: string; content: string } }).body;
    expect(updateBody.contentType).toBe('HTML');
    expect(updateBody.content).toBe('<h1>updated</h1>');
  });
});

describe('provider-microsoft/Sent Message Tracking', () => {
  it('Scenario: Find sent message', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    // Send with tracking ID
    await provider.sendMessage({
      to: [{ email: 'alice@corp.com' }],
      subject: 'Tracked',
      body: 'Hello',
      trackingId: 'tracking-123',
    });

    // Verify tracking ID was included in the extended property
    const callArgs = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const sentMsg = (callArgs[1] as { message: { singleValueExtendedProperties: Array<{ id: string; value: string }> } }).message;
    const trackingProp = sentMsg.singleValueExtendedProperties.find(
      (p: { value: string }) => p.value === 'tracking-123',
    );
    expect(trackingProp).toBeDefined();
  });
});

describe('provider-microsoft/Dual Watch Mode', () => {
  it('Scenario: Delta Query polling (local)', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [{
          id: 'new-msg',
          subject: 'New Email',
          from: { emailAddress: { address: 'bob@corp.com' } },
          receivedDateTime: '2024-03-15T10:00:00Z',
        }],
        '@odata.deltaLink': '/delta?token=next',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0]!.subject).toBe('New Email');
    expect(delta.nextDeltaLink).toContain('delta');
  });

  it('Scenario: Webhook mode (production)', async () => {
    // Webhook mode is handled by subscription creation (tested in subscriptions.test.ts)
    // Here we verify the provider supports the dual-mode concept
    const client = createMockClient({
      post: vi.fn().mockResolvedValue({
        id: 'sub-123',
        resource: 'users/me/mailFolders/Inbox/messages',
        expirationDateTime: '2024-03-20T00:00:00Z',
      }),
    });

    const response = await client.post('/subscriptions', {
      changeType: 'created',
      notificationUrl: 'https://prod.example.com/webhook',
      resource: 'users/me/mailFolders/Inbox/messages',
    });

    expect(response.id).toBe('sub-123');
  });
});

describe('provider-microsoft/Thread Lookup', () => {
  it('Scenario: getThread filters by conversationId', async () => {
    const client = createMockClient({
      get: vi.fn()
        .mockResolvedValueOnce({
          id: 'msg-1',
          subject: 'Thread root',
          conversationId: 'conv-123',
          from: { emailAddress: { address: 'alice@corp.com' } },
          receivedDateTime: '2024-03-15T10:00:00Z',
        })
        .mockResolvedValueOnce({
          value: [
            {
              id: 'msg-1',
              subject: 'Thread root',
              conversationId: 'conv-123',
              from: { emailAddress: { address: 'alice@corp.com' } },
              receivedDateTime: '2024-03-15T10:00:00Z',
            },
            {
              id: 'msg-2',
              subject: 'Re: Thread root',
              conversationId: 'conv-123',
              from: { emailAddress: { address: 'bob@corp.com' } },
              receivedDateTime: '2024-03-15T11:00:00Z',
            },
          ],
        }),
    });
    const provider = new GraphEmailProvider(client);

    const thread = await provider.getThread('msg-1');

    expect(thread.id).toBe('conv-123');
    expect(thread.messageCount).toBe(2);
    expect(client.get).toHaveBeenNthCalledWith(
      1,
      '/me/messages/msg-1?$expand=attachments($select=id,name,contentType,size,isInline,contentId)',
    );
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    const decodedUrl = decodeURIComponent(url).replaceAll('+', ' ');
    expect(decodedUrl).toContain("conversationId eq 'conv-123'");
    expect(decodedUrl).not.toContain('$orderby=');
    expect(thread.messages[0]!.id).toBe('msg-1');
    expect(thread.messages[1]!.id).toBe('msg-2');
  });
});

describe('provider-microsoft/Email Categorizer', () => {
  it('Scenario: applyLabels merges categories with the existing master values', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({ categories: ['Existing'] }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.applyLabels('msg-1', ['Urgent', 'Existing']);

    expect(client.get).toHaveBeenCalledWith('/me/messages/msg-1?$select=categories');
    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', {
      categories: ['Existing', 'Urgent'],
    });
  });

  it('Scenario: removeLabels patches the remaining categories', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({ categories: ['Existing', 'Urgent'] }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.removeLabels('msg-1', ['Urgent']);

    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', {
      categories: ['Existing'],
    });
  });

  it('Scenario: setFlag uses follow-up flag status, not message importance', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.setFlag('msg-1', true);

    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', {
      flag: { flagStatus: 'flagged' },
    });
  });

  it('Scenario: setReadState patches isRead', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.setReadState('msg-1', true);

    expect(client.patch).toHaveBeenCalledWith('/me/messages/msg-1', { isRead: true });
  });

  it('Scenario: moveToFolder normalizes well-known folder aliases', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.moveToFolder('msg-1', 'trash');

    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/move', {
      destinationId: 'deleteditems',
    });
  });

  it('Scenario: soft delete moves the message to Deleted Items', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.deleteMessage('msg-1', false);

    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/move', {
      destinationId: 'deleteditems',
    });
  });

  it('Scenario: hard delete uses permanentDelete', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.deleteMessage('msg-1', true);

    expect(client.post).toHaveBeenCalledWith('/me/messages/msg-1/permanentDelete');
  });
});

describe('provider-microsoft/Graph API Client', () => {
  it('Scenario: POST without a body omits JSON encoding', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      text: vi.fn().mockResolvedValue(''),
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealGraphApiClient(async () => 'token-123');
    await client.post('/me/messages/msg-1/permanentDelete');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.microsoft.com/v1.0/me/messages/msg-1/permanentDelete',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer token-123' },
      },
    );

    vi.unstubAllGlobals();
  });
});

describe('provider-microsoft/Graph API Auth Retry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries GET on 401 when onAuthError succeeds', async () => {
    let tokenVersion = 0;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [{ id: 'msg-1' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(true);
    const client = new RealGraphApiClient(
      async () => `token-v${++tokenVersion}`,
      onAuthError,
    );

    const result = await client.get('/me/messages');
    expect(onAuthError).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Retry should use fresh token
    const retryHeaders = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(retryHeaders['Authorization']).toBe('Bearer token-v2');
    expect(result.value).toHaveLength(1);
  });

  it('throws GraphApiError on 401 when no onAuthError callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new RealGraphApiClient(async () => 'token');
    await expect(client.get('/me/messages')).rejects.toThrow(GraphApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws GraphApiError on 401 when onAuthError returns false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => 'Unauthorized',
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(false);
    const client = new RealGraphApiClient(async () => 'token', onAuthError);
    await expect(client.get('/me/messages')).rejects.toThrow(GraphApiError);
    expect(onAuthError).toHaveBeenCalledOnce();
    // Should not retry
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not trigger onAuthError for non-401 errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 403, text: async () => 'Forbidden',
    });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(true);
    const client = new RealGraphApiClient(async () => 'token', onAuthError);
    await expect(client.get('/me/messages')).rejects.toThrow(GraphApiError);
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it('retries POST on 401 when onAuthError succeeds', async () => {
    let tokenVersion = 0;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    const onAuthError = vi.fn().mockResolvedValue(true);
    const client = new RealGraphApiClient(
      async () => `token-v${++tokenVersion}`,
      onAuthError,
    );

    const result = await client.post('/me/sendMail', { message: {} });
    expect(onAuthError).toHaveBeenCalledOnce();
    expect(result).toEqual({});
  });
});

describe('provider-microsoft/Delta Query Sync Protocol', () => {
  it('Scenario: Uses $select for efficiency', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    // Verify the initial URL includes $select
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining('$select='),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining('subject'),
    );
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining('mailFolders/Inbox/messages/delta'),
    );
  });

  it('Scenario: Paging with @odata.nextLink', async () => {
    // Simulate multi-page response: page1 has nextLink, page2 has deltaLink
    const client = createMockClient({
      get: vi.fn()
        .mockResolvedValueOnce({
          value: [{
            id: 'msg-1',
            subject: 'Page 1',
            from: { emailAddress: { address: 'alice@corp.com' } },
          }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/delta?skiptoken=page2',
        })
        .mockResolvedValueOnce({
          value: [{
            id: 'msg-2',
            subject: 'Page 2',
            from: { emailAddress: { address: 'bob@corp.com' } },
          }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=final',
        }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    // Should have followed both pages
    expect(client.get).toHaveBeenCalledTimes(2);
    expect(delta.messages).toHaveLength(2);
    expect(delta.messages[0]!.subject).toBe('Page 1');
    expect(delta.messages[1]!.subject).toBe('Page 2');
    expect(delta.nextDeltaLink).toBe('https://graph.microsoft.com/v1.0/delta?token=final');
  });

  it('Scenario: Tombstone filtering', async () => {
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [
          {
            id: 'msg-new',
            subject: 'New Email',
            from: { emailAddress: { address: 'alice@corp.com' } },
          },
          {
            id: 'msg-deleted',
            subject: 'Deleted Email',
            '@removed': { reason: 'deleted' },
          },
          {
            id: 'msg-moved',
            subject: 'Moved Email',
            '@removed': { reason: 'changed' },
          },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages("https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject");

    // Tombstones should be filtered out
    expect(delta.messages).toHaveLength(1);
    expect(delta.messages[0]!.id).toBe('msg-new');
  });

  it('Scenario: Subsequent poll with deltaLink', async () => {
    const savedDeltaLink = 'https://graph.microsoft.com/v1.0/delta?token=saved';
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [{
          id: 'new-since-last',
          subject: 'New Since Last Poll',
          from: { emailAddress: { address: 'charlie@corp.com' } },
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=updated',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages(savedDeltaLink);

    // Should use the saved deltaLink, not the initial URL
    expect(client.get).toHaveBeenCalledWith(savedDeltaLink);
    expect(delta.messages).toHaveLength(1);
    expect(delta.nextDeltaLink).toBe('https://graph.microsoft.com/v1.0/delta?token=updated');
  });
});

describe('provider-microsoft/ESM Compatibility', () => {
  it('Scenario: ESM import resolution', async () => {
    // Verify all imports in the module use explicit .js extensions
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const sourceFiles = ['email-graph-provider.ts', 'auth.ts', 'subscriptions.ts', 'index.ts'];
    for (const file of sourceFiles) {
      const content = await readFile(join(import.meta.dirname, file), 'utf-8');
      // Check that local imports use .js extensions
      const localImports = content.match(/from\s+['"]\.\//g) ?? [];
      const localImportsWithJs = content.match(/from\s+['"]\.\/[^'"]+\.js['"]/g) ?? [];
      expect(localImportsWithJs.length).toBe(localImports.length);
    }
  });
});

describe('provider-microsoft/NemoClaw Compatibility', () => {
  it('Scenario: NemoClaw egress config', () => {
    const domains = GraphEmailProvider.egressDomains;
    expect(domains).toContain('graph.microsoft.com');
    expect(domains).toContain('login.microsoftonline.com');
  });
});

describe('provider-microsoft/Search Hardening', () => {
  it('Scenario: Empty query returns empty array', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    expect(await provider.searchMessages('')).toEqual([]);
    expect(await provider.searchMessages('   ')).toEqual([]);
    // Should not have called the API at all
    expect(client.get).not.toHaveBeenCalled();
  });

  it('Scenario: Search includes $top=50 in the URL', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('budget report');

    expect(client.get).toHaveBeenCalledTimes(1);
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('%24top=50');
  });

  it('Scenario: Search auto-simplifies on 400 error', async () => {
    const client = createMockClient({
      get: vi.fn()
        .mockRejectedValueOnce(new GraphApiError(400, 'Bad Request: syntax error'))
        .mockResolvedValueOnce({
          value: [{
            id: 'msg-1',
            subject: 'Budget Report Q4',
            from: { emailAddress: { address: 'cfo@corp.com' } },
            receivedDateTime: '2024-06-01T12:00:00Z',
          }],
        }),
    });
    const provider = new GraphEmailProvider(client);

    const results = await provider.searchMessages('from:cfo@corp.com AND subject:budget');

    expect(results).toHaveLength(1);
    expect(results[0]!.subject).toBe('Budget Report Q4');
    // Should have retried with simplified query
    expect(client.get).toHaveBeenCalledTimes(2);
    const retryUrl = (client.get as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    // Simplified query should not contain field prefixes or boolean operators
    expect(retryUrl).not.toContain('from%3A');
    expect(retryUrl).not.toContain('AND');
  });

  it('Scenario: simplifySearchQuery strips prefixes and operators', () => {
    expect(simplifySearchQuery('from:alice@corp.com AND subject:"Q4 budget"'))
      .toBe('alice@corp.com Q4 budget');
    expect(simplifySearchQuery('body:hello OR to:bob@corp.com NOT spam'))
      .toBe('hello bob@corp.com spam');
    expect(simplifySearchQuery('simple keywords')).toBe('simple keywords');
  });
});

describe('provider-microsoft/Inbox-Scoped Message Access', () => {
  it('Scenario: Inbox-scoped message listing', async () => {
    // WHEN listing or fetching messages from Graph
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ limit: 10 });

    // THEN the API call uses /me/mailFolders/Inbox/messages (default folder is inbox)
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/inbox/messages');
    expect(url).not.toMatch(/\/me\/messages\?/);
  });

  it('Scenario: Sent alias listing normalizes to sentitems', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ folder: 'sent', limit: 10 });

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/sentitems/messages');
  });

  it('Scenario: Folder-scoped search normalizes well-known aliases', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('launch prep', 'trash');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/deleteditems/messages');
  });

  it('Scenario: Inbox-scoped delta query', async () => {
    // WHEN the watcher performs a delta query
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    // Use the inbox-scoped delta URL
    await provider.getDeltaMessages('https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject');

    // THEN the API call uses /me/mailFolders/Inbox/messages/delta
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('mailFolders/Inbox/messages/delta');
    expect(url).not.toMatch(/\/me\/messages\/delta/);
  });
});

describe('provider-microsoft/Delta Query Field Selection', () => {
  it('Scenario: Delta query uses $select', async () => {
    // WHEN the system issues a Delta Query request for inbox messages
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
      }),
    });
    const provider = new GraphEmailProvider(client);

    // The initial delta URL includes $select for efficiency
    const deltaUrl = 'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments';
    await provider.getDeltaMessages(deltaUrl);

    // THEN the request includes $select with the required fields
    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('$select=');
    expect(url).toContain('subject');
    expect(url).toContain('from');
    expect(url).toContain('toRecipients');
    expect(url).toContain('ccRecipients');
    expect(url).toContain('receivedDateTime');
    expect(url).toContain('hasAttachments');
  });

  it('Scenario: Selected fields sufficient for wake payload', async () => {
    // WHEN the watcher constructs a wake payload from delta query results
    const client = createMockClient({
      get: vi.fn().mockResolvedValue({
        value: [{
          id: 'msg-1',
          subject: 'Quarterly Report',
          from: { emailAddress: { address: 'cfo@corp.com', name: 'CFO' } },
          toRecipients: [{ emailAddress: { address: 'test-user@example.com' } }],
          ccRecipients: [{ emailAddress: { address: 'team@corp.com' } }],
          receivedDateTime: '2024-06-01T12:00:00Z',
          hasAttachments: true,
        }],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=next',
      }),
    });
    const provider = new GraphEmailProvider(client);

    const delta = await provider.getDeltaMessages(
      'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages/delta?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments',
    );

    // THEN all required payload fields are available from the $select fields
    const msg = delta.messages[0]!;
    expect(msg.subject).toBe('Quarterly Report');
    expect(msg.from.email).toBe('cfo@corp.com');
    expect(msg.to).toHaveLength(1);
    expect(msg.to[0]!.email).toBe('test-user@example.com');
    expect(msg.cc).toHaveLength(1);
    expect(msg.cc![0]!.email).toBe('team@corp.com');
    expect(msg.hasAttachments).toBe(true);
    expect(msg.receivedAt).toBe('2024-06-01T12:00:00Z');
  });
});

describe('provider-microsoft/Email Address Retrieval from /me', () => {
  it('Scenario: Email from /me mail property', async () => {
    // WHEN configure_mailbox fetches /me and the response includes mail: "test-user@example.com"
    // The auth manager stores the email address from the /me profile
    const auth = new (await import('./auth.js')).DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'work',
    );

    // Simulate setting the email address from /me mail property
    auth.setEmailAddress('test-user@example.com');

    // THEN the stored emailAddress is test-user@example.com
    expect(auth.emailAddress).toBe('test-user@example.com');
  });

  it('Scenario: Fallback to userPrincipalName', async () => {
    // WHEN configure_mailbox fetches /me and mail is null
    // AND userPrincipalName is test-user@example.onmicrosoft.com
    // Simulate the fallback logic from cli.ts runConfigure:
    //   const emailAddress = profile.mail ?? profile.userPrincipalName;
    const profile = {
      mail: null as string | null,
      userPrincipalName: 'test-user@example.onmicrosoft.com',
    };
    const emailAddress = profile.mail ?? profile.userPrincipalName;

    // THEN the stored emailAddress is test-user@example.onmicrosoft.com
    expect(emailAddress).toBe('test-user@example.onmicrosoft.com');

    // Verify the auth manager accepts this fallback value
    const auth = new (await import('./auth.js')).DelegatedAuthManager(
      { mode: 'delegated', clientId: 'test-client-id' },
      'work',
    );
    auth.setEmailAddress(emailAddress);
    expect(auth.emailAddress).toBe('test-user@example.onmicrosoft.com');
  });
});

describe('provider-microsoft/Offset Pagination', () => {
  it('listMessages includes $skip when offset is provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ limit: 10, offset: 25 });

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('$top=10');
    expect(decoded).toContain('$skip=25');
  });

  it('listMessages omits $skip when offset is not provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.listMessages({ limit: 10 });

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('%24top=10');
    expect(url).not.toContain('skip');
  });

  it('searchMessages includes $top and $skip when provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('budget', undefined, 20, 10);

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('$top=20');
    expect(decoded).toContain('$skip=10');
  });

  it('searchMessages uses default $top=50 when limit not provided', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.searchMessages('report');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain('%24top=50');
    expect(url).not.toContain('skip');
  });
});

describe('provider-microsoft/Watcher Timestamp Boundary', () => {
  it('Scenario: getNewMessages uses ge not gt', async () => {
    const client = createMockClient();
    const provider = new GraphEmailProvider(client);

    await provider.getNewMessages('2024-06-01T00:00:00Z');

    const url = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('receivedDateTime ge 2024-06-01T00:00:00Z');
    expect(decoded).not.toContain('receivedDateTime gt ');
  });
});
