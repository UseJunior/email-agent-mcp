// Gmail OAuth2 authentication.
//
// Two modes:
//   - 'byok'    — caller supplied clientId+clientSecret; auth talks to
//                 Google directly using google-auth-library's OAuth2Client.
//   - 'broker'  — caller supplied a brokerUrl; auth never holds the
//                 client_secret. Code exchange and refresh are relayed
//                 through the broker (see apps/oauth-broker).
//
// In both modes API calls go directly from the user's machine to Gmail
// with the locally-held access token. Email content never reaches the
// broker.
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { createHash, randomBytes } from 'node:crypto';
import type { AuthManager } from '@usejunior/email-core';

export type GmailAuthMode = 'byok' | 'broker';

export interface GmailAuthConfig {
  /** Bring-your-own-key fields. Both required for `byok` mode. */
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;

  /** Broker mode. Mutually exclusive with clientSecret. */
  brokerUrl?: string;

  mailboxName?: string;
  lastInteractiveAuthAt?: string;
  /** Called in rotation order. Failure warns but never fails an API operation. */
  metadataWriter?: (refreshToken: string, previousRefreshToken: string) => Promise<void>;
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

export interface GmailBrokerSession {
  /** Public correlation handle (passes through URLs / `state`). */
  sessionId: string;
  /** Private claim credential (kept on the CLI; never in any URL). */
  pickupSecret: string;
  /** Browser entry point. */
  authorizationUrl: string;
}

export interface GmailPickUpOptions {
  /** Polling interval, default 1500ms. */
  intervalMs?: number;
  /** Total timeout. Default 5 min — matches the broker's ticket TTL. */
  timeoutMs?: number;
  /** Abort signal forwarded into the polling loop. */
  signal?: AbortSignal;
}

export interface GmailProfile {
  emailAddress: string;
  historyId?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export const GMAIL_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

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

interface BrokerTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

type GmailAuthState =
  | { kind: 'disconnected' | 'connecting' | 'disconnecting' }
  | { kind: 'reauth_required'; reason: unknown }
  | { kind: 'connected'; session: Credentials }
  | { kind: 'refreshing'; session: Credentials; promise: Promise<void> };

// All library automatic refreshes join the manager's explicit single flight.
// The transport client used by refresh() is separate, avoiding recursion.
class ManagedOAuth2Client extends OAuth2Client {
  managedRefresh?: () => Promise<Credentials>;
  protected override async refreshToken(refreshToken?: string | null) {
    if (!this.managedRefresh) return super.refreshToken(refreshToken);
    return { tokens: await this.managedRefresh(), res: null };
  }
}

export class GmailAuthManager implements AuthManager {
  private oauth2Client: OAuth2Client;
  private state: GmailAuthState = { kind: 'disconnected' };
  private generation = 0;
  private persistence: Promise<void> = Promise.resolve();
  private persistenceWarning?: string;
  private readonly mailboxName: string;
  private readonly lastInteractiveAuthAt?: string;
  private readonly mode: GmailAuthMode;
  private readonly brokerUrl?: string;

  constructor(private readonly _config: GmailAuthConfig) {
    if (_config.brokerUrl && _config.clientSecret) {
      throw new Error(
        'GmailAuthManager: brokerUrl and clientSecret are mutually exclusive. Use one mode at a time.',
      );
    }
    if (!_config.brokerUrl && !(_config.clientId && _config.clientSecret)) {
      throw new Error(
        'GmailAuthManager: provide either brokerUrl (broker mode) or both clientId and clientSecret (byok mode).',
      );
    }

    this.mode = _config.brokerUrl ? 'broker' : 'byok';
    this.brokerUrl = _config.brokerUrl?.replace(/\/$/, '');

    this.oauth2Client = this.createClient();

    this.mailboxName = _config.mailboxName ?? 'gmail';
    this.lastInteractiveAuthAt = _config.lastInteractiveAuthAt;
  }

