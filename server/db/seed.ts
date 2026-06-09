import bcrypt from 'bcryptjs';
import { DEFAULT_POSITIONS, MODULES, PERMISSION_ACTIONS } from '../../shared/constants/modules.js';
import { getDb } from './database.js';

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

    const rolePermissionsMap: Record<string, Record<string, string[]>> = {
      'Laboratory Manager': {
        documents: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        personnel: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        nc_capa: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        complaints: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        risks: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        supplier_inventory: ['view', 'create', 'edit', 'print'],
        equipment: ['view', 'create', 'edit', 'print'],
        monitoring: ['view', 'create', 'edit', 'print'],
        facilities_safety: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        iqc: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        eqa: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        verification_validation: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        measurement_uncertainty: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        blood_bank_handover: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        monthly_reports: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        assessments: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        meetings: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        management_review: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        quality_indicators: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        continual_improvement: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        customer_focus: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        poct: ['view', 'create', 'edit', 'approve', 'export', 'print']
      },
      'Quality Manager': {
        documents: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        personnel: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        nc_capa: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        complaints: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        risks: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        supplier_inventory: ['view', 'create', 'edit', 'print'],
        equipment: ['view', 'create', 'edit', 'print'],
        monitoring: ['view', 'create', 'edit', 'print'],
        facilities_safety: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        iqc: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        eqa: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        verification_validation: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        measurement_uncertainty: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        blood_bank_handover: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        monthly_reports: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        assessments: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        meetings: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        management_review: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        quality_indicators: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        continual_improvement: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        customer_focus: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        poct: ['view', 'create', 'edit', 'approve', 'export', 'print']
      },
      'Data Officer': {
        monthly_reports: ['view', 'create', 'edit', 'export', 'print'],
        nc_capa: ['view', 'create', 'print'],
        actions: ['view', 'create', 'edit', 'print'],
        supplier_inventory: ['view', 'print']
      },
      'POCT Officer': {
        poct: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        nc_capa: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'print'],
        equipment: ['view', 'create', 'edit', 'print'],
        iqc: ['view', 'create', 'edit', 'print'],
        eqa: ['view', 'create', 'edit', 'print'],
        personnel: ['view', 'create', 'edit', 'print'],
        supplier_inventory: ['view', 'print'],
        documents: ['view', 'print']
      },
      'Blood Bank Unit Head': {
        blood_bank_handover: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        nc_capa: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'print'],
        facilities_safety: ['view', 'create', 'print'],
        monitoring: ['view', 'create', 'print'],
        equipment: ['view', 'print'],
        supplier_inventory: ['view', 'print']
      },
      'Safety Manager': {
        facilities_safety: ['view', 'create', 'edit', 'approve', 'export', 'print'],
        blood_bank_handover: ['view', 'print'],
        nc_capa: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'print']
      },
      'Quality Team Member': {
        documents: ['view', 'create', 'edit', 'print'],
        personnel: ['view', 'create', 'edit', 'print'],
        nc_capa: ['view', 'create', 'edit', 'print'],
        complaints: ['view', 'create', 'edit', 'print'],
        risks: ['view', 'create', 'edit', 'print'],
        supplier_inventory: ['view', 'create', 'edit', 'print'],
        equipment: ['view', 'create', 'edit', 'print'],
        monitoring: ['view', 'create', 'edit', 'print'],
        facilities_safety: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'print'],
        iqc: ['view', 'create', 'edit', 'print'],
        eqa: ['view', 'create', 'edit', 'print'],
        verification_validation: ['view', 'create', 'edit', 'print'],
        measurement_uncertainty: ['view', 'create', 'edit', 'print'],
        blood_bank_handover: ['view', 'create', 'edit', 'print'],
        monthly_reports: ['view', 'create', 'edit', 'print'],
        assessments: ['view', 'create', 'edit', 'print'],
        meetings: ['view', 'create', 'edit', 'print'],
        management_review: ['view', 'create', 'edit', 'print'],
        quality_indicators: ['view', 'create', 'edit', 'print'],
        continual_improvement: ['view', 'create', 'edit', 'print'],
        customer_focus: ['view', 'create', 'edit', 'print'],
        poct: ['view', 'create', 'edit', 'print']
      },
      'Section Head': {
        documents: ['view', 'create', 'edit', 'print'],
        personnel: ['view', 'create', 'edit', 'print'],
        nc_capa: ['view', 'create', 'edit', 'print'],
        complaints: ['view', 'create', 'edit', 'print'],
        risks: ['view', 'create', 'edit', 'print'],
        supplier_inventory: ['view', 'create', 'edit', 'print'],
        equipment: ['view', 'create', 'edit', 'print'],
        monitoring: ['view', 'create', 'edit', 'print'],
        facilities_safety: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'print'],
        iqc: ['view', 'create', 'edit', 'print'],
        eqa: ['view', 'create', 'edit', 'print'],
        verification_validation: ['view', 'create', 'edit', 'print'],
        measurement_uncertainty: ['view', 'create', 'edit', 'print'],
        monthly_reports: ['view', 'create', 'edit', 'print'],
        assessments: ['view', 'create', 'edit', 'print'],
        meetings: ['view', 'create', 'edit', 'print'],
        management_review: ['view'],
        quality_indicators: ['view', 'create', 'edit', 'print'],
        continual_improvement: ['view', 'create', 'edit', 'print'],
        customer_focus: ['view', 'create', 'edit', 'print'],
        poct: ['view', 'create', 'edit', 'print']
      },
      'Biomedical Scientist': {
        documents: ['view', 'print'],
        personnel: ['view'],
        nc_capa: ['view', 'create', 'print'],
        complaints: ['view', 'create', 'print'],
        risks: ['view', 'create', 'print'],
        supplier_inventory: ['view', 'create', 'print'],
        equipment: ['view', 'create', 'print'],
        monitoring: ['view', 'create', 'print'],
        facilities_safety: ['view', 'create', 'print'],
        actions: ['view', 'create', 'print'],
        iqc: ['view', 'create', 'print'],
        eqa: ['view', 'create', 'print'],
        verification_validation: ['view', 'create', 'print'],
        measurement_uncertainty: ['view', 'create', 'print'],
        blood_bank_handover: ['view', 'create', 'edit', 'print'],
        monthly_reports: ['view', 'print'],
        assessments: ['view', 'create', 'print'],
        meetings: ['view', 'print'],
        quality_indicators: ['view', 'create', 'print'],
        continual_improvement: ['view', 'create', 'print'],
        customer_focus: ['view', 'create', 'print'],
        poct: ['view', 'create', 'edit', 'print']
      },
      'Technician': {
        documents: ['view', 'print'],
        personnel: ['view'],
        nc_capa: ['view', 'create', 'print'],
        complaints: ['view', 'create', 'print'],
        risks: ['view', 'create', 'print'],
        supplier_inventory: ['view', 'create', 'print'],
        equipment: ['view', 'create', 'print'],
        monitoring: ['view', 'create', 'print'],
        facilities_safety: ['view', 'create', 'print'],
        actions: ['view', 'create', 'print'],
        iqc: ['view', 'create', 'print'],
        eqa: ['view', 'create', 'print'],
        verification_validation: ['view', 'create', 'print'],
        measurement_uncertainty: ['view', 'create', 'print'],
        blood_bank_handover: ['view', 'create'],
        monthly_reports: ['view'],
        assessments: ['view'],
        meetings: ['view'],
        quality_indicators: ['view'],
        continual_improvement: ['view'],
        customer_focus: ['view'],
        poct: ['view', 'create']
      },
      'Quality User': {
        nc_capa: ['view', 'create', 'edit', 'print'],
        complaints: ['view', 'create', 'edit', 'print'],
        risks: ['view', 'create', 'edit', 'print'],
        supplier_inventory: ['view', 'create', 'edit', 'print'],
        equipment: ['view', 'create', 'edit', 'print'],
        monitoring: ['view', 'create', 'edit', 'print'],
        facilities_safety: ['view', 'create', 'edit', 'print'],
        actions: ['view', 'create', 'edit', 'print'],
        iqc: ['view', 'create', 'edit', 'print'],
        eqa: ['view', 'create', 'edit', 'print'],
        verification_validation: ['view', 'create', 'edit', 'print'],
        measurement_uncertainty: ['view', 'create', 'edit', 'print']
      }
    };

    const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('System Administrator') as { id: number };
    const allPermissions = db.prepare('SELECT id, module_key, action FROM permissions').all() as { id: number; module_key: string; action: string }[];

    for (const permission of allPermissions) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, 1, ?)').run(adminRole.id, permission.id, 'Role default');
    }

    for (const [roleName, modulePermissions] of Object.entries(rolePermissionsMap)) {
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName) as { id: number } | undefined;
      if (!role) continue;
      for (const permission of allPermissions) {
        if (modulePermissions[permission.module_key]?.includes(permission.action)) {
          db.prepare('INSERT OR REPLACE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, 1, ?)').run(role.id, permission.id, 'Role default');
        }
      }
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
