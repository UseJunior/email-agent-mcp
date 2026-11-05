// Detect HTML that Outlook's compose editor reorders (issue #227).
//
// When a message is opened for editing, Outlook's editor hoists any content
// that follows a nested `<ul>`/`<ol>` inside the same `<li>` to *above* that
// nested list, and saves it in that order. Graph stores and returns the HTML
// as sent, so nothing server-side reveals the problem until a recipient (or
// the sender, editing a draft) opens it in Outlook.
//
// Caller-supplied HTML (`format: "html"`) is never rewritten; this check lets
// the compose actions return a warning instead. It runs on a real HTML parser
// (node-html-parser, already in the tree through node-html-markdown) so
// implicit `</li>` closes, wrapper `<div>`s, and attribute-laden tags are read
// the way a browser would read them, not by regex.

import { parse, NodeType } from 'node-html-parser';
import type { HTMLElement, Node } from 'node-html-parser';

/** Elements that carry content even with no text inside them. */
const CONTENT_ELEMENTS = new Set(['img', 'hr', 'table', 'iframe', 'video', 'audio', 'object', 'embed', 'svg', 'input']);
const LIST_TAGS = new Set(['ul', 'ol']);
/** Elements whose boundaries separate words in the snippet; inline ones do not. */
const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'span', 'font', 'code', 'sub', 'sup', 'small', 'mark']);

const SNIPPET_LENGTH = 60;

function tagOf(node: Node): string {
  return node.nodeType === NodeType.ELEMENT_NODE ? (node as HTMLElement).rawTagName?.toLowerCase() ?? '' : '';
}

/** Non-breaking spaces count as blank: they are what editors leave behind in empty lines. */
function isBlank(text: string): boolean {
  return text.replace(/[\s ]+/g, '') === '';
}

/** True when a node would show something a reader can see — text, an image, a rule, a table. */
function hasVisibleContent(node: Node): boolean {
  if (node.nodeType === NodeType.TEXT_NODE) return !isBlank(node.text);
  if (node.nodeType !== NodeType.ELEMENT_NODE) return false;
  const tag = tagOf(node);
  if (tag === 'br') return false;
  if (CONTENT_ELEMENTS.has(tag)) return true;
  if (!isBlank(node.text)) return true;
  return node.childNodes.some(hasVisibleContent);
}

/** The nearest `<li>` that contains `node`, or null. */
function enclosingItem(node: Node): HTMLElement | null {
  let current = node.parentNode;
  while (current) {
    if (tagOf(current) === 'li') return current;
    current = current.parentNode;
  }
  return null;
}

/**
 * True when something visible follows `list` inside `item` — a later sibling
 * of the list, or of any wrapper between the list and the `<li>`.
 */
function contentFollows(list: HTMLElement, item: HTMLElement): boolean {
  let node: Node = list;
  while (node !== item) {
    const parent: HTMLElement | null = node.parentNode;
    if (!parent) return false;
    const siblings = parent.childNodes;
    for (let k = siblings.indexOf(node) + 1; k < siblings.length; k++) {
      if (hasVisibleContent(siblings[k]!)) return true;
    }
    node = parent;
  }
  return false;
}

/** The item's own text before its first nested list, collapsed and shortened. */
function itemSnippet(item: HTMLElement): string {
  let text = '';
  // Depth-first, stopping at the first nested list wherever it sits.
  const walk = (node: Node): boolean => {
    for (const child of node.childNodes) {
      if (LIST_TAGS.has(tagOf(child))) return true;
      if (child.nodeType === NodeType.TEXT_NODE) text += child.text;
      else if (child.nodeType === NodeType.ELEMENT_NODE) {
        const gap = INLINE_TAGS.has(tagOf(child)) ? '' : ' ';
        text += gap;
        if (walk(child)) return true;
        text += gap;
      }
    }
    return false;
  };
  walk(item);
  const collapsed = text.replace(/[\s ]+/g, ' ').trim();
  return collapsed.length > SNIPPET_LENGTH ? `${collapsed.slice(0, SNIPPET_LENGTH - 1)}…` : collapsed;
}

/**
 * The list items in `html` that hold a nested list followed by more content
 * inside the same `<li>` — the shape Outlook's editor reorders. Returns one
 * short snippet of each such item's lead-in text, in document order. A nested
 * list that is the last thing in its item is not a hazard, and neither is
 * Outlook's own shape (a `<ul>` directly inside an `<ol>`, outside any `<li>`).
 */
export function findNestedListReorderHazards(html: string): string[] {
  // Cheap pre-check: no list markup, nothing to parse.
  if (!/<(?:ul|ol)[\s>/]/i.test(html) || !/<li[\s>/]/i.test(html)) return [];

  const root = parse(html, { comment: false });
  const hazards: string[] = [];
  const flagged = new Set<HTMLElement>();
  for (const list of root.querySelectorAll('ul, ol')) {
    const item = enclosingItem(list);
    if (!item || flagged.has(item)) continue;
    if (contentFollows(list, item)) {
      flagged.add(item);
      hazards.push(itemSnippet(item));
    }
  }
  return hazards;
}
