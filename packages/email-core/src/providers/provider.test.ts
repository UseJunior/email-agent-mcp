import { describe, it, expect, vi } from 'vitest';
import { MockEmailProvider } from '../testing/mock-provider.js';
import {
  normalizeProviderError,
  ProviderError,
  withRetry,
  withAutoRefresh,
  discoverProviders,
  type AuthManager,
  type EmailProvider,
} from './provider.js';

describe('provider-interface/Capability Interfaces', () => {
  it('Scenario: Provider supports read and send', async () => {
    const provider = new MockEmailProvider();
    provider.addMessage({ id: 'msg1', subject: 'Test' });

    // Read capability works
    const messages = await provider.listMessages({ limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.subject).toBe('Test');

    // Send capability works
    const result = await provider.sendMessage({
      to: [{ email: 'alice@example.com' }],
      subject: 'Hello',
      body: 'Hi there',
    });
    expect(result.success).toBe(true);

    // A provider that doesn't implement subscribe — Partial<EmailSubscriber>
    const partialProvider = {
      listMessages: provider.listMessages.bind(provider),
      getMessage: provider.getMessage.bind(provider),
      searchMessages: provider.searchMessages.bind(provider),
      getThread: provider.getThread.bind(provider),
      sendMessage: provider.sendMessage.bind(provider),
      replyToMessage: provider.replyToMessage.bind(provider),
      createDraft: provider.createDraft.bind(provider),
      sendDraft: provider.sendDraft.bind(provider),
    } satisfies EmailProvider;

    expect(partialProvider.subscribe).toBeUndefined();
    expect(partialProvider.unsubscribe).toBeUndefined();
  });

  it('Scenario: Provider honors ReplyOptions.bodyHtml', async () => {
    const provider = new MockEmailProvider();
    provider.addMessage({ id: 'msg1', subject: 'Hello', from: { email: 'sender@example.com' } });

    // replyToMessage with opts.bodyHtml — provider should preserve the HTML
    // body alongside the plain-text fallback.
    await provider.replyToMessage('msg1', 'plain fallback', {
      bodyHtml: '<p>rendered reply</p>',
    });

    const sent = provider.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.bodyHtml).toBe('<p>rendered reply</p>');
    expect(sent[0]!.body).toBe('plain fallback');
  });
});

describe('provider-interface/Provider Registration', () => {
  it('Scenario: Dynamic discovery', async () => {
    // WHEN the MCP server starts
    // THEN it discovers installed provider packages
    const providers = await discoverProviders();
    expect(Array.isArray(providers)).toBe(true);
    // In test env, provider packages aren't installed as separate deps
  });
});

describe('provider-interface/Error Normalization', () => {
  it('Scenario: Graph 429 normalized', async () => {
    const graphError = new ProviderError(
      'RATE_LIMITED',
      'Too Many Requests',
      'microsoft',
      true,
      30,
    );

    const normalized = normalizeProviderError(graphError, 'microsoft');
    expect(normalized).toEqual({
      code: 'RATE_LIMITED',
      message: 'Too Many Requests',
      provider: 'microsoft',
      recoverable: true,
      retryAfter: 30,
    });
  });
});

describe('provider-interface/Rate Limit Handling', () => {
  it('Scenario: Exponential backoff', async () => {
    let callCount = 0;

    const fn = async () => {
      callCount++;
      if (callCount <= 2) {
        throw new ProviderError('RATE_LIMITED', 'Too Many Requests', 'microsoft', true, 1);
      }
      return 'success';
    };

    const result = await withRetry(fn, { maxRetries: 3, baseDelay: 10, maxDelay: 100 });
    expect(result).toBe('success');
    expect(callCount).toBe(3);
  });
});

describe('provider-interface/Authentication Lifecycle', () => {
  it('Scenario: Token refresh', async () => {
    let tokenExpired = true;
    let refreshCalled = false;

    const authManager: AuthManager = {
      connect: vi.fn(),
      refresh: vi.fn(async () => {
        refreshCalled = true;
        tokenExpired = false;
      }),
      disconnect: vi.fn(),
      isTokenExpired: () => tokenExpired,
    };

    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount === 1 && tokenExpired) {
        throw new Error('Token expired');
      }
      return 'data';
    };

    const result = await withAutoRefresh(authManager, fn);
    expect(result).toBe('data');
    expect(refreshCalled).toBe(true);
    expect(callCount).toBe(2);
  });
});
