import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { getStore, type Session } from './store.js';

export const secret = 'synthetic-pickup';
export const tokens = { access_token: 'synthetic-access', expires_in: 3600 };
export const pending = (): Session => ({ state: 'pending', pickupHash: createHash('sha256').update(secret).digest('hex'), createdAt: Date.now() });

// These same decisions run against memory and the real Redis-backed SDK.
export function sessionContract() {
  describe('provider-gmail/OAuth2 Authentication session conformance', () => {
    it('Scenario: First terminal callback wins without extending expiry', async () => {
      const store = getStore();
      await store.create('race', pending());
      const results = await Promise.all([
        store.setReady('race', tokens),
        store.setFailed('race', 'denied', 'synthetic denial'),
        store.setFailed('race', 'exchange_failed', 'synthetic failure'),
        store.setReady('race', { ...tokens, access_token: 'loser' }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = await store.get('race');
      const states = ['ready', 'denied', 'exchange_failed', 'ready'];
      expect(winner?.state).toBe(states[results.indexOf(true)]);
      if (winner?.state === 'ready') expect(winner.tokens.access_token).toBe(results[0] ? tokens.access_token : 'loser');
      expect(await store.setFailed('race', 'denied', 'late')).toBe(false);
      expect(await store.setReady('race', tokens)).toBe(false);
      expect(await store.get('race')).toEqual(winner);
    });

    it.each(['ready', 'denied', 'exchange_failed'] as const)('keeps %s as the first terminal winner', async state => {
      const store = getStore();
      const id = `first-${state}`;
      await store.create(id, pending());
      expect(state === 'ready' ? await store.setReady(id, tokens) : await store.setFailed(id, state, 'first')).toBe(true);
      expect(await store.setReady(id, { ...tokens, access_token: 'late' })).toBe(false);
      expect(await store.setFailed(id, 'denied', 'late')).toBe(false);
      expect(await store.setFailed(id, 'exchange_failed', 'late')).toBe(false);
      expect(await store.claim(id, secret)).toEqual(state === 'ready' ? { ok: true, tokens } : { ok: false, reason: state, errorMessage: 'first' });
    });

    it('Scenario: Atomic one-shot ticket claim', async () => {
      const store = getStore();
      await store.create('claims', pending());
      await store.setReady('claims', tokens);
      const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim('claims', secret)));
      expect(claims.filter(result => result.ok)).toEqual([{ ok: true, tokens }]);
      expect(claims.filter(result => !result.ok).every(result => ['not_found', 'consumed'].includes(result.reason))).toBe(true);
      expect(await store.get('claims')).toBeNull();
    });

    it('wrong secrets at the first and last hash bytes never consume a ticket', async () => {
      const store = getStore();
      for (const index of [0, 63]) {
        const session = pending();
        const hash = session.pickupHash;
        session.pickupHash = hash.slice(0, index) + (hash[index] === '0' ? '1' : '0') + hash.slice(index + 1);
        await store.create(`hash-${index}`, session);
        await store.setReady(`hash-${index}`, tokens);
        expect(await store.claim(`hash-${index}`, secret)).toEqual({ ok: false, reason: 'invalid_secret' });
        expect((await store.get(`hash-${index}`))?.state).toBe('ready');
      }
      await store.create('mixed', pending());
      await store.setReady('mixed', tokens);
      const [wrong, right] = await Promise.all([store.claim('mixed', 'wrong'), store.claim('mixed', secret)]);
      expect(wrong.ok).toBe(false);
      expect(right).toEqual({ ok: true, tokens });
    });

    it('preserves pending and failure response shapes without consuming them', async () => {
      const store = getStore();
      await store.create('pending', pending());
      expect(await store.claim('pending', 'wrong')).toEqual({ ok: false, reason: 'pending' });
      for (const state of ['denied', 'exchange_failed'] as const) {
        await store.create(state, pending());
        expect(await store.setFailed(state, state, 'synthetic error')).toBe(true);
        for (let i = 0; i < 2; i++) {
          expect(await store.claim(state, secret)).toEqual({ ok: false, reason: state, errorMessage: 'synthetic error' });
        }
      }
      expect(await store.setReady('absent', tokens)).toBe(false);
      expect(await store.setFailed('absent', 'denied', 'error')).toBe(false);
      expect(await store.claim('absent', secret)).toEqual({ ok: false, reason: 'not_found' });
    });

    it('never releases tokens from malformed persisted sessions', async () => {
      const malformed: unknown[] = [
        null, [], 'invalid',
        { ...pending(), state: 'pending', tokens },
        { ...pending(), state: 'denied', tokens, errorMessage: 'denied' },
        { ...pending(), state: 'ready' },
        { ...pending(), state: 'ready', tokens: { access_token: 'synthetic' } },
        { ...pending(), state: 'ready', tokens: { ...tokens, expires_in: '3600' } },
        { ...pending(), state: 'ready', tokens: { ...tokens, scope: null } },
        { ...pending(), state: 'ready', tokens, pickupHash: 'bad' },
        { ...pending(), state: 'ready', tokens, createdAt: null },
        { ...pending(), state: 'ready', tokens, errorMessage: 'inconsistent' },
        { ...pending(), state: 'consumed', tokens },
      ];
      const store = getStore();
      for (const [i, value] of malformed.entries()) {
        await store.create(`malformed-${i}`, value as Session);
        expect(await store.get(`malformed-${i}`)).toBeNull();
        expect(await store.setReady(`malformed-${i}`, tokens)).toBe(false);
        expect(await store.setFailed(`malformed-${i}`, 'denied', 'error')).toBe(false);
        expect(await store.claim(`malformed-${i}`, secret)).toEqual({ ok: false, reason: 'consumed' });
      }
    });
  });
}
