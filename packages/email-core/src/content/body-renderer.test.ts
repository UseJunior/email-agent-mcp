import { describe, it, expect } from 'vitest';
import { renderEmailBody } from './body-renderer.js';

describe('renderEmailBody', () => {
  describe('markdown (default)', () => {
    it('renders headings and keeps raw source in body', () => {
      const { bodyHtml, body } = renderEmailBody('### Morning Brief');
      expect(body).toBe('### Morning Brief');
      expect(bodyHtml).toContain('<h3>Morning Brief</h3>');
    });

    it('renders bold and italic', () => {
      const { bodyHtml } = renderEmailBody('**bold** and *italic*');
      expect(bodyHtml).toContain('<strong>bold</strong>');
      expect(bodyHtml).toContain('<em>italic</em>');
    });

    it('turns single newlines into <br> (breaks: true)', () => {
      const { bodyHtml } = renderEmailBody('line1\nline2');
      expect(bodyHtml).toMatch(/line1<br\s*\/?>\s*line2/);
    });

    it('renders bullet lists', () => {
      const { bodyHtml } = renderEmailBody('- one\n- two\n- three');
      expect(bodyHtml).toContain('<ul>');
      expect(bodyHtml).toContain('<li>one</li>');
      expect(bodyHtml).toContain('<li>three</li>');
    });

    it('renders GFM tables', () => {
      const md = '| a | b |\n| - | - |\n| 1 | 2 |';
      const { bodyHtml } = renderEmailBody(md);
      expect(bodyHtml).toContain('<table>');
      expect(bodyHtml).toContain('<th>a</th>');
      expect(bodyHtml).toContain('<td>1</td>');
    });

    it('passes raw HTML through unchanged', () => {
      const { bodyHtml } = renderEmailBody('Hi <a href="https://example.com">link</a>');
      expect(bodyHtml).toContain('<a href="https://example.com">link</a>');
    });

    it('wraps output in force-black div by default', () => {
      const { bodyHtml } = renderEmailBody('plain paragraph');
      expect(bodyHtml).toMatch(/^<div style="color: #000000;">/);
      expect(bodyHtml).toMatch(/<\/div>$/);
    });

    it('honors forceBlack: false', () => {
      const { bodyHtml } = renderEmailBody('plain paragraph', { forceBlack: false });
      expect(bodyHtml).not.toContain('<div style="color: #000000;">');
    });
  });

  describe('html format', () => {
    it('passes HTML through without marked', () => {
      const input = '<h1>Already HTML</h1>';
      const { bodyHtml } = renderEmailBody(input, { format: 'html' });
      // Should contain the input verbatim inside the force-black wrapper
      expect(bodyHtml).toContain(input);
      expect(bodyHtml).toContain('<div style="color: #000000;">');
    });

    it('does not wrap when forceBlack is false', () => {
      const input = '<p>raw</p>';
      const { bodyHtml } = renderEmailBody(input, { format: 'html', forceBlack: false });
      expect(bodyHtml).toBe(input);
    });
  });

  describe('text format', () => {
    it('returns body only, no bodyHtml', () => {
      const { body, bodyHtml } = renderEmailBody('plain\ntext\nhere', { format: 'text' });
      expect(body).toBe('plain\ntext\nhere');
      expect(bodyHtml).toBeUndefined();
    });

    it('ignores forceBlack', () => {
      const { body, bodyHtml } = renderEmailBody('x', { format: 'text', forceBlack: true });
      expect(body).toBe('x');
      expect(bodyHtml).toBeUndefined();
    });
  });
});
