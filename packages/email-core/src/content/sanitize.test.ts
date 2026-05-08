import { describe, it, expect } from 'vitest';
import { htmlToMarkdown, normalizeEncoding, generateAttachmentSummary, unescapeMarkdownPunctuation, transformEmailContent } from './sanitize.js';

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

    // Library may pad columns for alignment; use flexible matching
    expect(result).toMatch(/\|\s*Name\s*\|\s*Amount\s*\|/);
    expect(result).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/);
    expect(result).toMatch(/\|\s*Alice\s*\|\s*\$100\s*\|/);
    expect(result).toMatch(/\|\s*Bob\s*\|\s*\$200\s*\|/);
  });

  // --- New image preservation tests ---

  it('Scenario: Non-tracking image preserved as markdown link', () => {
    const html = '<p>See chart:</p><img src="https://example.com/chart.png" alt="Q1 Revenue"><p>End</p>';
    const result = htmlToMarkdown(html);

    expect(result).toContain('![Q1 Revenue](https://example.com/chart.png)');
    expect(result).toContain('See chart:');
  });

  it('Scenario: CID inline image preserved as markdown link', () => {
    const html = '<p>Logo:</p><img src="cid:image001"><p>End</p>';
    const result = htmlToMarkdown(html);

    expect(result).toContain('![](cid:image001)');
  });

  it('Scenario: Image with no alt text', () => {
    const html = '<img src="https://example.com/photo.jpg">';
    const result = htmlToMarkdown(html);

    expect(result).toContain('![](https://example.com/photo.jpg)');
  });

  it('Scenario: Tracking pixel via attributes stripped', () => {
    const html = '<p>Hi</p><img src="https://track.co/px" width="1" height="1"><p>Bye</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
    expect(result).toContain('Hi');
    expect(result).toContain('Bye');
  });

  it('Scenario: Tracking pixel with interleaved attributes', () => {
    const html = '<img height="1" src="https://track.co/px" width="1">';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
  });

  it('Scenario: Tracking pixel via inline CSS stripped', () => {
    const html = '<img src="https://track.co/px" style="width:1px;height:1px">';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
  });

  it('Scenario: Tracking pixel mixed attribute and CSS', () => {
    const html = '<img src="https://track.co/px" width="1" style="height:1px">';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
  });

  it('Scenario: Zero-size tracking pixel stripped', () => {
    const html = '<img src="https://track.co/px" width="0" height="0">';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
  });

  it('Scenario: False positive guard for max-width', () => {
    const html = '<img src="https://example.com/banner.png" style="max-width:1px; height:400px" width="600" height="400">';
    const result = htmlToMarkdown(html);

    // Should NOT be stripped — max-width:1px is not the same as width:1px
    expect(result).toContain('example.com/banner.png');
  });

  it('Scenario: Hidden self-closing image stripped', () => {
    const html = '<p>Visible</p><img style="display:none" src="https://spy.com/px">';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('spy.com');
    expect(result).toContain('Visible');
  });

  it('Scenario: Hidden image with hidden attribute', () => {
    const html = '<img hidden src="https://spy.com/px"><p>Visible</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('spy.com');
    expect(result).toContain('Visible');
  });

  it('Scenario: Data URI image stripped', () => {
    const html = '<p>Before</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg"><p>After</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('data:image');
    expect(result).toContain('Before');
    expect(result).toContain('After');
  });

  it('Scenario: Mixed tracker and real image', () => {
    const html = '<img src="https://track.co/px" width="1" height="1"><img src="https://example.com/chart.png" alt="Chart">';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
    expect(result).toContain('![Chart](https://example.com/chart.png)');
  });

  it('Scenario: Image inside link preserved', () => {
    const html = '<a href="https://example.com"><img src="https://example.com/chart.png" alt="Chart"></a>';
    const result = htmlToMarkdown(html);

    // Should contain the image, not be stripped
    expect(result).toContain('Chart');
    expect(result).toContain('example.com');
  });

  it('Scenario: Tracker inside link cleaned up', () => {
    const html = '<a href="https://example.com"><img src="https://track.co/px" width="1" height="1"></a>';
    const result = htmlToMarkdown(html);

    // Should not leave an empty link like [](url)
    expect(result).not.toContain('track.co');
    expect(result).not.toMatch(/\[\s*\]\([^)]+\)/);
  });

  it('Scenario: Tracker inside link inside table cell', () => {
    const html = '<table><tr><td><a href="https://example.com"><img src="https://track.co/px" width="1" height="1"></a>Text</td></tr></table>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('track.co');
  });

  it('Scenario: Alt text with special characters', () => {
    const html = '<img src="https://example.com/x.png" alt="Revenue ] Q1 [data]">';
    const result = htmlToMarkdown(html);

    // Special chars should be escaped in the alt text
    expect(result).toContain('example.com/x.png');
    expect(result).toContain('Revenue');
  });

  it('Scenario: URL with spaces and parens', () => {
    const html = '<img src="https://example.com/a b(1).png" alt="test">';
    const result = htmlToMarkdown(html);

    // URL should be wrapped in angle brackets or encoded
    expect(result).toContain('example.com/a b(1).png');
    expect(result).toContain('test');
  });

  it('Scenario: Hidden div container stripped', () => {
    const html = '<div style="display:none">secret tracking text</div><p>Visible content</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('secret tracking text');
    expect(result).toContain('Visible content');
  });

  it('Scenario: Hidden table row stripped', () => {
    const html = '<table><tr><th>A</th></tr><tr style="display:none"><td>hidden</td></tr><tr><td>visible</td></tr></table>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('hidden');
    expect(result).toContain('visible');
  });

  it('Scenario: Script content stripped', () => {
    const html = '<script>alert("xss")</script><p>Clean content</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('alert');
    expect(result).not.toContain('xss');
    expect(result).toContain('Clean content');
  });

  it('Scenario: Style content stripped', () => {
    const html = '<style>.hidden{color:red}</style><p>Clean content</p>';
    const result = htmlToMarkdown(html);

    expect(result).not.toContain('color:red');
    expect(result).not.toContain('.hidden');
    expect(result).toContain('Clean content');
  });

  it('Scenario: Blockquote preserved', () => {
    const html = '<blockquote>Quoted text here</blockquote>';
    const result = htmlToMarkdown(html);

    expect(result).toContain('>');
    expect(result).toContain('Quoted text here');
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

describe('content-engine/Unescape Markdown Punctuation (issue #79)', () => {
  it('unescapes footnote-style refs', () => {
    expect(unescapeMarkdownPunctuation('See \\[1\\] and \\[2\\]')).toBe('See [1] and [2]');
  });

  it('unescapes URL obfuscation pattern', () => {
    expect(unescapeMarkdownPunctuation('Visit nipsco\\[.\\]com today')).toBe('Visit nipsco[.]com today');
  });

  it('unescapes bare parens in prose', () => {
    expect(unescapeMarkdownPunctuation('Note \\(important\\) detail')).toBe('Note (important) detail');
  });

  it('preserves inline links', () => {
    const md = 'See [docs](https://example.com) for info';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves inline images', () => {
    const md = '![Q1 Revenue](https://example.com/chart.png)';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves images with escaped brackets in alt text', () => {
    const md = '![Revenue \\[Q1\\]](https://example.com/x.png)';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves images with angle-bracket destinations', () => {
    const md = '![test](<https://example.com/a b(1).png>)';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves titled images with parens in title', () => {
    const md = '![x](https://example.com/x.png "Q(1) chart")';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves links with depth-1 balanced parens in URL', () => {
    const md = '[docs](https://example.com?a=(b))';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves reference-style links and definitions', () => {
    const md = 'See [docs][1] for info\n\n[1]: https://example.com';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves escapes inside inline code spans', () => {
    const md = 'Use `\\[escaped\\]` syntax';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves escapes inside fenced code blocks', () => {
    const md = 'Example:\n\n```\n\\[in fence\\]\n```\n';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('preserves links containing code spans (nested constructs)', () => {
    const md = '[`code`](https://example.com)';
    expect(unescapeMarkdownPunctuation(md)).toBe(md);
  });

  it('handles mixed escaped prose and valid links', () => {
    const md = 'See \\[1\\] at \\[example.com\\] for [docs](https://x.com)';
    expect(unescapeMarkdownPunctuation(md)).toBe(
      'See [1] at [example.com] for [docs](https://x.com)',
    );
  });

  it('end-to-end: HTML with footnote-style brackets', () => {
    const result = transformEmailContent(undefined, '<p>See [1] at nipsco[.]com</p>');
    expect(result).toContain('See [1] at nipsco[.]com');
    expect(result).not.toContain('\\[');
    expect(result).not.toContain('\\]');
  });

  it('end-to-end: plain-text body passes through unchanged', () => {
    // Plain-text bodies bypass the unescape pass — escapes typed by humans survive.
    const plain = 'Literal \\[escape\\] in plain text';
    expect(transformEmailContent(plain, undefined)).toBe(plain);
  });

  it('end-to-end: HTML with <a> tag does not introduce stray escapes', () => {
    // Note: the repo's custom <a> postprocess (sanitize.ts) flattens anchors
    // to their inner text — that's a separate pre-existing concern. This test
    // just guards that the unescape pass doesn't introduce backslash artifacts.
    const result = transformEmailContent(
      undefined,
      '<p>Read <a href="https://example.com">our docs</a> please</p>',
    );
    expect(result).toContain('our docs');
    expect(result).not.toContain('\\[');
    expect(result).not.toContain('\\]');
  });
});
