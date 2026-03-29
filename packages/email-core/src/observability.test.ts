import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, sanitizeError, sendMcpWarning, createSpan } from './observability.js';
import { recordActionMetric, getMetrics, resetMetrics } from './actions/status.js';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('observability/Log Destination', () => {
  it('Scenario: MCP mode logging', () => {
    const logger = createLogger({ mode: 'mcp', level: 'info' });
    logger.info({ action: 'list_emails', mailbox: 'work' });

    // THEN all logs go to stderr in structured JSON format
    expect(console.error).toHaveBeenCalled();
    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.level).toBe('info');
    expect(parsed.action).toBe('list_emails');
    expect(parsed.ts).toBeDefined();
  });

  it('Scenario: CLI mode logging', () => {
    const logger = createLogger({ mode: 'cli', level: 'info' });
    logger.info({ action: 'list_emails', mailbox: 'work' });

    // THEN logs go to stderr in human-readable format
    expect(console.error).toHaveBeenCalled();
    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(output).toContain('[INFO]');
    expect(output).toContain('list_emails');
  });
});

describe('observability/Structured Log Format', () => {
  it('Scenario: Action log entry', () => {
    const logger = createLogger({ mode: 'mcp', level: 'info' });
    logger.info({ action: 'list_emails', mailbox: 'work', duration_ms: 234 });

    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.ts).toBeDefined();
    expect(parsed.level).toBe('info');
    expect(parsed.action).toBe('list_emails');
    expect(parsed.mailbox).toBe('work');
    expect(parsed.duration_ms).toBe(234);
  });
});

describe('observability/Log Levels', () => {
  it('Scenario: Debug level', () => {
    const logger = createLogger({ mode: 'mcp', level: 'debug' });
    expect(logger.getLevel()).toBe('debug');

    logger.debug({ action: 'list_emails', mailbox: 'work' });
    // Debug messages are logged when level is debug
    expect(console.error).toHaveBeenCalled();

    // Info level logger suppresses debug
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoLogger = createLogger({ mode: 'mcp', level: 'info' });
    infoLogger.debug({ action: 'list_emails' });
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('observability/MCP Client Logging', () => {
  it('Scenario: Allowlist warning', () => {
    const mockClient = { sendLoggingMessage: vi.fn() };

    sendMcpWarning(mockClient, 'Outbound email disabled — configure send allowlist');

    expect(mockClient.sendLoggingMessage).toHaveBeenCalledWith(
      'warning',
      'Outbound email disabled — configure send allowlist',
    );
  });
});

describe('observability/Error Sanitization', () => {
  it('Scenario: API key in error', () => {
    const errorMsg = 'Authentication failed: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsIng1dCI6Ik1uQ19WWoNr';
    const sanitized = sanitizeError(errorMsg);

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsIng1dCI6Ik1uQ19WWoNr');
  });

  it('Scenario: File path in error', () => {
    const errorMsg = 'Failed to read config: /Users/testuser/.config/credentials.json not found';
    const sanitized = sanitizeError(errorMsg);

    expect(sanitized).toContain('[PATH]');
    expect(sanitized).not.toContain('/Users/testuser');
  });
});

describe('observability/Optional OpenTelemetry', () => {
  it('Scenario: OTel span', () => {
    const span = createSpan('read_email', true);
    span.setAttributes({
      action: 'read_email',
      mailbox: 'work',
      provider: 'microsoft',
      status: 'ok',
    });
    span.end();

    // Verify span was created and logged
    expect(console.error).toHaveBeenCalled();
    const output = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.type).toBe('otel_span');
    expect(parsed.action).toBe('read_email');
    expect(parsed.mailbox).toBe('work');
    expect(parsed.provider).toBe('microsoft');
    expect(parsed.duration_ms).toBeDefined();
  });
});

describe('observability/Metrics', () => {
  it('Scenario: Metrics in status', () => {
    resetMetrics();

    // Simulate some actions
    recordActionMetric(100, false);
    recordActionMetric(200, false);
    recordActionMetric(300, true);

    const metrics = getMetrics();
    expect(metrics.actions_total).toBe(3);
    expect(metrics.errors_total).toBe(1);
    expect(metrics.avg_latency_ms).toBe(200); // (100+200+300)/3
  });
});
