// Signature stripping — heuristic-based detection of email signatures and legal disclaimers

const SIGNATURE_PATTERNS = [
  // Standard email signature delimiter (RFC 3676): "-- " followed by newline
  /^-- \r?\n/m,
  // Common "Sent from" patterns
  /^Sent from my (?:iPhone|iPad|Galaxy|Android|BlackBerry|Windows Phone)/m,
  /^Sent from (?:Mail|Outlook|Yahoo)/m,
  // Common disclaimer patterns
  /^(?:CONFIDENTIALITY|DISCLAIMER|LEGAL NOTICE|This email and any attachments)/im,
  /^This (?:message|email|e-mail) (?:is|may be) (?:intended|confidential)/im,
];

/**
 * Strip email signatures and legal disclaimers from email body content.
 * Uses heuristic-based detection for common signature patterns.
 */
export function stripSignature(body: string, opts?: { enabled?: boolean }): string {
  if (opts?.enabled === false) return body;

  // Try RFC 3676 standard delimiter first: "-- \n"
  const rfcDelimiterIndex = body.indexOf('\n-- \n');
  if (rfcDelimiterIndex !== -1) {
    return body.substring(0, rfcDelimiterIndex).trimEnd();
  }

  // Also handle when it's at the start of the string
  if (body.startsWith('-- \n')) {
    return '';
  }

  // Try other common patterns
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = pattern.exec(body);
    if (match && match.index !== undefined) {
      // Only strip if the match is in the latter half of the email
      if (match.index > body.length * 0.3) {
        return body.substring(0, match.index).trimEnd();
      }
    }
  }

  return body;
}
