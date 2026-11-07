import { describe, it, expect, vi } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import type { EmailProvider } from '../providers/provider.js';
import { MessageNotFoundError } from '../providers/provider.js';
import { readDraftSnapshot } from './draft-eligibility.js';
import { sendDraftAction, updateDraftAction, createDraftAction } from './draft.js';
import { SendLedger } from '../security/send-ledger.js';

async function setup() {
  const provider = new MockEmailProvider();
  const { draftId } = await provider.createDraft({ to: [{ email: 'a@example.test' }], subject: 'Test', body: 'Original' });
  const ctx = { provider, sendAllowlist: { entries: ['*@example.test'] }, sendLedger: new SendLedger() };
  return { provider, draftId: draftId!, ctx };
}

describe('email-write/Draft observation eligibility', () => {
  it('Scenario: Snapshot lifecycle blocks sent and deleted drafts before mutation', async () => {
    for (const state of ['sent', 'deleted'] as const) {
      const { provider, draftId, ctx } = await setup();
      const snapshot = await provider.getDraftSnapshot(draftId);
      vi.spyOn(provider, 'getDraftSnapshot').mockImplementation(async () => {
        if (state === 'deleted') throw new MessageNotFoundError('Deleted');
        return { ...snapshot, lifecycle: 'indeterminate', message: { ...snapshot.message, isDraft: false } };
      });
      const update = vi.spyOn(provider, 'updateDraft');
      const send = vi.spyOn(provider, 'sendDraft');
      expect((await updateDraftAction.run(ctx, { draft_id: draftId, cc: [] })).success).toBe(false);
      expect((await sendDraftAction.run(ctx, { draft_id: draftId })).success).toBe(false);
      expect(update).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('Scenario: Unknown origin blocks body replacement independently of lifecycle', async () => {
    const { provider, draftId, ctx } = await setup();
    const snapshot = await provider.getDraftSnapshot(draftId);
    vi.spyOn(provider, 'getDraftSnapshot').mockResolvedValue({ ...snapshot, origin: 'indeterminate' });
    expect((await updateDraftAction.run(ctx, { draft_id: draftId, body: 'Overwrite', replace_body: true })).error?.code)
      .toBe('REPLY_DRAFT_BODY_IMMUTABLE');
    expect((await updateDraftAction.run(ctx, { draft_id: draftId, cc: [] })).success).toBe(true);
  });

  it('verified deferred drafts reject ordinary mutation and retain scheduling observation', async () => {
    const { provider, draftId, ctx } = await setup();
    const future = new Date(Date.now() + 3600000).toISOString();
    await provider.scheduleDraft(draftId, future);
    expect(await provider.getDraftSnapshot(draftId)).toMatchObject({ lifecycle: 'deferred', scheduledSendAt: future, origin: 'non_reply' });
    expect((await updateDraftAction.run(ctx, { draft_id: draftId, cc: [] })).error?.code).toBe('DRAFT_DEFERRED');
    expect((await sendDraftAction.run(ctx, { draft_id: draftId })).error?.code).toBe('DRAFT_DEFERRED');
  });

  it('an observed draft is not locked and a later mutation failure retains its id', async () => {
    const { provider, draftId, ctx } = await setup();
    const read = vi.spyOn(provider, 'getDraftSnapshot');
    vi.spyOn(provider, 'updateDraft').mockRejectedValue(new MessageNotFoundError('Remote draft disappeared after observation'));
    const result = await updateDraftAction.run(ctx, { draft_id: draftId, cc: [] });
    expect(result).toMatchObject({ success: false, draftId });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('Scenario: Draft observation uses canonical identity and recipients at the read barrier', async () => {
    const { provider, draftId, ctx } = await setup();
    const snapshot = await provider.getDraftSnapshot(draftId);
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(provider, 'getDraftSnapshot').mockImplementation(async () => {
      entered();
      await barrier;
      return { ...snapshot, draftId: 'canonical', message: { ...snapshot.message, bcc: [{ email: 'blocked@elsewhere.test' }] } };
    });
    const send = vi.spyOn(provider, 'sendDraft');
    const pending = sendDraftAction.run(ctx, { draft_id: 'message-alias' });
    await reading;
    expect(send).not.toHaveBeenCalled();
    release();
    expect((await pending).error?.code).toBe('ALLOWLIST_BLOCKED');
    expect(send).not.toHaveBeenCalled();
    vi.mocked(provider.getDraftSnapshot).mockResolvedValue({ ...snapshot, draftId: 'canonical' });
    send.mockResolvedValue({ success: true, messageId: 'sent' });
    expect((await sendDraftAction.run(ctx, { draft_id: draftId })).success).toBe(true);
    expect(send).toHaveBeenCalledWith('canonical');
  });

  describe('provider-interface/Optional draft observations', () => {
  it('Scenario: Legacy providers prefer draft reads and retain optional capability compatibility', async () => {
    const { provider, draftId } = await setup();
    const legacy: EmailProvider = {
      getMessage: vi.fn().mockRejectedValue(new Error('Message id is not draft id')),
      getDraft: vi.fn().mockResolvedValue((await provider.getDraftSnapshot(draftId)).message),
      getDraftReplyStatus: vi.fn().mockResolvedValue('non_reply'),
      listMessages: vi.fn(), searchMessages: vi.fn(), getThread: vi.fn(),
      sendMessage: vi.fn(), replyToMessage: vi.fn(), createDraft: vi.fn(), sendDraft: vi.fn(),
    };
    expect(await readDraftSnapshot(legacy, 'resource', true)).toMatchObject({ draftId: 'resource', origin: 'non_reply' });
    expect(legacy.getMessage).not.toHaveBeenCalled();
    delete legacy.getDraft;
    vi.mocked(legacy.getMessage).mockResolvedValue((await provider.getDraftSnapshot(draftId)).message);
    expect((await readDraftSnapshot(legacy, 'old')).lifecycle).toBe('editable');
    expect(legacy.getMessage).toHaveBeenCalledWith('old');
    vi.mocked(legacy.getDraftReplyStatus!).mockRejectedValue(new Error('Origin metadata unavailable'));
    expect((await readDraftSnapshot(legacy, 'old', true, false)).origin).toBe('indeterminate');
    await expect(readDraftSnapshot(legacy, 'old', true, true)).rejects.toThrow('Origin metadata unavailable');
  });
  });

  it('Scenario: Internal snapshot fields do not change draft tool wire schemas', () => {
    expect(Object.keys(sendDraftAction.input.shape)).toEqual(['draft_id', 'mailbox', 'scheduled_send_at', 'allow_duplicate']);
    expect(Object.keys(sendDraftAction.output.shape)).toEqual(['success', 'messageId', 'scheduledSendAt', 'error']);
    expect(Object.keys(createDraftAction.output.shape)).toEqual(['success', 'draftId', 'preview', 'previewError', 'warnings', 'error']);
    expect(updateDraftAction.output).toBe(createDraftAction.output);
    for (const schema of [sendDraftAction.input, updateDraftAction.input]) {
      expect(Object.keys(schema.shape)).not.toContain('revision');
      expect(Object.keys(schema.shape)).not.toContain('snapshot');
    }
  });
});
