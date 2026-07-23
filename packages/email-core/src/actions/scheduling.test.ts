import { describe, expect, it, vi } from 'vitest';
import type { EmailProvider } from '../providers/provider.js';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { sendDraftAction } from './draft.js';
import type { ActionContext, RateLimiter } from './registry.js';
import {
  cancelScheduledSendAction,
  listScheduledSendsAction,
  validateScheduledSendAt,
} from './scheduling.js';
import { sendEmailAction } from './send.js';

function futureAt(minutes = 10): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function actionContext(provider: EmailProvider): ActionContext {
  return {
    provider,
    sendAllowlist: { entries: ['*@example.com'] },
  };
}

function withoutScheduling(provider: MockEmailProvider): EmailProvider {
  Object.defineProperties(provider, {
    scheduleMessage: { value: undefined },
    scheduleDraft: { value: undefined },
    listScheduledSends: { value: undefined },
    cancelScheduledSend: { value: undefined },
  });
  return provider;
}

describe('email-write/Provider-Held Scheduled Delivery', () => {
  it('Scenario: New email is held for future delivery', async () => {
    const provider = new MockEmailProvider();
    const scheduled = vi.spyOn(provider, 'scheduleMessage');
    const rateLimiter: RateLimiter = {
      checkLimit: vi.fn().mockReturnValue({ allowed: true }),
      recordUsage: vi.fn(),
    };
    const inputTime = new Date(Date.now() + 10 * 60_000).toISOString()
      .replace('Z', '+00:00');

    const result = await sendEmailAction.run(
      { ...actionContext(provider), rateLimiter },
      {
        to: 'alice@example.com',
        subject: 'Tomorrow',
        body: 'Provider-held',
        format: 'text',
        scheduled_send_at: inputTime,
      },
    );

    expect(result.success).toBe(true);
    expect(result.messageId).toMatch(/^scheduled-/);
    expect(result.scheduledSendAt).toBe(new Date(inputTime).toISOString());
    expect(scheduled).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Tomorrow' }),
      new Date(inputTime).toISOString(),
    );
    expect(provider.getSentMessages()).toEqual([]);
    expect(rateLimiter.recordUsage).toHaveBeenCalledWith('send_email');
  });

  it('Scenario: Existing draft is held for future delivery', async () => {
    const provider = new MockEmailProvider();
    const draft = await provider.createDraft({
      to: [{ email: 'alice@example.com' }],
      subject: 'Queued draft',
      body: 'Hold this',
    });
    const scheduled = vi.spyOn(provider, 'scheduleDraft');

    const result = await sendDraftAction.run(actionContext(provider), {
      draft_id: draft.draftId!,
      scheduled_send_at: futureAt(),
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe(draft.draftId);
    expect(scheduled).toHaveBeenCalledWith(draft.draftId, expect.stringMatching(/Z$/));
    expect(provider.getSentMessages()).toEqual([]);
  });

  it('Scenario: Invalid scheduled time causes no provider write', async () => {
    const provider = new MockEmailProvider();
    const scheduleMessage = vi.spyOn(provider, 'scheduleMessage');
    const createDraft = vi.spyOn(provider, 'createDraft');

    const result = await sendEmailAction.run(actionContext(provider), {
      to: 'alice@example.com',
      subject: 'Invalid time',
      body: 'No write',
      scheduled_send_at: '2026-07-23T12:00:00',
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_SCHEDULED_SEND_AT' },
    });
    expect(scheduleMessage).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
    const now = Date.now();
    expect(validateScheduledSendAt(new Date(now - 60_000).toISOString(), now))
      .toMatchObject({ error: { code: 'INVALID_SCHEDULED_SEND_AT' } });
    expect(validateScheduledSendAt(new Date(now).toISOString(), now))
      .toMatchObject({ error: { code: 'INVALID_SCHEDULED_SEND_AT' } });
    expect(validateScheduledSendAt('not-a-date', now))
      .toMatchObject({ error: { code: 'INVALID_SCHEDULED_SEND_AT' } });

    const getMessage = vi.spyOn(provider, 'getMessage');
    const scheduleDraft = vi.spyOn(provider, 'scheduleDraft');
    const draftResult = await sendDraftAction.run(actionContext(provider), {
      draft_id: 'must-not-be-read',
      scheduled_send_at: new Date(now - 60_000).toISOString(),
    });
    expect(draftResult).toMatchObject({
      success: false,
      error: { code: 'INVALID_SCHEDULED_SEND_AT' },
    });
    expect(getMessage).not.toHaveBeenCalled();
    expect(scheduleDraft).not.toHaveBeenCalled();
  });

  it('Scenario: Draft mode and scheduling are mutually exclusive', async () => {
    const provider = new MockEmailProvider();
    const scheduleMessage = vi.spyOn(provider, 'scheduleMessage');
    const createDraft = vi.spyOn(provider, 'createDraft');

    const result = await sendEmailAction.run(actionContext(provider), {
      to: 'alice@example.com',
      subject: 'Contradictory',
      body: 'No write',
      draft: true,
      scheduled_send_at: futureAt(),
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'INVALID_SCHEDULED_SEND_MODE' },
    });
    expect(scheduleMessage).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('keeps allowlist and rate-limit gates in front of scheduled sends', async () => {
    const provider = new MockEmailProvider();
    const scheduleMessage = vi.spyOn(provider, 'scheduleMessage');
    const blocked = await sendEmailAction.run({
      provider,
      sendAllowlist: { entries: ['*@allowed.test'] },
    }, {
      to: 'alice@example.com',
      subject: 'Blocked',
      body: 'No write',
      scheduled_send_at: futureAt(),
    });
    expect(blocked).toMatchObject({
      success: false,
      error: { code: 'ALLOWLIST_BLOCKED' },
    });

    const rateLimited = await sendEmailAction.run({
      ...actionContext(provider),
      rateLimiter: {
        checkLimit: vi.fn().mockReturnValue({ allowed: false, retryAfter: 30 }),
        recordUsage: vi.fn(),
      },
    }, {
      to: 'alice@example.com',
      subject: 'Rate limited',
      body: 'No write',
      scheduled_send_at: futureAt(),
    });
    expect(rateLimited).toMatchObject({
      success: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(scheduleMessage).not.toHaveBeenCalled();
  });

  it('blocks a disallowed CC before immediate or scheduled provider writes', async () => {
    for (const scheduled_send_at of [undefined, futureAt()]) {
      const provider = new MockEmailProvider();
      const sendMessage = vi.spyOn(provider, 'sendMessage');
      const scheduleMessage = vi.spyOn(provider, 'scheduleMessage');

      const result = await sendEmailAction.run({
        provider,
        sendAllowlist: { entries: ['allowed@example.com'] },
      }, {
        to: 'allowed@example.com',
        cc: ['blocked@example.net'],
        subject: 'All recipients are gated',
        body: 'No write',
        scheduled_send_at,
      });

      expect(result).toMatchObject({
        success: false,
        error: { code: 'ALLOWLIST_BLOCKED' },
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(scheduleMessage).not.toHaveBeenCalled();
    }
  });

  it('Scenario: Ambiguous provider submission is not retried', async () => {
    const provider = new MockEmailProvider();
    provider.scheduleMessage = vi.fn().mockResolvedValue({
      success: false,
      messageId: 'status-unknown',
      scheduledSendAt: futureAt(),
      error: {
        code: 'SCHEDULE_SEND_STATUS_UNKNOWN',
        message: 'May already be scheduled',
        recoverable: false,
      },
    });
    const rateLimiter: RateLimiter = {
      checkLimit: vi.fn().mockReturnValue({ allowed: true }),
      recordUsage: vi.fn(),
    };

    const result = await sendEmailAction.run({
      ...actionContext(provider),
      rateLimiter,
    }, {
      to: 'alice@example.com',
      subject: 'Ambiguous response',
      body: 'Do not retry',
      scheduled_send_at: futureAt(),
    });

    expect(result).toMatchObject({
      success: false,
      messageId: 'status-unknown',
      error: { code: 'SCHEDULE_SEND_STATUS_UNKNOWN', recoverable: false },
    });
    expect(rateLimiter.recordUsage).toHaveBeenCalledWith('send_email');
  });
});

describe('email-write/Scheduled Send Management', () => {
  it('Scenario: Pending scheduled sends can be listed', async () => {
    const provider = new MockEmailProvider();
    const scheduledSendAt = futureAt();
    const queued = await provider.scheduleMessage({
      to: [{ email: 'alice@example.com', name: 'Alice' }],
      subject: 'Pending',
      body: 'Later',
    }, scheduledSendAt);

    const result = await listScheduledSendsAction.run(actionContext(provider), {});

    expect(result.scheduledSends).toEqual([{
      messageId: queued.messageId,
      subject: 'Pending',
      to: [{ email: 'alice@example.com', name: 'Alice' }],
      scheduledSendAt,
    }]);
    expect(listScheduledSendsAction.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it('Scenario: Pending scheduled send can be cancelled', async () => {
    const provider = new MockEmailProvider();
    const queued = await provider.scheduleMessage({
      to: [{ email: 'alice@example.com' }],
      subject: 'Cancel me',
      body: 'Later',
    }, futureAt());

    const result = await cancelScheduledSendAction.run(actionContext(provider), {
      message_id: queued.messageId!,
    });

    expect(result).toEqual({ success: true, messageId: queued.messageId });
    expect(await provider.listScheduledSends()).toEqual([]);
    expect(cancelScheduledSendAction.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it('Scenario: Cancellation cannot delete an arbitrary draft', async () => {
    const provider = new MockEmailProvider();
    const draft = await provider.createDraft({
      to: [{ email: 'alice@example.com' }],
      subject: 'Ordinary draft',
      body: 'Keep me',
    });

    const result = await cancelScheduledSendAction.run(actionContext(provider), {
      message_id: draft.draftId!,
    });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'NOT_SCHEDULED' },
    });
    expect(provider.getDrafts().has(draft.draftId!)).toBe(true);
  });
});

describe('provider-interface/Optional Scheduled Sender Capability', () => {
  it('Scenario: Scheduling capability is dispatched when present', async () => {
    const provider = new MockEmailProvider();
    const scheduleMessage = vi.spyOn(provider, 'scheduleMessage');

    await sendEmailAction.run(actionContext(provider), {
      to: 'alice@example.com',
      subject: 'Capability',
      body: 'Use it',
      scheduled_send_at: futureAt(),
    });

    expect(scheduleMessage).toHaveBeenCalledOnce();
    expect(provider.getSentMessages()).toEqual([]);
  });

  it('Scenario: Missing capability is reported without mutation', async () => {
    const provider = new MockEmailProvider();
    const sendMessage = vi.spyOn(provider, 'sendMessage');
    const createDraft = vi.spyOn(provider, 'createDraft');

    const result = await sendEmailAction.run(
      actionContext(withoutScheduling(provider)),
      {
        to: 'alice@example.com',
        subject: 'Unsupported',
        body: 'Do not send',
        scheduled_send_at: futureAt(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'NOT_SUPPORTED', recoverable: false },
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(createDraft).not.toHaveBeenCalled();
  });

  it('does not fall back to immediate draft send when scheduling is unsupported', async () => {
    const provider = new MockEmailProvider();
    const draft = await provider.createDraft({
      to: [{ email: 'alice@example.com' }],
      subject: 'Unsupported draft',
      body: 'Keep pending',
    });
    const sendDraft = vi.spyOn(provider, 'sendDraft');
    const getMessage = vi.spyOn(provider, 'getMessage');

    const result = await sendDraftAction.run(
      actionContext(withoutScheduling(provider)),
      {
        draft_id: draft.draftId!,
        scheduled_send_at: futureAt(),
      },
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: 'NOT_SUPPORTED' },
    });
    expect(sendDraft).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
    expect(provider.getDrafts().has(draft.draftId!)).toBe(true);
  });
});
