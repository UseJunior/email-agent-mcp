import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isAllowedSender,
  checkDeletePolicy,
  checkAntiSpoofing,
  getReceiveAllowlistPath,
  getDeletePolicyFromEnv,
} from './receive-allowlist.js';
import { MockEmailProvider } from '../testing/mock-provider.js';

describe('email-security/Receive Allowlist', () => {
  it('Scenario: Accept all by default with warning', () => {
    // WHEN no receive allowlist is configured
    // THEN all inbound emails trigger the watcher (accept all by default)
    expect(isAllowedSender('anyone@anywhere.com', undefined)).toBe(true);
    expect(isAllowedSender('hacker@evil.com', undefined)).toBe(true);

    // Empty entries also accepts all
    expect(isAllowedSender('anyone@anywhere.com', { entries: [] })).toBe(true);
  });

  it('Scenario: EMAIL_AGENT_MCP_HOME controls default receive allowlist path', () => {
    const originalEnv = process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST'];
    const originalHome = process.env['EMAIL_AGENT_MCP_HOME'];
    try {
      delete process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST'];
      process.env['EMAIL_AGENT_MCP_HOME'] = '/tmp/email-agent-mcp-live';
      expect(getReceiveAllowlistPath()).toBe('/tmp/email-agent-mcp-live/receive-allowlist.json');
    } finally {
      if (originalEnv === undefined) {
        delete process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST'];
      } else {
        process.env['AGENT_EMAIL_RECEIVE_ALLOWLIST'] = originalEnv;
      }
      if (originalHome === undefined) {
        delete process.env['EMAIL_AGENT_MCP_HOME'];
      } else {
        process.env['EMAIL_AGENT_MCP_HOME'] = originalHome;
      }
    }
  });
});

describe('email-security/Delete Policy', () => {
  it('Scenario: Soft delete', async () => {
    // WHEN delete is enabled and user_explicitly_requested_deletion: true is passed
    const policy = { enabled: true, hardDeleteAllowed: false };
    const error = checkDeletePolicy(policy, true, false);
    expect(error).toBeUndefined();

    // THEN the email is moved to Trash (soft delete) — verify via mock provider
    const provider = new MockEmailProvider();
    provider.addMessage({ id: 'msg1', subject: 'To delete', folder: 'inbox' });
    await provider.deleteMessage('msg1', false);
    const messages = await provider.listMessages({ folder: 'trash' });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.id).toBe('msg1');
  });

  it('Scenario: Hard delete requires explicit flag', async () => {
    // WHEN delete is disabled
    const disabledError = checkDeletePolicy(undefined, true, false);
    expect(disabledError).toContain('Email deletion is disabled');
    // Remediation message names the env var so operators know what to flip.
    expect(disabledError).toContain('AGENT_EMAIL_DELETE_ENABLED');

    // WHEN enabled + explicit flag + hard delete
    const policy = { enabled: true, hardDeleteAllowed: true };
    const error = checkDeletePolicy(policy, true, true);
    expect(error).toBeUndefined();

    // Verify hard delete actually removes
    const provider = new MockEmailProvider();
    provider.addMessage({ id: 'msg1', subject: 'To delete' });
    await provider.deleteMessage('msg1', true);
    const allMsgs = provider.getMessages();
    expect(allMsgs).toHaveLength(0);
  });

  it('Scenario: Disabled by default', () => {
    // Spec: when AGENT_EMAIL_DELETE_ENABLED is unset or non-'true', delete_email
    // returns DELETE_DISABLED whose message names AGENT_EMAIL_DELETE_ENABLED.
    const error = checkDeletePolicy(undefined, true, false);
    expect(error).toContain('AGENT_EMAIL_DELETE_ENABLED');
  });

  it('Scenario: Hard delete requires both server gate and explicit flag', () => {
    // Spec: hard delete requires AGENT_EMAIL_HARD_DELETE_ENABLED=true AND hard_delete: true.
    // Verify the success path: both gates open + caller flag set → no error.
    const policy = { enabled: true, hardDeleteAllowed: true };
    const error = checkDeletePolicy(policy, true, true);
    expect(error).toBeUndefined();
  });

  it('Scenario: Hard delete blocked when only soft is enabled', () => {
    const policy = { enabled: true, hardDeleteAllowed: false };
    const error = checkDeletePolicy(policy, true, true);
    expect(error).toBeDefined();
    expect(error).toContain('Hard delete is not allowed');
    // Remediation names the hard-delete env var.
    expect(error).toContain('AGENT_EMAIL_HARD_DELETE_ENABLED');
  });

  it('Scenario: checkDeletePolicy uses strict-equality on policy.enabled', () => {
    // Non-boolean truthy value should NOT enable deletion (fail-closed).
    const sneaky = { enabled: 'true' as unknown as boolean, hardDeleteAllowed: false };
    const error = checkDeletePolicy(sneaky, true, false);
    expect(error).toContain('Email deletion is disabled');
  });
});

