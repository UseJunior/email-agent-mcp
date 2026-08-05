import { afterEach, describe, expect, it } from 'vitest';
import type { EmailAction } from './actions/registry.js';
import {
  EMAIL_SCOPE_PROFILE_ENV,
  filterActionsForProfile,
  getEmailScopeProfile,
  profileBlockedActionError,
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

  it('Scenario: observe hides read-only tools its scopes cannot satisfy', () => {
    // list_inbox_rules is readOnlyHint, but Graph gates messageRules behind
    // MailboxSettings, which observe does not request. Advertising it would
    // hand an agent a tool that always 403s.
    const actions = [action('read_email', true), action('list_inbox_rules', true)];

    expect(filterActionsForProfile(actions, 'observe').map(item => item.name)).toEqual(['read_email']);
    expect(filterActionsForProfile(actions, 'full').map(item => item.name)).toEqual([
      'read_email',
      'list_inbox_rules',
    ]);
  });

  it('Scenario: blocked-tool errors name the right reason', () => {
    // A read-only tool withheld for scope reasons must not be described as a
    // write tool — that points an agent at the wrong recovery path.
    expect(profileBlockedActionError('send_email').message).toContain('can modify mailbox data');
    expect(profileBlockedActionError('list_inbox_rules').message)
      .toContain('does not request the Microsoft Graph scope it requires');
    expect(profileBlockedActionError('list_inbox_rules').message)
      .not.toContain('can modify mailbox data');
  });

  it('Scenario: invalid profile fails closed with an actionable error', () => {
    process.env[EMAIL_SCOPE_PROFILE_ENV] = 'readonly';
    expect(() => getEmailScopeProfile()).toThrow(
      `Invalid ${EMAIL_SCOPE_PROFILE_ENV} value "readonly"`,
    );
  });
});
