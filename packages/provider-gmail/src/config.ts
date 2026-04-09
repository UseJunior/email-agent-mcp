import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface GmailMailboxMetadata {
  provider: 'gmail';
  mailboxName: string;
  emailAddress: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri?: string;
  lastInteractiveAuthAt?: string;
}

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

function isGmailMailboxMetadata(value: unknown): value is GmailMailboxMetadata {
  if (!isRecord(value)) return false;

  const provider = value['provider'];
  if (provider !== undefined && provider !== 'gmail') return false;

  return (
    typeof value['mailboxName'] === 'string' &&
    typeof value['emailAddress'] === 'string' &&
    typeof value['clientId'] === 'string' &&
    typeof value['clientSecret'] === 'string' &&
    typeof value['refreshToken'] === 'string' &&
    !('authenticationRecord' in value)
  );
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
      const parsed = JSON.parse(raw) as unknown;
      if (isGmailMailboxMetadata(parsed)) {
        entries.push({
          filename: file,
          metadata: {
            ...parsed,
            provider: 'gmail',
          },
        });
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
      const parsed = JSON.parse(raw) as unknown;
      if (isGmailMailboxMetadata(parsed)) {
        return {
          ...parsed,
          provider: 'gmail',
        };
      }
    } catch {
      // Try the next path.
    }
  }

  try {
    const files = (await readdir(getConfigDir())).filter(file => file.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = await readFile(join(getConfigDir(), file), 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (
          isGmailMailboxMetadata(parsed) &&
          (parsed.mailboxName === identifier || parsed.emailAddress === identifier)
        ) {
          return {
            ...parsed,
            provider: 'gmail',
          };
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
