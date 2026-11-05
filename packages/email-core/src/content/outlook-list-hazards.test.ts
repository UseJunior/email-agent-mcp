import { describe, it, expect } from 'vitest';
import { findNestedListReorderHazards } from './outlook-list-hazards.js';
import { renderEmailBody } from './body-renderer.js';

// Issue #227 minimal repro, verbatim.
const REPRO_P = `<ol>
  <li>
    <p><strong>ITEM 2 lead-in.</strong> Body ending with a colon:</p>
    <ul><li>BULLET a;</li><li>BULLET b.</li></ul>
    <p>AFTER-BULLETS paragraph. It should appear below the bullets.</p>
  </li>
</ol>`;
// Variant B from the issue: <div> instead of <p>.
const REPRO_DIV = REPRO_P.replace(/<p>/g, '<div>').replace(/<\/p>/g, '</div>');

describe('email-write/Outlook Nested List Warning', () => {
  it('flags the issue #227 repro and its <div> variant', () => {
    expect(findNestedListReorderHazards(REPRO_P)).toEqual(['ITEM 2 lead-in. Body ending with a colon:']);
    expect(findNestedListReorderHazards(REPRO_DIV)).toEqual(['ITEM 2 lead-in. Body ending with a colon:']);
  });

  it('flags bare text, wrapped lists, deeper items, and implicit </li> closes', () => {
    // Bare text after the nested list.
    expect(findNestedListReorderHazards('<ul><li>lead<ul><li>x</li></ul>tail</li></ul>')).toEqual(['lead']);
    // The nested list sits in a wrapper; the content follows the wrapper.
    expect(findNestedListReorderHazards('<ol><li><div>lead<ul><li>x</li></ul></div><p>tail</p></li></ol>'))
      .toEqual(['lead']);
    // The hazard is one level down: only the inner item is flagged.
    expect(findNestedListReorderHazards(
      '<ol><li>outer<ul><li>inner<ol><li>x</li></ol><p>tail</p></li></ul></li></ol>',
    )).toEqual(['inner']);
    // Unclosed <li> tags, as hand-written HTML often has them.
    expect(findNestedListReorderHazards('<ol><li>lead<ul><li>x<li>y</ul>tail</ol>')).toEqual(['lead']);
    // An image after the nested list is content too.
    expect(findNestedListReorderHazards('<ul><li>lead<ul><li>x</li></ul><img src="cid:a"></li></ul>'))
      .toEqual(['lead']);
    // Each item is reported once, with long lead-ins shortened.
    const long = 'L'.repeat(80);
    const twice = `<ol><li>${long}<ul><li>x</li></ul>t1<ul><li>y</li></ul>t2</li></ol>`;
    const found = findNestedListReorderHazards(twice);
    expect(found).toHaveLength(1);
    expect(found[0]).toHaveLength(60);
    expect(found[0]!.endsWith('…')).toBe(true);
  });

  it('does not flag nested lists that end their item, or Outlook\'s own shape', () => {
    const clean = [
      '<ol><li><p>lead</p><ul><li>a</li><li>b</li></ul></li><li>next</li></ol>',
      // Only whitespace, <br>, &nbsp; and empty elements after the nested list.
      '<ol><li>lead<ul><li>a</li></ul>\n  <br><p>&nbsp;</p><div> </div></li></ol>',
      // Outlook's own surviving shape (issue #227): <ul> directly inside <ol>.
      '<ol><li><p>lead</p></li><ul><li>a</li></ul></ol><p style="margin:0 40px">after</p>',
      // Content before the nested list is fine.
      '<ul><li><p>one</p><p>two</p><ol><li>x</li></ol></li></ul>',
      '<p>No lists at all.</p>',
      '',
    ];
    for (const html of clean) {
      expect(findNestedListReorderHazards(html)).toEqual([]);
    }
  });

  it('finds nothing in list_style "outlook" output for the markdown repro', () => {
    const md = '1. **ITEM 2 lead-in.** Body ending with a colon:\n\n   - BULLET a;\n   - BULLET b.\n\n'
      + '   AFTER-BULLETS paragraph.\n\n2. Next\n';
    expect(findNestedListReorderHazards(renderEmailBody(md).bodyHtml!)).toEqual(['ITEM 2 lead-in. Body ending with a colon:']);
    expect(findNestedListReorderHazards(renderEmailBody(md, { listStyle: 'outlook' }).bodyHtml!)).toEqual([]);
  });
});
