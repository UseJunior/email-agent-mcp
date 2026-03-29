import { describe, it, expect } from 'vitest';
import { isPlausibleMessageId, checkReplyThreading } from './reply-validation.js';

describe('security/Reply Validation', () => {
  describe('isPlausibleMessageId', () => {
    it('accepts plausible Graph ID (long base64-like)', () => {
      // Graph IDs are typically 100+ chars of base64url
      const graphId = 'AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAABal4QnWq0JTKN' +
        'gphFNphAuBwCxl8PKhqILRKqhG0nJOSQIAAAAAAEMAACxl8PKhqILRKqhG0nJOSQI';
      expect(isPlausibleMessageId(graphId)).toBe(true);
    });

    it('accepts plausible Gmail ID (16+ hex)', () => {
      expect(isPlausibleMessageId('18e1f2a3b4c5d6e7')).toBe(true);
      expect(isPlausibleMessageId('190a1b2c3d4e5f6a7b8c')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isPlausibleMessageId('')).toBe(false);
    });

    it('rejects short string', () => {
      expect(isPlausibleMessageId('ab')).toBe(false);
      expect(isPlausibleMessageId('12345')).toBe(false);
    });

    it('rejects RFC 2822 Message-ID in V1', () => {
      expect(isPlausibleMessageId('<msg-123@example.com>')).toBe(false);
    });

    it('rejects whitespace-only string', () => {
      expect(isPlausibleMessageId('   ')).toBe(false);
    });
  });

  describe('checkReplyThreading', () => {
    it('returns error for Re: subject without reply_to', () => {
      const result = checkReplyThreading('Re: Hello');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('REPLY_THREADING_HINT');
      expect(result!.recoverable).toBe(true);
    });

    it('returns error for RE: subject (case insensitive)', () => {
      const result = checkReplyThreading('RE: Hello');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('REPLY_THREADING_HINT');
    });

    it('returns null for Re: subject with valid reply_to', () => {
      const result = checkReplyThreading('Re: Hello', 'some-message-id');
      expect(result).toBeNull();
    });

    it('returns null for non-Re: subject without reply_to', () => {
      const result = checkReplyThreading('Hello World');
      expect(result).toBeNull();
    });

    it('returns error for Re: subject with empty reply_to', () => {
      const result = checkReplyThreading('Re: Hello', '');
      expect(result).not.toBeNull();
      expect(result!.code).toBe('REPLY_THREADING_HINT');
    });

    it('returns error for Re: subject with whitespace-only reply_to', () => {
      const result = checkReplyThreading('Re: Hello', '   ');
      expect(result).not.toBeNull();
    });
  });
});
