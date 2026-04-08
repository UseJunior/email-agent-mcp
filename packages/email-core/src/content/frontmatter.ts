// Lightweight YAML frontmatter parser for .md body files
// Flat key-value only — no nesting, no arrays, no multi-line values
import type { BodyFormat } from './body-renderer.js';
import { BODY_FORMATS } from './body-renderer.js';

export interface FrontmatterFields {
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  reply_to?: string;
  draft?: boolean;
  format?: BodyFormat;
  force_black?: boolean;
}

const KNOWN_KEYS = new Set(['to', 'cc', 'subject', 'reply_to', 'draft', 'format', 'force_black']);

export function parseFrontmatter(
  content: string,
): { frontmatter?: FrontmatterFields; body: string } {
  // Normalize CRLF to LF
  const normalized = content.replace(/\r\n/g, '\n');

  // Must start with --- on line 1
  if (!normalized.startsWith('---\n')) {
    return { body: content };
  }

  // Find closing ---
  const closingIdx = normalized.indexOf('\n---\n', 4);
  if (closingIdx === -1) {
    // Unclosed frontmatter — treat as no frontmatter
    return { body: content };
  }

  const fmBlock = normalized.substring(4, closingIdx);
  const body = normalized.substring(closingIdx + 5); // skip past \n---\n

  const fields: FrontmatterFields = {};
  for (const line of fmBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Split on first colon only
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.substring(0, colonIdx).trim().toLowerCase();
    let value = trimmed.substring(colonIdx + 1).trim();

    if (!KNOWN_KEYS.has(key)) continue;

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key === 'to' || key === 'cc') {
      const parts = value.split(',').map(s => s.trim()).filter(Boolean);
      fields[key] = parts.length === 1 ? parts[0]! : parts;
    } else if (key === 'draft') {
      fields.draft = value.toLowerCase() === 'true';
    } else if (key === 'subject') {
      fields.subject = value;
    } else if (key === 'reply_to') {
      fields.reply_to = value;
    } else if (key === 'format') {
      const lowered = value.toLowerCase();
      if ((BODY_FORMATS as readonly string[]).includes(lowered)) {
        fields.format = lowered as BodyFormat;
      }
      // unknown values silently ignored — action layer falls back to default
    } else if (key === 'force_black') {
      fields.force_black = value.toLowerCase() === 'true';
    }
  }

  const hasSomeField = Object.keys(fields).length > 0;
  return { frontmatter: hasSomeField ? fields : undefined, body };
}
