import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export const MAILBOX_LEASE_STALE_MS = 60_000;
export const MAILBOX_LEASE_UPDATE_MS = 10_000;

type LeaseState =
  | { phase: 'acquiring' }
  | { phase: 'held'; release: () => Promise<void> }
  | { phase: 'compromised'; error: Error }
  | { phase: 'released' };

/** An acquired handle owns cleanup; a pathname or PID alone never does. */
export class MailboxLease {
  private state: LeaseState = { phase: 'acquiring' };
  private readonly controller = new AbortController();
  private releasing: Promise<void> | undefined;

  private constructor() {}

  get signal(): AbortSignal { return this.controller.signal; }
  get held(): boolean { return this.state.phase === 'held'; }
  get released(): boolean { return this.state.phase === 'released'; }

  assertHeld(): void {
    if (!this.held) throw new Error('Mailbox lease is no longer held');
  }

  static async acquire(directory: string, mailboxKey: string): Promise<MailboxLease | null> {
    if (!mailboxKey || mailboxKey === '.' || mailboxKey === '..' || /[/\\\0]/.test(mailboxKey)) {
      throw new Error('Invalid mailbox lock key');
    }
    await mkdir(directory, { recursive: true });
    const legacyPath = join(await realpath(directory), `${mailboxKey}.watcher.lock`);
    // Never remove legacy locks here: an old watcher could still own one.
    try {
      const legacy: unknown = JSON.parse(await readFile(legacyPath, 'utf8'));
      const pid = (legacy as { pid?: unknown } | null)?.pid;
      if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
      try {
        process.kill(pid as number, 0);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const lease = new MailboxLease();
    try {
      // The library keys its ownership registry by target, not lockfilePath.
      // A directory-wide target would make mailbox B overwrite mailbox A.
      const release = await lockfile.lock(legacyPath, {
        realpath: false, // The parent is canonical; the legacy file need not exist.
        lockfilePath: `${legacyPath}.lease`,
        stale: MAILBOX_LEASE_STALE_MS,
        update: MAILBOX_LEASE_UPDATE_MS,
        retries: 0,
        onCompromised(error) {
          lease.state = { phase: 'compromised', error };
          lease.controller.abort(error);
        },
      });
      if (lease.state.phase === 'compromised') return null;
      lease.state = { phase: 'held', release };
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return null;
      throw error;
    }
  }

  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    const state = this.state;
    this.state = { phase: 'released' };
    this.controller.abort(new Error('Mailbox lease released'));
    // proper-lockfile invalidates compromised handles; never unlink a successor.
    this.releasing = state.phase === 'held' ? state.release() : Promise.resolve();
    return this.releasing;
  }
}
