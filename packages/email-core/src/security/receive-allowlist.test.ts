import { describe, it, expect } from 'vitest';
import { isAllowedSender, checkDeletePolicy, checkAntiSpoofing, getReceiveAllowlistPath } from './receive-allowlist.js';
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
