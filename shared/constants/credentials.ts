/**
 * What counts as an acceptable password, and what happens to someone who keeps
 * guessing.
 *
 * One place, because the rule used to live in three: account creation,
 * administrator reset and self-service change each enforced "at least eight
 * characters" separately, which is how `password` came to be an acceptable
 * password for a laboratory quality record (validation finding VF-19).
 *
 * The rule below is deliberately not a maze of character-class requirements.
 * Length does most of the work; the rest is about refusing the handful of
 * choices people actually make when they are in a hurry — the word "password",
 * the laboratory's own name, a row of the keyboard, their own username.
 *
 * Shared with the client so the sign-up and change-password screens can say
 * what is wrong before the request is sent, and the server can refuse it again
 * when it arrives.
 */

/** Shortest password the system will accept. */
export const MIN_PASSWORD_LENGTH = 12;

/** Longest, so a pasted file cannot become a denial-of-service in bcrypt. */
export const MAX_PASSWORD_LENGTH = 200;

/**
 * How many recent passwords an account may not reuse. Enforced on change and
 * on administrator reset alike.
 */
export const PASSWORD_HISTORY_DEPTH = 5;

/** Failed attempts before an account is locked. */
export const MAX_FAILED_ATTEMPTS = 5;

/** How long the lock lasts, in minutes. */
export const LOCKOUT_MINUTES = 15;

/**
 * A session dies after this long without a request, however much of its
 * absolute lifetime is left. An unattended bench workstation is the reason.
 */
export const IDLE_TIMEOUT_MINUTES = 30;

/** Absolute session lifetime, regardless of activity. */
export const SESSION_HOURS = 12;

/**
 * Passwords nobody should be allowed to choose. Not a serious dictionary —
 * a serious one belongs behind a breach-corpus lookup — but it catches the
 * choices that actually turn up in a laboratory: the word itself, the product,
 * the facility, the keyboard.
 */
const REFUSED = [
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyuiop', 'asdfghjkl', 'letmein', 'welcome', 'admin', 'administrator',
  'changeme', 'temporary', 'temppassword', 'laboratory', 'sechlims', 'sech_lims',
  'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
];

/** Three or more of the same character in a row: "aaa", "111". */
const RUN_OF_SAME = /(.)\1{2,}/;

/** Four or more sequential characters: "abcd", "4567". */
function hasSequence(value: string): boolean {
  const lower = value.toLowerCase();
  let run = 1;
  for (let i = 1; i < lower.length; i++) {
    const step = lower.charCodeAt(i) - lower.charCodeAt(i - 1);
    if (step === 1 || step === -1) {
      run++;
      if (run >= 4) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

export interface PasswordCheck {
  ok: boolean;
  /** Ready to show to the person choosing the password. */
  error?: string;
}

/**
 * Judge a password. `username` and `fullName` are optional context — a password
 * that contains the person's own name is refused, because it is the first thing
 * anyone else would try.
 */
export function checkPassword(
  password: string,
  context: { username?: string | null; fullName?: string | null } = {},
): PasswordCheck {
  const value = String(password ?? '');

  if (!value) return { ok: false, error: 'Enter a password.' };
  if (value.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase you will remember is stronger than a short word with symbols in it.` };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `Keep it under ${MAX_PASSWORD_LENGTH} characters.` };
  }
  if (value.trim() !== value) {
    return { ok: false, error: 'Remove the space at the start or end.' };
  }

  const lower = value.toLowerCase();

  if (REFUSED.some(bad => lower === bad || lower.startsWith(bad) || lower.endsWith(bad))) {
    return { ok: false, error: 'That is one of the first passwords anyone would try. Choose something else.' };
  }
  if (RUN_OF_SAME.test(value)) {
    return { ok: false, error: 'Avoid repeating the same character three or more times in a row.' };
  }
  if (hasSequence(value)) {
    return { ok: false, error: 'Avoid runs like "abcd" or "3456".' };
  }
  if (new Set(lower).size < 5) {
    return { ok: false, error: 'Use a wider mix of characters.' };
  }

  const username = String(context.username ?? '').toLowerCase().trim();
  if (username.length >= 3 && lower.includes(username)) {
    return { ok: false, error: 'Do not put your username in your password.' };
  }
  for (const part of String(context.fullName ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      return { ok: false, error: 'Do not put your own name in your password.' };
    }
  }

  return { ok: true };
}

/**
 * The rule in a sentence, for the screen that asks for a password and for the
 * error the API returns when it refuses one.
 */
export const PASSWORD_RULE_SUMMARY =
  `At least ${MIN_PASSWORD_LENGTH} characters. Not a common password, not your name or username, ` +
  'and not a run of repeated or sequential characters. A short phrase works well.';
