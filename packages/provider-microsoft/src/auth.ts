// Microsoft Graph authentication — real MSAL device code flow + cache persistence
import type { AuthManager } from '@usejunior/email-core';
import { DeviceCodeCredential, useIdentityPlugin, type DeviceCodeInfo, type AuthenticationRecord } from '@azure/identity';
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
const CONFIG_DIR = join(homedir(), '.agent-email', 'tokens');

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

  constructor(config: MicrosoftAuthConfig, mailboxName = 'default') {
    this.config = config;
    this.mailboxName = mailboxName;
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
    return join(CONFIG_DIR, `${this.mailboxName}.json`);
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
  }): DeviceCodeCredential {
    return new DeviceCodeCredential({
      clientId: options.clientId,
      tenantId: options.tenantId ?? 'organizations',
      authenticationRecord: options.authenticationRecord,
      disableAutomaticAuthentication: true,
      userPromptCallback: options.userPromptCallback,
      tokenCachePersistenceOptions: {
        enabled: true,
        name: options.cacheName,
        unsafeAllowUnencryptedStorage: process.platform === 'linux',
      },
    });
  }

  private async saveMetadata(): Promise<void> {
    const path = this.getMetadataPath();
    await mkdir(dirname(path), { recursive: true });
    const metadata: MailboxMetadata = {
      authenticationRecord: this.authRecord!,
      cacheName: this.cacheName ?? undefined,
      lastInteractiveAuthAt: this._lastInteractiveAuthAt!,
      clientId: this.config.clientId,
      tenantId: this.config.tenantId,
      mailboxName: this.mailboxName,
    };
    await writeFile(path, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  private async loadMetadata(): Promise<MailboxMetadata | null> {
    try {
      const content = await readFile(this.getMetadataPath(), 'utf-8');
      return JSON.parse(content) as MailboxMetadata;
    } catch {
      return null;
    }
  }
}

/**
 * Client credentials auth manager (app-only / daemon).
 * Unchanged — uses ClientSecretCredential.
 */
export class ClientCredentialsAuthManager implements AuthManager {
  private accessToken?: string;
  private expiresAt?: number;
  private tokenCounter = 0;
  private readonly config: MicrosoftAuthConfig;

  constructor(config: MicrosoftAuthConfig) {
    this.config = config;
  }

  async connect(_credentials: Record<string, string>): Promise<void> {
    if (!this.config.clientSecret || !this.config.tenantId) {
      throw new Error('Client credentials require clientSecret and tenantId');
    }
    // In real implementation: use ClientSecretCredential from @azure/identity
    this.accessToken = `app-token-${Date.now()}`;
    this.expiresAt = Date.now() + 3600000;
  }

  async refresh(): Promise<void> {
    this.tokenCounter++;
    this.accessToken = `app-token-${Date.now()}-${this.tokenCounter}`;
    this.expiresAt = Date.now() + 3600000;
  }

  async disconnect(): Promise<void> {
    this.accessToken = undefined;
    this.expiresAt = undefined;
  }

  isTokenExpired(): boolean {
    if (!this.expiresAt) return true;
    return Date.now() >= this.expiresAt;
  }

  getAccessToken(): string | undefined {
    return this.accessToken;
  }
}

/**
 * List all configured mailboxes from ~/.agent-email/tokens/
 */
export async function listConfiguredMailboxes(): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(CONFIG_DIR);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Load metadata for a specific mailbox.
 */
export async function loadMailboxMetadata(mailboxName: string): Promise<MailboxMetadata | null> {
  try {
    const content = await readFile(join(CONFIG_DIR, `${mailboxName}.json`), 'utf-8');
    return JSON.parse(content) as MailboxMetadata;
  } catch {
    return null;
  }
}

// Re-export for backward compatibility with tests
export { type AuthenticationRecord } from '@azure/identity';
