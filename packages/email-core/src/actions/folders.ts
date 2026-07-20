// Folder management actions
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { ProviderError } from '../providers/provider.js';
import { checkDeletePolicy } from '../security/receive-allowlist.js';

const ActionError = z.object({
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

const EmailFolderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  path: z.string(),
  parentFolderId: z.string().optional(),
  childFolderCount: z.number().optional(),
  unreadItemCount: z.number().optional(),
  totalItemCount: z.number().optional(),
  isHidden: z.boolean().optional(),
}).catchall(z.unknown());

const ListFoldersInput = z.object({
  mailbox: z.string().optional(),
});

const ListFoldersOutput = z.object({
  success: z.boolean(),
  folders: z.array(EmailFolderSchema).optional(),
  error: ActionError.optional(),
});

export const listFoldersAction: EmailAction<
  z.infer<typeof ListFoldersInput>,
  z.infer<typeof ListFoldersOutput>
> = {
  name: 'list_folders',
  description: 'Recursively list mail folders, including computed paths for nested folders',
  input: ListFoldersInput,
  output: ListFoldersOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx) => {
    if (!ctx.provider.listFolders) {
      return notSupported('Provider does not support folder management');
    }
    const folders = await ctx.provider.listFolders();
    return { success: true, folders };
  },
};

const CreateFolderInput = z.object({
  display_name: z.string().min(1),
  parent_folder: z.string().min(1).optional().default('inbox'),
  mailbox: z.string().optional(),
});

const CreateFolderOutput = z.object({
  success: z.boolean(),
  folder: EmailFolderSchema.optional(),
  error: ActionError.optional(),
});

export const createFolderAction: EmailAction<
  z.infer<typeof CreateFolderInput>,
  z.infer<typeof CreateFolderOutput>
> = {
  name: 'create_folder',
  description: 'Create a custom child mail folder (defaults to a child of Inbox)',
  input: CreateFolderInput,
  output: CreateFolderOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!ctx.provider.createFolder) {
      return notSupported('Provider does not support folder management');
    }
    try {
      const folder = await ctx.provider.createFolder(input.display_name, input.parent_folder);
      return { success: true, folder };
    } catch (err) {
      return providerErrorResult(err);
    }
  },
};

const DeleteFolderInput = z.object({
  folder: z.string().min(1),
  user_explicitly_requested_deletion: z.boolean(),
  mailbox: z.string().optional(),
});

const DeleteFolderOutput = z.object({
  success: z.boolean(),
  error: ActionError.optional(),
});

export const deleteFolderAction: EmailAction<
  z.infer<typeof DeleteFolderInput>,
  z.infer<typeof DeleteFolderOutput>
> = {
  name: 'delete_folder',
  description: 'Delete a custom mail folder, including any mail it contains (disabled by default, requires explicit configuration). Well-known/system folders are protected.',
  input: DeleteFolderInput,
  output: DeleteFolderOutput,
  annotations: { readOnlyHint: false, destructiveHint: true },
  run: async (ctx, input) => {
    // Gated by the same operator policy as delete_email: deleting a folder can
    // discard every message inside it, so it must not be an ungated capability.
    const policyError = checkDeletePolicy(
      ctx.deleteEnabled === true ? { enabled: true, hardDeleteAllowed: ctx.hardDeleteAllowed === true } : undefined,
      input.user_explicitly_requested_deletion,
      false,
    );
    if (policyError) {
      return { success: false, error: { code: 'DELETE_DISABLED', message: policyError, recoverable: false } };
    }
    if (!ctx.provider.deleteFolder) {
      return notSupported('Provider does not support folder management');
    }
    try {
      await ctx.provider.deleteFolder(input.folder);
      return { success: true };
    } catch (err) {
      return providerErrorResult(err);
    }
  },
};

function notSupported(message: string): { success: false; error: { code: string; message: string; recoverable: boolean } } {
  return {
    success: false,
    error: { code: 'NOT_SUPPORTED', message, recoverable: false },
  };
}

function providerErrorResult(err: unknown): { success: false; error: { code: string; message: string; recoverable: boolean } } {
  if (err instanceof ProviderError) {
    return {
      success: false,
      error: { code: err.code, message: err.message, recoverable: err.recoverable },
    };
  }
  throw err;
}
