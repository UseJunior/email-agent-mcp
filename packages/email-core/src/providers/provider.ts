// Capability-based provider interfaces
import type {
  EmailMessage,
  EmailThread,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
  Subscription,
  EmailError,
} from '../types.js';

export interface EmailReader {
  listMessages(opts: ListOptions): Promise<EmailMessage[]>;
  getMessage(id: string): Promise<EmailMessage>;
  searchMessages(query: string, folder?: string, limit?: number, offset?: number): Promise<EmailMessage[]>;
  getThread(messageId: string): Promise<EmailThread>;
}

export interface EmailSender {
  sendMessage(msg: ComposeMessage): Promise<SendResult>;
  replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult>;
  createDraft(msg: ComposeMessage): Promise<DraftResult>;
  sendDraft(draftId: string): Promise<SendResult>;
  createReplyDraft?(messageId: string, body: string, opts?: ReplyOptions): Promise<DraftResult>;
  updateDraft?(draftId: string, msg: Partial<ComposeMessage>): Promise<DraftResult>;
}

export interface EmailSubscriber {
  subscribe(callback: (msg: EmailMessage) => void): Promise<Subscription>;
  unsubscribe(sub: Subscription): Promise<void>;
}

export interface EmailCategorizer {
  applyLabels(messageId: string, labels: string[]): Promise<void>;
  removeLabels(messageId: string, labels: string[]): Promise<void>;
  setFlag(messageId: string, flagged: boolean): Promise<void>;
  setReadState(messageId: string, isRead: boolean): Promise<void>;
  moveToFolder(messageId: string, folder: string): Promise<string | void>;
  deleteMessage(messageId: string, hard?: boolean): Promise<void>;
}

export interface EmailAttachmentHandler {
  listAttachments(messageId: string): Promise<import('../types.js').EmailAttachment[]>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
}

// Combined provider type — providers implement what they support
export type EmailProvider = EmailReader & EmailSender & Partial<EmailSubscriber> & Partial<EmailCategorizer> & Partial<EmailAttachmentHandler>;

// Provider metadata for registration
export interface ProviderInfo {
  name: string;
  displayName: string;
  capabilities: ('read' | 'send' | 'subscribe' | 'categorize' | 'attachments')[];
}

// Error normalization
export function normalizeProviderError(
  err: unknown,
  provider: string,
): EmailError {
  if (err instanceof ProviderError) {
    return {
      code: err.code,
      message: err.message,
      provider,
      recoverable: err.recoverable,
      retryAfter: err.retryAfter,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    code: 'UNKNOWN_ERROR',
    message,
    provider,
    recoverable: false,
  };
}

export class ProviderError extends Error {
  constructor(
    public code: string,
    message: string,
    public provider: string,
    public recoverable: boolean,
    public retryAfter?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// Provider registry for dynamic discovery
const providerRegistry = new Map<string, () => Promise<EmailProvider>>();

export function registerProvider(name: string, factory: () => Promise<EmailProvider>): void {
  providerRegistry.set(name, factory);
}

export function getRegisteredProviders(): string[] {
  return [...providerRegistry.keys()];
}

export async function createProvider(name: string): Promise<EmailProvider> {
  const factory = providerRegistry.get(name);
  if (!factory) {
    throw new ProviderError(
      'PROVIDER_NOT_FOUND',
      `Provider '${name}' not available. Install: npm install @usejunior/provider-${name}`,
      name,
      false,
    );
  }
  return factory();
}

// Dynamic discovery of installed providers
export async function discoverProviders(): Promise<string[]> {
  const providerPackages = ['microsoft', 'gmail'];
  const discovered: string[] = [];

  for (const name of providerPackages) {
    try {
      await import(`@usejunior/provider-${name}`);
      discovered.push(name);
    } catch {
      // Provider not installed — skip silently
    }
  }

  return discovered;
}

// Retry with exponential backoff
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelay?: number; maxDelay?: number } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelay ?? 1000;
  const maxDelay = opts.maxDelay ?? 16000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;

      // Only retry on recoverable errors
      if (err instanceof ProviderError && !err.recoverable) {
        throw err;
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter = delay * (0.5 + Math.random() * 0.5);
      await new Promise(resolve => setTimeout(resolve, jitter));
    }
  }

  throw lastError;
}

// Authentication lifecycle interface
export interface AuthManager {
  connect(credentials: Record<string, string>): Promise<void>;
  refresh(): Promise<void>;
  disconnect(): Promise<void>;
  isTokenExpired(): boolean;
}

// Wrapper that auto-refreshes tokens
export async function withAutoRefresh<T>(
  authManager: AuthManager,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // If token expired, refresh and retry
    if (authManager.isTokenExpired()) {
      await authManager.refresh();
      return await fn();
    }
    throw err;
  }
}
