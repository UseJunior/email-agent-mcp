import {
  classifyHttpStatus,
  classifyTransportError,
  ProviderError,
  type OperationKind,
} from '@usejunior/email-core';

export function getErrorStatus(err: unknown): number | undefined {
  const record = err as { code?: unknown; response?: { status?: unknown } } | null;
  if (!record || typeof record !== 'object') return undefined;
  if (typeof record.code === 'number') return record.code;
  if (typeof record.code === 'string' && /^\d{3}$/.test(record.code)) return Number(record.code);
  if (typeof record.response?.status === 'number') return record.response.status;
  return undefined;
}

export function getErrorMessage(err: unknown): string | undefined {
  const record = err as {
    message?: unknown;
    response?: { data?: { error?: { message?: unknown } } };
  } | null;
  if (!record || typeof record !== 'object') return undefined;
  if (typeof record.response?.data?.error?.message === 'string') return record.response.data.error.message;
  if (typeof record.message === 'string') return record.message;
  return undefined;
}

function getErrorReason(err: unknown): string | undefined {
  const record = err as {
    errors?: Array<{ reason?: unknown }>;
    response?: { data?: { error?: { errors?: Array<{ reason?: unknown }> } } };
  } | null;
  if (!record || typeof record !== 'object') return undefined;
  const reason = record.errors?.[0]?.reason ?? record.response?.data?.error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);

export function gmailProviderError(
  err: unknown,
  operation: OperationKind,
  ctx: { provider?: string } = {},
): ProviderError {
  const status = getErrorStatus(err);
  const message = getErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
  const provider = ctx.provider ?? 'gmail';

  if (status !== undefined) {
    const classified = status === 403 && RATE_LIMIT_REASONS.has(getErrorReason(err) ?? '')
      ? { code: 'RATE_LIMITED', recoverable: operation !== 'delivery' }
      : classifyHttpStatus(status, operation);
    return new ProviderError(classified.code, message, provider, classified.recoverable, classified.retryAfter);
  }

  const dispatched = classifyTransportError(err) === 'dispatched-or-unknown';
  const code = operation === 'delivery' && dispatched ? 'SEND_STATUS_UNKNOWN' : 'PROVIDER_ERROR';
  return new ProviderError(code, message, provider, operation !== 'delivery' && !dispatched);
}
