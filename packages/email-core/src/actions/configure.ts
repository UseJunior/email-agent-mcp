// Mailbox configuration actions — configure, remove, list mailboxes
import { z } from 'zod';
import type { EmailAction, ActionContext, MailboxEntry } from './registry.js';
import { discoverProviders, createProvider } from '../providers/provider.js';

const ConfigureMailboxInput = z.object({
  name: z.string(),
  provider: z.string(),
  credentials: z.record(z.string()).optional(),
  default: z.boolean().optional(),
});

const ConfigureMailboxOutput = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }).optional(),
});

// In-memory mailbox store (would be persisted in production)
const mailboxStore = new Map<string, MailboxEntry>();

export function getMailboxStore(): Map<string, MailboxEntry> {
  return mailboxStore;
}

export function resetMailboxStore(): void {
  mailboxStore.clear();
}

export const configureMailboxAction: EmailAction<
  z.infer<typeof ConfigureMailboxInput>,
  z.infer<typeof ConfigureMailboxOutput>
> = {
  name: 'configure_mailbox',
  description: 'Connect a named mailbox to an email provider with credentials',
  input: ConfigureMailboxInput,
  output: ConfigureMailboxOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    // Check if provider is available
    try {
      const provider = await createProvider(input.provider);

      const isDefault = input.default ?? (mailboxStore.size === 0);
      if (isDefault) {
        // Unset other defaults
        for (const [, entry] of mailboxStore) {
          entry.isDefault = false;
        }
      }

      mailboxStore.set(input.name, {
        name: input.name,
        provider,
        providerType: input.provider,
        isDefault,
        status: 'connected',
      });

      return {
        success: true,
        message: `Mailbox "${input.name}" configured with ${input.provider} provider${isDefault ? ' (default)' : ''}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not available')) {
        return {
          success: false,
          error: { code: 'PROVIDER_NOT_FOUND', message, recoverable: false },
        };
      }
      return {
        success: false,
        error: { code: 'CONFIGURE_FAILED', message, recoverable: false },
      };
    }
  },
};

// remove_mailbox
const RemoveMailboxInput = z.object({ name: z.string() });

export const removeMailboxAction: EmailAction<
  z.infer<typeof RemoveMailboxInput>,
  z.infer<typeof ConfigureMailboxOutput>
> = {
  name: 'remove_mailbox',
  description: 'Disconnect and remove a configured mailbox',
  input: RemoveMailboxInput,
  output: ConfigureMailboxOutput,
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (_ctx, input) => {
    if (!mailboxStore.has(input.name)) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: `Mailbox "${input.name}" not found`, recoverable: false },
      };
    }
    mailboxStore.delete(input.name);
    return { success: true, message: `Mailbox "${input.name}" removed` };
  },
};

// list_mailboxes
const ListMailboxesInput = z.object({});

const ListMailboxesOutput = z.object({
  mailboxes: z.array(z.object({
    name: z.string(),
    provider: z.string(),
    isDefault: z.boolean(),
    status: z.string(),
  })),
});

export const listMailboxesAction: EmailAction<
  z.infer<typeof ListMailboxesInput>,
  z.infer<typeof ListMailboxesOutput>
> = {
  name: 'list_mailboxes',
  description: 'List all configured mailboxes with their status',
  input: ListMailboxesInput,
  output: ListMailboxesOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async () => {
    const mailboxes = [...mailboxStore.values()].map(mb => ({
      name: mb.name,
      provider: mb.providerType,
      isDefault: mb.isDefault,
      status: mb.status,
    }));
    return { mailboxes };
  },
};
