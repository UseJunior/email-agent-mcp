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

/** Legacy outcome vocabulary retained for source compatibility. Persisted
 * sessions use the narrower Session discriminant below. */
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

interface SessionBase {
  /** SHA-256(pickup_secret) hex. Never the secret itself. */
  pickupHash: string;
  loginHint?: string;
  createdAt: number;
}

// Expiry, absence and consumption are outcomes, never persisted states.
export type Session = SessionBase & (
  | { state: 'pending'; tokens?: never; errorMessage?: never }
  | { state: 'ready'; tokens: BrokerTokens; errorMessage?: never }
  | { state: 'denied' | 'exchange_failed'; errorMessage: string; tokens?: never }
);

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

async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < 64; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validTokens(value: unknown): value is BrokerTokens {
  return isObject(value) && typeof value.access_token === 'string' && value.access_token.length > 0
    && typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) && value.expires_in > 0
    && ['refresh_token', 'scope', 'token_type'].every(key => value[key] === undefined || typeof value[key] === 'string');
}

function validSession(value: unknown): value is Session {
  if (!isObject(value) || typeof value.pickupHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.pickupHash)
    || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
    || (value.loginHint !== undefined && typeof value.loginHint !== 'string')) return false;
  switch (value.state) {
    case 'pending': return value.tokens === undefined && value.errorMessage === undefined;
    case 'ready': return validTokens(value.tokens) && value.errorMessage === undefined;
    case 'denied':
    case 'exchange_failed': return value.tokens === undefined && typeof value.errorMessage === 'string';
    default: return false;
  }
}

type Terminal = { state: 'ready'; tokens: BrokerTokens }
  | { state: 'denied' | 'exchange_failed'; errorMessage: string };

function advance(current: unknown, terminal: Terminal): Session | null {
  return validSession(current) && current.state === 'pending' ? { ...current, ...terminal } : null;
}

function claimResult(current: unknown, hash: string): ClaimResult {
  if (!validSession(current)) return { ok: false, reason: 'consumed' };
  switch (current.state) {
    case 'pending': return { ok: false, reason: 'pending' };
    case 'denied':
    case 'exchange_failed': return { ok: false, reason: current.state, errorMessage: current.errorMessage };
    case 'ready': return constantTimeEqual(current.pickupHash, hash)
      ? { ok: true, tokens: current.tokens } : { ok: false, reason: 'invalid_secret' };
  }
}

// Keep these predicates aligned with validSession/validTokens. cjson.decode is
// guarded: malformed persisted records must never yield credentials or throw.
const LUA_VALIDATION = `
local function finite(n) return type(n) == 'number' and n == n and math.abs(n) < math.huge end
local function tokens(t)
  if type(t) ~= 'table' or type(t.access_token) ~= 'string' or #t.access_token == 0
    or not finite(t.expires_in) or t.expires_in <= 0 then return false end
  for _, k in ipairs({'refresh_token', 'scope', 'token_type'}) do
    if t[k] ~= nil and type(t[k]) ~= 'string' then return false end
  end
  return true
end
local function valid(s)
  if type(s) ~= 'table' or type(s.pickupHash) ~= 'string' or #s.pickupHash ~= 64
    or string.find(s.pickupHash, '[^a-f0-9]') or not finite(s.createdAt)
    or (s.loginHint ~= nil and type(s.loginHint) ~= 'string') then return false end
  if s.state == 'pending' then return s.tokens == nil and s.errorMessage == nil end
  if s.state == 'ready' then return tokens(s.tokens) and s.errorMessage == nil end
  if s.state == 'denied' or s.state == 'exchange_failed' then
    return s.tokens == nil and type(s.errorMessage) == 'string'
  end
  return false
end
local raw = redis.call('GET', KEYS[1])
`;

const ADVANCE_LUA = LUA_VALIDATION + `
if not raw then return 0 end
local ok, s = pcall(cjson.decode, raw)
if not ok or not valid(s) or s.state ~= 'pending' then return 0 end
local next = cjson.decode(ARGV[1])
s.state = next.state
s.tokens = next.tokens
s.errorMessage = next.errorMessage
if not valid(s) or s.state == 'pending' then return 0 end
-- No expiry reset, including when the callback arrives just before expiration.
redis.call('SET', KEYS[1], cjson.encode(s), 'KEEPTTL')
return 1
`;

