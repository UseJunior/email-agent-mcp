// Observability — logging, error sanitization, metrics, optional OTel

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  action?: string;
  mailbox?: string;
  duration_ms?: number;
  error?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(entry: Partial<LogEntry>): void;
  info(entry: Partial<LogEntry>): void;
  warn(entry: Partial<LogEntry>): void;
  error(entry: Partial<LogEntry>): void;
  getLevel(): LogLevel;
}

export type LogMode = 'mcp' | 'cli';

/**
 * Create a logger that writes to stderr.
 * MCP mode: structured JSON
 * CLI mode: human-readable
 */
export function createLogger(opts: {
  level?: LogLevel;
  mode?: LogMode;
} = {}): Logger {
  const level = opts.level ?? (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info';
  const mode = opts.mode ?? 'mcp';

  function shouldLog(entryLevel: LogLevel): boolean {
    return LOG_LEVEL_ORDER[entryLevel] >= LOG_LEVEL_ORDER[level];
  }

  function emit(entryLevel: LogLevel, entry: Partial<LogEntry>): void {
    if (!shouldLog(entryLevel)) return;

    const fullEntry: LogEntry = {
      ts: new Date().toISOString(),
      level: entryLevel,
      ...entry,
    };

    if (mode === 'mcp') {
      // Structured JSON to stderr
      console.error(JSON.stringify(fullEntry));
    } else {
      // Human-readable to stderr
      const parts = [`[${fullEntry.level.toUpperCase()}]`];
      if (fullEntry.action) parts.push(fullEntry.action);
      if (fullEntry.mailbox) parts.push(`(${fullEntry.mailbox})`);
      if (fullEntry.duration_ms !== undefined) parts.push(`${fullEntry.duration_ms}ms`);
      if (fullEntry.error) parts.push(`ERROR: ${fullEntry.error}`);
      console.error(parts.join(' '));
    }
  }

  return {
    debug: (entry) => emit('debug', entry),
    info: (entry) => emit('info', entry),
    warn: (entry) => emit('warn', entry),
    error: (entry) => emit('error', entry),
    getLevel: () => level,
  };
}

/**
 * Sanitize error messages for MCP responses.
 * Strips file paths, API keys, stack traces.
 */
export function sanitizeError(message: string): string {
  let sanitized = message;

  // Redact file paths (Unix and Windows)
  sanitized = sanitized.replace(/\/(?:Users|home|var|tmp|etc|opt|sandbox|root)\/[^\s"']+/g, '[PATH]');
  sanitized = sanitized.replace(/[A-Z]:\\[^\s"']+/g, '[PATH]');

  // Redact API keys/tokens (common patterns)
  sanitized = sanitized.replace(/(?:key|token|secret|password|apikey|api_key|authorization)[=:\s]+["']?[A-Za-z0-9_\-./+]{20,}["']?/gi, '$1=[REDACTED]');
  // Bearer tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_\-./+=]{20,}/gi, 'Bearer [REDACTED]');
  // Generic long alphanumeric strings that look like keys (40+ chars)
  sanitized = sanitized.replace(/\b[A-Za-z0-9_\-]{40,}\b/g, '[REDACTED]');

  // Strip stack traces
  sanitized = sanitized.replace(/\s+at\s+.+\(.+\)/g, '');
  sanitized = sanitized.replace(/\s+at\s+.+:\d+:\d+/g, '');

  return sanitized;
}

/**
 * MCP client logging — send messages visible to the agent.
 */
export interface McpLoggingClient {
  sendLoggingMessage(level: string, message: string): void;
}

export function sendMcpWarning(client: McpLoggingClient | undefined, message: string): void {
  if (client) {
    client.sendLoggingMessage('warning', message);
  }
}

/**
 * Optional OpenTelemetry span wrapper.
 * Returns a no-op if OTel is not configured.
 */
export interface SpanAttributes {
  action: string;
  mailbox?: string;
  provider?: string;
  duration_ms?: number;
  status?: 'ok' | 'error';
}

export interface OTelSpan {
  setAttributes(attrs: SpanAttributes): void;
  end(): void;
}

export function createSpan(name: string, enabled: boolean): OTelSpan {
  if (!enabled) {
    return { setAttributes: () => {}, end: () => {} };
  }

  const startTime = Date.now();
  let attrs: SpanAttributes | null = null;

  return {
    setAttributes(a: SpanAttributes) {
      attrs = a;
      if (attrs.duration_ms === undefined) {
        attrs.duration_ms = Date.now() - startTime;
      }
    },
    end() {
      // In a real implementation, this would send to the OTel collector
      if (attrs) {
        console.error(JSON.stringify({ type: 'otel_span', name, ...attrs }));
      }
    },
  };
}
