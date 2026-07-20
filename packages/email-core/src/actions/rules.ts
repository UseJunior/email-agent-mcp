// Server-side inbox rule actions
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { ProviderError } from '../providers/provider.js';
import { checkDeletePolicy } from '../security/receive-allowlist.js';

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
  // Graph rejects sequence 0 and requires an Int32; forbid the invalid range at
  // the boundary so a schema-valid request can't still fail live. Omit it to let
  // the provider auto-assign the next sequence.
  sequence: z.number().int().min(1).max(2_147_483_647).optional(),
  is_enabled: z.boolean().optional().default(true),
  conditions: JsonObject,
  exceptions: JsonObject.optional(),
  actions: JsonObject,
  // NOTE: this is an intent affirmation, NOT a security boundary. The calling
  // model supplies it, so it cannot enforce human approval on its own — it
  // forces a deliberate second step and leaves an audit signal. Real
  // human-in-the-loop must come from the MCP client's tool-approval UI.
  user_explicitly_approved: z.boolean().optional().default(false),
  mailbox: z.string().optional(),
});

const CreateInboxRuleOutput = z.object({
  success: z.boolean(),
  rule: InboxRuleSchema.optional(),
  error: ActionError.optional(),
});

const BLOCKED_ACTIONS = ['forwardTo', 'forwardAsAttachmentTo', 'redirectTo', 'delete'] as const;
// Destinations that discard mail — filing into these is equivalent to `delete`.
// Covers the user-facing aliases plus the system-managed non-user folders the
// provider also rejects (kept in sync with DESTRUCTIVE_RULE_DESTINATIONS in the
// Microsoft provider). This is a fast, provider-independent reject; the provider
// re-checks by resolved id in case a custom folder name maps onto one of these.
const DESTRUCTIVE_DESTINATIONS = new Set([
  'trash',
  'deleted',
  'deleteditems',
  'deleted items',
  'recoverableitemsdeletions',
  'scheduled',
  'serverfailures',
  'localfailures',
  'syncissues',
  'conflicts',
]);
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
  description: 'Create a persistent server-side inbox rule using safe actions only; forwarding, redirection, and deletion are blocked. Confirm with the user before calling — this creates a rule that keeps acting on the mailbox 24/7 after the session ends.',
  input: CreateInboxRuleInput,
  output: CreateInboxRuleOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!input.user_explicitly_approved) {
      return actionError(
        'APPROVAL_REQUIRED',
        'Set user_explicitly_approved once the user has confirmed this specific rule',
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

    // A rule filing mail into Deleted Items is the blocked `delete` action
    // wearing a `moveToFolder` costume — and with empty conditions it would
    // discard the whole mailbox. Providers re-check this after resolving
    // aliases; this is the fast, provider-independent rejection.
    for (const folderAction of ['moveToFolder', 'copyToFolder'] as const) {
      const destination = input.actions[folderAction];
      // Normalize the same way the provider resolves (strip surrounding slashes
      // + lowercase), so alias tricks like `/trash/` don't slip past this
      // fast-path pre-filter. The provider re-checks the fully resolved folder.
      if (typeof destination === 'string'
        && DESTRUCTIVE_DESTINATIONS.has(destination.trim().replace(/^\/+|\/+$/g, '').toLowerCase())) {
        return actionError(
          'UNSAFE_RULE_DESTINATION',
          `Inbox rule destination '${destination}' discards mail and is blocked for security`,
        );
      }
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
  user_explicitly_requested_deletion: z.boolean(),
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
  description: 'Delete a server-side inbox rule by id (disabled by default, requires explicit configuration). Removing a rule can silently re-expose the mailbox to mail the rule was filtering.',
  input: DeleteInboxRuleInput,
  output: DeleteInboxRuleOutput,
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, input) => {
    // Same operator gate as delete_email / delete_folder: deleting a rule is a
    // destructive, security-relevant change (it can remove an organization or
    // anti-abuse rule), so it must not be an ungated capability.
    const policyError = checkDeletePolicy(
      ctx.deleteEnabled === true ? { enabled: true, hardDeleteAllowed: ctx.hardDeleteAllowed === true } : undefined,
      input.user_explicitly_requested_deletion,
      false,
    );
    if (policyError) {
      return actionError('DELETE_DISABLED', policyError);
    }
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
