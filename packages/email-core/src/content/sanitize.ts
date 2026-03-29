// Content engine — HTML to token-efficient markdown transformation
import { NodeHtmlMarkdown, PostProcessResult } from 'node-html-markdown';
import type { EmailAttachment } from '../types.js';

// --- Helpers for image filtering and markdown escaping ---

function isTrackingPixel(width: string | null, height: string | null, style: string): boolean {
  const w = width?.trim();
  const h = height?.trim();

  // Attribute-based: 0x0 or 1x1
  if ((w === '0' || w === '1') && (h === '0' || h === '1')) return true;

  // CSS-based: width:0/1px AND height:0/1px (word boundaries to avoid 11px, max-width, etc.)
  const hasSmallWidth = /\bwidth:\s*[01]px\b/i.test(style) && !/\b(?:max|min)-width/i.test(style);
  const hasSmallHeight = /\bheight:\s*[01]px\b/i.test(style) && !/\b(?:max|min)-height/i.test(style);
  if (hasSmallWidth && hasSmallHeight) return true;

  // Mixed: attribute width + CSS height or vice versa
  if ((w === '0' || w === '1') && hasSmallHeight) return true;
  if ((h === '0' || h === '1') && hasSmallWidth) return true;

  return false;
}

function isHidden(node: any): boolean {
  const style = String(node.getAttribute?.('style') ?? '');
  return (
    /\bdisplay:\s*none\b/i.test(style) ||
    /\bvisibility:\s*hidden\b/i.test(style) ||
    /\bmso-hide:\s*all\b/i.test(style) ||
    node.hasAttribute?.('hidden') === true ||
    String(node.getAttribute?.('aria-hidden') ?? '') === 'true'
  );
}

function escapeAlt(alt: string): string {
  return alt.replace(/[\[\]\\]/g, '\\$&');
}

function escapeUrl(url: string): string {
  if (/[\s()]/.test(url)) return `<${url}>`;
  return url;
}

// --- Configure NodeHtmlMarkdown instance ---

const nhm = new NodeHtmlMarkdown(
  {
    keepDataImages: false,
    maxConsecutiveNewlines: 2,
    bulletMarker: '-',
    useInlineLinks: false,
  },
  // Custom translators passed via constructor (applied to main translators collection)
  {
    // Custom img: strip trackers/hidden, preserve legitimate images with escaping
    'img': ({ node, options }: any) => {
      const src = String(node.getAttribute('src') ?? '');
      const style = String(node.getAttribute('style') ?? '');
      const width = node.getAttribute('width') ?? null;
      const height = node.getAttribute('height') ?? null;

      // Strip tracking pixels
      if (isTrackingPixel(width, height, style)) return { ignore: true };

      // Strip hidden images
      if (isHidden(node)) return { ignore: true };

      // Strip data: URIs (also handled by keepDataImages, but be explicit)
      if (!src || (!options.keepDataImages && /^data:/i.test(src))) return { ignore: true };

      // Surviving image → generate markdown with escaping
      const alt = escapeAlt(String(node.getAttribute('alt') ?? ''));
      const title = String(node.getAttribute('title') ?? '');
      const escapedSrc = escapeUrl(src);
      return {
        content: `![${alt}](${escapedSrc}${title ? ` "${title}"` : ''})`,
        recurse: false,
      };
    },

    // Custom link: clean up empty anchors after child image stripping
    'a': {
      postprocess: ({ content }) => {
        if (!content.trim()) return PostProcessResult.RemoveNode;
        return content;
      },
    },
  },
);

// Hidden element translator (factory-style: returns { ignore: true } to skip recursion)
const hiddenElementTranslator = (ctx: { node: { getAttribute?: (name: string) => string | null; hasAttribute?: (name: string) => boolean } }) => {
  if (isHidden(ctx.node)) return { ignore: true };
  return {};
};

// Apply hidden element detection to non-table tags in the main translator collection.
// Table-related tags (table, tr, td, th, etc.) are NOT patched in table sub-collections
// because returning {} for non-hidden elements would override the library's table formatting.
const HIDDEN_TAGS = [
  'div', 'span', 'p', 'section', 'article',
  'header', 'footer', 'li', 'ul', 'ol',
];

