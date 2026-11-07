import type { EmailMessage } from '@usejunior/email-core';
import {
  buildWakePayload, isProcessed, markProcessed, loadDeltaState, saveDeltaState,
  type TimestampCheckpoint, type WakePayload,
} from './watcher.js';

export type MailboxRunState =
  | { phase: 'bootstrapping' }
  | { phase: 'idle' | 'polling' | 'delivering' | 'checkpointing'; checkpoint: string }
  | { phase: 'backoff'; checkpoint: string; delayMs: number; error: unknown }
  | { phase: 'stopping' }
  | { phase: 'stopped'; outcome: RunOutcome };
export type RunOutcome = { kind: 'stopped' } | { kind: 'failed'; error: unknown };
export type PollOutcome = { kind: 'complete'; end: string } | { kind: 'retry'; error: unknown };
export interface RunnerLease {
  signal: AbortSignal;
  assertHeld(): void;
  release(): Promise<void>;
}
export interface WatchSource {
  prepare?(signal: AbortSignal): Promise<void>;
  getNewMessages(since: string, end: string, signal: AbortSignal): Promise<EmailMessage[]>;
  recover?(error: unknown, signal: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}
export interface MailboxRunnerOptions {
  provider: string;
  mailbox: string; // Stable configured identity, not the display name.
  receivingEmail: string;
  intervalMs: number;
  acquire(): Promise<RunnerLease | null>;
  setup(signal: AbortSignal, assertHeld: () => void): Promise<WatchSource>;
  wake(payload: WakePayload, signal: AbortSignal): Promise<{ success: boolean; error?: string }>;
  allowed(message: EmailMessage): boolean;
  load?: typeof loadDeltaState;
  save?: typeof saveDeltaState;
  now?: () => string;
  onState?(state: MailboxRunState): void;
  onError?(error: unknown): void;
}

/** One owner for setup, serial polling, retry and cleanup. Wakes are at-least-once. */
export class MailboxRunner {
  state: MailboxRunState = { phase: 'bootstrapping' };
  private stopping = false;
  private readonly cancellation = new AbortController();
  private readonly scheduling = new AbortController();
  private running?: Promise<RunOutcome>;
  constructor(private readonly options: MailboxRunnerOptions) {}

  requestStop(): void {
    this.stopping = true;
    this.scheduling.abort();
    if (this.state.phase !== 'stopped') this.transition({ phase: 'stopping' });
  }
  abort(): void {
    this.requestStop();
    this.cancellation.abort(new Error('Watcher drain deadline exceeded'));
  }
  start(): Promise<RunOutcome> { return this.running ??= this.run(); }

  private transition(state: MailboxRunState): void {
    // A draining poll can finish its transaction without re-entering scheduling.
    if (this.stopping && state.phase !== 'stopped' && state.phase !== 'stopping') return;
    this.state = state;
    this.options.onState?.(state);
  }

  private async poll(source: WatchSource, checkpoint: string, signal: AbortSignal, assertHeld: () => void): Promise<PollOutcome> {
    const o = this.options;
    const end = (o.now ?? (() => new Date().toISOString()))();
    try {
      assertHeld();
      this.transition({ phase: 'polling', checkpoint });
      await source.prepare?.(signal);
      assertHeld();
      const messages = await source.getNewMessages(checkpoint, end, signal);
      assertHeld();
      this.transition({ phase: 'delivering', checkpoint });
      for (const message of messages) {
        assertHeld();
        if (isProcessed(message.id, o.provider, o.mailbox)) continue;
        if (o.allowed(message)) {
          const result = await o.wake(buildWakePayload(o.receivingEmail, message), signal);
          assertHeld();
          if (!result.success) throw new Error(result.error ?? 'Wake failed; checkpoint retained');
        }
        markProcessed(message.id, o.provider, o.mailbox);
      }
      this.transition({ phase: 'checkpointing', checkpoint });
      assertHeld();
      const state: TimestampCheckpoint = { version: 1, kind: 'timestamp', lastUpdated: end };
      await (o.save ?? saveDeltaState)(o.mailbox, state, signal, assertHeld);
      assertHeld();
      return { kind: 'complete', end };
    } catch (error) {
      assertHeld();
      try { await source.recover?.(error, signal); }
      catch (recoveryError) { return { kind: 'retry', error: recoveryError }; }
      return { kind: 'retry', error };
    }
  }

