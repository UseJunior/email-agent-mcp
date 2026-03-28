// Microsoft Graph authentication — real MSAL device code flow + cache persistence
import type { AuthManager } from '@usejunior/email-core';
import { DeviceCodeCredential, ClientSecretCredential, useIdentityPlugin, type DeviceCodeInfo, type AuthenticationRecord } from '@azure/identity';
import { cachePersistencePlugin } from '@azure/identity-cache-persistence';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Enable MSAL persistent cache (OS keychain on macOS, DPAPI on Windows, libsecret on Linux)
useIdentityPlugin(cachePersistencePlugin);

export const GRAPH_SCOPES = ['Mail.Read', 'Mail.Send', 'User.Read', 'offline_access'];
// Full URL scopes for device code flow (ensures correct audience in the token)
export const GRAPH_SCOPES_FULL = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
];
/**
 * Resolve the config directory for token storage.
 * Supports AGENT_EMAIL_HOME env var override for test isolation.
 */
export function getConfigDir(): string {
  const base = process.env['AGENT_EMAIL_HOME'] ?? join(homedir(), '.agent-email');
  return join(base, 'tokens');
}

export interface MicrosoftAuthConfig {
  mode: 'delegated' | 'client_credentials';
  clientId: string;
  clientSecret?: string;
  tenantId?: string;
}

export interface MailboxMetadata {
  authenticationRecord: AuthenticationRecord;
  cacheName?: string;
  lastInteractiveAuthAt: string;
  clientId: string;
  tenantId?: string;
  mailboxName: string;
  emailAddress?: string;
}

/**
 * Convert an email address to a filesystem-safe key.
 * Lowercase, replace `@` with `-at-`, replace `.` with `-`, strip anything not [a-z0-9-].
 * Example: `steven@usejunior.com` → `steven-at-usejunior-com`
 */
