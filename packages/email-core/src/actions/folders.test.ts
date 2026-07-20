import { describe, expect, it, vi } from 'vitest';
import type { EmailProvider } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { createFolderAction, deleteFolderAction, listFoldersAction } from './folders.js';
import type { ActionContext } from './registry.js';

function contextWith(methods: Partial<EmailProvider> = {}): ActionContext {
  return { provider: Object.assign(new MockEmailProvider(), methods) };
}

describe('email-folders/List Folders', () => {
  it('Scenario: List folders recursively through the provider capability', async () => {
    const folders = [
      { id: 'inbox-id', displayName: 'Inbox', path: 'Inbox' },
      { id: 'news-id', displayName: 'Newsletters', path: 'Inbox/Newsletters', parentFolderId: 'inbox-id' },
    ];
    const listFolders = vi.fn().mockResolvedValue(folders);

    const result = await listFoldersAction.run(contextWith({ listFolders }), {});

    expect(result).toEqual({ success: true, folders });
    expect(listFolders).toHaveBeenCalledOnce();
    expect(listFoldersAction.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
  });

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await listFoldersAction.run(contextWith(), {});
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('email-folders/Create Folder', () => {
  it('Scenario: Create an inbox child folder', async () => {
    const folder = { id: 'news-id', displayName: 'Newsletters', path: 'Inbox/Newsletters' };
    const createFolder = vi.fn().mockResolvedValue(folder);

    const result = await createFolderAction.run(contextWith({ createFolder }), {
      display_name: 'Newsletters',
      parent_folder: 'inbox',
    });

    expect(result).toEqual({ success: true, folder });
    expect(createFolder).toHaveBeenCalledWith('Newsletters', 'inbox');
  });

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await createFolderAction.run(contextWith(), {
      display_name: 'Newsletters',
      parent_folder: 'inbox',
    });
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});

describe('email-folders/Delete Folder', () => {
  it('Scenario: Delete a custom folder', async () => {
    const deleteFolder = vi.fn().mockResolvedValue(undefined);
    const result = await deleteFolderAction.run(contextWith({ deleteFolder }), { folder: 'Inbox/Newsletters' });

    expect(result).toEqual({ success: true });
    expect(deleteFolder).toHaveBeenCalledWith('Inbox/Newsletters');
    expect(deleteFolderAction.annotations.destructiveHint).toBe(true);
  });

  it('Scenario: System folder protection is returned as a typed error', async () => {
    const deleteFolder = vi.fn().mockRejectedValue(
      new ProviderError('SYSTEM_FOLDER_PROTECTED', 'System folders cannot be deleted', 'microsoft', false),
    );
    const result = await deleteFolderAction.run(contextWith({ deleteFolder }), { folder: 'inbox-id' });

    expect(result).toMatchObject({ success: false, error: { code: 'SYSTEM_FOLDER_PROTECTED' } });
  });

  it('Scenario: Unsupported provider returns NOT_SUPPORTED', async () => {
    const result = await deleteFolderAction.run(contextWith(), { folder: 'Newsletters' });
    expect(result).toMatchObject({ success: false, error: { code: 'NOT_SUPPORTED' } });
  });
});
