import { describe, it, expect } from 'vitest';

// Spec: provider-gmail — Requirement: Dual Watch Mode
// Tests written FIRST (spec-driven). Implementation pending.

describe('provider-gmail/Dual Watch Mode', () => {
  it('Scenario: Pub/Sub auto-renewal', async () => {
    // WHEN the Pub/Sub watch registration approaches 7-day expiry
    // THEN automatically re-registers via users.watch()
    expect.fail('Not implemented — awaiting Pub/Sub auto-renewal');
  });

  it('Scenario: history.list fallback', async () => {
    // WHEN Pub/Sub is not configured
    // THEN polls history.list at configurable interval (default 30s)
    expect.fail('Not implemented — awaiting history.list polling');
  });
});
