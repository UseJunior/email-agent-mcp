import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAction } from './actions/registry.js';
import {
  EMAIL_SCOPE_PROFILE_ENV,
  filterActionsForProfile,
  getEmailScopeProfile,
} from './scope-profile.js';

const action = (name: string, readOnlyHint: boolean) => ({
  name,
  annotations: { readOnlyHint, destructiveHint: false },
}) as EmailAction;

describe('email scope profiles', () => {
  const originalProfile = process.env[EMAIL_SCOPE_PROFILE_ENV];

  afterEach(() => {
    if (originalProfile === undefined) delete process.env[EMAIL_SCOPE_PROFILE_ENV];
    else process.env[EMAIL_SCOPE_PROFILE_ENV] = originalProfile;
  });

  it('Scenario: full is the backwards-compatible default', () => {
    delete process.env[EMAIL_SCOPE_PROFILE_ENV];
    expect(getEmailScopeProfile()).toBe('full');
  });

  it('Scenario: observe retains reads and local mailbox configuration', () => {
    const actions = [
      action('read_email', true),
      action('send_email', false),
      action('configure_mailbox', false),
      action('remove_mailbox', false),
    ];

    expect(filterActionsForProfile(actions, 'observe').map(item => item.name)).toEqual([
      'read_email',
      'configure_mailbox',
      'remove_mailbox',
    ]);
  });

  it('Scenario: invalid profile fails closed with an actionable error', () => {
    process.env[EMAIL_SCOPE_PROFILE_ENV] = 'readonly';
    expect(() => getEmailScopeProfile()).toThrow(
      `Invalid ${EMAIL_SCOPE_PROFILE_ENV} value "readonly"`,
    );
  });
});
