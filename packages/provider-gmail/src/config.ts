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

  // Inferred discriminator for backward-compat: pre-broker metadata had
  // no `source` field; treat any record with clientId+clientSecret as
  // BYOK.
  const declared = value['source'];
  const source: GmailAuthSource | undefined =
    declared === 'byok' || declared === 'broker' ? declared : undefined;

  const brokerUrl = value['brokerUrl'];
  if (source === 'broker' || (!source && typeof brokerUrl === 'string')) {
    if (typeof brokerUrl !== 'string') return null;
    return { ...base, source: 'broker', brokerUrl };
  }

  const clientId = value['clientId'];
  const clientSecret = value['clientSecret'];
  if (typeof clientId === 'string' && typeof clientSecret === 'string') {
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
