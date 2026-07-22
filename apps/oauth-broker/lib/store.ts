// Session store. Sessions move through:
//
//   pending  ──Google consent───►  ready          ──claim──►  consumed
//      │                              │
//      └──user denied / failed────►  denied | exchange_failed
//
// All terminal states are returned to the CLI verbatim so it can
// distinguish "still waiting" from "auth was actually rejected".
//
// Backends:
//   - KV (Vercel Marketplace Redis / Upstash) when KV_REST_API_URL is set
//   - in-memory Map for `vercel dev` and unit tests
//
// Production (BROKER_REQUIRE_KV !== 'false') refuses to start without KV
// because Vercel Functions do not guarantee instance reuse — cross-request
// in-memory state is not actually shared.

import { getConfig } from './config.js';

export type SessionState =
  | 'pending'
  | 'ready'
  | 'consumed'
  | 'exchange_failed'
  | 'denied'
  | 'expired';

export interface BrokerTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

export interface Session {
  state: SessionState;
  /** SHA-256(pickup_secret) hex. Never the secret itself. */
  pickupHash: string;
  loginHint?: string;
  /** Present iff state === 'ready'. */
  tokens?: BrokerTokens;
  /** Present for failure states. */
  errorMessage?: string;
  createdAt: number;
}

export type CreateResult =
  | { created: true }
  | { created: false; reason: 'collision' };

export type ClaimResult =
  | { ok: true; tokens: BrokerTokens }
  | { ok: false; reason: 'pending' | 'invalid_secret' | 'consumed' | 'expired' | 'not_found' | 'denied' | 'exchange_failed'; errorMessage?: string };

export interface SessionStore {
  /** Register a brand new session. Fails on session_id collision. */
  create(sessionId: string, session: Session): Promise<CreateResult>;
  /** Fetch a session by id. Returns null if missing or expired. */
  get(sessionId: string): Promise<Session | null>;
  /** Mark a previously-pending session as ready with tokens. */
  setReady(sessionId: string, tokens: BrokerTokens): Promise<boolean>;
  /** Mark a session as terminally failed. */
  setFailed(sessionId: string, state: 'denied' | 'exchange_failed', message: string): Promise<boolean>;
  /**
   * Atomically claim a ready session. Caller must supply the raw
   * pickup_secret; the store hashes and compares against the stored
   * hash before atomically deleting the session record.
   */
  claim(sessionId: string, pickupSecret: string): Promise<ClaimResult>;
}

function ttlSeconds(): number {
  return Math.ceil(getConfig().ticketTtlMs / 1000);
}

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

class MemoryStore implements SessionStore {
  private map = new Map<string, { session: Session; expiresAt: number; claiming?: boolean }>();

  async create(sessionId: string, session: Session): Promise<CreateResult> {
    if (this.map.has(sessionId) && this.map.get(sessionId)!.expiresAt > Date.now()) {
      return { created: false, reason: 'collision' };
    }
    this.map.set(sessionId, { session, expiresAt: Date.now() + getConfig().ticketTtlMs });
    return { created: true };
  }

  async get(sessionId: string): Promise<Session | null> {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(sessionId);
      return null;
    }
    return entry.session;
  }

  async setReady(sessionId: string, tokens: BrokerTokens): Promise<boolean> {
    const entry = this.map.get(sessionId);
    if (!entry || entry.expiresAt <= Date.now() || entry.session.state !== 'pending') return false;
    entry.session.state = 'ready';
    entry.session.tokens = tokens;
    return true;
  }

  async setFailed(sessionId: string, state: 'denied' | 'exchange_failed', message: string): Promise<boolean> {
    const entry = this.map.get(sessionId);
    if (!entry || entry.expiresAt <= Date.now() || entry.session.state !== 'pending') return false;
    entry.session.state = state;
    entry.session.errorMessage = message;
    return true;
  }

  async claim(sessionId: string, pickupSecret: string): Promise<ClaimResult> {
    const entry = this.map.get(sessionId);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(sessionId);
      return { ok: false, reason: 'expired' };
    }
    const session = entry.session;
    if (session.state === 'pending') return { ok: false, reason: 'pending' };
    if (session.state === 'denied' || session.state === 'exchange_failed') {
      return { ok: false, reason: session.state, errorMessage: session.errorMessage };
    }
    if (session.state !== 'ready') return { ok: false, reason: 'consumed' };

    // sha256Hex awaits, which yields the event loop — a second concurrent
    // claim() for the same session can run its own checks in that window.
    // Synchronously stake a claim BEFORE the await so at most one caller
    // ever reaches the hash comparison; everyone else fails closed as if
    // the session were already consumed. On an invalid secret we release
    // the stake so a subsequent correct attempt can still succeed.
    if (entry.claiming) return { ok: false, reason: 'consumed' };
    entry.claiming = true;

    const expectedHash = session.pickupHash;
    const presentedHash = await sha256Hex(pickupSecret);
    if (!constantTimeEqual(expectedHash, presentedHash)) {
      entry.claiming = false;
      return { ok: false, reason: 'invalid_secret' };
    }
    this.map.delete(sessionId);
    if (!session.tokens) return { ok: false, reason: 'consumed' };
    return { ok: true, tokens: session.tokens };
  }
}

