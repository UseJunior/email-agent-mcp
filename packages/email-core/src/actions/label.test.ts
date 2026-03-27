import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { labelEmailAction, flagEmailAction, markReadAction, deleteEmailAction } from './label.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  provider.addMessage({ id: 'msg123', subject: 'Test', labels: [] });
  provider.addMessage({ id: 'msg1', subject: 'One', labels: [] });
  provider.addMessage({ id: 'msg2', subject: 'Two', labels: [] });
  provider.addMessage({ id: 'msg3', subject: 'Three', labels: [] });
  ctx = { provider };
});

describe('email-categorize/Label Email', () => {
  it('Scenario: Apply label', async () => {
    const result = await labelEmailAction.run(ctx, {
      id: 'msg123',
      labels: ['important', 'client-correspondence'],
    });

    expect(result.success).toBe(true);
    const msg = await provider.getMessage('msg123');
    expect(msg.labels).toContain('important');
    expect(msg.labels).toContain('client-correspondence');
  });

  it('Scenario: Bulk labeling', async () => {
    const result = await labelEmailAction.run(ctx, {
      ids: ['msg1', 'msg2', 'msg3'],
      labels: ['receipts'],
    });

    expect(result.success).toBe(true);
    for (const id of ['msg1', 'msg2', 'msg3']) {
      const msg = await provider.getMessage(id);
      expect(msg.labels).toContain('receipts');
    }
  });
});

describe('email-categorize/Mailbox Routing', () => {
  it('Scenario: Categorize without mailbox param', async () => {
    // When no mailbox param, applies via the context provider
    const result = await labelEmailAction.run(ctx, {
      id: 'msg123',
      labels: ['important'],
    });

    expect(result.success).toBe(true);
    const msg = await provider.getMessage('msg123');
    expect(msg.labels).toContain('important');
  });
});

describe('email-categorize/No Delete in v1', () => {
  it('Scenario: Delete attempt when disabled', async () => {
    // Delete is disabled by default (ctx.deleteEnabled is undefined)
    const result = await deleteEmailAction.run(ctx, {
      id: 'msg123',
      user_explicitly_requested_deletion: true,
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('Email deletion is disabled');
  });
});
