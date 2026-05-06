// Ticket store: holds {sessionId -> tokens} for the brief window between
// Google's redirect-to-callback and the CLI picking the tokens up via
// /api/tickets/[id]. One-shot reads. TTL-bounded.
//
// Auto-selects backend:
//   - KV (Vercel KV) if KV_REST_API_URL is set in env
//   - In-memory Map otherwise (dev / single-instance only)

import { getConfig } from './config.js';

export interface Ticket {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  tokenType?: string;
}

export interface TicketStore {
  put(sessionId: string, ticket: Ticket): Promise<void>;
  takeOnce(sessionId: string): Promise<Ticket | null>;
}

class MemoryStore implements TicketStore {
  private map = new Map<string, { ticket: Ticket; expiresAt: number }>();

  async put(sessionId: string, ticket: Ticket): Promise<void> {
    const ttl = getConfig().ticketTtlMs;
    this.map.set(sessionId, { ticket, expiresAt: Date.now() + ttl });
    // Best-effort GC; OK if process restarts.
    setTimeout(() => this.map.delete(sessionId), ttl).unref?.();
  }

  async takeOnce(sessionId: string): Promise<Ticket | null> {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    this.map.delete(sessionId);
    if (Date.now() > entry.expiresAt) return null;
    return entry.ticket;
  }
}

class KvStore implements TicketStore {
  private kvPromise: Promise<typeof import('@vercel/kv').kv> | null = null;

  private async kv() {
    if (!this.kvPromise) {
      this.kvPromise = import('@vercel/kv').then(m => m.kv);
    }
    return this.kvPromise;
  }

  async put(sessionId: string, ticket: Ticket): Promise<void> {
    const kv = await this.kv();
    const ttlSeconds = Math.ceil(getConfig().ticketTtlMs / 1000);
    await kv.set(this.key(sessionId), ticket, { ex: ttlSeconds });
  }

  async takeOnce(sessionId: string): Promise<Ticket | null> {
    const kv = await this.kv();
    const key = this.key(sessionId);
    const ticket = await kv.get<Ticket>(key);
    if (!ticket) return null;
    await kv.del(key);
    return ticket;
  }

  private key(sessionId: string): string {
    return `ticket:${sessionId}`;
  }
}

let storeSingleton: TicketStore | null = null;

export function getStore(): TicketStore {
  if (!storeSingleton) {
    storeSingleton = getConfig().useKv ? new KvStore() : new MemoryStore();
  }
  return storeSingleton;
}
