import bcrypt from 'bcryptjs';
import { DEFAULT_POSITIONS, MODULES, PERMISSION_ACTIONS } from '../../shared/constants/modules.js';
import { getDb } from './database.js';

export function seedDefaults() {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)').run('System Administrator', 'Full foundation administration role.', 1);
    db.prepare('INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)').run('Quality User', 'General QMS user role.', 1);
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
    const adminRole = db.prepare('SELECT id FROM roles WHERE name = ?').get('System Administrator') as { id: number };
    const permissions = db.prepare('SELECT id FROM permissions').all() as { id: number }[];
    for (const permission of permissions) {
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id, allowed, source) VALUES (?, ?, 1, ?)').run(adminRole.id, permission.id, 'Role default');
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
