import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { flagEmailAction, markReadAction } from './label.js';
import { moveToFolderAction } from './move.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  provider.addMessage({ id: 'msg123', subject: 'Test', folder: 'inbox', isRead: false, isFlagged: false });
  ctx = { provider };
});

describe('email-categorize/Flag Email', () => {
  it('Scenario: Flag as important', async () => {
    const result = await flagEmailAction.run(ctx, { id: 'msg123', flagged: true });
    expect(result.success).toBe(true);

    const msg = await provider.getMessage('msg123');
    expect(msg.isFlagged).toBe(true);
  });
});

describe('email-categorize/Mark Read State', () => {
  it('Scenario: Mark as read', async () => {
    const result = await markReadAction.run(ctx, { id: 'msg123', is_read: true });
    expect(result.success).toBe(true);

    const msg = await provider.getMessage('msg123');
    expect(msg.isRead).toBe(true);
  });
});

describe('email-categorize/Move to Folder', () => {
  it('Scenario: Archive email', async () => {
    const result = await moveToFolderAction.run(ctx, { id: 'msg123', folder: 'archive' });
    expect(result.success).toBe(true);

    const msg = await provider.getMessage('msg123');
    expect(msg.folder).toBe('archive');
  });
});
