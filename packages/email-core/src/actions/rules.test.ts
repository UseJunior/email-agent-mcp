import { describe, expect, it, vi } from 'vitest';
import type { EmailProvider } from '../providers/provider.js';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { createInboxRuleAction, deleteInboxRuleAction, listInboxRulesAction } from './rules.js';
import type { ActionContext } from './registry.js';

function contextWith(methods: Partial<EmailProvider> = {}): ActionContext {
  return { provider: Object.assign(new MockEmailProvider(), methods) };
}

describe('email-inbox-rules/List Inbox Rules', () => {
  it('Scenario: Faithfully list an externally created forwarding rule', async () => {
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

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await listInboxRulesAction.run(contextWith(), {});
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('email-inbox-rules/Create Inbox Rule', () => {
  it('Scenario: Create an approved safe move rule', async () => {
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

  it('Scenario: Missing human approval returns APPROVAL_REQUIRED', async () => {
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
    const result = await deleteInboxRuleAction.run(contextWith({ deleteInboxRule }), { id: 'rule-1' });

    expect(result).toEqual({ success: true });
    expect(deleteInboxRule).toHaveBeenCalledWith('rule-1');
    expect(deleteInboxRuleAction.annotations.destructiveHint).toBe(true);
  });

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await deleteInboxRuleAction.run(contextWith(), { id: 'rule-1' });
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});
