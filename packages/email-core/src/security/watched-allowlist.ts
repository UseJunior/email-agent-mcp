// Hot-reloading file watcher for allowlist configuration files.
// Watches the PARENT directory for robustness with atomic writes,
// file creation, and deletion.

import { watch, existsSync, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { AllowlistConfig } from '../actions/registry.js';

export class WatchedAllowlist {
  private _config: AllowlistConfig | undefined;
  private _watcher: FSWatcher | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly filePath: string,
    private readonly loader: (path: string) => Promise<AllowlistConfig | undefined>,
    private readonly debounceMs = 150,
    private readonly watchFactory: typeof watch = watch,
  ) {}

  /** Current allowlist config. undefined if file doesn't exist or hasn't been loaded. */
  get config(): AllowlistConfig | undefined {
    return this._config;
  }

  /**
   * Load initial config and start watching for changes.
   * Startup order: mkdir → arm watch → load (eliminates race window).
   */
  async start(): Promise<void> {
    const dir = dirname(this.filePath);
    const name = basename(this.filePath);

    // 1. Ensure parent directory exists
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      console.error(`[email-agent-mcp] Cannot create allowlist directory ${dir}: ${err instanceof Error ? err.message : err}`);
      // Still load the initial config even if we can't watch
      this._config = await this.loader(this.filePath);
      return;
    }

    // 2. Arm the watch BEFORE loading — eliminates the startup race window
    try {
      this._watcher = this.watchFactory(dir, (_event, filename) => {
        // filename can be null on some platforms — treat as possible target change
        if (!filename || filename === name) {
          this.scheduleReload();
        }
      });
      this._watcher.on('error', (err) => {
        this.disableWatching(err);
      });
      this._watcher.unref();
    } catch (err) {
      this.disableWatching(err);
    }

    // 3. Load initial config AFTER watch is armed
    this._config = await this.loader(this.filePath);
  }

  /** Stop watching and clean up resources. */
  close(): void {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = undefined;
    }
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
  }

  private scheduleReload(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => { void this.reload(); }, this.debounceMs);
    this._debounceTimer.unref();
  }

  private async reload(): Promise<void> {
    try {
      const newConfig = await this.loader(this.filePath);
      if (newConfig !== undefined) {
        // Valid config loaded — update
        this._config = newConfig;
        console.error(`[email-agent-mcp] Allowlist reloaded: ${newConfig.entries.length} entries from ${this.filePath}`);
      } else {
        // Loader returned undefined — distinguish deletion from corruption
        if (!existsSync(this.filePath)) {
          // File deleted → reset to undefined (respects default policies)
          this._config = undefined;
          console.error(`[email-agent-mcp] Allowlist file removed: ${this.filePath}`);
        }
        // File exists but malformed → keep last known good config (no update)
      }
    } catch {
      // Keep previous config on unexpected error
    }
  }

  private disableWatching(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (this._watcher) {
      try {
        this._watcher.close();
      } catch {
        // Best-effort cleanup on watcher failure.
      }
      this._watcher = undefined;
    }
    console.error(
      `[email-agent-mcp] Allowlist watcher disabled for ${this.filePath}: ${message}. Continuing without hot reload.`,
    );
  }
}
