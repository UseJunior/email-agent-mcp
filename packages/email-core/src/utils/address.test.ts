import { describe, it, expect } from 'vitest';
import { parseAddressString, parseAddressList } from './address.js';

describe('parseAddressString — positive cases', () => {
  it('parses a bare email', () => {
    expect(parseAddressString('jane@example.com')).toEqual({ email: 'jane@example.com' });
  });

  it('trims surrounding whitespace on bare email', () => {
    expect(parseAddressString('  jane@example.com  ')).toEqual({ email: 'jane@example.com' });
  });

  it('parses name-address form', () => {
    expect(parseAddressString('Jane Doe <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
  });

  it('parses quoted display name with comma', () => {
    expect(parseAddressString('"Doe, Jane" <jane@example.com>')).toEqual({
      name: 'Doe, Jane',
      email: 'jane@example.com',
    });
  });

  it('parses angle-only form (empty display name) without a name field', () => {
    expect(parseAddressString('<jane@example.com>')).toEqual({ email: 'jane@example.com' });
  });

  it('tolerates inner whitespace around the angle brackets', () => {
    expect(parseAddressString('Jane Doe   <  jane@example.com  >')).toEqual({
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
  });

  it('parses Unicode display names', () => {
    expect(parseAddressString('山田太郎 <yamada@example.jp>')).toEqual({
      name: '山田太郎',
      email: 'yamada@example.jp',
    });
  });
});

describe('parseAddressString — negative cases', () => {
  it.each([
    ['empty string', ''],
    ['plain text', 'not an email'],
    ['only angle brackets', '<@>'],
    ['stray angle bracket', 'foo<bar'],
    ['space-separated double email', 'a@b c@d'],
    ['multi-address single string (comma)', 'Alice <a@example.com>, Bob <b@example.com>'],
    ['multiple angle pairs', 'Name <one@x.com> <two@x.com>'],
    ['unmatched outer quote', '"unbalanced <jane@example.com>'],
    ['name with stray <', 'Bad < Name <jane@example.com>'],
    ['no @ in bare', 'jane.example.com'],
  ])('rejects %s', (_label, value) => {
    expect(() => parseAddressString(value)).toThrow();
  });
});

describe('parseAddressList', () => {
  it('returns ok with empty array for undefined input', () => {
    expect(parseAddressList(undefined, 'cc')).toEqual({ ok: true, addresses: [] });
  });

  it('returns ok with parsed addresses', () => {
    const result = parseAddressList(
      ['jane@example.com', 'Bob <bob@example.com>'],
      'to',
    );
    expect(result).toEqual({
      ok: true,
      addresses: [
        { email: 'jane@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ],
    });
  });

  it('returns offender (field, index, value) on first invalid entry', () => {
    const result = parseAddressList(
      ['jane@example.com', 'not an email', 'bob@example.com'],
      'cc',
    );
    expect(result).toEqual({ ok: false, field: 'cc', index: 1, value: 'not an email' });
  });

  it('returns the first offender when multiple are invalid', () => {
    const result = parseAddressList(['bad-1', 'bad-2'], 'to');
    expect(result).toEqual({ ok: false, field: 'to', index: 0, value: 'bad-1' });
  });
});
