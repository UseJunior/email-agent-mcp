// Gmail OAuth2 authentication
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { AuthManager } from '@usejunior/email-core';

export interface GmailAuthConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  mailboxName?: string;
  lastInteractiveAuthAt?: string;
}

export interface GmailAuthUrlOptions {
  scopes?: string[];
  state?: string;
  loginHint?: string;
  redirectUri?: string;
  codeChallenge?: string;
  prompt?: string;
}

export interface GmailExchangeCodeOptions {
  codeVerifier?: string;
  redirectUri?: string;
}

export interface GmailProfile {
  emailAddress: string;
  historyId?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export const GMAIL_OAUTH_SCOPES = ['https://mail.google.com/'];

function collectAuthErrorStrings(err: unknown): string[] {
  const values = new Set<string>();

  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    values.add(trimmed);
  };

  if (err instanceof Error) {
    add(err.message);
  }

  const record = err as {
    message?: unknown;
    error?: unknown;
    error_description?: unknown;
    response?: {
      data?: {
        error?: unknown;
        error_description?: unknown;
      };
    };
  } | null;

  if (record && typeof record === 'object') {
    add(record.message);
    add(record.error_description);

    if (typeof record.error === 'string') {
      add(record.error);
    } else if (record.error && typeof record.error === 'object') {
      const nestedError = record.error as { message?: unknown; code?: unknown };
      add(nestedError.message);
      add(nestedError.code);
    }

    const responseData = record.response?.data;
    if (responseData && typeof responseData === 'object') {
      add(responseData.error_description);
      if (typeof responseData.error === 'string') {
        add(responseData.error);
      } else if (responseData.error && typeof responseData.error === 'object') {
        const nestedError = responseData.error as { message?: unknown; status?: unknown };
        add(nestedError.message);
        add(nestedError.status);
      }
    }
  }

  return [...values];
}

export function isGmailReauthError(err: unknown): boolean {
  return collectAuthErrorStrings(err).some(value => {
    const lower = value.toLowerCase();
    return (
      lower.includes('invalid_grant') ||
      lower.includes('token has been expired or revoked') ||
      lower.includes('token has been revoked') ||
      lower.includes('invalid_rapt') ||
      lower.includes('no refresh token')
    );
  });
}

export function formatGmailAuthError(err: unknown, mailboxName: string): string {
  if (isGmailReauthError(err)) {
    return `Authentication expired for Gmail mailbox "${mailboxName}". Run: email-agent-mcp configure --provider gmail --mailbox ${mailboxName}`;
  }

  return collectAuthErrorStrings(err)[0] ?? (err instanceof Error ? err.message : String(err));
}

export class GmailAuthManager implements AuthManager {
  private oauth2Client: OAuth2Client;
  private accessToken?: string;
  private refreshToken?: string;
  private expiresAt?: number;
  private readonly mailboxName: string;
  private readonly lastInteractiveAuthAt?: string;
  private needsReauth = false;
  private reconnectPromise: Promise<boolean> | null = null;

  constructor(private readonly _config: GmailAuthConfig) {
    this.oauth2Client = new OAuth2Client(
      this._config.clientId,
      this._config.clientSecret,
      this._config.redirectUri ?? 'urn:ietf:wg:oauth:2.0:oob',
    );
    this.mailboxName = this._config.mailboxName ?? 'gmail';
    this.lastInteractiveAuthAt = this._config.lastInteractiveAuthAt;
  }

  get clientId(): string { return this._config.clientId; }

  /** Returns the underlying OAuth2Client for use with Gmail API. */
  getOAuth2Client(): OAuth2Client { return this.oauth2Client; }

  async generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }> {
    return await this.oauth2Client.generateCodeVerifierAsync();
  }

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
    this.needsReauth = false;
  }

  /**
   * Generate an OAuth2 authorization URL for the installed-app consent flow.
   * The user visits this URL, grants access, and receives an authorization code
   * which can be exchanged via `exchangeCode()`.
   */
  generateAuthUrl(options: GmailAuthUrlOptions = {}): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      include_granted_scopes: true,
      prompt: options.prompt ?? 'consent',
      scope: options.scopes ?? GMAIL_OAUTH_SCOPES,
      state: options.state,
      login_hint: options.loginHint,
      redirect_uri: options.redirectUri ?? this._config.redirectUri,
      code_challenge: options.codeChallenge,
      code_challenge_method: options.codeChallenge ? CodeChallengeMethod.S256 : undefined,
    });
  }

  /**
   * Exchange an authorization code (from the consent flow) for tokens.
   * Calls `connect()` internally with the resulting tokens.
   */
  async exchangeCode(code: string, options: GmailExchangeCodeOptions = {}): Promise<void> {
    const { tokens } = await this.oauth2Client.getToken({
      code,
      codeVerifier: options.codeVerifier,
      redirect_uri: options.redirectUri ?? this._config.redirectUri,
    });

    this.oauth2Client.setCredentials(tokens);
    this.accessToken = tokens.access_token ?? undefined;
    this.refreshToken = tokens.refresh_token ?? this.refreshToken;
    this.expiresAt = tokens.expiry_date ?? Date.now() + 3600000;
    this.needsReauth = false;
  }

  async refresh(): Promise<void> {
    if (!this.refreshToken) {
      this.needsReauth = true;
      throw new Error('No refresh token');
    }

    try {
      // Use the OAuth2Client's built-in refresh mechanism
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      this.accessToken = credentials.access_token ?? undefined;
      this.expiresAt = credentials.expiry_date ?? Date.now() + 3600000;
      this.needsReauth = false;
    } catch (err) {
      if (isGmailReauthError(err)) {
        this.needsReauth = true;
      }
      throw err;
    }
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
    this.needsReauth = false;
    this.reconnectPromise = null;
  }

  isTokenExpired(): boolean {
    if (this.needsReauth) return true;
    if (!this.expiresAt) return true;
    return Date.now() >= this.expiresAt;
  }

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  getRefreshToken(): string | undefined {
    return this.refreshToken;
  }

  async tryReconnect(): Promise<boolean> {
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      try {
        await this.refresh();
        return true;
      } catch {
        return false;
      } finally {
        this.reconnectPromise = null;
      }
    })();
    return this.reconnectPromise;
  }

  getTokenHealthWarning(): string | undefined {
    if (this.needsReauth) {
      return formatGmailAuthError(new Error('invalid_grant'), this.mailboxName);
    }

    if (this.lastInteractiveAuthAt) {
      const daysSinceAuth = (Date.now() - new Date(this.lastInteractiveAuthAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceAuth > 5) {
        return `If the Google OAuth app is still in Testing, Gmail may require reauthentication after 7 days. Last authenticated ${Math.round(daysSinceAuth)} days ago.`;
      }
    }

    return undefined;
  }

  async fetchProfile(): Promise<GmailProfile> {
    let accessToken = this.getAccessToken();
    if (!accessToken) {
      await this.refresh();
      accessToken = this.getAccessToken();
    }

    if (!accessToken) {
      throw new Error('No Gmail access token available');
    }

    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Gmail profile fetch failed (${response.status})`);
    }

    return await response.json() as GmailProfile;
  }
}
