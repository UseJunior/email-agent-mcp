import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

describe('content/Frontmatter Parser', () => {
  it('parses valid frontmatter with all fields', () => {
    const content = `---
to: alice@example.com
cc: bob@example.com, carol@example.com
subject: Hello World
reply_to: msg-abc123
draft: true
---
This is the body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter!.to).toBe('alice@example.com');
    expect(result.frontmatter!.cc).toEqual(['bob@example.com', 'carol@example.com']);
    expect(result.frontmatter!.subject).toBe('Hello World');
    expect(result.frontmatter!.reply_to).toBe('msg-abc123');
    expect(result.frontmatter!.draft).toBe(true);
    expect(result.body).toBe('This is the body.');
  });

  it('parses partial frontmatter (only some fields)', () => {
    const content = `---
to: alice@example.com
subject: Just a subject
---
Body here.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter!.to).toBe('alice@example.com');
    expect(result.frontmatter!.subject).toBe('Just a subject');
    expect(result.frontmatter!.cc).toBeUndefined();
    expect(result.frontmatter!.reply_to).toBeUndefined();
    expect(result.frontmatter!.draft).toBeUndefined();
    expect(result.body).toBe('Body here.');
  });

  it('returns no frontmatter when file has none', () => {
    const content = '# Hello\n\nThis is just content.';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeUndefined();
    expect(result.body).toBe(content);
  });

  it('treats unclosed frontmatter as no frontmatter', () => {
    const content = '---\nto: alice@example.com\nThis has no closing delimiter.';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeUndefined();
    expect(result.body).toBe(content);
  });

  it('parses comma-separated to field into array', () => {
    const content = `---
to: alice@a.com, bob@b.com, carol@c.com
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter!.to).toEqual(['alice@a.com', 'bob@b.com', 'carol@c.com']);
  });

  it('parses draft: false as boolean false', () => {
    const content = `---
to: alice@example.com
draft: false
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter!.draft).toBe(false);
  });

  it('ignores unknown keys', () => {
    const content = `---
to: alice@example.com
status: sent
created: 2024-01-01
priority: high
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter!.to).toBe('alice@example.com');
    expect(result.frontmatter).not.toHaveProperty('status');
    expect(result.frontmatter).not.toHaveProperty('created');
    expect(result.frontmatter).not.toHaveProperty('priority');
  });

  it('handles subjects with colons', () => {
    const content = `---
subject: Re: Meeting at 3:00pm
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter!.subject).toBe('Re: Meeting at 3:00pm');
  });

  it('handles CRLF line endings', () => {
    const content = '---\r\nto: alice@example.com\r\nsubject: Test\r\n---\r\nBody.';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter!.to).toBe('alice@example.com');
    expect(result.frontmatter!.subject).toBe('Test');
    expect(result.body).toBe('Body.');
  });

  it('strips surrounding quotes from values', () => {
    const content = `---
subject: "Re: Important"
to: 'alice@example.com'
---
Body.`;

    const result = parseFrontmatter(content);
    expect(result.frontmatter!.subject).toBe('Re: Important');
    expect(result.frontmatter!.to).toBe('alice@example.com');
  });
});
