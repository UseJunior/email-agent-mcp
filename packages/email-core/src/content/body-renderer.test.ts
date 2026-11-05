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

// Issue #228: numbered items with lettered sub-paragraphs, verbatim from the issue.
const OUTLOOK_REPRO_INDENTED = `1. **Apples are the first topic.** Apples grow on trees.

   **_a. Red apples_**_._ Sweeter.

   **_b. Green apples_**_._ Sharper.

2. **Pears are the second topic.** Pears ripen after picking.

   **_a. Soft pears_**_._ Eat within a few days.

3. **Plums are the third topic.** Short season.
`;
const OUTLOOK_REPRO_UNINDENTED = OUTLOOK_REPRO_INDENTED.replace(/^ {3}/gm, '');

// Outlook's own saved shape for the repro (issue #228, "Outlook's own shape").
const OUTLOOK_REPRO_EXPECTED = [
  '<ol start="1">\n<li><p><strong>Apples are the first topic.</strong> Apples grow on trees.</p>\n</li>\n</ol>\n',
  '<p style="margin-left:80px"><strong><em>a. Red apples</em></strong><em>.</em> Sweeter.</p>\n',
  '<p style="margin-left:80px"><strong><em>b. Green apples</em></strong><em>.</em> Sharper.</p>\n',
  '<ol start="2">\n<li><p><strong>Pears are the second topic.</strong> Pears ripen after picking.</p>\n</li>\n</ol>\n',
  '<p style="margin-left:80px"><strong><em>a. Soft pears</em></strong><em>.</em> Eat within a few days.</p>\n',
  '<ol start="3">\n<li><p><strong>Plums are the third topic.</strong> Short season.</p>\n</li>\n</ol>\n',
].join('');

function outlook(md: string): string {
  return renderEmailBody(md, { listStyle: 'outlook', forceBlack: false }).bodyHtml!;
}
function standard(md: string): string {
  return renderEmailBody(md, { forceBlack: false }).bodyHtml!;
}

