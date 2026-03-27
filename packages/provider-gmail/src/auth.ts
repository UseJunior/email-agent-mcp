// Gmail OAuth2 authentication
import type { AuthManager } from '@usejunior/email-core';

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export class GmailAuthManager implements AuthManager {
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt?: number;

  constructor(private readonly _config: GmailAuthConfig) {}

  get clientId(): string { return this._config.clientId; }

  async connect(credentials: Record<string, string>): Promise<void> {
    // In real implementation: use this._config for OAuth2 flow via @googleapis/gmail
    this.accessToken = credentials['access_token'] ?? 'gmail-mock-token';
    this.refreshToken = credentials['refresh_token'] ?? 'gmail-mock-refresh';
    this.expiresAt = Date.now() + 3600000;
  }

  async refresh(): Promise<void> {
    if (!this.refreshToken) throw new Error('No refresh token');
    this.accessToken = `gmail-refreshed-${Date.now()}`;
    this.expiresAt = Date.now() + 3600000;
  }

  async disconnect(): Promise<void> {
    this.accessToken = undefined;
    this.refreshToken = undefined;
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
