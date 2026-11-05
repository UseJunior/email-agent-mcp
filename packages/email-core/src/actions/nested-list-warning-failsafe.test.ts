import { describe, it, expect, vi } from 'vitest';

// The nested-list check is advisory: if analysis throws, compose must proceed
// with the caller's body and no warning (peer-review finding on PR #234).
vi.mock('../content/outlook-list-hazards.js', () => ({
  findNestedListReorderHazards: () => {
    throw new RangeError('Maximum call stack size exceeded');
  },
}));

const { MockEmailProvider } = await import('../testing/mock-provider.js');
const { createDraftAction } = await import('./draft.js');
const { SendLedger } = await import('../security/send-ledger.js');

describe('email-write/Outlook Nested List Warning', () => {
  it('a failing nested-list check never blocks the compose call', async () => {
    const provider = new MockEmailProvider();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = '<ul><li>lead<ul><li>x</li></ul><p>tail</p></li></ul>';
    const result = await createDraftAction.run(
      { provider, sendLedger: new SendLedger(), safeDir: process.cwd() },
      { to: 'jane@example.com', subject: 'Failsafe', body, format: 'html' },
    );
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(provider.getDrafts().get(result.draftId!)!.bodyHtml).toContain(body);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('nested-list check skipped'));
    errors.mockRestore();
  });
});