for (const tag of HIDDEN_TAGS) {
  nhm.translators.set(tag, hiddenElementTranslator as any);
}

// Also handle hidden tables/rows at the top level (main translators only)
const TABLE_HIDDEN_TAGS = ['table', 'tbody', 'thead', 'tfoot', 'tr', 'th', 'td'];
for (const tag of TABLE_HIDDEN_TAGS) {
  const existing = nhm.translators.get(tag);
  if (existing) {
    // Wrap the existing translator to add hidden detection
    const wrapped = (ctx: any) => {
      if (isHidden(ctx.node)) return { ignore: true };
      return typeof existing === 'function' ? existing(ctx) : existing;
    };
    nhm.translators.set(tag, wrapped as any);
  } else {
    nhm.translators.set(tag, hiddenElementTranslator as any);
  }
}

// Wrap table sub-collection translators to handle hidden rows/cells
function wrapWithHiddenCheck(collection: any, tag: string) {
  const existing = collection.get(tag);
  if (existing) {
    const wrapped = (ctx: any) => {
      if (isHidden(ctx.node)) return { ignore: true };
      return typeof existing === 'function' ? existing(ctx) : existing;
    };
    collection.set(tag, wrapped as any);
  }
}

for (const collection of [nhm.tableTranslators, nhm.tableRowTranslators, nhm.tableCellTranslators]) {
  for (const tag of TABLE_HIDDEN_TAGS) {
    wrapWithHiddenCheck(collection, tag);
  }
}

// Patch img and link translators into sub-collections (constructor only sets main translators)
const imgTranslator = nhm.translators.get('img');
const linkTranslator = nhm.translators.get('a');
if (imgTranslator) {
  for (const collection of [nhm.aTagTranslators, nhm.tableTranslators, nhm.tableRowTranslators, nhm.tableCellTranslators]) {
    collection.set('img', imgTranslator);
  }
}
if (linkTranslator) {
  for (const collection of [nhm.tableTranslators, nhm.tableRowTranslators, nhm.tableCellTranslators]) {
    collection.set('a', linkTranslator);
  }
}

/**
 * Convert HTML email body to token-efficient markdown.
 * Strips tracking pixels, data URI images, CSS, scripts, and hidden elements.
 * Preserves tables, lists, links, and non-tracking images.
 */
export function htmlToMarkdown(html: string): string {
  return nhm.translate(html);
}

/**
 * Normalize character encoding to UTF-8.
 * Handles ISO-8859-1 and other common encodings.
 */
export function normalizeEncoding(content: Buffer | string, charset?: string): string {
  if (typeof content === 'string') return content;

  const encoding = (charset ?? 'utf-8').toLowerCase().replace(/[-_]/g, '');

  if (encoding === 'utf8' || encoding === 'utf16le') {
    return content.toString(encoding === 'utf16le' ? 'utf16le' : 'utf-8');
  }

  // For ISO-8859-1 / Latin-1
  if (encoding === 'iso88591' || encoding === 'latin1') {
    return content.toString('latin1');
  }

  // Default: try utf-8
  return content.toString('utf-8');
}

/**
 * Generate inline attachment summary for email body.
 */
export function generateAttachmentSummary(attachments: EmailAttachment[]): string {
  if (attachments.length === 0) return '';

  const parts = attachments.map(att => {
    const size = formatFileSize(att.size);
    if (att.isInline) {
      return `${att.filename} (inline)`;
    }
    return `${att.filename} (${size})`;
  });

  return `Attachments: ${parts.join(', ')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Transform raw email content into token-efficient markdown.
 * Main entry point for the content engine.
 */
export function transformEmailContent(
  body: string | undefined,
  bodyHtml: string | undefined,
  attachments?: EmailAttachment[],
): string {
  let content = '';

  if (bodyHtml) {
    content = htmlToMarkdown(bodyHtml);
  } else if (body) {
    content = body;
  }

  if (attachments && attachments.length > 0) {
    const summary = generateAttachmentSummary(attachments);
    if (summary) {
      content = content ? `${content}\n\n${summary}` : summary;
    }
  }

  return content;
}