  private async run(): Promise<RunOutcome> {
    const o = this.options;
    let lease: RunnerLease | null = null;
    let source: WatchSource | undefined;
    let outcome: RunOutcome = { kind: 'stopped' };
    try {
      if (this.stopping) return outcome;
      lease = await o.acquire();
      if (!lease) throw new Error(`Mailbox ${o.mailbox} is already being watched`);
      const signal = AbortSignal.any([lease.signal, this.cancellation.signal]);
      const assertHeld = () => { signal.throwIfAborted(); lease!.assertHeld(); };
      assertHeld();
      if (this.stopping) return outcome;
      // Read before any network setup; malformed state stops only this mailbox.
      const saved = await (o.load ?? loadDeltaState)(o.mailbox);
      assertHeld();
      if (this.stopping) return outcome;
      source = await o.setup(signal, assertHeld);
      assertHeld();
      if (this.stopping) return outcome;
      let checkpoint = saved?.lastUpdated ?? (o.now ?? (() => new Date().toISOString()))();
      if (!saved) {
        await (o.save ?? saveDeltaState)(o.mailbox, { version: 1, kind: 'timestamp', lastUpdated: checkpoint }, signal, assertHeld);
        assertHeld();
      }
      let delay = o.intervalMs;
      while (!this.stopping) {
        assertHeld();
        this.transition({ phase: 'idle', checkpoint });
        const result = await this.poll(source, checkpoint, signal, assertHeld);
        if (result.kind === 'complete') {
          checkpoint = result.end; // Disk committed before memory moves.
          delay = o.intervalMs;
          this.transition({ phase: 'idle', checkpoint });
        } else {
          assertHeld();
          this.transition({ phase: 'backoff', checkpoint, delayMs: delay, error: result.error });
          o.onError?.(result.error);
        }
        if (this.stopping) break;
        await wait(delay, AbortSignal.any([signal, this.scheduling.signal]));
        if (result.kind === 'retry') delay = Math.min(delay * 2, 300_000);
      }
    } catch (error) {
      if (!this.cancellation.signal.aborted && !this.stopping) {
        outcome = { kind: 'failed', error };
        o.onError?.(error);
      }
    } finally {
      try { await source?.close?.(); }
      catch (error) { outcome = { kind: 'failed', error }; }
      try { await lease?.release(); }
      catch (error) { outcome = { kind: 'failed', error }; }
      this.transition({ phase: 'stopped', outcome });
    }
    return outcome;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Shared 15-second deadline; the caller awaits runners before disposing resources. */
export class WatchShutdown {
  private phase: 'running' | 'draining' | 'aborting' = 'running';
  private timer?: ReturnType<typeof setTimeout>;
  private readonly runners = new Set<MailboxRunner>();
  constructor(private readonly exit: (code: number) => void, private readonly drainMs = 15_000) {}
  get stopping(): boolean { return this.phase !== 'running'; }
  add(runner: MailboxRunner): void {
    this.runners.add(runner);
    if (this.stopping) runner.requestStop();
    if (this.phase === 'aborting') runner.abort();
  }
  signal = (): void => {
    if (this.stopping) { this.exit(0); return; }
    this.phase = 'draining';
    for (const runner of this.runners) runner.requestStop();
    this.timer = setTimeout(() => {
      this.phase = 'aborting';
      for (const runner of this.runners) runner.abort();
    }, this.drainMs);
  };
  dispose(): void { clearTimeout(this.timer); }
}
