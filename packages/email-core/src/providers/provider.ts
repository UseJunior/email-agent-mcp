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

export interface DownloadedAttachment {
  content: Buffer;
  filename: string;
  mimeType: string;
  size: number;
}

export interface EmailAttachmentHandler {
  listAttachments(messageId: string): Promise<import('../types.js').EmailAttachment[]>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<DownloadedAttachment>;
}

export interface EmailFolder {
  id: string;
  displayName: string;
  path: string;
  parentFolderId?: string;
  childFolderCount?: number;
  unreadItemCount?: number;
  totalItemCount?: number;
  isHidden?: boolean;
  [key: string]: unknown;
}

export interface EmailFolderManager {
  listFolders(): Promise<EmailFolder[]>;
  createFolder(displayName: string, parentFolder?: string): Promise<EmailFolder>;
  deleteFolder(folder: string): Promise<void>;
}

export interface InboxRule {
  id?: string;
  displayName?: string;
  sequence?: number;
  isEnabled?: boolean;
  hasError?: boolean;
  isReadOnly?: boolean;
  conditions?: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CreateInboxRule {
  displayName: string;
  sequence?: number;
  isEnabled?: boolean;
  conditions: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
  actions: Record<string, unknown>;
}

export interface EmailRuleManager {
  listInboxRules(): Promise<InboxRule[]>;
  createInboxRule(rule: CreateInboxRule): Promise<InboxRule>;
  deleteInboxRule(id: string): Promise<void>;
}

// Combined provider type — providers implement what they support
export type EmailProvider = EmailReader
  & EmailSender
  & Partial<EmailSubscriber>
  & Partial<EmailCategorizer>
  & Partial<EmailAttachmentHandler>
  & Partial<EmailFolderManager>
  & Partial<EmailRuleManager>;

// Provider metadata for registration
export interface ProviderInfo {
  name: string;
  displayName: string;
  // 'attachments' covers inbound (list/download); 'outbound-attachments'
  // covers attaching files to sent mail / drafts. Both Graph and Gmail
  // support both. Note: no provider currently exports a ProviderInfo value —
  // this is a forward-compat type surface; wiring a real metadata surface
  // that declares these is a follow-up.
  capabilities: ('read' | 'send' | 'subscribe' | 'categorize' | 'attachments' | 'outbound-attachments' | 'folders' | 'rules')[];
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

// Thrown by providers when an attachment cannot be downloaded by this
// implementation — e.g. Microsoft Graph item/reference attachments, which
// require the /$value raw-bytes path. The download_attachment action remaps
// this to a typed { code: 'NOT_SUPPORTED' } result instead of letting it
// surface as PROVIDER_UNAVAILABLE.
export class AttachmentNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentNotSupportedError';
  }
}

// Thrown by providers when the requested attachment id does not exist on the
// message (e.g. Graph 404 on the bytes call after a race deletion). The
// download_attachment action remaps this to { code: 'ATTACHMENT_NOT_FOUND' }
// so race-deleted attachments surface with the same code as a stale id.
export class AttachmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentNotFoundError';
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
