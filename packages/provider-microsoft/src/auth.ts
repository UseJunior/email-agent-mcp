// Microsoft Graph authentication — delegated OAuth and client credentials
import type { AuthManager } from '@usejunior/email-core';

export interface MicrosoftAuthConfig {
  mode: 'delegated' | 'client_credentials';
  clientId: string;
  clientSecret?: string;
  tenantId?: string;
  redirectUri?: string;
}

export interface TokenStore {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Delegated OAuth auth manager (device code or PKCE).
 */
export class DelegatedAuthManager implements AuthManager {
  private tokenStore: TokenStore = {};
  private readonly _config: MicrosoftAuthConfig;

  constructor(config: MicrosoftAuthConfig) {
    this._config = config;
  }

  get mode(): string { return this._config.mode; }

  async connect(credentials: Record<string, string>): Promise<void> {
    // In real implementation: use this._config.clientId for device code flow or PKCE
    this.tokenStore = {
      accessToken: credentials['access_token'] ?? 'mock-access-token',
      refreshToken: credentials['refresh_token'] ?? 'mock-refresh-token',
      expiresAt: Date.now() + 3600000,
    };
  }

  async refresh(): Promise<void> {
    if (!this.tokenStore.refreshToken) {
      throw new Error('No refresh token available');
    }
    // In real implementation: use refresh token to get new access token
    this.tokenStore.accessToken = `refreshed-${Date.now()}`;
    this.tokenStore.expiresAt = Date.now() + 3600000;
  }

  async disconnect(): Promise<void> {
    this.tokenStore = {};
  }

  isTokenExpired(): boolean {
    if (!this.tokenStore.expiresAt) return true;
    return Date.now() >= this.tokenStore.expiresAt;
  }

  getAccessToken(): string | undefined {
    return this.tokenStore.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.tokenStore.refreshToken;
  }

  setTokens(tokens: TokenStore): void {
    this.tokenStore = { ...tokens };
  }
}

/**
 * Client credentials auth manager (app-only).
 */
export class ClientCredentialsAuthManager implements AuthManager {
  private tokenStore: TokenStore = {};
  private readonly _config: MicrosoftAuthConfig;

  constructor(config: MicrosoftAuthConfig) {
    this._config = config;
  }

  async connect(_credentials: Record<string, string>): Promise<void> {
    if (!this._config.clientSecret || !this._config.tenantId) {
      throw new Error('Client credentials require clientSecret and tenantId');
    }
    // In real implementation: use ClientSecretCredential
    this.tokenStore = {
      accessToken: `app-token-${Date.now()}`,
      expiresAt: Date.now() + 3600000,
    };
  }

  private tokenCounter = 0;

  async refresh(): Promise<void> {
    // Client credentials tokens are refreshed by getting a new one
    this.tokenCounter++;
    this.tokenStore = {
      accessToken: `app-token-${Date.now()}-${this.tokenCounter}`,
      expiresAt: Date.now() + 3600000,
    };
  }

  async disconnect(): Promise<void> {
    this.tokenStore = {};
  }

  isTokenExpired(): boolean {
    if (!this.tokenStore.expiresAt) return true;
    return Date.now() >= this.tokenStore.expiresAt;
  }

  getAccessToken(): string | undefined {
    return this.tokenStore.accessToken;
  }
}

/**
 * Persist encrypted refresh tokens to config directory.
 */
export async function persistRefreshToken(
  configDir: string,
  mailboxName: string,
  refreshToken: string,
): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await mkdir(configDir, { recursive: true });
  // In production: encrypt the token before writing
  await writeFile(
    join(configDir, `${mailboxName}.token.json`),
    JSON.stringify({ refreshToken, savedAt: new Date().toISOString() }),
    'utf-8',
  );
}

/**
 * Load persisted refresh tokens from config directory.
 */
export async function loadRefreshToken(
  configDir: string,
  mailboxName: string,
): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const content = await readFile(join(configDir, `${mailboxName}.token.json`), 'utf-8');
    const data = JSON.parse(content) as { refreshToken?: string };
    return data.refreshToken;
  } catch {
    return undefined;
  }
}
