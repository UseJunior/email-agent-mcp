// Content engine — HTML to token-efficient markdown transformation
import type { EmailAttachment } from '../types.js';

/**
 * Convert HTML email body to token-efficient markdown.
 * Strips tracking pixels, CSS, scripts, hidden elements.
 * Preserves tables, lists, and links.
 */
export function htmlToMarkdown(html: string): string {
  let result = html;

  // Remove scripts and style blocks
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Remove tracking pixels (1x1 images)
  result = result.replace(/<img[^>]*(?:width\s*=\s*["']?1["']?\s+height\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?\s+width\s*=\s*["']?1["']?)[^>]*\/?>/gi, '');

  // Remove hidden elements
  result = result.replace(/<[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/[^>]+>/gi, '');
  result = result.replace(/<[^>]*visibility\s*:\s*hidden[^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  // Convert tables to markdown
  result = convertTablesToMarkdown(result);

  // Convert headers
  result = result.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  result = result.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  result = result.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');

  // Convert links
  result = result.replace(/<a[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Convert lists
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  result = result.replace(/<\/?[uo]l[^>]*>/gi, '\n');

  // Convert bold/strong
  result = result.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**');

  // Convert italic/em
  result = result.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*');

  // Convert line breaks and paragraphs
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<\/p>/gi, '\n\n');
  result = result.replace(/<p[^>]*>/gi, '');

  // Convert blockquote
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content: string) => {
    return content.split('\n').map((line: string) => `> ${line}`).join('\n');
  });

  // Strip remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  result = decodeHtmlEntities(result);

  // Normalize whitespace
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.trim();

  return result;
}

function convertTablesToMarkdown(html: string): string {
  return html.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, tableContent: string) => {
    const rows: string[][] = [];

    // Extract rows
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableContent)) !== null) {
      const cells: string[] = [];
      const cellRegex = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1]!)) !== null) {
        cells.push(cellMatch[1]!.replace(/<[^>]+>/g, '').trim());
      }
      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    if (rows.length === 0) return '';

    // Build markdown table
    const maxCols = Math.max(...rows.map(r => r.length));
    const lines: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      // Pad to max columns
      while (row.length < maxCols) row.push('');
      lines.push('| ' + row.join(' | ') + ' |');

      // Add separator after first row (header)
      if (i === 0) {
        lines.push('| ' + row.map(() => '---').join(' | ') + ' |');
      }
    }

    return '\n' + lines.join('\n') + '\n';
  });
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)));
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
