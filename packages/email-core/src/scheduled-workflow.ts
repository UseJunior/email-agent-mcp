import type { ScheduledSendWorkflow, ScheduledSendResult, ScheduledPreparationPhase, EmailError } from './types.js';

/** Own the scheduling sequence. No step is retried or compensated: even a
 * failed preparation write may have persisted remotely. Dispatch classification
 * belongs to the provider; missing evidence must be classified as unknown. */
export async function runScheduledWorkflow(steps: {
  scheduledSendAt: string;
  draftId?: string;
  createDraft: () => Promise<string>;
  prepareAttachments: (id: string) => Promise<void>;
  setDeferredProperty: (id: string) => Promise<void>;
  dispatch: (id: string) => Promise<void>;
  preparationError: (err: unknown, phase: ScheduledPreparationPhase) => EmailError;
  dispatchError: (err: unknown, id: string) => { outcome: 'rejected' | 'unknown'; error: EmailError };
}): Promise<ScheduledSendResult> {
  let state: ScheduledSendWorkflow = { phase: 'preparing' };
  let id = steps.draftId;
  try {
    id ??= await steps.createDraft();
    state = { phase: 'draft_created', draftId: id, messageId: id };
    await steps.prepareAttachments(id);
    state = { phase: 'attachments_ready', draftId: id, messageId: id };
    await steps.setDeferredProperty(id);
    state = { phase: 'deferred_property_set', draftId: id, messageId: id };
  } catch (err) {
    // No dispatch was attempted; a surviving draft may still carry a marker.
    const lastPhase = state.phase;
    return {
      success: false, messageId: id, scheduledSendAt: steps.scheduledSendAt,
      workflow: { phase: 'terminal', outcome: 'rejected', lastPhase, draftId: id, messageId: id },
      error: steps.preparationError(err, lastPhase),
    };
  }
  state = { phase: 'dispatching', draftId: id, messageId: id };
  try {
    await steps.dispatch(id);
    return {
      success: true, messageId: id, scheduledSendAt: steps.scheduledSendAt,
      workflow: { ...state, phase: 'terminal', outcome: 'accepted', lastPhase: 'dispatching' },
    };
  } catch (err) {
    const { outcome, error } = steps.dispatchError(err, id);
    return {
      success: false, messageId: id, scheduledSendAt: steps.scheduledSendAt, error,
      workflow: { ...state, phase: 'terminal', outcome, lastPhase: 'dispatching' },
    };
  }
}
