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
    expect(result.isTruncated).toBe(false);
    // Chronological order
    expect(result.messages[0]!.id).toBe('msg1');
    expect(result.messages[2]!.id).toBe('msg3');
  });

  it('Scenario: Thread messages surface recipient topology as explicit arrays (issue #102)', async () => {
    provider.addMessage({
      id: 'm1', subject: 'Re: follow-up from coffee', conversationId: 'conv-x',
      from: { email: 'alice@corp.com', name: 'Alice Smith' },
      to: [{ email: 'bob@corp.com', name: 'Bob Jones' }],
      cc: [{ email: 'nadim@corp.com', name: 'Nadim Cheaib' }],
      receivedAt: '2024-03-15T10:00:00Z', isRead: true, hasAttachments: false,
    });
    // Second message has no cc/bcc — must come back as [] arrays, not missing keys.
    provider.addMessage({
      id: 'm2', subject: 'Re: follow-up from coffee', conversationId: 'conv-x',
      from: { email: 'bob@corp.com', name: 'Bob Jones' },
      to: [{ email: 'alice@corp.com', name: 'Alice Smith' }],
      receivedAt: '2024-03-15T11:00:00Z', isRead: false, hasAttachments: false,
    });

    const result = await getThreadAction.run(ctx, { message_id: 'm1' });

    expect(result.messages[0]!.to).toEqual(['Bob Jones <bob@corp.com>']);
    expect(result.messages[0]!.cc).toEqual(['Nadim Cheaib <nadim@corp.com>']);
    expect(result.messages[0]!.bcc).toEqual([]);
    expect(result.messages[1]!.cc).toEqual([]);
    expect(result.messages[1]!.bcc).toEqual([]);
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

    // Returns the queried anchor plus the most recent 99 and indicates truncation
    expect(result.messages).toHaveLength(100);
    expect(result.messageCount).toBe(120);
    expect(result.isTruncated).toBe(true);
    expect(result.messages.map(message => message.id)).toContain('msg-0');
    expect(result.messages.at(-1)!.id).toBe('msg-119');
  });

  it('Scenario: honors a provider-reported isTruncated flag even when counts match', async () => {
    // A provider may cap a thread and report it explicitly (e.g. Gmail's 100-msg
    // cap) without the returned array being shorter than messageCount. The action
    // must not report the thread as complete in that case.
    const truncatingCtx = {
      provider: {
        getThread: async () => ({
          id: 'conv-capped',
          subject: 'Capped',
          messages: [
            { id: 'a', subject: 'Capped', from: { email: 'x@corp.com' }, to: [], cc: [], bcc: [], receivedAt: '2024-03-15T10:00:00Z', isRead: true },
          ],
          messageCount: 1,
          isTruncated: true,
        }),
      },
    } as unknown as ActionContext;

    const result = await getThreadAction.run(truncatingCtx, { message_id: 'a' });

    expect(result.isTruncated).toBe(true);
  });

  it('Scenario: anchor is placed chronologically when receivedAt is not lexically sortable', async () => {
    // Gmail carries the raw RFC 2822 Date header in receivedAt; weekday-prefixed
    // strings do NOT sort lexically by time. With 101 messages the queried oldest
    // message falls outside the newest-100 window and is re-inserted as the
    // anchor — this must stay chronological (prepend), not re-sort lexically.
    for (let i = 0; i <= 100; i++) {
      provider.addMessage({
        id: `msg-${i}`,
        subject: 'RFC Thread',
        conversationId: 'rfc-thread',
        from: { email: 'alice@corp.com' },
        // One message per day → weekday prefix cycles, so lexical order != time order.
        receivedAt: new Date(Date.UTC(2024, 0, 1 + i)).toUTCString(),
        isRead: true,
        hasAttachments: false,
      });
    }

    const result = await getThreadAction.run(ctx, { message_id: 'msg-0' });

    expect(result.messages).toHaveLength(100);
    expect(result.messages[0]!.id).toBe('msg-0'); // anchor first
    expect(result.messages.at(-1)!.id).toBe('msg-100'); // newest last
    // The retained window (after the anchor) is strictly increasing in time.
    const times = result.messages.slice(1).map(m => new Date(m.receivedAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
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
