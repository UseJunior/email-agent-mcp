import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type GmailAuthSource = 'byok' | 'broker';

interface GmailMailboxMetadataBase {
  provider: 'gmail';
  mailboxName: string;
  emailAddress: string;
  refreshToken: string;
  redirectUri?: string;
  lastInteractiveAuthAt?: string;
}

export interface GmailByokMailboxMetadata extends GmailMailboxMetadataBase {
  source: 'byok';
  clientId: string;
  clientSecret: string;
}

export interface GmailBrokerMailboxMetadata extends GmailMailboxMetadataBase {
  source: 'broker';
  brokerUrl: string;
}

export type GmailMailboxMetadata = GmailByokMailboxMetadata | GmailBrokerMailboxMetadata;

export function getConfigDir(): string {
  const base = process.env['EMAIL_AGENT_MCP_HOME'] ?? join(homedir(), '.email-agent-mcp');
  return join(base, 'tokens');
}

export function toFilesystemSafeKey(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeGmailMailboxMetadata(value: unknown): GmailMailboxMetadata | null {
  if (!isRecord(value)) return null;

  const provider = value['provider'];
  if (provider !== undefined && provider !== 'gmail') return null;
  if ('authenticationRecord' in value) return null;

  const mailboxName = value['mailboxName'];
  const emailAddress = value['emailAddress'];
  const refreshToken = value['refreshToken'];
  if (
    typeof mailboxName !== 'string' ||
    typeof emailAddress !== 'string' ||
    typeof refreshToken !== 'string'
  ) {
    return null;
  }

  const base: GmailMailboxMetadataBase = {
    provider: 'gmail',
    mailboxName,
    emailAddress,
    refreshToken,
    redirectUri: typeof value['redirectUri'] === 'string' ? (value['redirectUri'] as string) : undefined,
    lastInteractiveAuthAt:
      typeof value['lastInteractiveAuthAt'] === 'string'
        ? (value['lastInteractiveAuthAt'] as string)
        : undefined,
  };

  const declared = value['source'];
  const source: GmailAuthSource | undefined =
    declared === 'byok' || declared === 'broker' ? declared : undefined;

  const brokerUrl = typeof value['brokerUrl'] === 'string' ? (value['brokerUrl'] as string) : undefined;
  const clientId = typeof value['clientId'] === 'string' ? (value['clientId'] as string) : undefined;
  const clientSecret = typeof value['clientSecret'] === 'string' ? (value['clientSecret'] as string) : undefined;

  // Reject ambiguous mixed-shape records: they could equally describe
  // either mode, and we never want to silently pick one. A mailbox file
  // that has both a brokerUrl AND clientSecret is most likely corrupted;
  // forcing a re-configure is safer than guessing.
  const hasByokFields = clientId !== undefined && clientSecret !== undefined;
  const hasBrokerField = brokerUrl !== undefined;
  if (hasByokFields && hasBrokerField) return null;

  if (source === 'broker') {
    if (!hasBrokerField) return null;
    return { ...base, source: 'broker', brokerUrl };
  }
  if (source === 'byok') {
    if (!hasByokFields) return null;
    return { ...base, source: 'byok', clientId, clientSecret };
  }

  // Backward-compat: pre-broker metadata had no `source` field. Only
  // infer BYOK if the BYOK fields are present AND no broker field has
  // been written by a newer version. Records with only brokerUrl and
  // no `source` are rejected — if a future format change adds an
  // explicit broker `source`, those files will be valid then.
  if (hasByokFields && !hasBrokerField) {
    return { ...base, source: 'byok', clientId, clientSecret };
  }

  return null;
}

function sortByRecency(
  a: { metadata: GmailMailboxMetadata },
  b: { metadata: GmailMailboxMetadata },
): number {
  const dateA = new Date(a.metadata.lastInteractiveAuthAt ?? '1970-01-01').getTime();
  const dateB = new Date(b.metadata.lastInteractiveAuthAt ?? '1970-01-01').getTime();
  return dateB - dateA;
}

export async function listConfiguredGmailMailboxes(): Promise<GmailMailboxMetadata[]> {
  let files: string[];
  try {
    files = (await readdir(getConfigDir())).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }

  const entries: Array<{ filename: string; metadata: GmailMailboxMetadata }> = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(getConfigDir(), file), 'utf-8');
      const parsed = normalizeGmailMailboxMetadata(JSON.parse(raw) as unknown);
      if (parsed) {
        entries.push({ filename: file, metadata: parsed });
      }
    } catch {
      // Skip unreadable or invalid files.
    }
  }

  const byEmail = new Map<string, Array<{ filename: string; metadata: GmailMailboxMetadata }>>();
  for (const entry of entries) {
    const email = entry.metadata.emailAddress.toLowerCase();
    const group = byEmail.get(email) ?? [];
    group.push(entry);
    byEmail.set(email, group);
  }

  const results: GmailMailboxMetadata[] = [];
  for (const [, group] of byEmail) {
    group.sort(sortByRecency);
    results.push(group[0]!.metadata);
  }

  return results;
}

