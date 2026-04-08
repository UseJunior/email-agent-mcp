// Core types for email-agent-mcp

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
}

export interface EmailMessage {
  id: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  receivedAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  body?: string;
  bodyHtml?: string;
  snippet?: string;
  folder?: string;
  labels?: string[];
  threadId?: string;
  conversationId?: string;
  messageId?: string; // RFC Message-ID header
  inReplyTo?: string; // RFC In-Reply-To header
  references?: string[]; // RFC References header
  attachments?: EmailAttachment[];
  headers?: Record<string, string>;
  mailbox?: string;
  isFlagged?: boolean;
}

export interface EmailThread {
  id: string;
  subject: string;
  messages: EmailMessage[];
  messageCount: number;
  isTruncated?: boolean;
}

export interface ComposeMessage {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body: string;
  bodyHtml?: string;
  attachments?: OutboundAttachment[];
  trackingId?: string;
}

export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  mimeType: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: EmailError;
}

export interface DraftResult {
  success: boolean;
  draftId?: string;
  error?: EmailError;
}

export interface EmailError {
  code: string;
  message: string;
  provider?: string;
  recoverable: boolean;
  retryAfter?: number;
}

export interface ListOptions {
  mailbox?: string;
  folder?: string;
  unread?: boolean;
  limit?: number;
  offset?: number;
  from?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface ReplyOptions {
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  attachments?: OutboundAttachment[];
  /**
   * Pre-rendered HTML body. When set, providers send with HTML content-type
   * and use this instead of the plain `body` argument. When unset, providers
   * send with plain-text content-type.
   */
  bodyHtml?: string;
}

export interface Subscription {
  id: string;
  resource: string;
  expiresAt: string;
}
