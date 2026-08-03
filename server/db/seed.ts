import bcrypt from 'bcryptjs';
import { DEFAULT_POSITIONS, MODULES, PERMISSION_ACTIONS } from '../../shared/constants/modules.js';
import { FEATURES, LEVEL_ACTIONS, featuresOfModule, type AccessLevel } from '../../shared/constants/features.js';
import { getDb } from './database.js';
import { config } from '../config/index.js';

export function seedDefaults() {
  const db = getDb();
  const tx = db.transaction(() => {
    const rolesToSeed = [
      { name: 'System Administrator', description: 'Full foundation administration role.' },
      { name: 'Laboratory Manager', description: 'Lab leadership role for oversight of quality and operations.' },
      { name: 'Quality Manager', description: 'Lead quality assurance, corrective action, and review workflows.' },
      { name: 'Quality Team Member', description: 'Operational QMS user for investigations, CAPA, and action follow-up.' },
      { name: 'Section Head', description: 'Section manager with oversight for department-scoped quality records.' },
      { name: 'Biomedical Scientist', description: 'Technical staff member assigned to quality and operational records.' },
      { name: 'Technician', description: 'Frontline technical staff with access to assigned quality actions and records.' },
      { name: 'Blood Bank Unit Head', description: 'Blood bank section lead for handover review and quality oversight.' },
      { name: 'Safety Manager', description: 'Oversees safety incidents and reviews blood bank adverse events.' },
      { name: 'Data Officer', description: 'Imports LHIMS raw data and prepares monthly reports.' },
      { name: 'POCT Officer', description: 'Oversees point-of-care testing sites, devices, operators, QC, EQA, and incidents.' },
      { name: 'Quality User', description: 'General QMS user role.', is_system: 1 }
    ];
    for (const role of rolesToSeed) {
      db.prepare('INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)').run(role.name, role.description, role.is_system ?? 0);
    }
    for (const module of MODULES) {
      db.prepare('INSERT OR IGNORE INTO system_modules (key, label, path, enabled, alerts_paused) VALUES (?, ?, ?, 1, 0)').run(module.key, module.label, module.path);
      for (const action of PERMISSION_ACTIONS) {
        db.prepare('INSERT OR IGNORE INTO permissions (module_key, action, label) VALUES (?, ?, ?)').run(module.key, action, `${module.label}: ${action}`);
      }
    }
    // Features are permission targets in their own right, stored in the same
    // table keyed `module.feature`. A module's access is derived from these by
    // the resolver, so both granularities live in one place.
    for (const feature of FEATURES) {
      for (const action of PERMISSION_ACTIONS) {
        db.prepare('INSERT OR IGNORE INTO permissions (module_key, action, label) VALUES (?, ?, ?)').run(feature.key, action, `${feature.label}: ${action}`);
      }
    }
    for (const title of DEFAULT_POSITIONS) {
      db.prepare('INSERT OR IGNORE INTO positions (title, description, is_active) VALUES (?, ?, 1)').run(title, 'Default organogram position. Assign staff during setup or later.');
    }
    db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)').run('Laboratory');
    const labDept = db.prepare('SELECT id FROM departments WHERE name = ?').get('Laboratory') as { id: number };
    for (const section of ['Blood Bank', 'Microbiology', 'Biochemistry', 'Haematology', 'Quality Office', 'Stores', 'Customer Service']) {
      db.prepare('INSERT OR IGNORE INTO sections (department_id, name) VALUES (?, ?)').run(labDept.id, section);
    }
    db.prepare('INSERT OR IGNORE INTO locations (name, description) VALUES (?, ?)').run('Main Laboratory', 'Default local site location.');
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('setupComplete', 'false')").run();
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('hostMode', 'true')").run();
    // Deployment mode override (offline-first hybrid architecture, Phase 1).
    // Seeded from the SECH_LIMS_MODE env default; admin-settable at runtime.
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('systemMode', ?)").run(config.mode);
    db.prepare("INSERT OR IGNORE INTO dennis_settings (setting_key, setting_value) VALUES ('dennis.mode', 'Offline only')").run();
    db.prepare("INSERT OR IGNORE INTO dennis_settings (setting_key, setting_value) VALUES ('dennis.online.enabled', 'false')").run();

    // ========================================================================
    // Role defaults, expressed as an access LEVEL per feature.
    //
    // The old map hand-listed action arrays per module — 224 decisions a role,
    // unreviewable in practice, which is how a Technician came to hold create
    // rights on the equipment register and a POCT Officer edit rights on every
    // staff record. Levels are declarative and least-privilege by default:
    // anything not listed is `none`.
    //
    //   view       open and print, change nothing
    //   contribute add new records, alter nothing existing
    //   manage     add, change and export
    //   full       manage, plus approve and archive
    //
    // Keys are feature keys (`personnel.register`) for modules that have been
    // broken up, and module keys for those that have not.
    // ========================================================================

    // Bump whenever the table below changes in a way an existing laboratory
    // must receive — a right withdrawn, or a new area added to a role. See the
    // note beside the application loop for why this exists.
    const ROLE_DEFAULTS_VERSION = '2026.08-features.3';

    // Every member of staff, whatever their rank: their own record, their own
    // inbox, the launchpad, the ability to raise a safety incident or a
    // nonconformity, and read access to the documents they must follow.
    const EVERYONE: Partial<Record<AccessLevel, string[]>> = {
      view: ['home', 'dashboard', 'documents.library', 'organisation.structure', 'dennis'],
      manage: ['personnel.self', 'notifications.inbox'],
      contribute: ['nc_capa', 'facilities_safety.incidents', 'actions'],
    };

    const ROLE_ACCESS: Record<string, Partial<Record<AccessLevel, string[]>>> = {
      // ---- Frontline bench staff ------------------------------------------
      // Records the work they do. Owns nothing, configures nothing, and cannot
      // open a colleague's personnel file.
      'Technician': {
        contribute: [
          'monitoring.readings', 'equipment.maintenance', 'supplier_inventory.stock',
          'process_management.receipt', 'process_management.rejections',
          'customer_focus.feedback', 'customer_focus.communication',
          'iqc', 'blood_bank_handover', 'poct', 'risks', 'complaints',
        ],
        view: [
          'process_management.directory', 'process_management.intervals',
          'equipment.register', 'supplier_inventory.storage', 'eqa',
          'notifications.calendar', 'monitoring.reports',
        ],
      },

      // ---- Registered scientific staff -------------------------------------
      // Everything a Technician does, plus the technical quality work they are
      // qualified to perform and the registers that go with it.
      'Biomedical Scientist': {
        manage: ['iqc', 'monitoring.readings', 'equipment.maintenance', 'process_management.receipt'],
        contribute: [
          'eqa', 'verification_validation', 'measurement_uncertainty',
          'equipment.verification', 'equipment.adverse',
          'process_management.rejections', 'process_management.critical',
          'process_management.referrals', 'blood_bank_handover', 'poct',
          'supplier_inventory.stock', 'quality_indicators', 'continual_improvement',
          'customer_focus.feedback', 'customer_focus.communication',
          'risks', 'complaints', 'facilities_safety.equipment',
        ],
        view: [
          'process_management.directory', 'process_management.intervals',
          'equipment.register', 'equipment.files', 'supplier_inventory.storage',
          'assessments', 'meetings', 'records_reports.generate',
          'notifications.calendar', 'monitoring.reports', 'documents.records',
        ],
      },

      // ---- General QMS user -------------------------------------------------
      'Quality User': {
        contribute: [
          'risks', 'complaints', 'quality_indicators', 'continual_improvement',
          'customer_focus.feedback', 'customer_focus.communication',
          'monitoring.readings', 'equipment.maintenance', 'supplier_inventory.stock',
        ],
        view: ['assessments', 'meetings', 'notifications.calendar', 'documents.records'],
      },

      // ---- Section / unit leadership ---------------------------------------
      // Runs a section: its people's rosters and training, its equipment, its
      // technical quality. Not the laboratory's finances or licences.
      'Section Head': {
        full: ['iqc', 'eqa', 'verification_validation', 'measurement_uncertainty'],
        manage: [
          'personnel.rosters', 'personnel.training', 'personnel.orientation',
          'equipment.register', 'equipment.maintenance', 'equipment.verification',
          'equipment.training', 'equipment.files', 'equipment.adverse',
          'supplier_inventory.stock', 'supplier_inventory.storage',
          'process_management.receipt', 'process_management.rejections',
          'process_management.referrals', 'process_management.reviews',
          'monitoring.readings', 'monitoring.reports',
          'nc_capa', 'risks', 'complaints', 'actions', 'quality_indicators',
          'continual_improvement', 'blood_bank_handover', 'poct',
          'documents.authoring', 'documents.records',
          'customer_focus.feedback', 'customer_focus.communication', 'customer_focus.advisory',
          'facilities_safety.incidents', 'facilities_safety.equipment', 'facilities_safety.inspections',
          'records_reports.generate', 'notifications.calendar',
        ],
        view: [
          // Read, not run: the monitoring asset register and monthly LHIMS
          // reporting belong to the quality office and the data officer.
          'monitoring.assets', 'monthly_reports',
          'personnel.register', 'personnel.authorizations',
          'process_management.directory', 'process_management.intervals',
          'process_management.critical', 'assessments', 'meetings',
          'documents.masterlist', 'documents.archive', 'supplier_inventory.suppliers',
        ],
      },

      // ---- Quality office ---------------------------------------------------
      'Quality Team Member': {
        manage: [
          'nc_capa', 'complaints', 'risks', 'actions', 'assessments',
          'quality_indicators', 'continual_improvement', 'customer_focus.feedback',
          'customer_focus.surveys', 'customer_focus.communication', 'customer_focus.advisory',
          'customer_focus.reports', 'documents.authoring', 'documents.records',
          'documents.masterlist', 'documents.archive',
          'records_reports.generate', 'records_reports.evidence', 'records_reports.print',
          'notifications.calendar', 'meetings', 'monthly_reports',
          'process_management.reviews',
        ],
        view: [
          'personnel.register', 'personnel.training', 'personnel.orientation',
          'personnel.authorizations', 'personnel.reports',
          'equipment.register', 'equipment.maintenance', 'equipment.verification',
          'supplier_inventory.stock', 'supplier_inventory.suppliers',
          'process_management.directory', 'process_management.intervals',
          'process_management.critical', 'process_management.referrals',
          'information_management.assets', 'information_management.reviews',
          'organisation.quality_config', 'organisation.records_review',
          'management_review', 'iqc', 'eqa', 'verification_validation',
          'measurement_uncertainty', 'poct', 'blood_bank_handover',
          'facilities_safety.equipment', 'facilities_safety.inspections',
          'records_reports.audit', 'monitoring.readings', 'monitoring.reports',
        ],
      },

      // ---- Quality Manager --------------------------------------------------
      // Owns the management system end to end. Not staff pay, appraisals or
      // the budget — those stay with the Laboratory Manager.
      // Quality Manager — owns the management system and audits the rest.
      // Auditing something is not the same as running it: equipment, stock,
      // IT change control and facilities belong to the people who operate
      // them, so the Quality Manager reads those rather than managing them.
      'Quality Manager': {
        full: [
          'nc_capa', 'complaints', 'risks', 'actions', 'assessments',
          'quality_indicators', 'continual_improvement', 'management_review',
          'meetings', 'monthly_reports', 'iqc', 'eqa', 'verification_validation',
          'measurement_uncertainty', 'poct', 'blood_bank_handover',
          'documents.library', 'documents.authoring', 'documents.workflow',
          'documents.records', 'documents.masterlist', 'documents.archive',
          'customer_focus.feedback', 'customer_focus.surveys', 'customer_focus.communication',
          'customer_focus.advisory', 'customer_focus.stakeholders', 'customer_focus.imports',
          'customer_focus.reports',
          'records_reports.generate', 'records_reports.evidence', 'records_reports.print',
          'records_reports.audit', 'records_reports.retention',
          'organisation.quality_config', 'organisation.records_review',
          'notifications.calendar', 'notifications.rules',
        ],
        manage: [
          // Quality's own instruments: competence, impartiality, the manual.
          'personnel.training', 'personnel.orientation', 'personnel.authorizations',
          'personnel.declarations', 'personnel.reports',
          'documents.profile', 'organisation.structure',
          'process_management.directory', 'process_management.intervals',
          'process_management.critical', 'process_management.amendments',
          'process_management.reviews', 'process_management.rejections',
          'monitoring.reports',
        ],
        view: [
          // Audited, not operated. The Quality Manager must be able to read
          // every one of these; running them belongs to equipment, stores, IT,
          // safety and the sections.
          'personnel.register', 'personnel.rosters',
          'equipment.register', 'equipment.maintenance', 'equipment.verification',
          'equipment.training', 'equipment.files', 'equipment.adverse', 'equipment.reports',
          'supplier_inventory.stock', 'supplier_inventory.suppliers',
          'supplier_inventory.storage', 'supplier_inventory.reports',
          'process_management.receipt', 'process_management.referrals',
          'information_management.assets', 'information_management.access',
          'information_management.security', 'information_management.data',
          'information_management.change', 'information_management.downtime',
          'information_management.reviews', 'information_management.reports',
          'monitoring.readings', 'monitoring.assets', 'monitoring.settings',
          'facilities_safety.incidents', 'facilities_safety.equipment',
          'facilities_safety.inspections', 'facilities_safety.waste',
          'facilities_safety.environment', 'organisation.licences',
        ],
      },

      // ---- Laboratory Manager ----------------------------------------------
      // Accountable for the whole laboratory, including its people and money.
      'Laboratory Manager': {
        full: [
          'personnel.register', 'personnel.orientation', 'personnel.declarations',
          'personnel.training', 'personnel.appraisals', 'personnel.authorizations',
          'personnel.rosters', 'personnel.reports',
          'nc_capa', 'complaints', 'risks', 'actions', 'assessments',
          'quality_indicators', 'continual_improvement', 'management_review',
          'meetings', 'monthly_reports', 'iqc', 'eqa', 'verification_validation',
          'measurement_uncertainty', 'poct', 'blood_bank_handover',
          'documents.library', 'documents.authoring', 'documents.workflow',
          'documents.records', 'documents.masterlist', 'documents.archive', 'documents.profile',
          'organisation.structure', 'organisation.quality_config', 'organisation.budget',
          'organisation.records_review', 'organisation.licences',
          'customer_focus.feedback', 'customer_focus.surveys', 'customer_focus.communication',
          'customer_focus.advisory', 'customer_focus.stakeholders', 'customer_focus.imports',
          'customer_focus.reports',
          'records_reports.generate', 'records_reports.evidence', 'records_reports.print',
          'records_reports.audit', 'records_reports.retention',
          'notifications.calendar', 'notifications.rules',
        ],
        manage: [
          'equipment.register', 'equipment.maintenance', 'equipment.verification',
          'equipment.training', 'equipment.files', 'equipment.adverse', 'equipment.reports',
          'supplier_inventory.stock', 'supplier_inventory.suppliers',
          'supplier_inventory.storage', 'supplier_inventory.labels', 'supplier_inventory.reports',
          'process_management.receipt', 'process_management.directory',
          'process_management.rejections', 'process_management.intervals',
          'process_management.critical', 'process_management.referrals',
          'process_management.amendments', 'process_management.reviews',
          'information_management.assets', 'information_management.data',
          'information_management.downtime', 'information_management.reports',
          'monitoring.readings', 'monitoring.assets', 'monitoring.reports',
          'facilities_safety.incidents', 'facilities_safety.equipment',
          'facilities_safety.inspections', 'facilities_safety.waste',
          'facilities_safety.environment',
        ],
        view: [
          // Accountable for the laboratory, but these are operated by others:
          // IT runs change control and access review, the Safety Manager holds
          // occupational health, and monitoring thresholds are a technical
          // setting rather than a management decision.
          'information_management.access', 'information_management.security',
          'information_management.change', 'information_management.reviews',
          'facilities_safety.health', 'monitoring.settings',
        ],
      },

      // ---- Specialist leads --------------------------------------------------
      // Runs the blood bank. Seniority is not breadth: laboratory-wide
      // equipment, stores and safety equipment belong to the people who own
      // those functions, so this role contributes to them rather than
      // managing them.
      'Blood Bank Unit Head': {
        full: ['blood_bank_handover'],
        manage: ['nc_capa', 'actions', 'risks', 'monitoring.readings'],
        contribute: ['equipment.maintenance', 'supplier_inventory.stock'],
        view: [
          'equipment.register', 'supplier_inventory.storage', 'documents.records',
          'notifications.calendar', 'facilities_safety.equipment',
        ],
      },

      // Owns safety and occupational health outright. The laboratory's
      // equipment register is not a safety record — safety equipment has its
      // own feature — so it is not granted here.
      'Safety Manager': {
        full: [
          'facilities_safety.incidents', 'facilities_safety.equipment',
          'facilities_safety.inspections', 'facilities_safety.waste',
          'facilities_safety.health', 'facilities_safety.environment',
        ],
        manage: ['nc_capa', 'actions', 'risks', 'monitoring.readings', 'monitoring.reports'],
        view: ['blood_bank_handover', 'personnel.training', 'notifications.calendar'],
      },

      'Data Officer': {
        full: ['monthly_reports'],
        manage: [
          'information_management.assets', 'information_management.data',
          'information_management.downtime', 'information_management.reports',
          'records_reports.generate', 'actions',
        ],
        view: [
          // Stock levels are not a data-reporting concern, so they are not here.
          'information_management.change', 'information_management.reviews',
          'process_management.receipt', 'documents.records',
          'notifications.calendar', 'quality_indicators',
        ],
      },

      // POCT oversight. Deliberately holds NO rights over the personnel
      // register: the previous default let a POCT Officer edit any member of
      // staff's record, which their role never required.
      // POCT oversight, and only that. Point-of-care devices, operator
      // authorisations, QC and EQA all live inside the POCT module, so the
      // laboratory-wide equivalents — the bench IQC and EQA registers, lab
      // equipment training, the personnel training register — are not this
      // role's concern and are not granted. It also holds no right over the
      // personnel register, which the previous default let it edit outright.
      'POCT Officer': {
        full: ['poct'],
        manage: ['nc_capa', 'actions'],
        contribute: ['equipment.maintenance', 'monitoring.readings'],
        view: [
          'equipment.register', 'supplier_inventory.stock', 'iqc', 'eqa',
          'documents.records', 'notifications.calendar',
        ],
      },
    };

    // Fold the shared baseline into every role without overwriting a role's own,
    // higher, level for the same key.
    const LEVEL_RANK: Record<AccessLevel, number> = { none: 0, view: 1, contribute: 2, manage: 3, full: 4 };
    const effectiveLevels: Record<string, Record<string, AccessLevel>> = {};
    for (const [roleName, byLevel] of Object.entries(ROLE_ACCESS)) {
      const flat: Record<string, AccessLevel> = {};
      const apply = (source: Partial<Record<AccessLevel, string[]>>) => {
        for (const [level, keys] of Object.entries(source) as [AccessLevel, string[]][]) {
          for (const k of keys) {
            if (!flat[k] || LEVEL_RANK[level] > LEVEL_RANK[flat[k]]) flat[k] = level;
          }
        }
      };
      apply(EVERYONE);
      apply(byLevel);
      effectiveLevels[roleName] = flat;
    }

    const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('System Administrator') as { id: number };
    const allPermissions = db.prepare('SELECT id, module_key, action FROM permissions').all() as { id: number; module_key: string; action: string }[];

    // The administrator holds everything, module and feature alike.
    for (const permission of allPermissions) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, 1, ?)').run(adminRole.id, permission.id, 'Role default');
    }

    // ── How defaults reach a laboratory that is already running ──────────────
    // Two rules pull in opposite directions and both matter:
    //
    //   • A permission an administrator revoked must stay revoked. Re-applying
    //     defaults on every restart silently undid their decision.
    //   • A default we later find to be WRONG — a Technician holding create on
    //     the equipment register, a POCT Officer able to edit any staff record
    //     — must actually reach the installations running it. Never overwriting
    //     means a security correction ships to new databases only.
    //
    // The version marker settles it: when ROLE_DEFAULTS_VERSION changes, the
    // corrected defaults are applied once, authoritatively — granting what the
    // level allows and explicitly denying what it does not. Every restart after
    // that leaves the laboratory's own decisions alone.
    const storedVersion = (db.prepare("SELECT value FROM settings WHERE key = 'roleDefaultsVersion'").get() as { value: string } | undefined)?.value ?? null;
    const reapply = storedVersion !== ROLE_DEFAULTS_VERSION;

    if (reapply) {
      // Modules that have been split into features carry no grants of their
      // own — their access is derived. Any leftover module-level row is at
      // best ignored and at worst a denial that cascades over every feature
      // inside, so they are cleared out as part of applying the defaults.
      const derivedModules = [...new Set(FEATURES.map(f => f.module))];
      for (const moduleKey of derivedModules) {
        const ids = db.prepare('SELECT id FROM permissions WHERE module_key = ?').all(moduleKey) as { id: number }[];
        for (const { id } of ids) {
          db.prepare('DELETE FROM role_permissions WHERE permission_id = ? AND role_id != ?').run(id, adminRole.id);
        }
      }
    }

    for (const [roleName, levels] of Object.entries(effectiveLevels)) {
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName) as { id: number } | undefined;
      if (!role) continue;
      for (const permission of allPermissions) {
        // A module that has been split into features has no grants of its own:
        // its access is derived from those features. Writing a row here would
        // be a denial that cascades over the features and switches the whole
        // module off for the role.
        if (featuresOfModule(permission.module_key).length > 0) continue;
        const level = levels[permission.module_key];
        const allowed = level && LEVEL_ACTIONS[level].includes(permission.action) ? 1 : 0;
        if (reapply) {
          // Write the whole position, allowed AND denied, so a right this role
          // should not hold is actively withdrawn rather than left behind.
          db.prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, ?, ?)').run(role.id, permission.id, allowed, 'Role default');
        } else if (allowed) {
          db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, 1, ?)').run(role.id, permission.id, 'Role default');
        }
      }
    }

    if (reapply) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('roleDefaultsVersion', ?, CURRENT_TIMESTAMP)").run(ROLE_DEFAULTS_VERSION);
      db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value) VALUES (NULL, ?, ?, ?, ?)')
        .run('role_defaults_applied', 'role_permissions', ROLE_DEFAULTS_VERSION,
          JSON.stringify({ version: ROLE_DEFAULTS_VERSION, previous: storedVersion, roles: Object.keys(effectiveLevels).length }));
      console.log(`[seed] role defaults ${storedVersion ?? '(none)'} -> ${ROLE_DEFAULTS_VERSION} applied`);
    }

    type SeedSection = { title: string; description?: string; questions: Array<{ text: string; guidance?: string; evidence?: string }> };
    const defaultChecklists: Array<{ code: string; name: string; type: string; sections: SeedSection[] }> = [
      { code: 'CHK-GEN', name: 'General Laboratory Assessment Checklist', type: 'general', sections: [
        { title: 'Organisation and management', questions: [
          { text: 'Is there a current organogram with named leadership roles?', evidence: 'Organogram document, position descriptions' },
          { text: 'Are roles, responsibilities, and authorities documented for key positions?', evidence: 'Job descriptions, responsibility matrix' }
        ]},
        { title: 'Quality management system', questions: [
          { text: 'Is there a current quality manual or equivalent QMS reference?', evidence: 'Quality manual record' },
          { text: 'Are management reviews conducted at a defined frequency?', evidence: 'Management review minutes' }
        ]}
      ]},
      { code: 'CHK-SEC', name: 'Sectional Assessment Checklist', type: 'sectional', sections: [
        { title: 'Section staffing and supervision', questions: [
          { text: 'Is the section supervised by a competent staff member?', evidence: 'Supervisor authorisation, competency record' },
          { text: 'Are duty rosters maintained and approved?', evidence: 'Duty roster' }
        ]},
        { title: 'Section quality records', questions: [
          { text: 'Are corrective actions documented for section-level issues?', evidence: 'CAPA records' }
        ]}
      ]},
      { code: 'CHK-HAEM', name: 'Haematology Assessment Checklist', type: 'section_specific', sections: [
        { title: 'IQC for haematology analysers', questions: [
          { text: 'Is daily IQC run on each haematology analyser before patient testing?', evidence: 'IQC log, Levey-Jennings record' },
          { text: 'Are out-of-control IQC results investigated and documented?', evidence: 'IQC nonconformance log' }
        ]},
        { title: 'Sample integrity', questions: [
          { text: 'Are EDTA samples rejected when clotted or inadequate volume?', evidence: 'Sample rejection log' }
        ]}
      ]},
      { code: 'CHK-MICRO', name: 'Microbiology Assessment Checklist', type: 'section_specific', sections: [
        { title: 'Media and reagent control', questions: [
          { text: 'Are culture media QC checks performed before use?', evidence: 'Media QC log' },
          { text: 'Are stains, antisera, and reagents within validity?', evidence: 'Reagent register, expiry log' }
        ]},
        { title: 'Antimicrobial susceptibility testing', questions: [
          { text: 'Are AST QC strains run at the defined frequency?', evidence: 'AST QC log' }
        ]}
      ]},
      { code: 'CHK-BB', name: 'Blood Bank Quality Assessment Checklist', type: 'section_specific', sections: [
        { title: 'Blood unit screening and storage', questions: [
          { text: 'Are all blood units screened for HBsAg, HCV, syphilis, and HIV before issue?', evidence: 'Screening log per unit' },
          { text: 'Are blood storage refrigerator temperatures monitored continuously?', evidence: 'Temperature monitoring records' }
        ]},
        { title: 'Handover and traceability', questions: [
          { text: 'Is a Thursday-to-Thursday handover record maintained?', evidence: 'Handover register' }
        ]}
      ]},
      { code: 'CHK-SAFETY', name: 'Safety Assessment Checklist', type: 'safety', sections: [
        { title: 'PPE and biosafety', questions: [
          { text: 'Is appropriate PPE available and worn during sample handling?', evidence: 'PPE register, observation' },
          { text: 'Are biosafety cabinets serviced and certified within the validity period?', evidence: 'BSC certificate' }
        ]},
        { title: 'Incident reporting', questions: [
          { text: 'Are safety incidents reported and investigated promptly?', evidence: 'Incident register, CAPA' }
        ]}
      ]},
      { code: 'CHK-DOC', name: 'Document Control Assessment Checklist', type: 'document_control', sections: [
        { title: 'Document master list', questions: [
          { text: 'Is there a current document master list of controlled SOPs and policies?', evidence: 'Master list' },
          { text: 'Are document review due dates tracked and acted upon?', evidence: 'Document review register' }
        ]},
        { title: 'Attestations', questions: [
          { text: 'Do staff attest to reading current versions of relevant SOPs?', evidence: 'Attestation records' }
        ]}
      ]}
    ];

    const insertSection = db.prepare(`INSERT INTO assessment_checklist_sections (checklist_id, section_title, section_description, display_order, is_active, created_by) VALUES (?, ?, ?, ?, 1, NULL)`);
    const insertQuestion = db.prepare(`INSERT INTO assessment_checklist_questions (checklist_id, section_id, question_text, expected_evidence, guidance, response_type, display_order, is_required, is_active, created_by) VALUES (?, ?, ?, ?, ?, 'met_partial_not_met', ?, 0, 1, NULL)`);
    const sectionCountByChecklist = db.prepare('SELECT COUNT(*) AS c FROM assessment_checklist_sections WHERE checklist_id = ?');

    for (const c of defaultChecklists) {
      let row = db.prepare('SELECT id FROM assessment_checklists WHERE checklist_code = ? AND is_default = 1').get(c.code) as { id: number } | undefined;
      if (!row) {
        const r = db.prepare(`INSERT INTO assessment_checklists (checklist_code, checklist_name, checklist_type, description, status, is_default, is_editable, marking_enabled) VALUES (?, ?, ?, ?, 'draft', 1, 1, 0)`)
          .run(c.code, c.name, c.type, 'Default starter checklist. Sections and questions are editable; replace, archive, or delete unused checklists freely.');
        row = { id: Number(r.lastInsertRowid) };
      }
      const existing = sectionCountByChecklist.get(row.id) as { c: number };
      if (existing.c > 0) continue; // already seeded sections — never overwrite editor changes
      let order = 0;
      for (const s of c.sections) {
        const sr = insertSection.run(row.id, s.title, s.description ?? null, order++);
        const sectionId = Number(sr.lastInsertRowid);
        let qOrder = 0;
        for (const q of s.questions) {
          insertQuestion.run(row.id, sectionId, q.text, q.evidence ?? null, q.guidance ?? null, qOrder++);
        }
      }
    }

    // Equipment lifecycle checklist starter questions. Seeded once per type and
    // never overwritten — the laboratory edits, adds to, or retires them freely.
    const equipmentChecklists: Array<{ type: string; prompts: string[] }> = [
      { type: 'verification_validation', prompts: [
        'Has validation information been obtained from the manufacturer as part of the verification?',
        'Have performance characteristics been appropriately selected and evaluated as per intended use?',
        'Were the verification studies appropriate and adequate?',
        'Was the analysis of data appropriate for the selected performance characteristics?',
        'Have the verification results and reports been reviewed and approved by an authorised person?',
      ] },
      { type: 'calibration', prompts: [
        'Is routine calibration of laboratory measuring equipment scheduled, at minimum following the manufacturer’s recommendations?',
        'When routine calibration is performed offsite (externally), are there records of verification before use?',
        'Is information on metrological traceability (e.g. reference materials, certified thermometer, tachometer) available?',
        'Is there evidence of review of calibration records by the laboratory before acceptance back into use?',
        'Where traceability using an accredited calibration laboratory is not possible, are certified reference materials, examination/calibration by another procedure, or mutual-consent standards used for in-house calibrations?',
      ] },
    ];
    const equipItemCount = db.prepare('SELECT COUNT(*) AS c FROM equipment_checklist_items WHERE checklist_type = ?');
    const insertEquipItem = db.prepare('INSERT INTO equipment_checklist_items (checklist_type, prompt, sort_order, is_active, created_by) VALUES (?, ?, ?, 1, NULL)');
    for (const c of equipmentChecklists) {
      if ((equipItemCount.get(c.type) as { c: number }).c > 0) continue; // already seeded — keep editor changes
      c.prompts.forEach((p, i) => insertEquipItem.run(c.type, p, i));
    }

    const defaultTemplates: Array<{ code: string; name: string; type: string; module: string; format: string; description: string }> = [
      { code: 'RPTT-NCCAPA-OPEN', name: 'Open NC/CAPA register', type: 'register', module: 'nc_capa', format: 'csv', description: 'Open NC events list for the period.' },
      { code: 'RPTT-COMPLAINTS-PERIOD', name: 'Complaints in period', type: 'register', module: 'complaints', format: 'html', description: 'Complaints received within the period.' },
      { code: 'RPTT-EQUIP-CAL-DUE', name: 'Equipment calibration register', type: 'register', module: 'equipment', format: 'csv', description: 'Equipment items with calibration data, filterable by status.' },
      { code: 'RPTT-MONITORING-PERIOD', name: 'Monitoring records in period', type: 'list', module: 'monitoring', format: 'csv', description: 'Environmental monitoring records.' },
      { code: 'RPTT-IQC-PERIOD', name: 'IQC results in period', type: 'list', module: 'iqc', format: 'csv', description: 'IQC results filterable by status.' },
      { code: 'RPTT-EQA-PERIOD', name: 'EQA events in period', type: 'list', module: 'eqa', format: 'html', description: 'EQA events received or due in the period.' },
      { code: 'RPTT-BB-HANDOVERS', name: 'Blood bank handovers register', type: 'register', module: 'blood_bank_handover', format: 'csv', description: 'Blood bank handover records.' },
      { code: 'RPTT-ASSESSMENTS-LIST', name: 'Assessment programmes register', type: 'register', module: 'assessments', format: 'html', description: 'Assessment programmes filterable by status.' },
      { code: 'RPTT-QI-RESULTS', name: 'Quality indicator results', type: 'list', module: 'quality_indicators', format: 'csv', description: 'Quality indicator results across indicators.' },
      { code: 'RPTT-POCT-QC', name: 'POCT QC results', type: 'list', module: 'poct', format: 'csv', description: 'POCT QC results filterable by status.' },
      { code: 'RPTT-CUSTOMER-FEEDBACK', name: 'Customer feedback register', type: 'register', module: 'customer_focus', format: 'html', description: 'Customer feedback filterable by urgency/status.' },
      { code: 'RPTT-NOTIFICATIONS', name: 'Notifications register', type: 'list', module: 'notifications', format: 'csv', description: 'Notifications filterable by status/severity.' }
    ];
    for (const t of defaultTemplates) {
      const existing = db.prepare('SELECT id FROM report_templates WHERE template_code = ?').get(t.code);
      if (!existing) {
        db.prepare(`INSERT INTO report_templates (template_code, template_name, template_type, module_key, description, output_format, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)`).run(t.code, t.name, t.type, t.module, t.description, t.format);
      }
    }
  });
  tx();
}

export function setupInitialSystem(input: { facilityName: string; shortName?: string; username: string; password: string; fullName: string }) {
  seedDefaults();
  const db = getDb();
  const exists = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
  if (exists.count > 0) throw new Error('Initial setup has already been completed.');
  const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('System Administrator') as { id: number };
  const hash = bcrypt.hashSync(input.password, 12);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO users (username, password_hash, full_name, role_id) VALUES (?, ?, ?, ?)').run(input.username, hash, input.fullName, adminRole.id);
    db.prepare('INSERT OR REPLACE INTO laboratory_profile (id, facility_name, short_name, host_mode, host_api_port) VALUES (1, ?, ?, 1, ?)').run(input.facilityName, input.shortName ?? 'SECH Laboratory', Number(process.env.API_PORT ?? 4317));
    db.prepare("UPDATE settings SET value = 'true', updated_at = CURRENT_TIMESTAMP WHERE key = 'setupComplete'").run();
    db.prepare('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, new_value) VALUES (NULL, ?, ?, ?, ?)').run('initial_setup', 'setup', '1', JSON.stringify({ facilityName: input.facilityName, username: input.username }));
  });
  tx();
}