export function toFilesystemSafeKey(email: string): string {
  return email
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/\./g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Delegated OAuth auth manager — real device code flow with MSAL cache persistence.
 *
 * Tokens are stored in the OS keychain by MSAL.
 * Only the AuthenticationRecord (non-secret metadata) is saved to disk.
 */
export class DelegatedAuthManager implements AuthManager {
  private credential: DeviceCodeCredential | null = null;
  private authRecord: AuthenticationRecord | null = null;
  private cacheName: string | null = null;
  private readonly config: MicrosoftAuthConfig;
  private readonly mailboxName: string;
  private _needsReauth = false;
  private _lastInteractiveAuthAt: string | null = null;
  private _emailAddress: string | null = null;

  constructor(config: MicrosoftAuthConfig, mailboxName = 'default') {
    this.config = config;
    this.mailboxName = mailboxName;
  }

  /** Set the email address for this mailbox (called after profile fetch during configure). */
  setEmailAddress(email: string): void {
    this._emailAddress = email;
  }

  /** Get the email address for this mailbox (may be null if not yet fetched). */
  get emailAddress(): string | null {
    return this._emailAddress;
  }

  get needsReauth(): boolean { return this._needsReauth; }
  get lastInteractiveAuthAt(): string | null { return this._lastInteractiveAuthAt; }

  /**
   * Interactive device code flow — prints URL + code to stderr.
   * Call this from `agent-email configure`, NOT from MCP serve.
   */
  async connect(_credentials: Record<string, string>): Promise<void> {
    this.cacheName = this.createCacheName();
    this.credential = this.createPersistentCredential({
      clientId: this.config.clientId,
      tenantId: this.config.tenantId,
      cacheName: this.cacheName,
      disableAutomaticAuthentication: true, // Force interactive in connect()
      userPromptCallback: (info: DeviceCodeInfo) => {
        console.error('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.error('  To sign in, open this URL in your browser:');
        console.error(`  ${info.verificationUri}`);
        console.error(`  Enter code: ${info.userCode}`);
        console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      },
    });

    this.authRecord = (await this.credential.authenticate(GRAPH_SCOPES_FULL)) ?? null;
    if (!this.authRecord) throw new Error('Authentication failed — no record received');
    this._lastInteractiveAuthAt = new Date().toISOString();
    this._needsReauth = false;

    // Persist metadata (not the tokens — those are in OS keychain via MSAL)
    await this.saveMetadata();
  }

  /**
   * Reconnect from a saved AuthenticationRecord (silent, no user interaction).
   */
  async reconnect(): Promise<void> {
    const metadata = await this.loadMetadata();
    if (!metadata) {
      throw new Error(`No saved credentials for mailbox "${this.mailboxName}". Run: agent-email configure --mailbox ${this.mailboxName}`);
    }

    this.authRecord = metadata.authenticationRecord;
    this.cacheName = metadata.cacheName ?? this.getLegacyCacheName();
    this._lastInteractiveAuthAt = metadata.lastInteractiveAuthAt;
    this._emailAddress = metadata.emailAddress ?? null;
    this.credential = this.createPersistentCredential({
      clientId: metadata.clientId,
      tenantId: metadata.tenantId,
      authenticationRecord: this.authRecord,
      cacheName: this.cacheName,
    });

    // Verify the token still works
    try {
      await this.credential.getToken(GRAPH_SCOPES_FULL);
      this._needsReauth = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('interaction_required') || message.includes('invalid_grant')) {
        this._needsReauth = true;
        throw new Error(`Token expired. Run: agent-email configure --mailbox ${this.mailboxName}`);
      }
      throw err;
    }
  }

  /**
   * Get a valid access token (refreshes automatically via MSAL cache).
   */
  async getAccessToken(): Promise<string> {
    if (!this.credential) {
      throw new Error('Not connected. Call connect() or reconnect() first.');
    }
    try {
      const token = await this.credential.getToken(GRAPH_SCOPES_FULL);
      if (!token) throw new Error('Failed to acquire token');
      return token.token;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('interaction_required') || message.includes('invalid_grant')) {
        this._needsReauth = true;
      }
      throw err;
    }
  }

  async refresh(): Promise<void> {
    // MSAL handles refresh automatically via getToken() / cache
    await this.getAccessToken();
  }

  async disconnect(): Promise<void> {
    this.credential = null;
    this.authRecord = null;
    this.cacheName = null;
  }

  isTokenExpired(): boolean {
    // With MSAL cache, we don't track expiry directly — MSAL handles it.
    // We use needsReauth as the signal.
    return this._needsReauth;
  }

  /**
   * Check token health: returns a warning if approaching expiry.
   */
  getTokenHealthWarning(): string | undefined {
    if (this._needsReauth) {
      return `Authentication expired. Run: agent-email configure --mailbox ${this.mailboxName}`;
    }
    if (this._lastInteractiveAuthAt) {
      const daysSinceAuth = (Date.now() - new Date(this._lastInteractiveAuthAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceAuth > 80) {
        return `Token may expire soon (last authenticated ${Math.round(daysSinceAuth)} days ago). Run: agent-email configure --mailbox ${this.mailboxName}`;
      }
    }
    return undefined;
  }

  private getMetadataPath(): string {
    if (this._emailAddress) {
      return join(getConfigDir(), `${toFilesystemSafeKey(this._emailAddress)}.json`);
    }
    return join(getConfigDir(), `${this.mailboxName}.json`);
  }

  private getLegacyCacheName(): string {
    return `agent-email-${this.mailboxName}`;
  }

  private createCacheName(): string {
    return `${this.getLegacyCacheName()}-${randomUUID()}`;
  }

  private createPersistentCredential(options: {
    clientId: string;
    tenantId?: string;
    cacheName: string;
    authenticationRecord?: AuthenticationRecord;
    userPromptCallback?: (info: DeviceCodeInfo) => void;
    disableAutomaticAuthentication?: boolean;
  }): DeviceCodeCredential {
    return new DeviceCodeCredential({
      clientId: options.clientId,
      tenantId: options.tenantId ?? 'organizations',
      authenticationRecord: options.authenticationRecord,
      disableAutomaticAuthentication: options.disableAutomaticAuthentication ?? false,
      userPromptCallback: options.userPromptCallback,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: options.cacheName,
        unsafeAllowUnencryptedStorage: process.platform === 'linux',
      },
    });
  }

  async saveMetadata(): Promise<void> {
    const path = this.getMetadataPath();
    await mkdir(dirname(path), { recursive: true });
    const metadata: MailboxMetadata = {
      authenticationRecord: this.authRecord!,
      cacheName: this.cacheName ?? undefined,
      lastInteractiveAuthAt: this._lastInteractiveAuthAt!,
      clientId: this.config.clientId,
      tenantId: this.config.tenantId,
      mailboxName: this.mailboxName,
      emailAddress: this._emailAddress ?? undefined,
    };
    await writeFile(path, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  private async loadMetadata(): Promise<MailboxMetadata | null> {
    // Use the public loadMailboxMetadata which handles both old-style (name-based)
    // and new-style (email-based) filenames, plus fallback search
    return loadMailboxMetadata(this.mailboxName);
  }
}

/**
 * Client credentials auth manager (app-only / daemon).
 * Uses ClientSecretCredential from @azure/identity for real Azure AD authentication.
 */
export class ClientCredentialsAuthManager implements AuthManager {
  private credential: ClientSecretCredential | null = null;
  private accessToken?: string;
  private expiresAt?: number;
  private readonly config: MicrosoftAuthConfig;

  private static readonly GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

  constructor(config: MicrosoftAuthConfig) {
    this.config = config;
  }

  async connect(_credentials: Record<string, string>): Promise<void> {
    if (!this.config.clientSecret || !this.config.tenantId) {
      throw new Error('Client credentials require clientSecret and tenantId');
    }
    this.credential = new ClientSecretCredential(
      this.config.tenantId,
      this.config.clientId,
      this.config.clientSecret,
    );
    const tokenResponse = await this.credential.getToken(ClientCredentialsAuthManager.GRAPH_SCOPE);
    if (!tokenResponse) throw new Error('Failed to acquire token via client credentials');
    this.accessToken = tokenResponse.token;
    this.expiresAt = tokenResponse.expiresOnTimestamp;
  }

  async refresh(): Promise<void> {
    if (!this.credential) {
      throw new Error('Not connected. Call connect() first.');
    }
    const tokenResponse = await this.credential.getToken(ClientCredentialsAuthManager.GRAPH_SCOPE);
    if (!tokenResponse) throw new Error('Failed to refresh token via client credentials');
    this.accessToken = tokenResponse.token;
    this.expiresAt = tokenResponse.expiresOnTimestamp;
  }

  async disconnect(): Promise<void> {
    this.credential = null;
    this.accessToken = undefined;
    this.expiresAt = undefined;
  }

  isTokenExpired(): boolean {
    if (!this.expiresAt) return true;
    return Date.now() >= this.expiresAt;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (!this.credential) return undefined;
    if (this.isTokenExpired()) {
      await this.refresh();
    }
    return this.accessToken;
  }
}

/**
 * List all configured mailboxes from ~/.agent-email/tokens/
 * Returns mailbox names (filename stems) for backward compatibility.
 */
export async function listConfiguredMailboxes(): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(getConfigDir());
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * List all configured mailboxes with their full metadata.
 * Deduplicates by emailAddress: if multiple files have the same email,
 * keeps the one with the most recent lastInteractiveAuthAt and deletes the older file(s).
 * Legacy files (no emailAddress) are kept only if no email-based file exists for the same mailboxName.
 */
export async function listConfiguredMailboxesWithMetadata(): Promise<MailboxMetadata[]> {
  const { readdir, unlink } = await import('node:fs/promises');

  let files: string[];
  try {
    files = (await readdir(getConfigDir())).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  // Load all metadata with their filenames
  const entries: Array<{ filename: string; metadata: MailboxMetadata }> = [];
  for (const file of files) {
    try {
      const content = await readFile(join(getConfigDir(), file), 'utf-8');
      const metadata = JSON.parse(content) as MailboxMetadata;
      entries.push({ filename: file, metadata });
    } catch {
      // Skip unreadable files
    }
  }

  // Group by emailAddress for dedup
  const byEmail = new Map<string, Array<{ filename: string; metadata: MailboxMetadata }>>();
  const noEmail: Array<{ filename: string; metadata: MailboxMetadata }> = [];

  for (const entry of entries) {
    if (entry.metadata.emailAddress) {
      const email = entry.metadata.emailAddress.toLowerCase();
      const group = byEmail.get(email) ?? [];
      group.push(entry);
      byEmail.set(email, group);
    } else {
      noEmail.push(entry);
    }
  }

  const results: MailboxMetadata[] = [];
  const emailAddressesSeen = new Set<string>();

  // For each email group, keep the most recent and delete the rest
  for (const [email, group] of byEmail) {
    // Sort by lastInteractiveAuthAt descending (most recent first)
    group.sort((a, b) => {
      const dateA = new Date(a.metadata.lastInteractiveAuthAt ?? '1970-01-01').getTime();
      const dateB = new Date(b.metadata.lastInteractiveAuthAt ?? '1970-01-01').getTime();
      return dateB - dateA;
    });

    // Keep the first (most recent), delete the rest
    results.push(group[0]!.metadata);
    emailAddressesSeen.add(email);

    for (let i = 1; i < group.length; i++) {
      const staleFile = group[i]!.filename;
      console.error(`[agent-email] Removing stale token file ${staleFile} (superseded by ${group[0]!.filename} for ${email})`);
      try {
        await unlink(join(getConfigDir(), staleFile));
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // Keep legacy (no email) entries only if no email-based file exists for the same mailboxName
  for (const entry of noEmail) {
    // Check if any email-based entry has the same mailboxName
    const superseded = results.some(r =>
      r.mailboxName === entry.metadata.mailboxName && r.emailAddress,
    );
    if (superseded) {
      console.error(`[agent-email] Removing legacy token file ${entry.filename} (superseded by email-based file for mailbox "${entry.metadata.mailboxName}")`);
      try {
        await unlink(join(getConfigDir(), entry.filename));
      } catch {
        // Best-effort cleanup
      }
    } else {
      results.push(entry.metadata);
    }
  }

  return results;
}

/**
 * Load metadata for a specific mailbox.
 * Accepts a mailbox name (filename stem), an email address, or a filesystem-safe key.
 */
export async function loadMailboxMetadata(identifier: string): Promise<MailboxMetadata | null> {
  // Try direct filename match first (e.g., "work" → "work.json", or safe key → safe key.json)
  try {
    const content = await readFile(join(getConfigDir(), `${identifier}.json`), 'utf-8');
    return JSON.parse(content) as MailboxMetadata;
  } catch {
    // Not found by direct name
  }

  // Try as email address: convert to filesystem-safe key
  if (identifier.includes('@')) {
    try {
      const safeKey = toFilesystemSafeKey(identifier);
      const content = await readFile(join(getConfigDir(), `${safeKey}.json`), 'utf-8');
      return JSON.parse(content) as MailboxMetadata;
    } catch {
      // Not found
    }
  }

  // Fall back: search all metadata files for matching mailboxName or emailAddress
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(getConfigDir());
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await readFile(join(getConfigDir(), file), 'utf-8');
        const metadata = JSON.parse(content) as MailboxMetadata;
        if (metadata.mailboxName === identifier || metadata.emailAddress === identifier) {
          return metadata;
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // No config dir
  }

  return null;
}

// Re-export for backward compatibility with tests
export { type AuthenticationRecord } from '@azure/identity';