  get clientId(): string | undefined { return this._config.clientId; }
  get authMode(): GmailAuthMode { return this.mode; }
  get broker(): string | undefined { return this.brokerUrl; }

  private get session(): Credentials | undefined {
    return this.state.kind === 'connected' || this.state.kind === 'refreshing'
      ? this.state.session : undefined;
  }

  private createClient(): OAuth2Client {
    const generation = this.generation;
    const client = new ManagedOAuth2Client(
      this._config.clientId, this._config.clientSecret,
      this._config.redirectUri ?? 'urn:ietf:wg:oauth:2.0:oob',
    );
    const refresh = async () => {
      this.assertGeneration(generation);
      await this.refresh();
      this.assertGeneration(generation);
      return this.clientCredentials(this.session!);
    };
    client.managedRefresh = refresh;
    if (this.mode === 'broker') {
      client.refreshHandler = async () => {
        const tokens = await refresh();
        if (!tokens.access_token) throw new Error('No Gmail access token available');
        return { access_token: tokens.access_token, expiry_date: tokens.expiry_date ?? Date.now() + 3600000 };
      };
      client.forceRefreshOnFailure = true;
    }
    client.on?.('tokens', tokens => {
      if (generation === this.generation && this.session) {
        this.publish(tokens, generation);
      }
    });
    return client;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) throw new Error('Gmail authentication operation superseded');
  }

  private clientCredentials(tokens: Credentials): Credentials {
    if (this.mode === 'broker') {
      return { access_token: tokens.access_token, expiry_date: tokens.expiry_date };
    }
    return { ...tokens };
  }

  private publish(tokens: Credentials, generation: number): void {
    this.assertGeneration(generation);
    const previous = this.session;
    const session = { ...previous, ...tokens,
      refresh_token: tokens.refresh_token ?? previous?.refresh_token };
    if (this.state.kind === 'refreshing') this.state.session = session;
    else this.state = { kind: 'connected', session };
    this.oauth2Client.setCredentials(this.clientCredentials(session));
    if (previous?.refresh_token && session.refresh_token && previous.refresh_token !== session.refresh_token) {
      const next = session.refresh_token;
      const old = previous.refresh_token;
      this.persistence = this.persistence.then(async () => {
        if (generation !== this.generation) return;
        try {
          await this._config.metadataWriter?.(next, old);
          if (generation === this.generation) this.persistenceWarning = undefined;
        } catch {
          if (generation !== this.generation) return;
          // Do not propagate this into delivery retry paths or log credentials.
          this.persistenceWarning = `Gmail token rotation could not be saved for mailbox "${this.mailboxName}". Runtime authentication remains available; reconfigure before restarting.`;
          console.error(this.persistenceWarning);
        }
      });
    }
  }

  /** Returns the underlying OAuth2Client for use with Gmail API. */
  getOAuth2Client(): OAuth2Client { return this.oauth2Client; }

  async generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }> {
    if (this.mode === 'broker') {
      throw new Error('generateCodeVerifierAsync is only available in byok mode.');
    }
    return await this.oauth2Client.generateCodeVerifierAsync();
  }

