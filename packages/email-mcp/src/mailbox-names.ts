// Mailbox name rules shared by `setup` and `mailbox rename`.
//
// A mailbox name (alias) is a selector: tools accept either a mailbox's name
// or its email address. Names must therefore be unique across ALL providers,
// and must not equal the email address of a different mailbox, or a selector
// would resolve ambiguously.

export interface MailboxNameEntry {
  provider: 'microsoft' | 'gmail';
  mailboxName: string;
  emailAddress?: string;
}

const MAX_ALIAS_LENGTH = 64;
const MAX_EMAIL_LENGTH = 254;
const MAILBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9._+@-]*$/i;

export function normalizeMailboxName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Validate a mailbox name a user is choosing. Returns an error message, or
 * undefined when the name is acceptable. An email-shaped name is accepted
 * only when it is the mailbox's own address (`ownEmailAddress`).
 */
export function validateMailboxName(name: string, ownEmailAddress?: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Mailbox name must not be empty.';
  if (trimmed.includes('@')) {
    if (!ownEmailAddress || normalizeMailboxName(trimmed) !== normalizeMailboxName(ownEmailAddress)) {
      return `Mailbox name "${trimmed}" looks like an email address. Use the account's own address or a plain name such as "work".`;
    }
    return trimmed.length > MAX_EMAIL_LENGTH ? 'Mailbox name is too long.' : undefined;
  }
  if (trimmed.length > MAX_ALIAS_LENGTH) {
    return `Mailbox name must be at most ${MAX_ALIAS_LENGTH} characters.`;
  }
  if (!MAILBOX_NAME_PATTERN.test(trimmed)) {
    return `Mailbox name "${trimmed}" may only contain letters, digits, ".", "_", "+" and "-", and must start with a letter or digit.`;
  }
  return undefined;
}

function isSameEntry(a: MailboxNameEntry, b: MailboxNameEntry): boolean {
  if (a.provider !== b.provider) return false;
  if (a.emailAddress && b.emailAddress) {
    return normalizeMailboxName(a.emailAddress) === normalizeMailboxName(b.emailAddress);
  }
  return normalizeMailboxName(a.mailboxName) === normalizeMailboxName(b.mailboxName);
}

/**
 * Find a configured mailbox, other than `self`, whose name or email address
 * equals `name` (case-insensitive). `self` is the mailbox being named: the
 * Gmail record for the authenticated address during setup, or the mailbox
 * being renamed.
 */
export function findMailboxNameConflict(
  name: string,
  mailboxes: readonly MailboxNameEntry[],
  self?: MailboxNameEntry,
): MailboxNameEntry | undefined {
  const target = normalizeMailboxName(name);
  return mailboxes.find(mailbox => {
    if (self && isSameEntry(mailbox, self)) return false;
    if (normalizeMailboxName(mailbox.mailboxName) === target) return true;
    return mailbox.emailAddress !== undefined && normalizeMailboxName(mailbox.emailAddress) === target;
  });
}

export function describeMailbox(mailbox: MailboxNameEntry): string {
  const provider = mailbox.provider === 'gmail' ? 'Gmail' : 'Microsoft';
  return mailbox.emailAddress
    ? `the ${provider} mailbox "${mailbox.mailboxName}" (${mailbox.emailAddress})`
    : `the ${provider} mailbox "${mailbox.mailboxName}"`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive a plain mailbox name from an email address: the local part plus the
 * domain without its top-level label, e.g. `jane@example.com` → `jane-example`.
 */
export function deriveMailboxName(emailAddress: string): string {
  const [localPart = '', domain = ''] = emailAddress.trim().toLowerCase().split('@');
  const labels = domain.split('.').filter(Boolean);
  const domainPart = labels.length > 1 ? labels.slice(0, -1).join('-') : labels.join('-');
  const derived = slug([localPart, domainPart].filter(Boolean).join('-')).slice(0, MAX_ALIAS_LENGTH - 4);
  return derived.replace(/-+$/, '') || 'mailbox';
}

/**
 * Suggest a derived mailbox name for `emailAddress` that does not collide with
 * any configured mailbox on any provider (`-2`, `-3`, ... suffixes as needed).
 */
export function suggestMailboxName(
  emailAddress: string,
  mailboxes: readonly MailboxNameEntry[],
  self?: MailboxNameEntry,
  isOtherwiseTaken: (name: string) => boolean = () => false,
): string {
  const taken = (name: string) => Boolean(findMailboxNameConflict(name, mailboxes, self)) || isOtherwiseTaken(name);
  const base = deriveMailboxName(emailAddress);
  if (!taken(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Token filename stems (lowercased, without `.json`) mapped to the email address stored in each file. */
export type TokenFileStems = ReadonlyMap<string, string | undefined>;

/**
 * Legacy lookups still accept a token filename stem as a selector, so a name
 * must not equal the stem of a file that belongs to a different account.
 * Returns the conflicting stem, or undefined.
 */
export function findTokenStemConflict(
  name: string,
  stems: TokenFileStems,
  ownEmailAddress?: string,
): string | undefined {
  const key = normalizeMailboxName(name);
  if (!stems.has(key)) return undefined;
  const owner = stems.get(key);
  if (owner && ownEmailAddress && normalizeMailboxName(owner) === normalizeMailboxName(ownEmailAddress)) {
    return undefined;
  }
  return key;
}
