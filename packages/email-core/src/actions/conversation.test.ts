import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { getThreadAction } from './conversation.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  ctx = { provider };
});

describe('email-threading/Get Thread', () => {
  it('Scenario: Retrieve thread by message ID', async () => {
    // Setup a conversation with 3 messages
    provider.addMessage({
      id: 'msg1', subject: 'Contract Review', conversationId: 'conv-1',
      from: { email: 'alice@corp.com' }, receivedAt: '2024-03-15T10:00:00Z',
      isRead: true, hasAttachments: false,
    });
    provider.addMessage({
      id: 'msg2', subject: 'Re: Contract Review', conversationId: 'conv-1',
      from: { email: 'bob@corp.com' }, receivedAt: '2024-03-15T11:00:00Z',
      isRead: true, hasAttachments: false,
    });
    provider.addMessage({
      id: 'msg3', subject: 'Re: Contract Review', conversationId: 'conv-1',
      from: { email: 'alice@corp.com' }, receivedAt: '2024-03-15T12:00:00Z',
      isRead: false, hasAttachments: false,
    });

    const result = await getThreadAction.run(ctx, { message_id: 'msg1' });

    expect(result.messages).toHaveLength(3);
    expect(result.messageCount).toBe(3);
    // Chronological order
    expect(result.messages[0]!.id).toBe('msg1');
    expect(result.messages[2]!.id).toBe('msg3');
  });

  it('Scenario: Graph subject-change breakage', async () => {
    // Messages in same thread but Graph broke conversationId due to subject change
    // Use RFC headers to reconstruct
    provider.addMessage({
      id: 'msg-a', subject: 'Original Subject', messageId: '<a@corp.com>',
      from: { email: 'alice@corp.com' }, receivedAt: '2024-03-15T10:00:00Z',
      isRead: true, hasAttachments: false,
      // No conversationId — simulating the break
    });
    provider.addMessage({
      id: 'msg-b', subject: 'Changed Subject', messageId: '<b@corp.com>',
      inReplyTo: '<a@corp.com>', references: ['<a@corp.com>'],
      from: { email: 'bob@corp.com' }, receivedAt: '2024-03-15T11:00:00Z',
      isRead: true, hasAttachments: false,
    });

    const result = await getThreadAction.run(ctx, { message_id: 'msg-b' });

    // Falls back to RFC headers to reconstruct chain
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const ids = result.messages.map(m => m.id);
    expect(ids).toContain('msg-a');
    expect(ids).toContain('msg-b');
  });

  it('Scenario: Gmail 100-message cap', async () => {
    // Create a thread with 120 messages
    for (let i = 0; i < 120; i++) {
      provider.addMessage({
        id: `msg-${i}`,
        subject: 'Long Thread',
        conversationId: 'long-thread',
        from: { email: 'alice@corp.com' },
        receivedAt: new Date(2024, 0, 1, 0, i).toISOString(),
        isRead: true,
        hasAttachments: false,
      });
    }

    const result = await getThreadAction.run(ctx, { message_id: 'msg-0' });

    // Returns most recent 100 and indicates truncation
    expect(result.messages).toHaveLength(100);
    expect(result.messageCount).toBe(120);
    expect(result.isTruncated).toBe(true);
  });
});

describe('email-threading/RFC Header Fallback', () => {
  it('Scenario: Reconstruct broken thread', async () => {
    // Messages with incomplete conversationId but valid RFC headers
    provider.addMessage({
      id: 'root', subject: 'Discussion', messageId: '<root@corp.com>',
      from: { email: 'alice@corp.com' }, receivedAt: '2024-03-15T10:00:00Z',
      isRead: true, hasAttachments: false,
    });
    provider.addMessage({
      id: 'reply1', subject: 'Re: Discussion', messageId: '<reply1@corp.com>',
      inReplyTo: '<root@corp.com>', references: ['<root@corp.com>'],
      from: { email: 'bob@corp.com' }, receivedAt: '2024-03-15T11:00:00Z',
      isRead: true, hasAttachments: false,
    });
    provider.addMessage({
      id: 'reply2', subject: 'Re: Discussion', messageId: '<reply2@corp.com>',
      inReplyTo: '<reply1@corp.com>', references: ['<root@corp.com>', '<reply1@corp.com>'],
      from: { email: 'alice@corp.com' }, receivedAt: '2024-03-15T12:00:00Z',
      isRead: true, hasAttachments: false,
    });

    const result = await getThreadAction.run(ctx, { message_id: 'reply2' });

    // Uses In-Reply-To and References to find all messages
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const ids = result.messages.map(m => m.id);
    expect(ids).toContain('root');
    expect(ids).toContain('reply2');
  });
});
