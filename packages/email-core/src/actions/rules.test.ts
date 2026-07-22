import { describe, expect, it, vi } from 'vitest';
import type { EmailProvider } from '../providers/provider.js';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { createInboxRuleAction, deleteInboxRuleAction, listInboxRulesAction } from './rules.js';
import type { ActionContext } from './registry.js';

function contextWith(methods: Partial<EmailProvider> = {}, overrides: Partial<ActionContext> = {}): ActionContext {
  // Rule deletion is gated by the same operator policy as delete_email;
  // default to enabled here so non-deletion scenarios stay focused.
  return { provider: Object.assign(new MockEmailProvider(), methods), deleteEnabled: true, ...overrides };
}

describe('email-inbox-rules/List Inbox Rules', () => {
  it('Scenario: List externally created forwarding rule', async () => {
    const rules = [{
      id: 'rule-1',
      displayName: 'External forwarding rule',
      actions: { forwardTo: [{ emailAddress: { address: 'external@example.com' } }] },
      futureGraphField: { retained: true },
    }];
    const listInboxRules = vi.fn().mockResolvedValue(rules);

    const result = await listInboxRulesAction.run(contextWith({ listInboxRules }), {});

    expect(result).toEqual({ success: true, rules });
    expect(listInboxRulesAction.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('Scenario: Gmail rule request', async () => {
    // MockEmailProvider without listInboxRules stands in for a provider
    // (e.g. Gmail) that does not implement EmailRuleManager.
    const result = await listInboxRulesAction.run(contextWith(), {});
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('email-inbox-rules/Create Inbox Rule', () => {
  it('Scenario: Schema rejects sequence 0 and out-of-range values (Graph requires 1..Int32)', () => {
    const base = {
      display_name: 'X', conditions: {}, actions: { markAsRead: true }, user_explicitly_approved: true,
    };
    for (const bad of [0, -1, 1.5, 2_147_483_648]) {
      expect(createInboxRuleAction.input.safeParse({ ...base, sequence: bad }).success).toBe(false);
    }
    // Omitted and valid positive sequences pass.
    expect(createInboxRuleAction.input.safeParse(base).success).toBe(true);
    expect(createInboxRuleAction.input.safeParse({ ...base, sequence: 5 }).success).toBe(true);
  });

  it('Scenario: Create attested move rule', async () => {
    const rule = { id: 'rule-1', displayName: 'GitHub', actions: { moveToFolder: 'Newsletters' } };
    const createInboxRule = vi.fn().mockResolvedValue(rule);

    const result = await createInboxRuleAction.run(contextWith({ createInboxRule }), {
      display_name: 'GitHub',
      is_enabled: true,
      conditions: { senderContains: ['github.com'] },
      actions: { moveToFolder: 'Newsletters' },
      user_explicitly_approved: true,
    });

    expect(result).toEqual({ success: true, rule });
    expect(createInboxRule).toHaveBeenCalledWith({
      displayName: 'GitHub',
      sequence: undefined,
      isEnabled: true,
      conditions: { senderContains: ['github.com'] },
      exceptions: undefined,
      actions: { moveToFolder: 'Newsletters' },
    });
  });

  it('Scenario: Missing intent affirmation', async () => {
    const createInboxRule = vi.fn();
    const result = await createInboxRuleAction.run(contextWith({ createInboxRule }), {
      display_name: 'GitHub',
      is_enabled: true,
      conditions: { senderContains: ['github.com'] },
      actions: { moveToFolder: 'Newsletters' },
      user_explicitly_approved: false,
    });

    expect(result).toMatchObject({ success: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(createInboxRule).not.toHaveBeenCalled();
  });

  it.each(['forwardTo', 'forwardAsAttachmentTo', 'redirectTo', 'delete']) (
    'Scenario: Block unsafe %s action with a typed error',
    async (blockedAction) => {
      const createInboxRule = vi.fn();
      const result = await createInboxRuleAction.run(contextWith({ createInboxRule }), {
        display_name: 'Unsafe',
        is_enabled: true,
        conditions: { subjectContains: ['invoice'] },
        actions: { [blockedAction]: blockedAction === 'delete' ? true : [] },
        user_explicitly_approved: true,
      });

      expect(result).toMatchObject({ success: false, error: { code: 'UNSAFE_RULE_ACTION' } });
      expect(createInboxRule).not.toHaveBeenCalled();
    },
  );

  it('Scenario: Reject forwarding action', async () => {
    // Non-parameterized instance of the it.each block above (that block's
    // dynamic title isn't matched by the spec-coverage scanner), scoped to
    // the exact forwardTo case the canonical scenario names.
    const createInboxRule = vi.fn();
    const result = await createInboxRuleAction.run(contextWith({ createInboxRule }), {
      display_name: 'Unsafe',
      is_enabled: true,
      conditions: { subjectContains: ['invoice'] },
      actions: { forwardTo: [] },
      user_explicitly_approved: true,
    });

    expect(result).toMatchObject({ success: false, error: { code: 'UNSAFE_RULE_ACTION' } });
    expect(createInboxRule).not.toHaveBeenCalled();
  });

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await createInboxRuleAction.run(contextWith(), {
      display_name: 'GitHub',
      is_enabled: true,
      conditions: { senderContains: ['github.com'] },
      actions: { moveToFolder: 'Newsletters' },
      user_explicitly_approved: true,
    });
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('email-inbox-rules/Delete Inbox Rule', () => {
  it('Scenario: Delete a rule', async () => {
    const deleteInboxRule = vi.fn().mockResolvedValue(undefined);
    const result = await deleteInboxRuleAction.run(contextWith({ deleteInboxRule }), { id: 'rule-1', user_explicitly_requested_deletion: true });

    expect(result).toEqual({ success: true });
    expect(deleteInboxRule).toHaveBeenCalledWith('rule-1');
    expect(deleteInboxRuleAction.annotations.destructiveHint).toBe(true);
  });

  it('Scenario: Rule deletion is disabled by default', async () => {
    const deleteInboxRule = vi.fn().mockResolvedValue(undefined);
    const result = await deleteInboxRuleAction.run(
      contextWith({ deleteInboxRule }, { deleteEnabled: false }),
      { id: 'rule-1', user_explicitly_requested_deletion: true },
    );

    expect(result).toMatchObject({ success: false, error: { code: 'DELETE_DISABLED' } });
    expect(deleteInboxRule).not.toHaveBeenCalled();
  });

  it('Scenario: Rule deletion requires explicit affirmation', async () => {
    const deleteInboxRule = vi.fn().mockResolvedValue(undefined);
    const result = await deleteInboxRuleAction.run(
      contextWith({ deleteInboxRule }),
      { id: 'rule-1', user_explicitly_requested_deletion: false },
    );

    expect(result).toMatchObject({ success: false, error: { code: 'DELETE_DISABLED' } });
    expect(deleteInboxRule).not.toHaveBeenCalled();
  });

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await deleteInboxRuleAction.run(contextWith(), { id: 'rule-1', user_explicitly_requested_deletion: true });
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('create_inbox_rule destructive destinations (PR #106 review)', () => {
  it('Scenario: Reject a rule that files mail into Deleted Items', async () => {
    const createInboxRule = vi.fn();
    const ctx = { provider: { createInboxRule } } as never;

    for (const destination of ['trash', 'Deleted', 'DELETEDITEMS', ' trash ']) {
      const result = await createInboxRuleAction.run(ctx, {
        display_name: 'Discard everything',
        conditions: {},
        actions: { moveToFolder: destination },
        is_enabled: true,
        user_explicitly_approved: true,
      });
      expect(result).toMatchObject({
        success: false,
        error: { code: 'UNSAFE_RULE_DESTINATION' },
      });
    }
    expect(createInboxRule).not.toHaveBeenCalled();
  });

  it('Scenario: Still allows moves to ordinary custom folders', async () => {
    const createInboxRule = vi.fn().mockResolvedValue({ id: 'rule-1', displayName: 'GitHub' });
    const ctx = { provider: { createInboxRule } } as never;

    const result = await createInboxRuleAction.run(ctx, {
      display_name: 'GitHub',
      conditions: { senderContains: ['github.com'] },
      actions: { moveToFolder: 'Inbox/Notifications' },
      is_enabled: true,
      user_explicitly_approved: true,
    });

    expect(result).toMatchObject({ success: true });
    expect(createInboxRule).toHaveBeenCalled();
  });
});
