import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAllowlistPolicy, type AllowlistPolicy } from './allowlist-policy.js';
import { loadSendAllowlist, checkSendAllowlist, isAllowedRecipient } from './send-allowlist.js';
import { loadReceiveAllowlist, isAllowedSender } from './receive-allowlist.js';

describe('email-security/Allowlist policy validation', () => {
  let dir: string;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('Scenario: Only missing files and absent paths use absent defaults', async () => {
    dir = await mkdtemp(join(tmpdir(), 'allowlist-policy-'));
    expect(await loadAllowlistPolicy()).toEqual({ status: 'absent' });
    const missing = await loadAllowlistPolicy(join(dir, 'missing.json'));
    expect(missing).toEqual({ status: 'absent' });
    expect(isAllowedSender('sender@example.com', missing)).toBe(true);
    expect(isAllowedRecipient('recipient@example.com', missing)).toBe(false);
    // EISDIR is an actual read failure, not ENOENT.
    const unreadable = await loadAllowlistPolicy(dir);
    expect(unreadable.status).toBe('invalid');
    expect(isAllowedSender('sender@example.com', unreadable)).toBe(false);
  });

  it.each(['{ malformed', 'null', '[]', '{}', '{"entries":null}', '{"entries":"*"}', '{"entries":[42]}', '{"entries":["*",false]}'])
  ('Scenario: Invalid existing policy blocks permissions (%s)', async (content) => {
    dir = await mkdtemp(join(tmpdir(), 'allowlist-policy-'));
    const path = join(dir, 'policy.json');
    await writeFile(path, content);
    const policy = await loadAllowlistPolicy(path);
    expect(policy.status).toBe('invalid');
    expect(isAllowedSender('sender@example.com', policy)).toBe(false);
    expect(isAllowedRecipient('recipient@example.com', policy)).toBe(false);
    expect(checkSendAllowlist([], policy)).toContain('invalid');
    // Deprecated adapters retain the original return type.
    expect(await loadSendAllowlist(path)).toBeUndefined();
    expect(await loadReceiveAllowlist(path)).toBeUndefined();
  });

  it('Scenario: Explicitly empty receive policy retains accept-all behavior', async () => {
    dir = await mkdtemp(join(tmpdir(), 'allowlist-policy-'));
    const path = join(dir, 'policy.json');
    await writeFile(path, '{"entries":[]}');
    const policy = await loadAllowlistPolicy(path);
    expect(policy).toEqual({ status: 'valid', config: { entries: [] } });
    expect(isAllowedSender('sender@example.com', policy)).toBe(true);
    expect(isAllowedRecipient('recipient@example.com', policy)).toBe(false);
    expect(await loadReceiveAllowlist(path)).toEqual({ entries: [] });
    expect(await loadSendAllowlist(path)).toEqual({ entries: [] });
  });

  it('Scenario: Valid typed policy supports existing matching rules', () => {
    const policy: AllowlistPolicy = { status: 'valid', config: { entries: ['*@example.com'] } };
    expect(isAllowedSender('sender@example.com', policy)).toBe(true);
    expect(isAllowedSender('sender@other.com', policy)).toBe(false);
    expect(checkSendAllowlist(['recipient@example.com'], policy)).toBeUndefined();
  });
});
