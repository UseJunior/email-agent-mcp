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

export function isActionAllowedForProfile(
  action: Pick<EmailAction, 'name' | 'annotations'>,
  profile: EmailScopeProfile,
): boolean {
  return profile === 'full'
    || action.annotations.readOnlyHint
    || OBSERVE_CONFIGURATION_ACTIONS.has(action.name);
}

export function filterActionsForProfile<T extends Pick<EmailAction, 'name' | 'annotations'>>(
  actions: readonly T[],
  profile: EmailScopeProfile,
): T[] {
  return actions.filter(action => isActionAllowedForProfile(action, profile));
}

export function profileBlockedActionError(actionName: string): Error {
  return new Error(
    `Tool "${actionName}" is unavailable under the "observe" scope profile because it can modify mailbox data. Set ${EMAIL_SCOPE_PROFILE_ENV}=full and re-authenticate to enable write tools.`,
  );
}
