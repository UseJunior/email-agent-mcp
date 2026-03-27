// get_mailbox_status action — connection state, unread count, warnings
import { z } from 'zod';
import type { EmailAction } from './registry.js';
import { getMailboxStore } from './configure.js';

const GetMailboxStatusInput = z.object({
  mailbox: z.string().optional(),
});

const GetMailboxStatusOutput = z.object({
  name: z.string(),
  provider: z.string(),
  status: z.string(),
  isDefault: z.boolean(),
  warnings: z.array(z.string()),
  metrics: z.object({
    actions_total: z.number(),
    errors_total: z.number(),
    avg_latency_ms: z.number(),
  }).optional(),
});

// Simple metrics tracker
const metricsStore = {
  actionCount: 0,
  errorCount: 0,
  totalLatencyMs: 0,
};

export function recordActionMetric(durationMs: number, isError: boolean): void {
  metricsStore.actionCount++;
  metricsStore.totalLatencyMs += durationMs;
  if (isError) metricsStore.errorCount++;
}

export function getMetrics() {
  return {
    actions_total: metricsStore.actionCount,
    errors_total: metricsStore.errorCount,
    avg_latency_ms: metricsStore.actionCount > 0
      ? Math.round(metricsStore.totalLatencyMs / metricsStore.actionCount)
      : 0,
  };
}

export function resetMetrics(): void {
  metricsStore.actionCount = 0;
  metricsStore.errorCount = 0;
  metricsStore.totalLatencyMs = 0;
}

export const getMailboxStatusAction: EmailAction<
  z.infer<typeof GetMailboxStatusInput>,
  z.infer<typeof GetMailboxStatusOutput>
> = {
  name: 'get_mailbox_status',
  description: 'Get mailbox connection status, unread count, and warnings',
  input: GetMailboxStatusInput,
  output: GetMailboxStatusOutput,
  annotations: { readOnlyHint: true, destructiveHint: false },
  run: async (ctx, input) => {
    const store = getMailboxStore();
    const mailboxName = input.mailbox ?? ctx.mailboxName;

    // Find the target mailbox
    let entry = mailboxName ? store.get(mailboxName) : undefined;
    if (!entry) {
      // Try default
      for (const [, mb] of store) {
        if (mb.isDefault) { entry = mb; break; }
      }
    }

    const warnings: string[] = [];

    // Check send allowlist
    if (!ctx.sendAllowlist || ctx.sendAllowlist.entries.length === 0) {
      warnings.push('Outbound email disabled — configure send allowlist to enable replies and sends');
    }

    if (!entry) {
      return {
        name: mailboxName ?? 'none',
        provider: 'none',
        status: 'not configured',
        isDefault: false,
        warnings,
        metrics: getMetrics(),
      };
    }

    return {
      name: entry.name,
      provider: entry.providerType,
      status: entry.status,
      isDefault: entry.isDefault,
      warnings,
      metrics: getMetrics(),
    };
  },
};
