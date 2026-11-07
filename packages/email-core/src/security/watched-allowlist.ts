// Watch the parent directory so atomic replacement, deletion and recreation work.
import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import type { AllowlistConfig } from '../actions/registry.js';
import { asAllowlistPolicy, loadAllowlistPolicy, type AllowlistPolicy } from './allowlist-policy.js';

export type AllowlistLifecycle = 'unstarted' | 'starting' | 'active' | 'degraded' | 'closed';
type Loader = (path: string) => Promise<AllowlistPolicy | AllowlistConfig | undefined>;

export class WatchedAllowlist {
  private _policy: AllowlistPolicy = { status: 'invalid', reason: 'Allowlist not loaded' };
  private _lifecycle: AllowlistLifecycle = 'unstarted';
  private _watcher: FSWatcher | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private startPromise: Promise<void> | undefined;
  private reads: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly filePath: string,
    // Legacy config loaders remain accepted. Shipped callers use the typed loader.
    private readonly loader: Loader = loadAllowlistPolicy,
    private readonly debounceMs = 150,
    private readonly watchFactory: typeof watch = watch,
  ) {}

  get lifecycle(): AllowlistLifecycle { return this._lifecycle; }
  get policy(): AllowlistPolicy { return this._policy; }

  /** @deprecated Permission checks must use policy to distinguish invalid from absent. */
  get config(): AllowlistConfig | undefined {
    return this._policy.status === 'valid' ? this._policy.config : undefined;
  }

  /** Concurrent callers share startup; closed watchers cannot restart. */
  start(): Promise<void> {
    if (this._lifecycle === 'closed') return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this._lifecycle = 'starting';
    this.startPromise = this.initialize(this.generation);
    return this.startPromise;
  }

  private isCurrent(generation: number): boolean {
    return this._lifecycle !== 'closed' && generation === this.generation;
  }

  private async initialize(generation: number): Promise<void> {
    const dir = dirname(this.filePath);
    const name = basename(this.filePath);
    try {
      await mkdir(dir, { recursive: true });
      if (!this.isCurrent(generation)) return;
      this._watcher = this.watchFactory(dir, (_event, filename) => {
        if (!filename || filename.toString() === name) this.scheduleReload();
      });
      this._watcher.on('error', (err) => this.disableWatching(err));
      this._watcher.unref();
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      this.disableWatching(err);
    }
    if (!this.isCurrent(generation)) return;
    // Watch is armed before the initial read. Subsequent reads queue behind it.
    await this.enqueueRead();
    if (this.isCurrent(generation)) this._lifecycle = this._watcher ? 'active' : 'degraded';
  }

  close(): void {
    if (this._lifecycle === 'closed') return;
    this._lifecycle = 'closed';
    this.generation++;
    this.clearTimer();
    this._watcher?.close();
    this._watcher = undefined;
  }

  private clearTimer(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = undefined;
  }

  private scheduleReload(): void {
    if (this._lifecycle === 'closed' || this._lifecycle === 'degraded') return;
    this.clearTimer();
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = undefined;
      void this.enqueueRead();
    }, this.debounceMs);
    this._debounceTimer.unref();
  }

  private enqueueRead(): Promise<void> {
    const generation = this.generation;
    this.reads = this.reads.then(async () => {
      if (!this.isCurrent(generation)) return;
      let policy: AllowlistPolicy;
      try {
        const result = await this.loader(this.filePath);
        // Legacy undefined is ambiguous: classify with a read rather than a
        // separate exists check that races deletion/recreation.
        policy = result === undefined ? await loadAllowlistPolicy(this.filePath) : asAllowlistPolicy(result);
      } catch {
        policy = { status: 'invalid', reason: 'Allowlist loader failed' };
      }
      if (!this.isCurrent(generation)) return;
      if (policy.status !== 'invalid' || this._policy.status === 'invalid') this._policy = policy;
      if (policy.status === 'invalid') {
        console.error(`[email-agent-mcp] Invalid allowlist at ${this.filePath}: ${policy.reason}. Retaining last good policy when available.`);
      }
    });
    return this.reads;
  }

  private disableWatching(err: unknown): void {
    if (this._lifecycle === 'closed') return;
    this._lifecycle = 'degraded';
    this.clearTimer();
    this._watcher?.close();
    this._watcher = undefined;
    console.error(`[email-agent-mcp] Allowlist watcher disabled for ${this.filePath}: ${err instanceof Error ? err.message : String(err)}. Continuing without hot reload.`);
  }
}
