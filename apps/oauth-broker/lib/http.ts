// Tiny request helpers shared across routes. Keeps each handler small.

import type { VercelRequest } from '@vercel/node';

export const ID_RE = /^[A-Za-z0-9_-]{32,128}$/;
export const HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * Vercel's Node runtime auto-parses `application/json`, but malformed
 * JSON can cause `req.body` to be `undefined` or to throw on access.
 * Wrap that defensively and accept either pre-parsed objects or strings.
 */
export function readJsonBody(req: VercelRequest): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = req.body;
  } catch {
    return null;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  return null;
}