  /**
   * Connect using OAuth2 credentials.
   *
   * Accepts `access_token` and optionally `refresh_token`. If a refresh_token
   * is provided, the OAuth2Client is configured so that token refresh works
   * automatically — via Google's token endpoint (byok) or the broker.
   *
   * Broker-mode invariant: refresh_token MUST NOT live on `oauth2Client.credentials`.
   * If it does, google-auth-library prefers `refreshAccessTokenAsync()` on 401
   * (oauth2client.js:227,274,430), bypassing our `refreshHandler` and trying to
   * exchange against Google's token endpoint without the secret. We hold the
   * refresh token on this instance instead and route refreshes through the
   * broker exclusively.
   */
  async connect(credentials: Record<string, string>, options: { expiresInSeconds?: number } = {}): Promise<void> {
    const accessToken = credentials['access_token'];
    const refreshTokenVal = credentials['refresh_token'];

    if (!accessToken && !refreshTokenVal) {
      throw new Error(
        'Gmail OAuth2 connect requires at least an access_token or refresh_token.',
      );
    }

    // Compute expiry. Only assert one when we actually have an access_token —
    // otherwise leave it undefined and trigger a refresh on first use.
    let expiryDate: number | undefined;
    if (accessToken) {
      const ttlMs = (options.expiresInSeconds ?? 3600) * 1000;
      expiryDate = Date.now() + ttlMs;
    }

    ++this.generation;
    this.persistenceWarning = undefined;
    this.oauth2Client.setCredentials({});
    this.state = { kind: 'connecting' };
    this.oauth2Client = this.createClient();
    this.publish({ access_token: accessToken, refresh_token: refreshTokenVal, expiry_date: expiryDate }, this.generation);
  }

