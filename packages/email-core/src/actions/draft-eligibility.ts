import type { DraftSnapshot } from '../types.js';
import type { EmailProvider } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';

/** Prefer the optional observation capability. Legacy providers retain their
 * draft reader and origin contract; an absent isDraft field stays compatible.
 * Neither path closes the remote read/write TOCTOU window. */
export async function readDraftSnapshot(
  provider: EmailProvider,
  id: string,
  readOrigin = false,
  originRequired = readOrigin,
): Promise<DraftSnapshot> {
  if (provider.getDraftSnapshot) return provider.getDraftSnapshot(id);
  const message = await (provider.getDraft ? provider.getDraft(id) : provider.getMessage(id));
  let origin: DraftSnapshot['origin'] = 'indeterminate';
  if (readOrigin) {
    try {
      origin = await provider.getDraftReplyStatus?.(id) ?? 'indeterminate';
    } catch (err) {
      if (originRequired) throw err;
    }
  }
  return {
    draftId: id,
    messageId: message.id,
    message,
    lifecycle: message.isDraft === false ? 'indeterminate' : 'editable',
    origin,
  };
}

/** Lifecycle and origin are independent: unknown origin only blocks body edits. */
export function assertDraftMutationEligible(snapshot: DraftSnapshot, replacesBody = false): void {
  if (snapshot.lifecycle !== 'editable') {
    throw new ProviderError(
      snapshot.lifecycle === 'deferred' ? 'DRAFT_DEFERRED' : 'NOT_A_DRAFT',
      snapshot.lifecycle === 'deferred'
        ? 'Draft has a pending scheduled send.'
        : 'Cannot verify that this message is an editable draft.',
      'draft', false,
    );
  }
  if (replacesBody && snapshot.origin !== 'non_reply') {
    throw new ProviderError('REPLY_DRAFT_BODY_IMMUTABLE',
      'The draft body cannot be replaced safely because its origin is reply or indeterminate. Create a new draft instead.',
      'draft', true);
  }
}