class KvStore implements SessionStore {
  private kvPromise: Promise<typeof import('@vercel/kv').kv> | null = null;

  private async kv() {
    if (!this.kvPromise) this.kvPromise = import('@vercel/kv').then(m => m.kv);
    return this.kvPromise;
  }

  private key(id: string): string {
    return `session:${id}`;
  }

  async create(sessionId: string, session: Session): Promise<CreateResult> {
    const kv = await this.kv();
    // SET NX gives us collision detection in a single round trip.
    const ok = await kv.set(this.key(sessionId), session, { ex: ttlSeconds(), nx: true });
    return ok ? { created: true } : { created: false, reason: 'collision' };
  }

  async get(sessionId: string): Promise<Session | null> {
    const kv = await this.kv();
    return (await kv.get<Session>(this.key(sessionId))) ?? null;
  }

  async setReady(sessionId: string, tokens: BrokerTokens): Promise<boolean> {
    const kv = await this.kv();
    const current = await kv.get<Session>(this.key(sessionId));
    if (!current || current.state !== 'pending') return false;
    const next: Session = { ...current, state: 'ready', tokens };
    // Preserve the original TTL by passing keepTtl. Upstash accepts it as KEEPTTL.
    await kv.set(this.key(sessionId), next, { ex: ttlSeconds() });
    return true;
  }

  async setFailed(sessionId: string, state: 'denied' | 'exchange_failed', message: string): Promise<boolean> {
    const kv = await this.kv();
    const current = await kv.get<Session>(this.key(sessionId));
    if (!current || current.state !== 'pending') return false;
    const next: Session = { ...current, state, errorMessage: message };
    await kv.set(this.key(sessionId), next, { ex: ttlSeconds() });
    return true;
  }

  async claim(sessionId: string, pickupSecret: string): Promise<ClaimResult> {
    const kv = await this.kv();
    const current = await kv.get<Session>(this.key(sessionId));
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.state === 'pending') return { ok: false, reason: 'pending' };
    if (current.state === 'denied' || current.state === 'exchange_failed') {
      return { ok: false, reason: current.state, errorMessage: current.errorMessage };
    }
    if (current.state !== 'ready') return { ok: false, reason: 'consumed' };

    const presentedHash = await sha256Hex(pickupSecret);
    if (!constantTimeEqual(current.pickupHash, presentedHash)) {
      return { ok: false, reason: 'invalid_secret' };
    }
    // GETDEL is a single Redis command, so two concurrent claims with the
    // correct secret cannot both succeed: only one observes the value.
    const claimed = await (kv as unknown as { getdel<T>(key: string): Promise<T | null> }).getdel<Session>(this.key(sessionId));
    if (!claimed || !claimed.tokens) return { ok: false, reason: 'consumed' };
    return { ok: true, tokens: claimed.tokens };
  }
}

let storeSingleton: SessionStore | null = null;

export function getStore(): SessionStore {
  if (!storeSingleton) {
    storeSingleton = getConfig().useKv ? new KvStore() : new MemoryStore();
  }
  return storeSingleton;
}

/** Test helper: reset the singleton and clear in-memory state. */
export function _resetStoreForTests(): void {
  storeSingleton = null;
}

export { sha256Hex };
