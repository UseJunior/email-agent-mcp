import type { EmailAction } from './actions/registry.js';

export const EMAIL_SCOPE_PROFILES = ['full', 'observe'] as const;
export type EmailScopeProfile = (typeof EMAIL_SCOPE_PROFILES)[number];

export const EMAIL_SCOPE_PROFILE_ENV = 'EMAIL_AGENT_MCP_SCOPE_PROFILE';

// These actions change only local connection metadata. They must remain
// available in observe mode so an installation can configure and repair its
// own authentication without gaining permission to mutate mailbox contents.
const OBSERVE_CONFIGURATION_ACTIONS = new Set([
  'configure_mailbox',
  'remove_mailbox',
  'list_mailboxes',
]);

export function getEmailScopeProfile(
  value = process.env[EMAIL_SCOPE_PROFILE_ENV],
): EmailScopeProfile {
  if (value === undefined || value.trim() === '') return 'full';
  if (value === 'full' || value === 'observe') return value;
  throw new Error(
    `Invalid ${EMAIL_SCOPE_PROFILE_ENV} value "${value}". Expected "full" or "observe".`,
  );
}

// Read-only actions that observe must still hide, because the Graph scopes the
// observe profile requests cannot satisfy them. list_inbox_rules reads
// /mailFolders/inbox/messageRules, which Graph gates behind MailboxSettings —
// a scope observe deliberately does not request (see GRAPH_SCOPES_BY_PROFILE).
// Exposing it anyway would advertise a tool that always 403s.
const OBSERVE_EXCLUDED_ACTIONS = new Set([
  'list_inbox_rules',
]);

export function isActionAllowedForProfile(
  action: Pick<EmailAction, 'name' | 'annotations'>,
  profile: EmailScopeProfile,
): boolean {
  if (profile === 'full') return true;
  if (OBSERVE_EXCLUDED_ACTIONS.has(action.name)) return false;
  return action.annotations.readOnlyHint
    || OBSERVE_CONFIGURATION_ACTIONS.has(action.name);
}

export function filterActionsForProfile<T extends Pick<EmailAction, 'name' | 'annotations'>>(
  actions: readonly T[],
  profile: EmailScopeProfile,
): T[] {
  return actions.filter(action => isActionAllowedForProfile(action, profile));
}

export function profileBlockedActionError(actionName: string): Error {
  // Two different reasons a tool can be missing under observe, and telling an
  // agent the wrong one sends it down the wrong recovery path. A read-only tool
  // excluded for scope reasons is not "a write tool".
  const reason = OBSERVE_EXCLUDED_ACTIONS.has(actionName)
    ? 'because the "observe" profile does not request the Microsoft Graph scope it requires'
    : 'because it can modify mailbox data';
  return new Error(
    `Tool "${actionName}" is unavailable under the "observe" scope profile ${reason}. `
    + `Set ${EMAIL_SCOPE_PROFILE_ENV}=full and re-authenticate to enable it.`,
  );
}