/**
 * Filename used for a Gmail record when the email-keyed filename
 * (`<safe-key>.json`) already holds another provider's record (for example a
 * Microsoft mailbox for the same address). Safe keys never contain dots, so
 * this name cannot collide with any provider's email-keyed filename.
 */
export function gmailProviderScopedFilename(emailAddress: string): string {
  return `${toFilesystemSafeKey(emailAddress)}.gmail.json`;
}

export async function loadGmailMailboxMetadata(identifier: string): Promise<GmailMailboxMetadata | null> {
  const candidatePaths = [`${identifier}.json`];
  if (identifier.includes('@')) {
    candidatePaths.push(`${toFilesystemSafeKey(identifier)}.json`);
    candidatePaths.push(gmailProviderScopedFilename(identifier));
  }

  for (const candidate of candidatePaths) {
    try {
      const raw = await readFile(join(getConfigDir(), candidate), 'utf-8');
      const parsed = normalizeGmailMailboxMetadata(JSON.parse(raw) as unknown);
      if (parsed) return parsed;
    } catch {
      // Try the next path.
    }
  }

  try {
    const files = (await readdir(getConfigDir())).filter(file => file.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = await readFile(join(getConfigDir(), file), 'utf-8');
        const parsed = normalizeGmailMailboxMetadata(JSON.parse(raw) as unknown);
        if (parsed && (parsed.mailboxName === identifier || parsed.emailAddress === identifier)) {
          return parsed;
        }
      } catch {
        // Skip unreadable or invalid files.
      }
    }
  } catch {
    // Config dir does not exist.
  }

  return null;
}

type RawRecord = Record<string, unknown>;

async function readRawRecord(path: string): Promise<RawRecord | null | 'missing'> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pick the file a Gmail record for `emailAddress` is written to.
 *
 * 1. An existing Gmail record for the same address is updated in place.
 * 2. Otherwise the email-keyed `<safe-key>.json` is used when it is free.
 * 3. If `<safe-key>.json` holds anything that is not a Gmail record (a
 *    Microsoft mailbox for the same address, or an unreadable file), it is
 *    never overwritten: the Gmail record goes to `<safe-key>.gmail.json`.
 */
export async function resolveGmailMetadataPath(emailAddress: string): Promise<string> {
  const directory = getConfigDir();
  const target = emailAddress.toLowerCase();
  const canonical = `${toFilesystemSafeKey(emailAddress)}.json`;
  const scoped = gmailProviderScopedFilename(emailAddress);

  let files: string[] = [];
  try {
    files = (await readdir(directory)).filter(file => file.endsWith('.json'));
  } catch {
    // Config dir does not exist yet.
  }

  const ordered = [canonical, scoped, ...files.filter(file => file !== canonical && file !== scoped)];
  for (const file of ordered) {
    const record = await readRawRecord(join(directory, file)).catch(() => null);
    if (!record || record === 'missing') continue;
    const parsed = normalizeGmailMailboxMetadata(record);
    if (parsed && parsed.emailAddress.toLowerCase() === target) {
      return join(directory, file);
    }
  }

  const canonicalRecord = await readRawRecord(join(directory, canonical)).catch(() => null);
  if (canonicalRecord === 'missing') return join(directory, canonical);
  return join(directory, scoped);
}

