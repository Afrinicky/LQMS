import type Database from 'better-sqlite3';

/**
 * Starting orientation & induction frameworks.
 *
 * These are the laboratory's own induction checklists carried across — the
 * standard new-staff induction and the shorter intern/attachment induction —
 * restated as grouped checklist items with who is normally responsible for
 * each. They mirror the competency frameworks: records copy a framework's
 * items, and a laboratory that edits, renames or retires one keeps its change
 * across upgrades because seeding is keyed on the framework code.
 *
 * Both land as drafts: nothing here is in force until somebody with the
 * authority to agree it activates it.
 */

type Item = { group: string; text: string; description?: string; responsible?: string };

type Framework = {
  code: string;
  title: string;
  appliesTo: string;
  purpose: string;
  scope: string;
  validityMonths: number;
  isDefault?: boolean;
  items: Item[];
};

const FACILITATOR = 'facilitator';
const SAFETY = 'safety_officer';
const QUALITY = 'quality_manager';
const SECTION = 'section_head';
const LIS = 'lis_administrator';
const HR = 'hr';

const FRAMEWORKS: Framework[] = [
  {
    code: 'OF-NEWSTAFF',
    title: 'Staff orientation & induction',
    appliesTo: 'new_hire',
    isDefault: true,
    purpose: 'Take a newly appointed member of staff through everything they must be shown, given and told before they begin work, and record that each step was completed.',
    scope: 'All newly appointed laboratory staff during their induction. Items that do not apply to the post are marked not applicable and excluded from completion.',
    validityMonths: 0,
    items: [
      // Welcome & administration
      { group: 'Welcome & administration', text: 'Welcome, introduction to the laboratory and its management structure', description: 'The laboratory, its mission, the organogram and who to go to for what.', responsible: FACILITATOR },
      { group: 'Welcome & administration', text: 'Tour of the premises, benches, amenities and emergency exits', responsible: FACILITATOR },
      { group: 'Welcome & administration', text: 'Introduction to colleagues and the section team', responsible: SECTION },
      { group: 'Welcome & administration', text: 'Personnel file, contract, job description and conditions of service explained', responsible: HR },
      { group: 'Welcome & administration', text: 'Attendance, duty roster, leave and reporting arrangements explained', responsible: HR },
      { group: 'Welcome & administration', text: 'Staff identity, access card and keys issued', responsible: HR },

      // Quality & ethics
      { group: 'Quality & ethics', text: 'Quality policy, quality manual and quality objectives explained', responsible: QUALITY },
      { group: 'Quality & ethics', text: 'Document control — how to find and use the current authorised procedure', responsible: QUALITY },
      { group: 'Quality & ethics', text: 'Code of Conduct read and signed', description: 'Completed in Code of Conduct — confirm the acknowledgement is recorded.', responsible: QUALITY },
      { group: 'Quality & ethics', text: 'Confidentiality and impartiality declarations read and signed', responsible: QUALITY },
      { group: 'Quality & ethics', text: 'How nonconformities, incidents and complaints are raised', responsible: QUALITY },

      // Health, safety & biosafety
      { group: 'Health, safety & biosafety', text: 'Laboratory safety and biosafety induction', description: 'Hazards, risk assessments and the rules for the areas the person will work in.', responsible: SAFETY },
      { group: 'Health, safety & biosafety', text: 'Personal protective equipment issued and correct use demonstrated', responsible: SAFETY },
      { group: 'Health, safety & biosafety', text: 'Waste segregation, sharps handling and spill response explained', responsible: SAFETY },
      { group: 'Health, safety & biosafety', text: 'Fire safety, first aid and emergency procedures explained', responsible: SAFETY },
      { group: 'Health, safety & biosafety', text: 'Occupational health — immunisation status and exposure/incident reporting', responsible: SAFETY },

      // Systems & information
      { group: 'Systems & information', text: 'LIS / information system account created and login demonstrated', responsible: LIS },
      { group: 'Systems & information', text: 'Data protection, system security and password rules explained', responsible: LIS },
      { group: 'Systems & information', text: 'How to register requests, enter and release results within authorisation', responsible: LIS },

      // Bench & technical induction
      { group: 'Bench & technical induction', text: 'Introduction to the section, its scope of work and equipment', responsible: SECTION },
      { group: 'Bench & technical induction', text: 'Standard operating procedures relevant to the post reviewed', responsible: SECTION },
      { group: 'Bench & technical induction', text: 'Equipment the person will use — operation, maintenance and function checks shown', responsible: SECTION },
      { group: 'Bench & technical induction', text: 'Baseline competency assessment planned or scheduled', description: 'Raise the appropriate competency assessment before unsupervised work.', responsible: SECTION },
      { group: 'Bench & technical induction', text: 'Supervision and authorisation arrangements explained', responsible: SECTION },
    ],
  },
  {
    code: 'OF-INTERN',
    title: 'Intern & attachment orientation',
    appliesTo: 'intern_attachee',
    purpose: 'Induct interns, students and attachés for a supervised placement, covering conduct, safety and the arrangements for their supervision.',
    scope: 'Interns, students and attachés for the duration of their placement. Nothing in this induction authorises unsupervised work.',
    validityMonths: 0,
    items: [
      { group: 'Welcome & administration', text: 'Welcome, introduction to the laboratory and the placement supervisor', responsible: FACILITATOR },
      { group: 'Welcome & administration', text: 'Tour of the premises, amenities and emergency exits', responsible: FACILITATOR },
      { group: 'Welcome & administration', text: 'Placement objectives, duration and attendance expectations explained', responsible: SECTION },

      { group: 'Quality & ethics', text: 'Confidentiality declaration read and signed', responsible: QUALITY },
      { group: 'Quality & ethics', text: 'Expected standard of conduct and the limits of a supervised role explained', responsible: QUALITY },

      { group: 'Health, safety & biosafety', text: 'Safety and biosafety induction for the areas of the placement', responsible: SAFETY },
      { group: 'Health, safety & biosafety', text: 'Personal protective equipment issued and correct use demonstrated', responsible: SAFETY },
      { group: 'Health, safety & biosafety', text: 'Waste handling, sharps safety and spill/exposure response explained', responsible: SAFETY },

      { group: 'Supervised training', text: 'Introduction to the benches the placement will cover', responsible: SECTION },
      { group: 'Supervised training', text: 'Relevant procedures reviewed with the supervisor', responsible: SECTION },
      { group: 'Supervised training', text: 'Supervision arrangement explained — always work under supervision', responsible: SECTION },
      { group: 'Supervised training', text: 'Placement competency assessment planned', responsible: SECTION },
    ],
  },
];

export function seedOrientationFrameworks(database: Database.Database) {
  const exists = database.prepare('SELECT id FROM orientation_frameworks WHERE framework_code = ?');
  const insertFramework = database.prepare(`INSERT INTO orientation_frameworks
    (framework_code, title, applies_to, version_label, purpose, scope, validity_months,
     requires_facilitator_sign_off, requires_staff_sign_off, status, is_default)
    VALUES (?, ?, ?, '1.0', ?, ?, ?, 1, 1, 'draft', ?)`);
  const insertItem = database.prepare(`INSERT INTO orientation_framework_items
    (framework_id, group_title, item_text, item_description, responsible_role, display_order)
    VALUES (?, ?, ?, ?, ?, ?)`);

  for (const framework of FRAMEWORKS) {
    if (exists.get(framework.code)) continue;
    const result = insertFramework.run(framework.code, framework.title, framework.appliesTo,
      framework.purpose, framework.scope, framework.validityMonths, framework.isDefault ? 1 : 0);
    const frameworkId = Number(result.lastInsertRowid);
    let order = 0;
    for (const item of framework.items) {
      insertItem.run(frameworkId, item.group, item.text, item.description ?? null, item.responsible ?? null, order += 10);
    }
  }
}
