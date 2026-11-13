/**
 * Primary roles and organisational positions — the two things a person is.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 * "Role" used to mean three different things at once. A row in `roles` was an
 * access profile; the same word named a bench grade on the staff register
 * (`staff.designation`, free text, typed differently by everybody); and the
 * same word again named a post on the organogram, because bench grades had
 * been created as positions so that people could be put somewhere. One person
 * could therefore be a "MEDICAL LAB SCIENTIST" by designation, a "Biomedical
 * Scientist" by account role and an "INTERNAL AUDITOR" by position, and no
 * screen agreed with any other.
 *
 * There are now exactly two concepts, and they do not overlap:
 *
 *   PRIMARY ROLE — what a staff member IS. Exactly one, mandatory, chosen
 *   from a short fixed list. It is their professional classification and
 *   their designation: one field, one value, the same on the register, on the
 *   login account and on every personnel file.
 *
 *   POSITION — an additional responsibility a staff member HOLDS. Zero, one
 *   or many. Laboratory Manager, Quality Manager, Safety Manager, a unit
 *   supervisor's post. Positions are what the organogram draws.
 *
 * Both can carry access. A primary role carries the access of its grade; a
 * position carries the access of the post, and because a post outranks a
 * grade, a held position's profile is what applies (see permissionResolver).
 *
 * The administrator is deliberately untouched: it stays a primary role of its
 * own, and the laboratory may add further primary roles and give them their
 * own access under Access Control.
 */

