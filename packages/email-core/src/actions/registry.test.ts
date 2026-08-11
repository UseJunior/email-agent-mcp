/// <reference types="vite/client" />
// Spec: openspec/specs/mcp-transport/spec.md — "Action to Tool Mapping"
// EMAIL_ACTIONS is the canonical registry consumed by adapters; it must be
// non-empty, duplicate-free, and complete (issue #174: a previous mutable
// registration mechanism was never called, shipping a permanently empty
// array as public API).
import { describe, expect, it } from 'vitest';
import { EMAIL_ACTIONS } from './registry.js';
import { EMAIL_ACTIONS as PUBLIC_EMAIL_ACTIONS } from '../index.js';

const EXPECTED_ACTION_NAMES = [
  'list_emails',
  'read_email',
  'search_emails',
  'get_thread',
  'send_email',
  'reply_to_email',
  'create_draft',
  'send_draft',
  'update_draft',
  'cancel_scheduled_send',
  'list_scheduled_sends',
  'list_attachments',
  'download_attachment',
  'label_email',
  'flag_email',
  'mark_read',
  'delete_email',
  'move_to_folder',
  'list_folders',
  'create_folder',
  'delete_folder',
  'list_inbox_rules',
  'create_inbox_rule',
  'delete_inbox_rule',
  'configure_mailbox',
  'remove_mailbox',
  'list_mailboxes',
  'get_mailbox_status',
] as const;

describe('EMAIL_ACTIONS registry', () => {
  it('is non-empty and contains every defined action exactly once', () => {
    const names = EMAIL_ACTIONS.map((a) => a.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_ACTION_NAMES].sort());
  });

  it('every entry is a well-formed EmailAction', () => {
    for (const action of EMAIL_ACTIONS) {
      expect(action.name, 'action name').toMatch(/^[a-z][a-z0-9_]*$/);
      expect(typeof action.description, `${action.name} description`).toBe('string');
      expect(action.description.length, `${action.name} description`).toBeGreaterThan(0);
      expect(action.input, `${action.name} input schema`).toBeDefined();
      expect(action.output, `${action.name} output schema`).toBeDefined();
      expect(typeof action.annotations?.readOnlyHint, `${action.name} readOnlyHint`).toBe('boolean');
      expect(typeof action.annotations?.destructiveHint, `${action.name} destructiveHint`).toBe(
        'boolean',
      );
      expect(typeof action.run, `${action.name} run`).toBe('function');
    }
  });

  it('matches an independent discovery of every action module export (no lockstep drift)', () => {
    // EXPECTED_ACTION_NAMES above documents the published API, but it is
    // manually maintained alongside the registry list — both could drift
    // together. This test discovers action exports straight from the module
    // files, so a new `*Action` export that is missing from EMAIL_ACTIONS
    // fails here even if both manual lists were forgotten.
    const modules = import.meta.glob(['./*.ts', '!./*.test.ts', '!./registry.ts'], {
      eager: true,
    }) as Record<string, Record<string, unknown>>;
    const discovered: { source: string; action: { name: string } }[] = [];
    for (const [file, mod] of Object.entries(modules)) {
      for (const [exportName, value] of Object.entries(mod)) {
        if (!exportName.endsWith('Action')) continue;
        if (
          typeof value !== 'object' ||
          value === null ||
          typeof (value as { name?: unknown }).name !== 'string' ||
          typeof (value as { run?: unknown }).run !== 'function'
        ) {
          continue;
        }
        discovered.push({ source: `${file}#${exportName}`, action: value as { name: string } });
      }
    }
    expect(discovered.length).toBeGreaterThan(0);
    // Every discovered action object appears in EMAIL_ACTIONS exactly once (by identity).
    for (const { source, action } of discovered) {
      const occurrences = EMAIL_ACTIONS.filter((a) => a === action).length;
      expect(occurrences, `${source} (${action.name}) must be registered exactly once`).toBe(1);
    }
    // Every registry entry corresponds to a discovered action export.
    for (const entry of EMAIL_ACTIONS) {
      const known = discovered.some(({ action }) => action === entry);
      expect(known, `registry entry ${entry.name} must come from an action module`).toBe(true);
    }
    expect(EMAIL_ACTIONS.length).toBe(discovered.length);
  });

  it('is exported (populated) from the package entry point', () => {
    expect(PUBLIC_EMAIL_ACTIONS).toBe(EMAIL_ACTIONS);
    expect(PUBLIC_EMAIL_ACTIONS.length).toBe(EXPECTED_ACTION_NAMES.length);
  });

  it('is populated in the BUILT public entry point (dist/index.js)', async () => {
    // The defect in issue #174 lived at the published-package surface:
    // consumers of @usejunior/email-core imported a permanently empty array.
    // Assert against the compiled entry point, exactly as a consumer would.
    // CI and the repo workflow always run `npm run build` before tests.
    let built: { EMAIL_ACTIONS: readonly { name: string }[] };
    try {
      built = await import('../../dist/index.js');
    } catch (err) {
      throw new Error(
        'dist/index.js not importable — run `npm run build -w @usejunior/email-core` before tests',
        { cause: err },
      );
    }
    const names = built.EMAIL_ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_ACTION_NAMES].sort());
  });
});