describe('email-write/Outlook List Style', () => {
  it("Scenario: Indented sub-paragraphs render in Outlook's split-list shape", () => {
    const html = outlook(OUTLOOK_REPRO_INDENTED);
    expect(html).toBe(OUTLOOK_REPRO_EXPECTED);
    expect([...html.matchAll(/<ol start="(\d+)">/g)].map(m => m[1])).toEqual(['1', '2', '3']);
    expect(html.match(/<p style="margin-left:80px">/g)).toHaveLength(3);
    // Each <li> holds only the item's own first paragraph.
    for (const li of html.match(/<li>[^]*?<\/li>/g)!) {
      expect(li.match(/<p[ >]/g)).toHaveLength(1);
    }
  });

  it('Scenario: Unindented sub-paragraphs render identically', () => {
    expect(outlook(OUTLOOK_REPRO_UNINDENTED)).toBe(outlook(OUTLOOK_REPRO_INDENTED));
    expect(outlook(OUTLOOK_REPRO_UNINDENTED)).toBe(OUTLOOK_REPRO_EXPECTED);
  });

  it("Scenario: A list's own start number is respected", () => {
    const html = outlook('3. Third\n\n   a. sub\n\n4. Fourth\n');
    expect(html).toBe(
      '<ol start="3">\n<li><p>Third</p>\n</li>\n</ol>\n'
      + '<p style="margin-left:80px">a. sub</p>\n'
      + '<ol start="4">\n<li><p>Fourth</p>\n</li>\n</ol>\n',
    );
    // Unindented variant with explicit continuing numbers gives the same.
    expect(outlook('3. Third\n\na. sub\n\n4. Fourth\n')).toBe(html);
  });

  it('Scenario: Lists with nothing to reshape are unchanged', () => {
    const bodies = [
      '- one\n\n  continuation of one\n\n- two\n',
      '1. one\n2. two\n3. three\n',
      '1. one\n\n2. two\n',
      '### Heading\n\nIntro line\nsecond line\n\n| a | b |\n|---|---|\n| 1 | 2 |\n',
      'Some prose.\n\n1. first\n2. second\n\nClosing prose.\n',
      '1. one\n2. two\n\nInterlude.\n\n1. restarted\n',
      '> 1. quoted\n>\n>    quoted continuation\n',
      '- [ ] task\n- [x] done\n',
      '',
    ];
    for (const md of bodies) {
      expect(outlook(md)).toBe(standard(md));
    }
  });

  it('Scenario: Items containing a nested list stay whole', () => {
    const md = '1. Parent\n\n   - child a\n   - child b\n\n   after the nested list\n\n2. Next\n';
    expect(outlook(md)).toBe(standard(md));

    // In a list that does get split, the nested-list item keeps everything in its <li>.
    const mixed = '1. Split me\n\n   a. sub\n\n2. Keep me\n\n   - child\n\n   tail\n\n3. Last\n';
    const html = outlook(mixed);
    expect(html).toContain('<p style="margin-left:80px">a. sub</p>');
    expect(html).toContain('<ol start="2">\n<li><p>Keep me</p>\n<ul>\n<li>child</li>\n</ul>\n<p>tail</p>\n</li>\n<li><p>Last</p>\n</li>\n</ol>\n');
    expect(html).not.toContain('<p style="margin-left:80px">tail</p>');

    // A tight nested-list item inside a reshaped chain keeps marked's own
    // markup — no paragraph wrapper is added to it (peer-review finding).
    const tight = '1. Parent\n   - child\n\na. bridge\n\n2. Next\n';
    const defaultItem = standard(tight).match(/<li>Parent[^]*?<\/ul>\n<\/li>/)![0];
    expect(defaultItem).toBe('<li>Parent<ul>\n<li>child</li>\n</ul>\n</li>');
    expect(outlook(tight)).toBe(
      `<ol start="1">\n${defaultItem}\n</ol>\n`
      + '<p style="margin-left:80px">a. bridge</p>\n'
      + '<ol start="2">\n<li><p>Next</p>\n</li>\n</ol>\n',
    );
  });

  it('Scenario: Closing prose and restarted lists are not indented', () => {
    const md = '1. One\n\n   a. sub\n\n2. Two\n\nThanks,\nSteven\n\n1. A new list\n\n   x. its sub\n';
    const html = outlook(md);
    expect(html).toContain('<p>Thanks,<br>Steven</p>\n');
    expect(html).not.toContain('margin-left:80px">Thanks');
    // The restarted list is its own chain, starting again at 1.
    expect([...html.matchAll(/<ol start="(\d+)">/g)].map(m => m[1])).toEqual(['1', '2', '1']);
    expect(html).toContain('<p style="margin-left:80px">x. its sub</p>');
  });

  it('Scenario: Omitting list_style leaves rendering unchanged', () => {
    // Golden string: the pre-#228 rendering of the repro, captured from main.
    const golden = '<div style="color: #000000;"><ol>\n'
      + '<li><p><strong>Apples are the first topic.</strong> Apples grow on trees.</p>\n'
      + '<p><strong><em>a. Red apples</em></strong><em>.</em> Sweeter.</p>\n'
      + '<p><strong><em>b. Green apples</em></strong><em>.</em> Sharper.</p>\n'
      + '</li>\n'
      + '<li><p><strong>Pears are the second topic.</strong> Pears ripen after picking.</p>\n'
      + '<p><strong><em>a. Soft pears</em></strong><em>.</em> Eat within a few days.</p>\n'
      + '</li>\n'
      + '<li><p><strong>Plums are the third topic.</strong> Short season.</p>\n'
      + '</li>\n'
      + '</ol>\n</div>';
    expect(renderEmailBody(OUTLOOK_REPRO_INDENTED).bodyHtml).toBe(golden);
    expect(renderEmailBody(OUTLOOK_REPRO_INDENTED, { listStyle: 'default' }).bodyHtml).toBe(golden);
  });

  it('Scenario: list_style is ignored for html and text formats', () => {
    for (const format of ['html', 'text'] as const) {
      expect(renderEmailBody(OUTLOOK_REPRO_INDENTED, { format, listStyle: 'outlook' }))
        .toEqual(renderEmailBody(OUTLOOK_REPRO_INDENTED, { format }));
    }
  });

  it('keeps the force-black wrapper around the reshaped HTML', () => {
    const { bodyHtml, body } = renderEmailBody(OUTLOOK_REPRO_INDENTED, { listStyle: 'outlook' });
    expect(bodyHtml).toBe(`<div style="color: #000000;">${OUTLOOK_REPRO_EXPECTED}</div>`);
    expect(body).toBe(OUTLOOK_REPRO_INDENTED);
  });

  it('parses list_style from frontmatter and ignores unknown values', () => {
    expect(parseFrontmatter('---\nlist_style: Outlook\n---\nBody').frontmatter?.list_style).toBe('outlook');
    expect(parseFrontmatter('---\nlist_style: fancy\n---\nBody').frontmatter).toBeUndefined();
  });
});
