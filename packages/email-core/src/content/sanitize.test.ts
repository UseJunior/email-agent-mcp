import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, normalizeEncoding, generateAttachmentSummary } from './sanitize.js';

describe('content-engine/HTML to Token-Efficient Markdown', () => {
  it('Scenario: HTML with tracking pixel', () => {
    const html = '<p>Hello world</p><img src="https://tracker.example.com/pixel.gif" width="1" height="1"><p>Goodbye</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('tracker.example.com');
    expect(result).not.toContain('<img');
    expect(result).toContain('Hello world');
    expect(result).toContain('Goodbye');
  });

  it('Scenario: Table preservation', () => {
    const html = `<table>
      <tr><th>Name</th><th>Amount</th></tr>
      <tr><td>Alice</td><td>$100</td></tr>
      <tr><td>Bob</td><td>$200</td></tr>
    </table>`;
    const result = htmlToMarkdown(html);

    expect(result).toContain('| Name | Amount |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| Alice | $100 |');
    expect(result).toContain('| Bob | $200 |');
  });
});

describe('content-engine/Encoding Handling', () => {
  it('Scenario: Non-UTF8 email', () => {
    // Create a buffer with ISO-8859-1 encoded content (é = 0xe9)
    const latin1Buffer = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0xe9]);

    const result = normalizeEncoding(latin1Buffer, 'iso-8859-1');
    expect(result).toContain('Hello');
    expect(result).toContain('é');
  });
});

describe('content-engine/Attachment Summary', () => {
  it('Scenario: Attachment list in body', () => {
    const attachments = [
      { id: '1', filename: 'contract.docx', mimeType: 'application/docx', size: 245 * 1024, isInline: false },
      { id: '2', filename: 'logo.png', mimeType: 'image/png', size: 50 * 1024, isInline: true },
      { id: '3', filename: 'data.xlsx', mimeType: 'application/xlsx', size: 1.2 * 1024 * 1024, isInline: false },
    ];

    const result = generateAttachmentSummary(attachments);
    expect(result).toContain('contract.docx (245KB)');
    expect(result).toContain('logo.png (inline)');
    expect(result).toContain('data.xlsx (1.2MB)');
    expect(result).toMatch(/^Attachments: /);
  });
});