  /**
   * Build the consent-flow URL for byok mode. In broker mode use
   * {@link startBrokerSession} instead.
   */
  generateAuthUrl(options: GmailAuthUrlOptions = {}): string {
    if (this.mode === 'broker') {
      throw new Error('generateAuthUrl is only available in byok mode. Use startBrokerSession.');
    }
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
   * Exchange an authorization code for tokens. Byok mode only — broker
   * users hand the code off to the broker via {@link pickUpTicket}.
   */
  async exchangeCode(code: string, options: GmailExchangeCodeOptions = {}): Promise<void> {
    if (this.mode === 'broker') {
      throw new Error('exchangeCode is only available in byok mode. Use pickUpTicket.');
    }
    const generation = ++this.generation;
    this.persistenceWarning = undefined;
    this.state = { kind: 'connecting' };
    const exchangeClient = this.oauth2Client;
    this.oauth2Client.setCredentials({});
    this.oauth2Client = this.createClient();
    try {
      const { tokens } = await exchangeClient.getToken({
        code,
        codeVerifier: options.codeVerifier,
        redirect_uri: options.redirectUri ?? this._config.redirectUri,
      });
      this.publish({ ...tokens, expiry_date: tokens.expiry_date ?? Date.now() + 3600000 }, generation);
    } catch (error) {
      this.connectionFailed(generation, error);
      throw error;
    }
  }

  private connectionFailed(generation: number, reason: unknown): void {
    if (generation !== this.generation) return;
    this.state = isGmailReauthError(reason) ? { kind: 'reauth_required', reason } : { kind: 'disconnected' };
    this.oauth2Client.setCredentials({});
  }

  /**
   * Begin a broker-mediated authorization session. The CLI generates the
   * session ID locally so the broker only learns it via the auth URL.
   */
  /**
   * Begin a broker-mediated authorization session.
   *
   * Two random secrets are generated locally:
   *   - `sessionId`     — public correlation handle, ends up in the
   *                       browser URL and Google's `state` param. A leak
   *                       only lets an observer see *that* a session
   *                       exists; it does NOT let them claim tokens.
   *   - `pickupSecret`  — private claim credential. Only its SHA-256
   *                       hash is sent to the broker. The raw secret
   *                       never appears in any URL.
   *
   * The CLI must register the session at /api/sessions before opening
   * the browser; otherwise /api/start will 410.
   */
  async startBrokerSession(opts: { loginHint?: string } = {}): Promise<GmailBrokerSession> {
    if (this.mode !== 'broker') {
      throw new Error('startBrokerSession is only available in broker mode.');
    }
    const sessionId = randomUrlSafe(32);
    const pickupSecret = randomUrlSafe(32);
    const pickupHash = createHash('sha256').update(pickupSecret).digest('hex');

    const registerRes = await fetch(`${this.brokerUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        pickup_hash: pickupHash,
        ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
      }),
    });
    if (!registerRes.ok) {
      const body = await safeReadText(registerRes);
      throw new Error(`Broker session registration failed (${registerRes.status}): ${body}`);
    }

    const params = new URLSearchParams({ session: sessionId });
    return {
      sessionId,
      pickupSecret,
      authorizationUrl: `${this.brokerUrl}/api/start?${params.toString()}`,
    };
  }

  /**
   * Poll the broker's ticket endpoint until tokens land, the user
   * cancels, or the timeout expires. Distinguishes between the
   * possible failure states so callers can surface actionable errors.
   */
  async pickUpTicket(
    session: { sessionId: string; pickupSecret: string },
    opts: GmailPickUpOptions = {},
  ): Promise<void> {
    if (this.mode !== 'broker') {
      throw new Error('pickUpTicket is only available in broker mode.');
    }
    const generation = ++this.generation;
    this.persistenceWarning = undefined;
    this.state = { kind: 'connecting' };
    this.oauth2Client.setCredentials({});
    this.oauth2Client = this.createClient();
    const interval = Math.max(500, opts.intervalMs ?? 1500);
    const deadline = Date.now() + Math.max(interval, opts.timeoutMs ?? 5 * 60 * 1000);
    const url = `${this.brokerUrl}/api/tickets/claim`;

    try {
      while (Date.now() < deadline) {
        this.assertGeneration(generation);
        if (opts.signal?.aborted) throw new Error('pickUpTicket aborted');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: session.sessionId,
            pickup_secret: session.pickupSecret,
          }),
          signal: opts.signal,
        });
        this.assertGeneration(generation);

        if (res.status === 200) {
          const tokens = (await res.json()) as BrokerTokenResponse;
          this.assertGeneration(generation);
          await this.connect(
            {
              access_token: tokens.access_token,
              ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
            },
            typeof tokens.expires_in === 'number' ? { expiresInSeconds: tokens.expires_in } : {},
          );
          return;
        }

        if (res.status === 202) {
          await sleep(interval, opts.signal);
          continue;
        }

        // Terminal: surface a useful message instead of generic timeout text.
        const body = await safeReadText(res);
        let parsed: { status?: string; error?: string; error_description?: string } = {};
        try { parsed = JSON.parse(body) as typeof parsed; } catch { /* ignore */ }

        if (res.status === 403) {
          throw new Error('Broker rejected the pickup secret — auth was likely intercepted. Re-run configure.');
        }
        if (res.status === 410) {
          const reason = parsed.status ?? 'expired';
          const detail = parsed.error_description ? ` (${parsed.error_description})` : '';
          throw new Error(`Broker session ${reason}${detail}. Re-run configure.`);
        }
        if (res.status === 404) {
          throw new Error('Broker has no record of this session. Re-run configure.');
        }
        throw new Error(`Broker ticket claim failed (${res.status}): ${body}`);
      }
      throw new Error('Broker ticket pickup timed out — user did not complete consent.');
    } catch (error) {
      this.connectionFailed(generation, error);
      throw error;
    }
  }

  async refresh(): Promise<void> {
    if (this.state.kind === 'refreshing') return this.state.promise;
    const session = this.session;
    if (!session?.refresh_token) {
      const reason = new Error('No refresh token');
      if (this.state.kind === 'connected') {
        this.state = { kind: 'reauth_required', reason };
        this.oauth2Client.setCredentials({});
      }
      throw reason;
    }
    const generation = this.generation;
    // Defer the work until the state owns the promise, even with sync mocks.
    const promise = Promise.resolve().then(async () => {
      try {
        this.assertGeneration(generation);
        let tokens: Credentials;
        if (this.mode === 'broker') {
          tokens = await this.brokerRefresh(session.refresh_token!);
        } else {
          const transport = new OAuth2Client(this._config.clientId, this._config.clientSecret);
          transport.setCredentials({ ...session });
          let eventTokens: Credentials = {};
          transport.on?.('tokens', update => {
            if (generation !== this.generation) return;
            eventTokens = { ...eventTokens, ...update };
            this.publish(update, generation);
          });
          const result = await transport.refreshAccessToken();
          // The library may put the *old* refresh_token back in its result.
          tokens = { ...result.credentials, ...eventTokens };
        }
        this.publish({ ...tokens, expiry_date: tokens.expiry_date ?? Date.now() + 3600000 }, generation);
        await this.persistence;
        this.assertGeneration(generation);
        this.state = { kind: 'connected', session: this.session! };
      } catch (err) {
        if (generation === this.generation) {
          if (isGmailReauthError(err)) {
            this.state = { kind: 'reauth_required', reason: err };
            this.oauth2Client.setCredentials({});
          } else if (this.state.kind === 'refreshing') {
            this.state = { kind: 'connected', session: this.state.session };
          }
        }
        throw err;
      }
    });
    this.state = { kind: 'refreshing', session, promise };
    return promise;
  }

  private async brokerRefresh(refreshToken: string): Promise<Credentials> {
    const res = await fetch(`${this.brokerUrl}/api/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      const body = await safeReadText(res);
      const err: Error & { error?: string } = new Error(`Broker refresh failed (${res.status}): ${body}`);
      // Surface upstream invalid_grant so isGmailReauthError() recognises it.
      if (/invalid_grant/i.test(body)) err.error = 'invalid_grant';
      throw err;
    }
    const tokens = (await res.json()) as BrokerTokenResponse;
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + (tokens.expires_in ?? 3600) * 1000 };
  }

