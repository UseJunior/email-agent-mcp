import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import { readEmailAction } from './read.js';
import type { ActionContext } from './registry.js';

let provider: MockEmailProvider;
let ctx: ActionContext;

beforeEach(() => {
  provider = new MockEmailProvider();
  ctx = { provider };
});

describe('email-read/Read Email', () => {
  it('Scenario: Read email with body and metadata', async () => {
    provider.addMessage({
      id: 'msg123',
      subject: 'Contract Review',
      from: { email: 'alice@corp.com', name: 'Alice Smith' },
      to: [{ email: 'bob@corp.com', name: 'Bob Jones' }],
      receivedAt: '2024-03-15T10:30:00Z',
      isRead: false,
      hasAttachments: true,
      bodyHtml: '<p>Please review the attached contract.</p>',
      attachments: [
        { id: 'att1', filename: 'contract.pdf', mimeType: 'application/pdf', size: 245000, isInline: false },
      ],
    });

    const result = await readEmailAction.run(ctx, { id: 'msg123' });

    expect(result.id).toBe('msg123');
    expect(result.subject).toBe('Contract Review');
    expect(result.from).toContain('Alice Smith');
    expect(result.from).toContain('alice@corp.com');
    expect(result.to).toContain('Bob Jones <bob@corp.com>');
    expect(result.receivedAt).toBe('2024-03-15T10:30:00Z');
    expect(result.body).toContain('Please review the attached contract');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]!.filename).toBe('contract.pdf');
  });
});
