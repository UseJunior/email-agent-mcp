// Scheduled-send actions and shared timestamp validation.
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { checkMailboxRequired, handleProviderError } from './compose-helpers.js';

export const ScheduledSendAtSchema = z.string().meta({
  format: 'date-time',
  description: 'Future ISO 8601 delivery time with an explicit timezone. Accepted values are normalized to UTC.',
});

const ISO_DATETIME_WITH_OFFSET = z.iso.datetime({ offset: true });

const EXPLICIT_TIMEZONE = /(?:Z|[+-]\d{2}:\d{2})$/i;

export type ScheduledSendAtValidation =
  | { value: string }
  | { error: { code: 'INVALID_SCHEDULED_SEND_AT'; message: string; recoverable: false } };

export function validateScheduledSendAt(value: string, now = Date.now()): ScheduledSendAtValidation {
  if (!EXPLICIT_TIMEZONE.test(value) || !ISO_DATETIME_WITH_OFFSET.safeParse(value).success) {
    return {
      error: {
        code: 'INVALID_SCHEDULED_SEND_AT',
        message: 'scheduled_send_at must be an ISO 8601 timestamp with an explicit timezone',
        recoverable: false,
      },
    };
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    return {
      error: {
        code: 'INVALID_SCHEDULED_SEND_AT',
        message: 'scheduled_send_at must be a valid future timestamp',
        recoverable: false,
      },
    };
  }
  return { value: new Date(timestamp).toISOString() };
}

const ScheduledSendErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
  availableMailboxes: z.array(z.string()).optional(),
  defaultMailbox: z.string().optional(),
});

const CancelScheduledSendInput = z.object({
  message_id: z.string(),
  mailbox: z.string().optional(),
});

const CancelScheduledSendOutput = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: ScheduledSendErrorSchema.optional(),
});

export const cancelScheduledSendAction: EmailAction<
  z.infer<typeof CancelScheduledSendInput>,
  z.infer<typeof CancelScheduledSendOutput>
> = {
  name: 'cancel_scheduled_send',
  description: 'Cancel a pending provider-held scheduled send. Only verified scheduled drafts can be cancelled.',
  input: CancelScheduledSendInput,
  output: CancelScheduledSendOutput,
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, input) => {
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) return { success: false, error: mailboxError };
    if (!ctx.provider.cancelScheduledSend) {
      return {
        success: false,
        error: {
          code: 'NOT_SUPPORTED',
          message: 'Scheduled send is not supported by this email provider',
          recoverable: false,
        },
      };
    }
    try {
      await ctx.provider.cancelScheduledSend(input.message_id);
      return { success: true, messageId: input.message_id };
    } catch (err) {
      return handleProviderError(err, 'CANCEL_SCHEDULED_SEND_FAILED');
    }
  },
};

const ListScheduledSendsInput = z.object({
  mailbox: z.string().optional(),
});

const ListScheduledSendsOutput = z.object({
  scheduledSends: z.array(z.object({
    messageId: z.string(),
    subject: z.string(),
    to: z.array(z.object({
      email: z.string(),
      name: z.string().optional(),
    })),
    scheduledSendAt: z.string(),
  })),
  error: ScheduledSendErrorSchema.optional(),
});

export const listScheduledSendsAction: EmailAction<
  z.infer<typeof ListScheduledSendsInput>,
  z.infer<typeof ListScheduledSendsOutput>
> = {
  name: 'list_scheduled_sends',
  description: 'List pending provider-held scheduled sends for a mailbox',
  input: ListScheduledSendsInput,
  output: ListScheduledSendsOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const mailboxError = checkMailboxRequired(input.mailbox, ctx.allMailboxes);
    if (mailboxError) return { scheduledSends: [], error: mailboxError };
    if (!ctx.provider.listScheduledSends) {
      return {
        scheduledSends: [],
        error: {
          code: 'NOT_SUPPORTED',
          message: 'Scheduled send is not supported by this email provider',
          recoverable: false,
        },
      };
    }
    try {
      return { scheduledSends: await ctx.provider.listScheduledSends() };
    } catch (err) {
      const handled = handleProviderError(err, 'LIST_SCHEDULED_SENDS_FAILED');
      return { scheduledSends: [], error: handled.error };
    }
  },
};

export function scheduledSendNotSupportedError() {
  return {
    success: false as const,
    error: {
      code: 'NOT_SUPPORTED',
      message: 'Scheduled send is not supported by this email provider',
      recoverable: false,
    },
  };
}