/** Save a Gmail mailbox record and return the path it was written to. */
export async function saveGmailMailboxMetadata(metadata: GmailMailboxMetadata): Promise<string> {
  const path = await resolveGmailMetadataPath(metadata.emailAddress);
  await serializeMetadata(path, () => atomicWriteMetadata(path, metadata));
  return path;
}

/**
 * Rename the Gmail mailbox alias `oldName` (case-insensitive) for the account
 * `emailAddress`. Gmail token files are keyed by email address, so the file
 * stays where it is and only its `mailboxName` changes. Returns the paths that
 * were rewritten. Callers are responsible for collision checks.
 */
export async function renameGmailMailbox(args: {
  oldName: string;
  newName: string;
  emailAddress: string;
}): Promise<string[]> {
  const directory = getConfigDir();
  const oldKey = args.oldName.trim().toLowerCase();
  const emailKey = args.emailAddress.trim().toLowerCase();
  let files: string[];
  try {
    files = (await readdir(directory)).filter(file => file.endsWith('.json'));
  } catch {
    return [];
  }

  const rewritten: string[] = [];
  for (const file of files) {
    const path = join(directory, file);
    const record = await readRawRecord(path).catch(() => null);
    if (!record || record === 'missing') continue;
    const parsed = normalizeGmailMailboxMetadata(record);
    if (!parsed) continue;
    if (parsed.mailboxName.trim().toLowerCase() !== oldKey) continue;
    if (parsed.emailAddress.trim().toLowerCase() !== emailKey) continue;
    await serializeMetadata(path, () =>
      atomicWriteMetadata(path, { ...record, mailboxName: args.newName } as unknown as GmailMailboxMetadata));
    rewritten.push(path);
  }
  return rewritten;
}

const metadataWrites = new Map<string, Promise<void>>();

async function serializeMetadata(key: string, write: () => Promise<void>): Promise<void> {
  const prior = metadataWrites.get(key) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(write);
  metadataWrites.set(key, next);
  try { await next; } finally {
    if (metadataWrites.get(key) === next) metadataWrites.delete(key);
  }
}

async function atomicWriteMetadata(path: string, metadata: GmailMailboxMetadata): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify({ ...metadata, provider: 'gmail' }, null, 2) + '\n',
      { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/** Process-local ordered compare-and-replace at the existing metadata route.
 * Atomic rename prevents partial files; this is not a cross-process CAS.
 */
export function createGmailMetadataWriter(metadata: GmailMailboxMetadata):
  (refreshToken: string, previousRefreshToken: string) => Promise<void> {
  const directory = getConfigDir();
  const canonicalPath = join(directory, `${toFilesystemSafeKey(metadata.emailAddress)}.json`);
  let expected = metadata.refreshToken;
  return async refreshToken => {
    await serializeMetadata(canonicalPath, async () => {
      const files = await readdir(directory);
      const canonical = `${toFilesystemSafeKey(metadata.emailAddress)}.json`;
      const scoped = gmailProviderScopedFilename(metadata.emailAddress);
      const ordered = [
        canonical,
        ...files.filter(file => file === scoped),
        ...files.filter(file => file.endsWith('.json') && file !== canonical && file !== scoped),
      ];
      for (const file of ordered) {
        const path = join(directory, file);
        let current: GmailMailboxMetadata | null;
        try { current = normalizeGmailMailboxMetadata(JSON.parse(await readFile(path, 'utf-8'))); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          // The canonical target must not be overwritten if corrupt. Other
          // candidates may belong to unrelated mailboxes/providers; discovery
          // already skips those, so they must not prevent a valid alias rotation.
          if (file === canonical) throw error;
          continue;
        }
        if (!current || current.emailAddress !== metadata.emailAddress) continue;
        // Refuse stale rotations and changes to the configured OAuth identity.
        if (current.refreshToken !== expected ||
            JSON.stringify({ ...current, refreshToken: '' }) !==
              JSON.stringify({ ...normalizeGmailMailboxMetadata(metadata), refreshToken: '' })) {
          throw new Error('Gmail metadata changed; refusing stale token rotation');
        }
        await atomicWriteMetadata(path, { ...current, refreshToken });
        expected = refreshToken;
        return;
      }
      throw new Error('Gmail metadata no longer exists');
    });
  };
}
