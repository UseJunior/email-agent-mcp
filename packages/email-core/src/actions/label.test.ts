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

describe('email-categorize/Delete Policy', () => {
  it('Scenario: Delete attempt when disabled', async () => {
    // Delete is disabled by default (ctx.deleteEnabled is undefined)
    const result = await deleteEmailAction.run(ctx, {
      id: 'msg123',
      user_explicitly_requested_deletion: true,
      hard_delete: false,
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('DELETE_DISABLED');
    expect(result.error!.message).toContain('Email deletion is disabled');
    // Names the env var so operators can self-remediate.
    expect(result.error!.message).toContain('AGENT_EMAIL_DELETE_ENABLED');
  });

  it('Scenario: Delete enabled, soft delete succeeds', async () => {
    const enabledCtx: ActionContext = { provider, deleteEnabled: true, hardDeleteAllowed: false };
    const result = await deleteEmailAction.run(enabledCtx, {
      id: 'msg123',
      user_explicitly_requested_deletion: true,
      hard_delete: false,
    });

    expect(result.success).toBe(true);
    // Soft delete moves to trash (not removed entirely).
    const msgs = provider.getMessages();
    const moved = msgs.find(m => m.id === 'msg123');
    expect(moved?.folder).toBe('trash');
  });

  it('Scenario: hard_delete blocked when only soft is enabled (closes self-approval loophole)', async () => {
    // Even though caller passes hard_delete: true, ctx.hardDeleteAllowed is false
    // so the request must be rejected. Previously, label.ts derived
    // hardDeleteAllowed from input.hard_delete itself, so this case "succeeded".
    const enabledCtx: ActionContext = { provider, deleteEnabled: true, hardDeleteAllowed: false };
    const result = await deleteEmailAction.run(enabledCtx, {
      id: 'msg123',
      user_explicitly_requested_deletion: true,
      hard_delete: true,
    });

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('DELETE_DISABLED');
    expect(result.error!.message).toContain('Hard delete is not allowed');
    expect(result.error!.message).toContain('AGENT_EMAIL_HARD_DELETE_ENABLED');
  });

  it('Scenario: hard delete succeeds when both gates are open', async () => {
    const enabledCtx: ActionContext = { provider, deleteEnabled: true, hardDeleteAllowed: true };
    const result = await deleteEmailAction.run(enabledCtx, {
      id: 'msg123',
      user_explicitly_requested_deletion: true,
      hard_delete: true,
    });

    expect(result.success).toBe(true);
    // Hard delete removes the message entirely.
    const msgs = provider.getMessages();
    expect(msgs.find(m => m.id === 'msg123')).toBeUndefined();
  });

  it('Scenario: ctx.deleteEnabled requires strict-equality (not truthy)', async () => {
    // Passing a non-boolean truthy value must NOT enable deletion.
    const sneakyCtx = { provider, deleteEnabled: 'true' as unknown as boolean };
    const result = await deleteEmailAction.run(sneakyCtx, {
      id: 'msg123',
      user_explicitly_requested_deletion: true,
      hard_delete: false,
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('Email deletion is disabled');
  });
});
