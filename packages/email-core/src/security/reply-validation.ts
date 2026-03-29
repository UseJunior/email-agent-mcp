// Reply threading validation — message ID plausibility and Re: subject guardrail

/**
 * Check if a string looks like a plausible provider message ID.
 * V1: Provider IDs only (Graph base64-like or Gmail hex). No RFC Message-IDs.
 */
export function isPlausibleMessageId(id: string): boolean {
  if (!id || id.trim().length < 10) return false;
  const trimmed = id.trim();

  // Gmail: 16+ hex characters
  if (/^[0-9a-f]{16,}$/i.test(trimmed)) return true;

  // Graph: long base64url-like string (typically 100+ chars with alphanumeric, -, _)
  if (trimmed.length >= 20 && /^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) return true;

  return false;
}

/**
 * Check for orphaned Re: subjects — emails that look like replies but aren't threaded.
 * Returns a structured error if the subject starts with Re: but no reply_to is provided.
 */
export function checkReplyThreading(
  subject: string,
  replyTo?: string,
): { code: string; message: string; recoverable: boolean } | null {
  if (!/^Re:/i.test(subject)) return null;
  if (replyTo && replyTo.trim().length > 0) return null;

  return {
    code: 'REPLY_THREADING_HINT',
    message: "Subject starts with 'Re:' but no reply_to message ID was provided. Either provide a reply_to ID to thread this email or remove the 'Re:' prefix to send as a new thread.",
    recoverable: true,
  };
}
