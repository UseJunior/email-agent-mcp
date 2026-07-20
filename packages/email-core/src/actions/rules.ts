// Server-side inbox rule actions
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { ProviderError } from '../providers/provider.js';

const ActionError = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

const JsonObject = z.object({}).catchall(z.unknown());

// Listing is deliberately permissive: Graph can add fields and can return
// unsafe actions on rules created outside this tool. Do not strip either.
const InboxRuleSchema = z.object({
  id: z.string().optional(),
  displayName: z.string().optional(),
  sequence: z.number().optional(),
  isEnabled: z.boolean().optional(),
  hasError: z.boolean().optional(),
  isReadOnly: z.boolean().optional(),
  conditions: JsonObject.optional(),
  exceptions: JsonObject.optional(),
  actions: JsonObject.optional(),
}).catchall(z.unknown());

const ListInboxRulesInput = z.object({
  mailbox: z.string().optional(),
});

const ListInboxRulesOutput = z.object({
  success: z.boolean(),
  rules: z.array(InboxRuleSchema).optional(),
  error: ActionError.optional(),
});

export const listInboxRulesAction: EmailAction<
  z.infer<typeof ListInboxRulesInput>,
  z.infer<typeof ListInboxRulesOutput>
> = {
  name: 'list_inbox_rules',
  description: 'List server-side inbox rules with all fields reported by the provider',
  input: ListInboxRulesInput,
  output: ListInboxRulesOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx) => {
    if (!ctx.provider.listInboxRules) {
      return notSupported();
    }
    const rules = await ctx.provider.listInboxRules();
    return { success: true, rules };
  },
};

const CreateInboxRuleInput = z.object({
  display_name: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
  is_enabled: z.boolean().optional().default(true),
  conditions: JsonObject,
  exceptions: JsonObject.optional(),
  actions: JsonObject,
  user_explicitly_approved: z.boolean().optional().default(false),
  mailbox: z.string().optional(),
});

const CreateInboxRuleOutput = z.object({
  success: z.boolean(),
  rule: InboxRuleSchema.optional(),
  error: ActionError.optional(),
});

const BLOCKED_ACTIONS = ['forwardTo', 'forwardAsAttachmentTo', 'redirectTo', 'delete'] as const;
const SAFE_ACTIONS = new Set([
  'assignCategories',
  'copyToFolder',
  'markAsRead',
  'markImportance',
  'moveToFolder',
  'stopProcessingRules',
]);

export const createInboxRuleAction: EmailAction<
  z.infer<typeof CreateInboxRuleInput>,
  z.infer<typeof CreateInboxRuleOutput>
> = {
  name: 'create_inbox_rule',
  description: 'Create a human-approved server-side inbox rule using safe actions only; forwarding, redirection, and deletion are blocked',
  input: CreateInboxRuleInput,
  output: CreateInboxRuleOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!input.user_explicitly_approved) {
      return actionError(
        'APPROVAL_REQUIRED',
        'A human must explicitly approve the inbox rule before creation',
      );
    }

    const blocked = BLOCKED_ACTIONS.find(action => Object.hasOwn(input.actions, action));
    if (blocked) {
      return actionError(
        'UNSAFE_RULE_ACTION',
        `Inbox rule action '${blocked}' is blocked for security`,
      );
    }

    const unsupported = Object.keys(input.actions).find(action => !SAFE_ACTIONS.has(action));
    if (unsupported) {
      return actionError(
        'UNSUPPORTED_RULE_ACTION',
        `Inbox rule action '${unsupported}' is not supported for creation`,
      );
    }

    if (Object.keys(input.actions).length === 0) {
      return actionError('MISSING_RULE_ACTION', 'At least one safe inbox rule action is required');
    }

    if (!ctx.provider.createInboxRule) {
      return notSupported();
    }

    try {
      const rule = await ctx.provider.createInboxRule({
        displayName: input.display_name,
        sequence: input.sequence,
        isEnabled: input.is_enabled,
        conditions: input.conditions,
        exceptions: input.exceptions,
        actions: input.actions,
      });
      return { success: true, rule };
    } catch (err) {
      return providerErrorResult(err);
    }
  },
};

const DeleteInboxRuleInput = z.object({
  id: z.string().min(1),
  mailbox: z.string().optional(),
});

const DeleteInboxRuleOutput = z.object({
  success: z.boolean(),
  error: ActionError.optional(),
});

export const deleteInboxRuleAction: EmailAction<
  z.infer<typeof DeleteInboxRuleInput>,
  z.infer<typeof DeleteInboxRuleOutput>
> = {
  name: 'delete_inbox_rule',
  description: 'Delete a server-side inbox rule by id',
  input: DeleteInboxRuleInput,
  output: DeleteInboxRuleOutput,
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, input) => {
    if (!ctx.provider.deleteInboxRule) {
      return notSupported();
    }
    try {
      await ctx.provider.deleteInboxRule(input.id);
      return { success: true };
    } catch (err) {
      return providerErrorResult(err);
    }
  },
};

function notSupported(): { success: false; error: { code: string; message: string; recoverable: boolean } } {
  return actionError('NOT_SUPPORTED', 'Provider does not support server-side inbox rules');
}

function actionError(code: string, message: string): { success: false; error: { code: string; message: string; recoverable: boolean } } {
  return { success: false, error: { code, message, recoverable: false } };
}

function providerErrorResult(err: unknown): { success: false; error: { code: string; message: string; recoverable: boolean } } {
  if (err instanceof ProviderError) {
    return actionError(err.code, err.message);
  }
  throw err;
}