describe('email-security/getDeletePolicyFromEnv', () => {
  const originalDelete = process.env['AGENT_EMAIL_DELETE_ENABLED'];
  const originalHard = process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];

  afterEach(() => {
    if (originalDelete === undefined) delete process.env['AGENT_EMAIL_DELETE_ENABLED'];
    else process.env['AGENT_EMAIL_DELETE_ENABLED'] = originalDelete;
    if (originalHard === undefined) delete process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];
    else process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'] = originalHard;
  });

  it('returns undefined when env vars are unset', () => {
    delete process.env['AGENT_EMAIL_DELETE_ENABLED'];
    delete process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toBeUndefined();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns soft-only policy when only AGENT_EMAIL_DELETE_ENABLED=true', () => {
    process.env['AGENT_EMAIL_DELETE_ENABLED'] = 'true';
    delete process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toEqual({ enabled: true, hardDeleteAllowed: false });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('returns full policy when both env vars are exactly "true"', () => {
    process.env['AGENT_EMAIL_DELETE_ENABLED'] = 'true';
    process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'] = 'true';
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toEqual({ enabled: true, hardDeleteAllowed: true });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('treats non-"true" values as disabled and warns (strict parsing)', () => {
    process.env['AGENT_EMAIL_DELETE_ENABLED'] = '1';
    delete process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toBeUndefined();
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toContain('AGENT_EMAIL_DELETE_ENABLED');
  });

  it('treats uppercase TRUE as disabled (strict literal "true")', () => {
    process.env['AGENT_EMAIL_DELETE_ENABLED'] = 'TRUE';
    delete process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'];
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toBeUndefined();
    expect(onWarn).toHaveBeenCalled();
  });

  it('Scenario: Misconfigured env vars warn at startup', () => {
    // Spec: AGENT_EMAIL_HARD_DELETE_ENABLED=true without AGENT_EMAIL_DELETE_ENABLED=true must warn.
    delete process.env['AGENT_EMAIL_DELETE_ENABLED'];
    process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'] = 'true';
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toBeUndefined();
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toContain('has no effect without AGENT_EMAIL_DELETE_ENABLED');
  });

  it('warns when AGENT_EMAIL_HARD_DELETE_ENABLED=true is set without AGENT_EMAIL_DELETE_ENABLED', () => {
    delete process.env['AGENT_EMAIL_DELETE_ENABLED'];
    process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'] = 'true';
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toBeUndefined();
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toContain('has no effect without AGENT_EMAIL_DELETE_ENABLED');
  });

  it('warns about unsupported AGENT_EMAIL_HARD_DELETE_ENABLED value when delete is enabled', () => {
    process.env['AGENT_EMAIL_DELETE_ENABLED'] = 'true';
    process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'] = 'yes';
    const onWarn = vi.fn();
    const policy = getDeletePolicyFromEnv(onWarn);
    expect(policy).toEqual({ enabled: true, hardDeleteAllowed: false });
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn.mock.calls[0]![0]).toContain('AGENT_EMAIL_HARD_DELETE_ENABLED');
  });

  it('treats empty-string env values as unset (no warning)', () => {
    process.env['AGENT_EMAIL_DELETE_ENABLED'] = '';
    process.env['AGENT_EMAIL_HARD_DELETE_ENABLED'] = '';
    const onWarn = vi.fn();
    expect(getDeletePolicyFromEnv(onWarn)).toBeUndefined();
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe('email-security/Anti-Spoofing', () => {
  it('Scenario: Graph anti-spoofing', () => {
    // External email with failed SPF+DKIM should be rejected
    const spoofedResult = checkAntiSpoofing(
      { spf: 'fail', dkim: 'fail', isInternal: false },
      'relaxed',
    );
    expect(spoofedResult.passed).toBe(false);
    expect(spoofedResult.reason).toContain('Anti-spoofing check failed');

    // Internal M365 emails are allowed through
    const internalResult = checkAntiSpoofing(
      { spf: 'fail', dkim: 'fail', isInternal: true },
      'relaxed',
    );
    expect(internalResult.passed).toBe(true);

    // External with valid SPF passes relaxed
    const validResult = checkAntiSpoofing(
      { spf: 'pass', dkim: 'fail', isInternal: false },
      'relaxed',
    );
    expect(validResult.passed).toBe(true);
  });

  it('Scenario: Gmail anti-spoofing', () => {
    // Gmail: check Authentication-Results header — strict mode requires both
    const strictFail = checkAntiSpoofing(
      { spf: 'pass', dkim: 'fail', isInternal: false },
      'strict',
    );
    expect(strictFail.passed).toBe(false);

    const strictPass = checkAntiSpoofing(
      { spf: 'pass', dkim: 'pass', isInternal: false },
      'strict',
    );
    expect(strictPass.passed).toBe(true);

    // Off mode skips checks
    const offResult = checkAntiSpoofing(
      { spf: 'fail', dkim: 'fail', isInternal: false },
      'off',
    );
    expect(offResult.passed).toBe(true);
  });
});
