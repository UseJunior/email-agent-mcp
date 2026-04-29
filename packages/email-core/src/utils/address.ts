import type { EmailAddress } from '../types.js';

export class AddressParseError extends Error {
  constructor(public readonly field: string, public readonly index: number, public readonly value: string) {
    super(`${field}[${index}] invalid address: "${value}"`);
    this.name = 'AddressParseError';
  }
}

export function parseAddressString(raw: string): EmailAddress {
  const trimmed = raw.trim();

  // Reject stringly-multi-address inputs ('Alice <a@x>, Bob <b@y>') — multiple
  // angle brackets signal a joined list, not a single entry.
  const angleCount = (trimmed.match(/</g) ?? []).length;
  if (angleCount > 1) throw new Error(`invalid address: "${raw}"`);

  // Bare email (no angle brackets).
  if (!trimmed.includes('<') && !trimmed.includes('>')) {
    if (/^[^\s"<>@]+@[^\s"<>@]+$/.test(trimmed)) return { email: trimmed };
    throw new Error(`invalid address: "${raw}"`);
  }

  // Name-address: either "quoted name" + <email>, or bare-name + <email>.
  // Quotes must be balanced when present; bare name cannot contain '<' or '"'.
  const m = /^\s*(?:"([^"]*)"|([^<"]*?))\s*<\s*([^\s"<>@]+@[^\s"<>@]+)\s*>\s*$/.exec(trimmed);
  if (!m || m[3] === undefined) throw new Error(`invalid address: "${raw}"`);

  const rawName = (m[1] ?? m[2] ?? '').trim();
  const email = m[3];
  return rawName ? { name: rawName, email } : { email };
}

export type ParsedList =
  | { ok: true; addresses: EmailAddress[] }
  | { ok: false; field: string; index: number; value: string };

export function parseAddressList(raws: string[] | undefined, field: string): ParsedList {
  if (!raws) return { ok: true, addresses: [] };
  const out: EmailAddress[] = [];
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i] ?? '';
    try {
      out.push(parseAddressString(raw));
    } catch {
      return { ok: false, field, index: i, value: raw };
    }
  }
  return { ok: true, addresses: out };
}