  async disconnect(): Promise<void> {
    const accessToken = this.session?.access_token;
    const client = this.oauth2Client;
    const generation = ++this.generation;
    this.persistenceWarning = undefined;
    this.state = { kind: 'disconnecting' };
    client.setCredentials({});
    this.oauth2Client = this.createClient();
    if (this.mode === 'byok' && accessToken) {
      try {
        await client.revokeToken(accessToken);
      } catch {
        // Best-effort revocation; token may already be invalid.
      }
    }
    // Broker mode: revocation needs Google's revoke endpoint, which still
    // works with just the access token (no client_secret needed).
    if (this.mode === 'broker' && accessToken) {
      try {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`,
          { method: 'POST' },
        );
      } catch {
        // Best-effort.
      }
    }
    if (generation === this.generation) this.state = { kind: 'disconnected' };
  }

  isTokenExpired(): boolean {
    const session = this.session;
    return !session?.access_token || !session.expiry_date || Date.now() >= session.expiry_date;
  }

  getAccessToken(): string | undefined {
    return this.isTokenExpired() ? undefined : this.session?.access_token ?? undefined;
  }

  getRefreshToken(): string | undefined {
    return this.session?.refresh_token ?? undefined;
  }

  /** Async valid-token acquisition; getAccessToken remains synchronous. */
  async getValidAccessToken(): Promise<string> {
    if (this.isTokenExpired()) await this.refresh();
    const token = this.getAccessToken();
    if (!token) throw new Error('No Gmail access token available');
    return token;
  }

  async tryReconnect(): Promise<boolean> {
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }

  getTokenHealthWarning(): string | undefined {
    if (this.state.kind === 'reauth_required') {
      return formatGmailAuthError(new Error('invalid_grant'), this.mailboxName);
    }

    if (this.persistenceWarning) return this.persistenceWarning;

    if (this.lastInteractiveAuthAt) {
      const daysSinceAuth = (Date.now() - new Date(this.lastInteractiveAuthAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceAuth > 5) {
        return `If the Google OAuth app is still in Testing, Gmail may require reauthentication after 7 days. Last authenticated ${Math.round(daysSinceAuth)} days ago.`;
      }
    }

    return undefined;
  }

  async fetchProfile(): Promise<GmailProfile> {
    const accessToken = await this.getValidAccessToken();

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

function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function safeReadText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
