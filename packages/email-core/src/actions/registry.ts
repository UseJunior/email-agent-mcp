// Action registry — single source of truth for all email actions
import { z } from 'zod';
import type { EmailProvider } from '../providers/provider.js';

export interface ActionContext {
  provider: EmailProvider;
  mailboxName?: string;
  allMailboxes?: MailboxEntry[];
  sendAllowlist?: AllowlistConfig;
  receiveAllowlist?: AllowlistConfig;
  safeDir?: string;
  deleteEnabled?: boolean;
  rateLimiter?: RateLimiter;
}

export interface MailboxEntry {
  name: string;
  provider: EmailProvider;
  providerType: string;
  isDefault: boolean;
  status: 'connected' | 'disconnected' | 'error';
}

export interface AllowlistConfig {
  entries: string[]; // e.g., ["*@example.com", "alice@test.com", "*"]
}

export interface RateLimiter {
  checkLimit(action: string): { allowed: boolean; retryAfter?: number };
  recordUsage(action: string): void;
}

export interface EmailAction<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  input: z.ZodType<TInput>;
  output: z.ZodType<TOutput>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  run: (ctx: ActionContext, input: TInput) => Promise<TOutput>;
}

// Mutable action list — actions register themselves on import
const actions: EmailAction[] = [];

export function registerAction(action: EmailAction): void {
  actions.push(action);
}

export function getActions(): EmailAction[] {
  return [...actions];
}

// For the main export — populated after all action modules are imported
export const EMAIL_ACTIONS: EmailAction[] = actions;
