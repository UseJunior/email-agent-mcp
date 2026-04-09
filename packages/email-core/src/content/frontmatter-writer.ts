// Frontmatter writer — patches simple key: value pairs into a Markdown file's
// YAML-ish frontmatter block. Mirrors the (intentionally narrow) parser in
// frontmatter.ts: flat scalar fields only, no nesting, no multiline values.
//
// Used by create_draft's update_source_frontmatter flag to write back
// draft_id / draft_link (or draft_reply_id / draft_reply_link) so the
// human author can open the resulting draft from their source file.
//
// Design choices:
// - Patch in place: read file → split into frontmatter + body → update keys
//   → re-serialize. Body bytes are preserved byte-exact.
// - If the file has no frontmatter block, prepend one.
// - Existing keys: replace the FIRST occurrence; any additional occurrences
//   are left alone and a warning is written to stderr (the parser behaviour
//   reads the last value, but rewriting them all risks mangling structured
//   lists the user wrote by hand).
// - Multiline YAML scalars (`key: |` or `key: >`) are refused — we log a
//   warning and return `{ ok: false }` without modifying the file.
// - Silent-fail policy: this helper is called from a success-path branch
//   (draft already created). The caller should not abort the draft on
//   write failure; it should log and continue.
import { readFile, writeFile } from 'node:fs/promises';

export interface PatchResult {
  ok: boolean;
  reason?: string;
}

/**
 * Patch the given keys into the frontmatter of `filePath`.
 *
 * Values are written as plain unquoted scalars. Keys/values containing
 * characters that would confuse the hand-rolled parser (colons, newlines,
 * leading/trailing whitespace) are rejected with `{ ok: false }`.
 */
export async function patchFrontmatter(
  filePath: string,
  updates: Record<string, string>,
): Promise<PatchResult> {
  // Validate values up front — we refuse to write anything that would break
  // the read-side parser or introduce ambiguity.
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      return { ok: false, reason: `invalid key: ${JSON.stringify(k)}` };
    }
    if (typeof v !== 'string' || v.includes('\n') || v.includes('\r')) {
      return { ok: false, reason: `value for ${k} must be a single-line string` };
    }
  }

  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    return { ok: false, reason: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const normalized = raw.replace(/\r\n/g, '\n');
  const hadCrlf = raw !== normalized;

  let newContent: string;
  if (!normalized.startsWith('---\n')) {
    // No frontmatter block — prepend a new one followed by the original body.
    const fm = ['---', ...Object.entries(updates).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
    newContent = fm + raw;
  } else {
    const closingIdx = normalized.indexOf('\n---\n', 4);
    if (closingIdx === -1) {
      return { ok: false, reason: 'frontmatter block is unclosed — refusing to rewrite' };
    }

    const fmBlock = normalized.substring(4, closingIdx);
    // Body includes the trailing '\n---\n' marker length (5 chars)
    const bodyStart = closingIdx + 5;
    const body = normalized.substring(bodyStart);

    // Check for multiline scalar syntax — we can't safely rewrite those.
    for (const line of fmBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const value = trimmed.substring(colonIdx + 1).trim();
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        process.stderr.write(
          `[email-agent-mcp] frontmatter-writer: refusing to patch ${filePath} — contains multiline scalar ("${value}")\n`,
        );
        return { ok: false, reason: 'multiline YAML scalars are not supported' };
      }
    }

    // Patch existing keys in place (first occurrence); append new ones.
    const fmLines = fmBlock.split('\n');
    const remainingUpdates = new Map(Object.entries(updates));
    const duplicateWarnings: string[] = [];
    const seenKeys = new Set<string>();
    // Track which keys we actually patched so we can warn on duplicates even
    // after the update has been consumed from remainingUpdates.
    const patchedKeys = new Set<string>();

    for (let i = 0; i < fmLines.length; i++) {
      const line = fmLines[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.substring(0, colonIdx).trim();

      if (seenKeys.has(key)) {
        // Duplicate key in the original frontmatter — warn if we patched the
        // first occurrence (the duplicate may now disagree with the patched
        // value).
        if (patchedKeys.has(key)) {
          duplicateWarnings.push(key);
        }
        continue;
      }
      seenKeys.add(key);

      if (remainingUpdates.has(key)) {
        fmLines[i] = `${key}: ${remainingUpdates.get(key)}`;
        remainingUpdates.delete(key);
        patchedKeys.add(key);
      }
    }

    // Append any updates whose keys weren't found
    const appendLines = [...remainingUpdates.entries()].map(([k, v]) => `${k}: ${v}`);

    if (duplicateWarnings.length > 0) {
      process.stderr.write(
        `[email-agent-mcp] frontmatter-writer: ${filePath} has duplicate keys ${duplicateWarnings.join(', ')} — only the first occurrence was patched\n`,
      );
    }

    const newFm = [...fmLines, ...appendLines].join('\n');
    newContent = `---\n${newFm}\n---\n${body}`;
  }

  // Restore CRLF line endings if the original file used them.
  if (hadCrlf) {
    newContent = newContent.replace(/\n/g, '\r\n');
  }

  try {
    await writeFile(filePath, newContent, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `write failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
