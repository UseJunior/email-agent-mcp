import { describe, it, expect, afterEach } from 'vitest';
import { WatchedAllowlist } from './watched-allowlist.js';
import { writeFile, rm, mkdtemp, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AllowlistConfig } from '../actions/registry.js';

// Reuse the same loader pattern as the real allowlist files
async function testLoader(filePath: string): Promise<AllowlistConfig | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as { entries?: string[] };
    return { entries: data.entries ?? [] };
  } catch {
    return undefined;
  }
}

// Condition-based waiting — avoids flaky fixed sleeps
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('security/WatchedAllowlist', () => {
  let tmpDir: string;
  let watcher: WatchedAllowlist | null = null;

  afterEach(async () => {
    watcher?.close();
    watcher = null;
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Scenario: Initial load from existing file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');
    await writeFile(filePath, JSON.stringify({ entries: ['*@example.com'] }));

    watcher = new WatchedAllowlist(filePath, testLoader);
    await watcher.start();

    expect(watcher.config).toBeDefined();
    expect(watcher.config!.entries).toEqual(['*@example.com']);
  });

  it('Scenario: Initial load when file does not exist', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'nonexistent.json');

    watcher = new WatchedAllowlist(filePath, testLoader);
    await watcher.start();

    expect(watcher.config).toBeUndefined();
  });

  it('Scenario: Hot reload on in-place write', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');
    await writeFile(filePath, JSON.stringify({ entries: ['alice@test.com'] }));

    watcher = new WatchedAllowlist(filePath, testLoader, 50);
    await watcher.start();

    expect(watcher.config!.entries).toEqual(['alice@test.com']);

    // Update the file in place
    await writeFile(filePath, JSON.stringify({ entries: ['alice@test.com', 'bob@test.com'] }));

    // Wait for debounce + reload
    await waitFor(() => watcher!.config?.entries.length === 2);

    expect(watcher.config!.entries).toEqual(['alice@test.com', 'bob@test.com']);
  });

  it('Scenario: Hot reload on atomic temp+rename', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');
    const tmpFile = join(tmpDir, 'allowlist.tmp');
    await writeFile(filePath, JSON.stringify({ entries: ['initial@test.com'] }));

    watcher = new WatchedAllowlist(filePath, testLoader, 50);
    await watcher.start();

    expect(watcher.config!.entries).toEqual(['initial@test.com']);

    // Atomic save: write temp file, then rename over target
    await writeFile(tmpFile, JSON.stringify({ entries: ['atomic@test.com'] }));
    await rename(tmpFile, filePath);

    await waitFor(() => watcher!.config?.entries[0] === 'atomic@test.com');

    expect(watcher.config!.entries).toEqual(['atomic@test.com']);
  });

  it('Scenario: Keeps last known config on malformed JSON', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');
    await writeFile(filePath, JSON.stringify({ entries: ['valid@test.com'] }));

    watcher = new WatchedAllowlist(filePath, testLoader, 50);
    await watcher.start();

    expect(watcher.config!.entries).toEqual(['valid@test.com']);

    // Write malformed JSON
    await writeFile(filePath, '{ broken json !!!');

    // Wait for debounce to fire + reload attempt
    await new Promise(r => setTimeout(r, 200));

    // Should retain last known good config (file exists but malformed)
    expect(watcher.config!.entries).toEqual(['valid@test.com']);
  });

  it('Scenario: Resets config on file deletion', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');
    await writeFile(filePath, JSON.stringify({ entries: ['keep-me@test.com'] }));

    watcher = new WatchedAllowlist(filePath, testLoader, 50);
    await watcher.start();

    expect(watcher.config!.entries).toEqual(['keep-me@test.com']);

    // Delete the file
    await unlink(filePath);

    // Config should reset to undefined
    await waitFor(() => watcher!.config === undefined);

    expect(watcher.config).toBeUndefined();
  });

  it('Scenario: close() stops watching', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');
    await writeFile(filePath, JSON.stringify({ entries: ['initial@test.com'] }));

    watcher = new WatchedAllowlist(filePath, testLoader, 50);
    await watcher.start();

    expect(watcher.config!.entries).toEqual(['initial@test.com']);

    // Close the watcher
    watcher.close();

    // Update file after close — should NOT be picked up
    await writeFile(filePath, JSON.stringify({ entries: ['updated@test.com'] }));
    await new Promise(r => setTimeout(r, 200));

    expect(watcher.config!.entries).toEqual(['initial@test.com']);
  });

  it('Scenario: Handles parent directory not existing at startup', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    // Point to a nested directory that doesn't exist — mkdir will create it
    const nestedDir = join(tmpDir, 'nested', 'deep');
    const filePath = join(nestedDir, 'allowlist.json');

    watcher = new WatchedAllowlist(filePath, testLoader);
    await watcher.start();

    // Should not throw, config should be undefined
    expect(watcher.config).toBeUndefined();
  });

  it('Scenario: File created after watcher starts', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'watched-allowlist-'));
    const filePath = join(tmpDir, 'allowlist.json');

    // Start watcher before file exists
    watcher = new WatchedAllowlist(filePath, testLoader, 50);
    await watcher.start();

    expect(watcher.config).toBeUndefined();

    // Create the file — watcher should pick it up
    await writeFile(filePath, JSON.stringify({ entries: ['new@test.com'] }));

    await waitFor(() => watcher!.config !== undefined);

    expect(watcher.config!.entries).toEqual(['new@test.com']);
  });
});
