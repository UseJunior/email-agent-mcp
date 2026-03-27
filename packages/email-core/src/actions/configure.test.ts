import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import {
  configureMailboxAction,
  removeMailboxAction,
  listMailboxesAction,
  getMailboxStore,
  resetMailboxStore,
} from './configure.js';
import { registerProvider } from '../providers/provider.js';
import type { ActionContext } from './registry.js';

let ctx: ActionContext;

beforeEach(() => {
  resetMailboxStore();
  ctx = { provider: new MockEmailProvider() };
  // Register a test provider
  registerProvider('test-provider', async () => new MockEmailProvider());
});

describe('mailbox-config/Configure Mailbox', () => {
  it('Scenario: Add work mailbox', async () => {
    const result = await configureMailboxAction.run(ctx, {
      name: 'work',
      provider: 'test-provider',
      credentials: { clientId: 'test' },
      default: true,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('work');
    expect(result.message).toContain('default');
    expect(getMailboxStore().get('work')?.isDefault).toBe(true);
  });
});

describe('mailbox-config/Default Mailbox', () => {
  it('Scenario: Single mailbox auto-default', async () => {
    // First mailbox auto-becomes default
    await configureMailboxAction.run(ctx, {
      name: 'personal',
      provider: 'test-provider',
    });

    expect(getMailboxStore().get('personal')?.isDefault).toBe(true);
  });
});

describe('mailbox-config/Remove Mailbox', () => {
  it('Scenario: Remove old account', async () => {
    await configureMailboxAction.run(ctx, { name: 'old-account', provider: 'test-provider' });
    expect(getMailboxStore().has('old-account')).toBe(true);

    const result = await removeMailboxAction.run(ctx, { name: 'old-account' });
    expect(result.success).toBe(true);
    expect(getMailboxStore().has('old-account')).toBe(false);
  });
});

describe('mailbox-config/List Mailboxes', () => {
  it('Scenario: List all mailboxes', async () => {
    await configureMailboxAction.run(ctx, { name: 'work', provider: 'test-provider', default: true });
    await configureMailboxAction.run(ctx, { name: 'personal', provider: 'test-provider' });

    const result = await listMailboxesAction.run(ctx, {});

    expect(result.mailboxes).toHaveLength(2);
    const work = result.mailboxes.find(m => m.name === 'work');
    expect(work).toBeDefined();
    expect(work!.isDefault).toBe(true);
    expect(work!.status).toBe('connected');
  });
});

describe('mailbox-config/Provider Discovery', () => {
  it('Scenario: Provider not installed', async () => {
    const result = await configureMailboxAction.run(ctx, {
      name: 'gmail-work',
      provider: 'nonexistent-provider',
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('not available');
    expect(result.error!.message).toContain('Install');
  });
});
