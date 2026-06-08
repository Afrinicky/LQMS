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
        blood_bank_handover: ['view', 'create', 'edit', 'approve', 'export', 'print']
      },
      'Quality Manager': {
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
        blood_bank_handover: ['view', 'create', 'edit', 'approve', 'export', 'print']
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
        blood_bank_handover: ['view', 'create', 'edit', 'print']
      },
      'Section Head': {
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
      },
      'Biomedical Scientist': {
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
        blood_bank_handover: ['view', 'create', 'edit', 'print']
      },
      'Technician': {
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
        blood_bank_handover: ['view', 'create']
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
