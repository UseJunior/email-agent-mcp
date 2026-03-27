import { describe, it, expect } from 'vitest';
import { isAllowedRecipient, checkSendAllowlist, SendRateLimiter, getSendAllowlistPath } from './send-allowlist.js';
import type { AllowlistConfig } from '../actions/registry.js';

describe('email-security/Send Allowlist', () => {
  it('Scenario: Empty allowlist blocks all outbound including replies', () => {
    // WHEN no send allowlist is configured
    const noAllowlist: AllowlistConfig | undefined = undefined;

    // THEN all send AND reply attempts are blocked
    expect(isAllowedRecipient('alice@example.com', noAllowlist)).toBe(false);
    expect(isAllowedRecipient('bob@corp.com', noAllowlist)).toBe(false);

    // Also empty entries blocks all
    const emptyEntries: AllowlistConfig = { entries: [] };
    expect(isAllowedRecipient('alice@example.com', emptyEntries)).toBe(false);

    // checkSendAllowlist returns clear error message
    const error = checkSendAllowlist(['alice@example.com'], noAllowlist);
    expect(error).toContain('Send allowlist not configured');
    expect(error).toContain('all outbound email is disabled');
  });

  it('Scenario: Domain wildcard match', () => {
    const allowlist: AllowlistConfig = { entries: ['*@lawfirm.com'] };

    // WHEN *@lawfirm.com is in the allowlist, THEN partner@lawfirm.com is allowed
    expect(isAllowedRecipient('partner@lawfirm.com', allowlist)).toBe(true);
    expect(isAllowedRecipient('associate@lawfirm.com', allowlist)).toBe(true);

    // Other domains blocked
    expect(isAllowedRecipient('hacker@evil.com', allowlist)).toBe(false);
  });

  it('Scenario: Wildcard allows all', () => {
    const allowlist: AllowlistConfig = { entries: ['*'] };

    // WHEN * is in the send allowlist, THEN all outbound is allowed
    expect(isAllowedRecipient('anyone@anywhere.com', allowlist)).toBe(true);
    expect(isAllowedRecipient('hacker@evil.com', allowlist)).toBe(true);
  });
});

describe('email-security/Allowlist Protection', () => {
  it('Scenario: Agent cannot modify allowlist', async () => {
    // Verify the send-allowlist module exports no mutation functions
    const mod = await import('./send-allowlist.js');
    const exportedNames = Object.keys(mod);
    const mutationFns = exportedNames.filter(
      name => name.startsWith('set') || name.startsWith('update') ||
              name.startsWith('write') || name.startsWith('modify'),
    );
    expect(mutationFns).toHaveLength(0);
  });

  it('Scenario: NemoClaw read-only storage', () => {
    // WHEN running in NemoClaw sandbox
    // THEN the allowlist path comes from env var
    const originalEnv = process.env['AGENT_EMAIL_SEND_ALLOWLIST'];
    try {
      process.env['AGENT_EMAIL_SEND_ALLOWLIST'] = '/sandbox/.openclaw/send-allowlist.json';
      expect(getSendAllowlistPath()).toBe('/sandbox/.openclaw/send-allowlist.json');
    } finally {
      if (originalEnv === undefined) {
        delete process.env['AGENT_EMAIL_SEND_ALLOWLIST'];
      } else {
        process.env['AGENT_EMAIL_SEND_ALLOWLIST'] = originalEnv;
      }
    }
  });
});

describe('email-security/Rate Limiting', () => {
  it('Scenario: Rate limit exceeded', () => {
    const limiter = new SendRateLimiter(2, 60000); // 2 per minute

    limiter.recordUsage('send_email');
    limiter.recordUsage('send_email');

    // THEN returns an error with retry-after guidance
    const result = limiter.checkLimit('send_email');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeDefined();
    expect(result.retryAfter!).toBeGreaterThan(0);
  });
});