/** The two kinds of row in `roles`. */
export const ROLE_KINDS = ['primary', 'position'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** The administrator profile — special-cased everywhere, never renamed. */
export const ADMINISTRATOR_ROLE = 'System Administrator';

export type PrimaryRoleDef = {
  /** Canonical name, stored in `roles.name` and mirrored to `staff.designation`. */
  name: string;
  description: string;
  /** The cadre column this grade implies, which orders the organogram. */
  cadre: 'Scientist' | 'Technician' | 'Assistant' | 'Other';
  /** Earlier spellings that mean the same grade. Used by the migration and by import. */
  aliases: string[];
  /** Free text that means this grade — a designation, a job title, a legacy position title. */
  match: RegExp;
  /** Text that must NOT appear, where another grade's words would otherwise capture it. */
  notMatch?: RegExp;
  /**
   * A laboratory grade, as opposed to a classification for people who are not
   * bench staff. Only these were ever created as organogram positions, and
   * only these are retired from the positions list by the migration.
   */
  bench: boolean;
};

/**
 * The fixed classifications. Order is significant: `matchPrimaryRole` walks
 * this list in order and takes the first hit, so the narrower patterns come
 * before the wider ones.
 */
export const PRIMARY_ROLES: PrimaryRoleDef[] = [
  {
    name: ADMINISTRATOR_ROLE,
    description: 'Runs the system itself: access control, configuration, backups and the audit trail.',
    cadre: 'Other',
    aliases: ['Administrator', 'System Admin', 'IT Administrator'],
    match: /\b(system\s*admin(istrator)?|it\s*admin(istrator)?)\b/,
    bench: false,
  },
  {
    name: 'Medical Laboratory Scientist',
    description: 'Registered scientific staff: performs, reviews and verifies technical work.',
    cadre: 'Scientist',
    aliases: ['Biomedical Scientist', 'Medical Lab Scientist', 'Laboratory Scientist', 'Medical Laboratory Technologist', 'MLS'],
    // "Technologist" is the older name for the same grade and is matched here,
    // not as a technician — which is what the register has always meant by it.
    match: /\b(biomedical\s*scientist|med(ical)?\s*lab(oratory)?\s*(scientist|technologist)|laborator(y|ies)\s*(scientist|technologist)|scientist)\b|^\s*mls\s*$/,
    bench: true,
  },
  {
    name: 'Medical Laboratory Technician',
    description: 'Technical staff: performs assigned bench work and the records that go with it.',
    cadre: 'Technician',
    aliases: ['Technician', 'Medical Lab Technician', 'Laboratory Technician', 'Lab Technician', 'Technical Officer'],
    match: /\b(technician|technical\s*officer)\b/,
    bench: true,
  },
  {
    name: 'Medical Laboratory Assistant',
    description: 'Laboratory support at the bench: specimen handling, preparation and housekeeping.',
    cadre: 'Assistant',
    aliases: ['Laboratory Assistant', 'Lab Assistant', 'Medical Lab Assistant', 'Laboratory Aide', 'Phlebotomist'],
    match: /\b(assistant|aide|attendant|orderly|phlebotom\w*)\b/,
    // An administrative assistant is not a laboratory assistant.
    notMatch: /\b(administrat\w*|office|secretar\w*|clerical|account\w*|procure\w*|stores?|personal)\b/,
    bench: true,
  },
  {
    name: 'Intern',
    description: 'Bench staff under supervision for a stated period: intern, student, trainee or national service.',
    cadre: 'Other',
    // `\bintern\b` deliberately does not match "internal", so an Internal
    // Auditor is never mistaken for an intern.
    aliases: ['Student', 'Trainee', 'House Officer', 'National Service', 'NSS'],
    match: /\b(intern|interns|internship|student|trainee|attach(e|ment|ee)|nss|national\s*service)\b/,
    bench: true,
  },
  {
    name: 'Administrative & Support Staff',
    description: 'Non-laboratory staff: administration, records, stores, front desk and support services.',
    cadre: 'Other',
    aliases: ['Support Staff', 'Administrative Staff', 'Secretary', 'Clerk'],
    match: /\b(secretar\w*|administrat\w*|clerk|clerical|receptionist|records?\s*(officer|clerk)|stores?\s*(officer|keeper)|data\s*(officer|clerk)|customer\s*(service|care)|account\w*|procure\w*|driver|cleaner|porter|messenger|security|biostatist\w*)\b/,
    bench: false,
  },
];

export const PRIMARY_ROLE_NAMES: string[] = PRIMARY_ROLES.map(r => r.name);

/** The four laboratory grades — the ones that were wrongly created as positions. */
export const BENCH_PRIMARY_ROLES: PrimaryRoleDef[] = PRIMARY_ROLES.filter(r => r.bench);

const normalise = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[_\-/]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Is this role name one of the fixed primary roles (by canonical name or alias)? */
export function primaryRoleByName(name: unknown): PrimaryRoleDef | null {
  const n = normalise(name);
  if (!n) return null;
  for (const role of PRIMARY_ROLES) {
    if (normalise(role.name) === n) return role;
    if (role.aliases.some(a => normalise(a) === n)) return role;
  }
  return null;
}

/**
 * The grade a piece of free text describes — a designation, a job title, a
 * legacy position title — or null when it describes none of them.
 *
 * Several pieces of text can be offered at once, most authoritative first;
 * the first one that resolves wins, so a blank designation falls through to
 * the job title rather than giving up.
 */
export function matchPrimaryRole(...texts: unknown[]): PrimaryRoleDef | null {
  for (const text of texts) {
    const t = normalise(text);
    if (!t) continue;
    const exact = primaryRoleByName(t);
    if (exact) return exact;
    for (const role of PRIMARY_ROLES) {
      if (role.notMatch?.test(t)) continue;
      if (role.match.test(t)) return role;
    }
  }
  return null;
}

/**
 * A position title that is really a bench grade, and so has no business on the
 * organogram: "Biomedical Scientist", "MLS", "LAB TECHNICIAN", "INTERN".
 *
 * Posts are excluded explicitly rather than by hoping the grade words do not
 * appear in them, because real posts do contain those words — a "Chief
 * Technician" who runs a unit, a "Scientist in charge of QC". Anything that
 * names a post is a post.
 */
const POST_WORDS = /\b(manager|supervisor|head|director|officer|auditor|coordinator|lead|in\s*charge|incharge|chief|deputy|focal)\b/;

export function isBenchGradeTitle(title: unknown): boolean {
  const t = normalise(title);
  if (!t) return false;
  if (POST_WORDS.test(t)) return false;
  const role = matchPrimaryRole(t);
  return !!role && role.bench;
}

/**
 * Must somebody of this grade belong to a clinical unit?
 *
 * Every laboratory professional works in one, and exactly one. Administrative
 * and support staff primarily belong to an administrative unit, and the
 * administrator is not a bench grade at all, so neither is required to hold
 * one — though both may be given one where the laboratory works that way.
 */
export function requiresClinicalUnit(roleName: unknown): boolean {
  return primaryRoleByName(roleName)?.bench === true;
}

/** The cadre a primary role implies, for the organogram's within-unit ordering. */
export function cadreForPrimaryRole(name: unknown): string | null {
  return primaryRoleByName(name)?.cadre ?? null;
}

/**
 * Every spelling of a role name that should still be recognised after the
 * rename, so a laboratory upgrading from an older build never loses access
 * because a list in the seed said "Biomedical Scientist" and the row now says
 * "Medical Laboratory Scientist".
 */
export function roleNameAliases(name: string): string[] {
  const def = primaryRoleByName(name);
  if (!def) return [name];
  return [def.name, ...def.aliases];
}

/** Do two role names mean the same grade? Tolerant of the pre-rename spellings. */
export function sameRole(a: unknown, b: unknown): boolean {
  if (normalise(a) === normalise(b)) return true;
  const ra = primaryRoleByName(a);
  const rb = primaryRoleByName(b);
  return !!ra && !!rb && ra.name === rb.name;
}
