// Mock email provider for testing — implements all capability interfaces in-memory
import type {
  EmailMessage,
  EmailThread,
  ComposeMessage,
  SendResult,
  DraftResult,
  ListOptions,
  ReplyOptions,
  Subscription,
  EmailAttachment,
} from '../types.js';
import {
  ProviderError,
  type EmailReader,
  type EmailSender,
  type EmailSubscriber,
  type EmailCategorizer,
  type EmailAttachmentHandler,
} from '../providers/provider.js';

export class MockEmailProvider implements EmailReader, EmailSender, EmailSubscriber, EmailCategorizer, EmailAttachmentHandler {
  private messages: EmailMessage[] = [];
  private drafts: Map<string, ComposeMessage> = new Map();
  private sentMessages: ComposeMessage[] = [];
  private subscriptions: Map<string, (msg: EmailMessage) => void> = new Map();
  private attachmentData: Map<string, Buffer> = new Map();
  private nextId = 1;

  // --- Setup helpers for tests ---

  addMessage(msg: Partial<EmailMessage> & { id: string }): void {
    this.messages.push({
      subject: '',
      from: { email: 'sender@example.com' },
      to: [{ email: 'recipient@example.com' }],
      receivedAt: new Date().toISOString(),
      isRead: false,
      hasAttachments: false,
      ...msg,
    });
  }

  addAttachmentData(messageId: string, attachmentId: string, data: Buffer): void {
    this.attachmentData.set(`${messageId}:${attachmentId}`, data);
  }

  getSentMessages(): ComposeMessage[] {
    return [...this.sentMessages];
  }

  getMessages(): EmailMessage[] {
    return [...this.messages];
  }

  // Track errors to throw on next call
  private errorToThrow: Error | null = null;
  private errorCountdown = 0;

  setError(err: Error, afterCalls = 0): void {
    this.errorToThrow = err;
    this.errorCountdown = afterCalls;
  }

  private maybeThrow(): void {
    if (this.errorToThrow) {
      if (this.errorCountdown <= 0) {
        const err = this.errorToThrow;
        this.errorToThrow = null;
        throw err;
      }
      this.errorCountdown--;
    }
  }

  // --- EmailReader ---

  async listMessages(opts: ListOptions): Promise<EmailMessage[]> {
    this.maybeThrow();
    let results = [...this.messages];

    if (opts.folder) {
      results = results.filter(m => (m.folder ?? 'inbox') === opts.folder);
    }
    if (opts.unread) {
      results = results.filter(m => !m.isRead);
    }
    if (opts.from) {
      results = results.filter(m => m.from.email === opts.from);
    }

    // Sort by receivedAt descending
    results.sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());

