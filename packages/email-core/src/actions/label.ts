// label_email action — apply labels/categories, flag, mark read
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkDeletePolicy, type DeletePolicy } from '../security/receive-allowlist.js';

const LabelEmailInput = z.object({
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
  labels: z.array(z.string()),
  mailbox: z.string().optional(),
});

const LabelEmailOutput = z.object({
  success: z.boolean(),
  error: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }).optional(),
});

export const labelEmailAction: EmailAction<
  z.infer<typeof LabelEmailInput>,
  z.infer<typeof LabelEmailOutput>
> = {
  name: 'label_email',
  description: 'Apply labels or categories to one or more emails',
  input: LabelEmailInput,
  output: LabelEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!ctx.provider.applyLabels) {
      return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Provider does not support labeling', recoverable: false } };
    }

    const messageIds = input.ids ?? (input.id ? [input.id] : []);
    if (messageIds.length === 0) {
      return { success: false, error: { code: 'MISSING_ID', message: 'id or ids is required', recoverable: false } };
    }

    for (const msgId of messageIds) {
      await ctx.provider.applyLabels(msgId, input.labels);
    }

    return { success: true };
  },
};

// flag_email
const FlagEmailInput = z.object({
  id: z.string(),
  flagged: z.boolean().default(true),
  mailbox: z.string().optional(),
});

export const flagEmailAction: EmailAction<z.infer<typeof FlagEmailInput>, z.infer<typeof LabelEmailOutput>> = {
  name: 'flag_email',
  description: 'Flag or unflag an email as important/starred',
  input: FlagEmailInput,
  output: LabelEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!ctx.provider.setFlag) {
      return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Provider does not support flagging', recoverable: false } };
    }
    await ctx.provider.setFlag(input.id, input.flagged);
    return { success: true };
  },
};

// mark_read
const MarkReadInput = z.object({
  id: z.string(),
  is_read: z.boolean().default(true),
  mailbox: z.string().optional(),
});

export const markReadAction: EmailAction<z.infer<typeof MarkReadInput>, z.infer<typeof LabelEmailOutput>> = {
  name: 'mark_read',
  description: 'Mark an email as read or unread',
  input: MarkReadInput,
  output: LabelEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!ctx.provider.setReadState) {
      return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Provider does not support read state', recoverable: false } };
    }
    await ctx.provider.setReadState(input.id, input.is_read);
    return { success: true };
  },
};

// delete_email — disabled by default
const DeleteEmailInput = z.object({
  id: z.string(),
  user_explicitly_requested_deletion: z.boolean(),
  hard_delete: z.boolean().optional().default(false),
  mailbox: z.string().optional(),
});

export const deleteEmailAction: EmailAction<z.infer<typeof DeleteEmailInput>, z.infer<typeof LabelEmailOutput>> = {
  name: 'delete_email',
  description: 'Delete an email (disabled by default, requires explicit configuration)',
  input: DeleteEmailInput,
  output: LabelEmailOutput,
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, input) => {
    const deletePolicy: DeletePolicy | undefined = ctx.deleteEnabled
      ? { enabled: true, hardDeleteAllowed: input.hard_delete }
      : undefined;

    const policyError = checkDeletePolicy(deletePolicy, input.user_explicitly_requested_deletion, input.hard_delete);
    if (policyError) {
      return { success: false, error: { code: 'DELETE_DISABLED', message: policyError, recoverable: false } };
    }

    if (!ctx.provider.deleteMessage) {
      return { success: false, error: { code: 'NOT_SUPPORTED', message: 'Provider does not support deletion', recoverable: false } };
    }

    await ctx.provider.deleteMessage(input.id, input.hard_delete);
    return { success: true };
  },
};
