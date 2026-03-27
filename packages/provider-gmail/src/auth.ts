// Gmail OAuth2 authentication
import { OAuth2Client } from 'google-auth-library';
import type { AuthManager } from '@usejunior/email-core';

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

export class GmailAuthManager implements AuthManager {
  private oauth2Client: OAuth2Client;
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt?: number;

  constructor(private readonly _config: GmailAuthConfig) {
    this.oauth2Client = new OAuth2Client(
      this._config.clientId,
      this._config.clientSecret,
      this._config.redirectUri ?? 'urn:ietf:wg:oauth:2.0:oob',
    );
  }

  get clientId(): string { return this._config.clientId; }

  /** Returns the underlying OAuth2Client for use with Gmail API. */
  getOAuth2Client(): OAuth2Client { return this.oauth2Client; }

  /**
   * Connect using OAuth2 credentials.
   *
   * Accepts `access_token` and optionally `refresh_token`. If a refresh_token
   * is provided, the OAuth2Client is configured so that token refresh works
   * automatically via Google's token endpoint.
   */
  async connect(credentials: Record<string, string>): Promise<void> {
    const accessToken = credentials['access_token'];
    const refreshTokenVal = credentials['refresh_token'];

    if (!accessToken && !refreshTokenVal) {
      throw new Error(
        'Gmail OAuth2 connect requires at least an access_token or refresh_token. ' +
        'Use GmailAuthManager.generateAuthUrl() to initiate the OAuth2 consent flow.',
      );
    }

    this.oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshTokenVal,
    });

    this.accessToken = accessToken;
    this.refreshToken = refreshTokenVal;
    this.expiresAt = Date.now() + 3600000; // 1 hour default
  }

  /**
   * Generate an OAuth2 authorization URL for the installed-app consent flow.
   * The user visits this URL, grants access, and receives an authorization code
   * which can be exchanged via `exchangeCode()`.
   */
  generateAuthUrl(scopes: string[] = ['https://www.googleapis.com/auth/gmail.modify']): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
    });
  }

  /**
   * Exchange an authorization code (from the consent flow) for tokens.
   * Calls `connect()` internally with the resulting tokens.
   */
  async exchangeCode(code: string): Promise<void> {
    const { tokens } = await this.oauth2Client.getToken(code);
    await this.connect({
      access_token: tokens.access_token ?? '',
      refresh_token: tokens.refresh_token ?? '',
    });
  }

  async refresh(): Promise<void> {
    if (!this.refreshToken) throw new Error('No refresh token');

    // Use the OAuth2Client's built-in refresh mechanism
    const { credentials } = await this.oauth2Client.refreshAccessToken();
    this.accessToken = credentials.access_token ?? undefined;
    this.expiresAt = credentials.expiry_date ?? Date.now() + 3600000;
  }

  async disconnect(): Promise<void> {
    if (this.accessToken) {
      try {
        await this.oauth2Client.revokeToken(this.accessToken);
      } catch {
        // Best-effort revocation; token may already be invalid
      }
    }
    this.oauth2Client.setCredentials({});
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