const CLAIM_LUA = LUA_VALIDATION + `
local function failure(reason) return cjson.encode({ok=false, reason=reason}) end
if not raw then return failure('not_found') end
local ok, s = pcall(cjson.decode, raw)
if not ok or not valid(s) then return failure('consumed') end
if s.state == 'pending' then return failure('pending') end
if s.state == 'denied' or s.state == 'exchange_failed' then
  return cjson.encode({ok=false, reason=s.state, errorMessage=s.errorMessage})
end
-- Full fixed-width comparison: no early exit on a mismatching byte.
local hash = ARGV[1]
local diff = bit.bxor(#s.pickupHash, #hash)
for i = 1, 64 do
  diff = bit.bor(diff, bit.bxor(string.byte(s.pickupHash, i) or 0, string.byte(hash, i) or 0))
end
if diff ~= 0 then return failure('invalid_secret') end
redis.call('DEL', KEYS[1])
return cjson.encode({ok=true, tokens=s.tokens})
`;

class MemoryStore implements SessionStore {
  private map = new Map<string, { session: Session; expiresAt: number }>();

  async create(sessionId: string, session: Session): Promise<CreateResult> {
    if (this.map.has(sessionId) && this.map.get(sessionId)!.expiresAt > Date.now()) {
      return { created: false, reason: 'collision' };
    }
    this.map.set(sessionId, { session: structuredClone(session), expiresAt: Date.now() + getConfig().ticketTtlMs });
    return { created: true };
  }

  async get(sessionId: string): Promise<Session | null> {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(sessionId);
      return null;
    }
    return validSession(entry.session) ? structuredClone(entry.session) : null;
  }

  async setReady(sessionId: string, tokens: BrokerTokens): Promise<boolean> {
    const entry = this.map.get(sessionId);
    if (!entry || entry.expiresAt <= Date.now() || !validTokens(tokens)) return false;
    const next = advance(entry.session, { state: 'ready', tokens });
    if (!next) return false;
    entry.session = structuredClone(next);
    return true;
  }

  async setFailed(sessionId: string, state: 'denied' | 'exchange_failed', message: string): Promise<boolean> {
    const entry = this.map.get(sessionId);
    if (!entry || entry.expiresAt <= Date.now() || typeof message !== 'string') return false;
    const next = advance(entry.session, { state, errorMessage: message });
    if (!next) return false;
    entry.session = structuredClone(next);
    return true;
  }

  async claim(sessionId: string, pickupSecret: string): Promise<ClaimResult> {
    const entry = this.map.get(sessionId);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(sessionId);
      return { ok: false, reason: 'expired' };
    }
    const presentedHash = await sha256Hex(pickupSecret);
    // Hashing yields. Never delete a replacement or release an expired ticket.
    if (this.map.get(sessionId) !== entry) return { ok: false, reason: 'not_found' };
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(sessionId);
      return { ok: false, reason: 'expired' };
    }
    const result = claimResult(entry.session, presentedHash);
    if (result.ok) this.map.delete(sessionId);
    return structuredClone(result);
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
    const ok = await kv.set(this.key(sessionId), session, { px: getConfig().ticketTtlMs, nx: true });
    return ok ? { created: true } : { created: false, reason: 'collision' };
  }

  async get(sessionId: string): Promise<Session | null> {
    const kv = await this.kv();
    const session = await kv.get<unknown>(this.key(sessionId));
    return validSession(session) ? session : null;
  }

  async setReady(sessionId: string, tokens: BrokerTokens): Promise<boolean> {
    const kv = await this.kv();
    if (!validTokens(tokens)) return false;
    return (await kv.eval(ADVANCE_LUA, [this.key(sessionId)], [JSON.stringify({ state: 'ready', tokens })])) === 1;
  }

  async setFailed(sessionId: string, state: 'denied' | 'exchange_failed', message: string): Promise<boolean> {
    const kv = await this.kv();
    if (typeof message !== 'string') return false;
    return (await kv.eval(ADVANCE_LUA, [this.key(sessionId)], [JSON.stringify({ state, errorMessage: message })])) === 1;
  }

  async claim(sessionId: string, pickupSecret: string): Promise<ClaimResult> {
    const kv = await this.kv();
    const presentedHash = await sha256Hex(pickupSecret);
    // @vercel/kv passes strings through unchanged and automatically decodes
    // the JSON result. Verification and DEL operate on the same current record.
    return kv.eval<unknown[], ClaimResult>(CLAIM_LUA, [this.key(sessionId)], [presentedHash]);
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
