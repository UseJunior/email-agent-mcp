// move_to_folder action — move email between folders
import { z } from 'zod';
import type { EmailAction } from './registry.js';

const MoveToFolderInput = z.object({
  id: z.string(),
  folder: z.string(),
  mailbox: z.string().optional(),
});

const MoveToFolderOutput = z.object({
  success: z.boolean(),
  newId: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string(), recoverable: z.boolean() }).optional(),
});

export const moveToFolderAction: EmailAction<
  z.infer<typeof MoveToFolderInput>,
  z.infer<typeof MoveToFolderOutput>
> = {
  name: 'move_to_folder',
  description: 'Move an email to a specific folder (inbox, archive, trash, etc.). Returns the new message ID since Graph assigns a new ID after moving.',
  input: MoveToFolderInput,
  output: MoveToFolderOutput,
  annotations: { readOnlyHint: false, destructiveHint: false },
  run: async (ctx, input) => {
    if (!ctx.provider.moveToFolder) {
      return {
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Provider does not support folder operations', recoverable: false },
      };
    }
    const newId = await ctx.provider.moveToFolder(input.id, input.folder);
    return { success: true, newId: typeof newId === 'string' ? newId : undefined };
  },
};