    const limit = opts.limit ?? 25;
    return results.slice(0, limit);
  }

  async getMessage(id: string): Promise<EmailMessage> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === id);
    if (msg) {
      return { ...msg };
    }

    // Fall back to drafts — allows send_draft to look up draft recipients
    const draft = this.drafts.get(id);
    if (draft) {
      return {
        id,
        subject: draft.subject,
        from: { email: 'me@company.com' },
        to: draft.to,
        cc: draft.cc,
        receivedAt: new Date().toISOString(),
        isRead: true,
        hasAttachments: false,
        body: draft.body,
      };
    }

    throw new Error(`Message not found: ${id}`);
  }

  async searchMessages(query: string, _folder?: string, limit?: number, offset?: number): Promise<EmailMessage[]> {
    this.maybeThrow();
    const lowerQuery = query.toLowerCase();
    const filtered = this.messages.filter(m =>
      m.subject.toLowerCase().includes(lowerQuery) ||
      (m.body ?? '').toLowerCase().includes(lowerQuery) ||
      m.from.email.toLowerCase().includes(lowerQuery),
    );
    const start = offset ?? 0;
    return filtered.slice(start, limit ? start + limit : undefined);
  }

  async getThread(messageId: string): Promise<EmailThread> {
    this.maybeThrow();
    const message = this.messages.find(m => m.id === messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }

    // Group by conversationId or threadId
    const threadId = message.conversationId ?? message.threadId;
    let threadMessages: EmailMessage[];

    if (threadId) {
      threadMessages = this.messages.filter(
        m => m.conversationId === threadId || m.threadId === threadId,
      );
    } else {
      // RFC header fallback
      threadMessages = this.reconstructThreadByHeaders(message);
    }

    // Sort chronologically
    threadMessages.sort(
      (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
    );

    return {
      id: threadId ?? messageId,
      subject: message.subject,
      messages: threadMessages,
      messageCount: threadMessages.length,
    };
  }

  private reconstructThreadByHeaders(message: EmailMessage): EmailMessage[] {
    const chain: EmailMessage[] = [message];
    const seen = new Set<string>([message.id]);

    // Follow In-Reply-To and References headers
    const findByMessageId = (msgId: string): EmailMessage | undefined => {
      return this.messages.find(m => m.messageId === msgId);
    };

    // Walk up the reply chain
    let current = message;
    while (current.inReplyTo) {
      const parent = findByMessageId(current.inReplyTo);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      chain.push(parent);
      current = parent;
    }

    // Check references for any additional messages
    if (message.references) {
      for (const ref of message.references) {
        const refMsg = findByMessageId(ref);
        if (refMsg && !seen.has(refMsg.id)) {
          seen.add(refMsg.id);
          chain.push(refMsg);
        }
      }
    }

    return chain;
  }

  // --- EmailSender ---

  async sendMessage(msg: ComposeMessage): Promise<SendResult> {
    this.maybeThrow();
    const id = `sent-${this.nextId++}`;
    this.sentMessages.push(msg);
    return { success: true, messageId: id };
  }

  async replyToMessage(messageId: string, body: string, opts?: ReplyOptions): Promise<SendResult> {
    this.maybeThrow();
    const original = this.messages.find(m => m.id === messageId);
    if (!original) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const id = `reply-${this.nextId++}`;
    this.sentMessages.push({
      to: [original.from],
      cc: opts?.cc,
      bcc: opts?.bcc,
      subject: `Re: ${original.subject}`,
      body,
      attachments: opts?.attachments,
    });

    return { success: true, messageId: id };
  }

  async createDraft(msg: ComposeMessage): Promise<DraftResult> {
    this.maybeThrow();
    const draftId = `draft-${this.nextId++}`;
    this.drafts.set(draftId, msg);
    return { success: true, draftId };
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    this.maybeThrow();
    const draft = this.drafts.get(draftId);
    if (!draft) {
      throw new ProviderError('DRAFT_NOT_FOUND', `Draft not found: ${draftId}`, 'mock', false);
    }
    this.drafts.delete(draftId);
    this.sentMessages.push(draft);
    return { success: true, messageId: `sent-${this.nextId++}` };
  }

  async createReplyDraft(messageId: string, body: string, opts?: ReplyOptions): Promise<DraftResult> {
    this.maybeThrow();
    const original = this.messages.find(m => m.id === messageId);
    if (!original) {
      throw new Error(`Message not found: ${messageId}`);
    }
    const draftId = `draft-${this.nextId++}`;
    this.drafts.set(draftId, {
      to: [original.from],
      cc: opts?.cc,
      subject: `Re: ${original.subject}`,
      body,
    });
    return { success: true, draftId };
  }

  async updateDraft(draftId: string, msg: Partial<ComposeMessage>): Promise<DraftResult> {
    this.maybeThrow();
    const existing = this.drafts.get(draftId);
    if (!existing) {
      throw new Error(`Draft not found: ${draftId}`);
    }
    this.drafts.set(draftId, {
      ...existing,
      ...(msg.to !== undefined && { to: msg.to }),
      ...(msg.cc !== undefined && { cc: msg.cc }),
      ...(msg.subject !== undefined && { subject: msg.subject }),
      ...(msg.body !== undefined && { body: msg.body }),
    });
    return { success: true, draftId };
  }

  getDrafts(): Map<string, ComposeMessage> {
    return new Map(this.drafts);
  }

  // --- EmailSubscriber ---

  async subscribe(callback: (msg: EmailMessage) => void): Promise<Subscription> {
    const id = `sub-${this.nextId++}`;
    this.subscriptions.set(id, callback);
    return {
      id,
      resource: 'users/me/mailFolders/Inbox/messages',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };
  }

  async unsubscribe(sub: Subscription): Promise<void> {
    this.subscriptions.delete(sub.id);
  }

  // Test helper: simulate incoming email
  simulateIncomingEmail(msg: EmailMessage): void {
    this.messages.push(msg);
    for (const callback of this.subscriptions.values()) {
      callback(msg);
    }
  }

  // --- EmailCategorizer ---

  async applyLabels(messageId: string, labels: string[]): Promise<void> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    msg.labels = [...new Set([...(msg.labels ?? []), ...labels])];
  }

  async removeLabels(messageId: string, labels: string[]): Promise<void> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    msg.labels = (msg.labels ?? []).filter(l => !labels.includes(l));
  }

  async setFlag(messageId: string, flagged: boolean): Promise<void> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    msg.isFlagged = flagged;
  }

  async setReadState(messageId: string, isRead: boolean): Promise<void> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    msg.isRead = isRead;
  }

  async moveToFolder(messageId: string, folder: string): Promise<string> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    msg.folder = folder;
    return messageId;
  }

  async deleteMessage(messageId: string, hard?: boolean): Promise<void> {
    this.maybeThrow();
    if (hard) {
      this.messages = this.messages.filter(m => m.id !== messageId);
    } else {
      const msg = this.messages.find(m => m.id === messageId);
      if (!msg) throw new Error(`Message not found: ${messageId}`);
      msg.folder = 'trash';
    }
  }

  // --- EmailAttachmentHandler ---

  async listAttachments(messageId: string): Promise<EmailAttachment[]> {
    this.maybeThrow();
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) throw new Error(`Message not found: ${messageId}`);
    return msg.attachments ?? [];
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    this.maybeThrow();
    const data = this.attachmentData.get(`${messageId}:${attachmentId}`);
    if (!data) throw new Error(`Attachment not found: ${attachmentId}`);
    return data;
  }
}
