import { describe, it, expect } from 'vitest';
import { renderEmailBody } from './body-renderer.js';
import { parseFrontmatter } from './frontmatter.js';

describe('content-engine/Outbound Markdown Rendering', () => {
  it('Scenario: Markdown to HTML conversion', () => {
    const md = '### Morning Brief\n\n**bold** and *italic*\n- one\n- two';
    const { bodyHtml, body } = renderEmailBody(md);

    // Rendered via GFM semantics
    expect(bodyHtml).toContain('<h3>Morning Brief</h3>');
    expect(bodyHtml).toContain('<strong>bold</strong>');
    expect(bodyHtml).toContain('<em>italic</em>');
    expect(bodyHtml).toContain('<li>one</li>');

    // Raw source preserved in body for plain-text fallback
    expect(body).toBe(md);
  });

  it('Scenario: HTML passthrough', () => {
    const input = '<h1>Already HTML</h1>';
    const { bodyHtml } = renderEmailBody(input, { format: 'html' });
    // Returned verbatim inside the force-black wrapper
    expect(bodyHtml).toContain(input);
    expect(bodyHtml).toContain('<div style="color: #000000;">');
  });

  it('Scenario: Text mode skips rendering', () => {
    const { body, bodyHtml } = renderEmailBody('plain\ntext\nhere', { format: 'text' });
    expect(body).toBe('plain\ntext\nhere');
    expect(bodyHtml).toBeUndefined();
  });

  it('Scenario: Force-black dark-mode wrapper', () => {
    const { bodyHtml } = renderEmailBody('plain paragraph');
    expect(bodyHtml).toMatch(/^<div style="color: #000000;">/);
    expect(bodyHtml).toMatch(/<\/div>$/);
  });

  it('Scenario: Force-black opt-out', () => {
    const { bodyHtml } = renderEmailBody('plain paragraph', { forceBlack: false });
    expect(bodyHtml).not.toContain('<div style="color: #000000;">');
  });

  it('Scenario: Raw HTML embedded in markdown is preserved', () => {
    const { bodyHtml } = renderEmailBody('Hi <a href="https://example.com">link</a>');
    expect(bodyHtml).toContain('<a href="https://example.com">link</a>');
  });

  // Additional coverage beyond the spec scenarios — GFM tables and <br> on
  // single newlines — kept so regressions on either behavior fail loudly.
  it('preserves single newlines as <br> (breaks: true)', () => {
    const { bodyHtml } = renderEmailBody('line1\nline2');
    expect(bodyHtml).toMatch(/line1<br\s*\/?>\s*line2/);
  });

  it('renders GFM tables', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |';
    const { bodyHtml } = renderEmailBody(md);
    expect(bodyHtml).toContain('<table>');
    expect(bodyHtml).toContain('<th>a</th>');
    expect(bodyHtml).toContain('<td>1</td>');
  });
});

describe('content-engine/Frontmatter Format Override', () => {
  it('Scenario: Format declared in frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\nformat: text\n---\n### Not rendered',
    );
    expect(frontmatter?.format).toBe('text');
    expect(body).toBe('### Not rendered');
  });

  it('Scenario: force_black declared in frontmatter', () => {
    const { frontmatter } = parseFrontmatter(
      '---\nforce_black: false\n---\nBody',
    );
    expect(frontmatter?.force_black).toBe(false);
  });
});
