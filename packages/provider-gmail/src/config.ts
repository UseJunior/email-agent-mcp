import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
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

export async function loadGmailMailboxMetadata(identifier: string): Promise<GmailMailboxMetadata | null> {
  const candidatePaths = [`${identifier}.json`];
  if (identifier.includes('@')) {
    candidatePaths.push(`${toFilesystemSafeKey(identifier)}.json`);
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

export async function saveGmailMailboxMetadata(metadata: GmailMailboxMetadata): Promise<void> {
  const filename = `${toFilesystemSafeKey(metadata.emailAddress)}.json`;
  const path = join(getConfigDir(), filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ ...metadata, provider: 'gmail' }, null, 2) + '\n',
    'utf-8',
  );
}
