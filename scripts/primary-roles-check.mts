/* Exercises the primary-role and unit migrations against a database shaped
   like the live one in the screenshots. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway database, so the check never touches a laboratory's own data.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sechlims-check-'));
process.env.SECH_LIMS_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const { getDb, closeDb } = await import('../server/db/database.js');
const { seedDefaults } = await import('../server/db/seed.js');

let db = getDb();
seedDefaults();

// ---- Make it look like the laboratory's actual database -------------------
db.exec("UPDATE roles SET name = 'Biomedical Scientist' WHERE name = 'Medical Laboratory Scientist'");
db.exec("UPDATE roles SET name = 'Technician' WHERE name = 'Medical Laboratory Technician'");
db.exec("UPDATE roles SET kind = 'position'");
db.exec("UPDATE positions SET access_profile_role_id = NULL WHERE access_profile_role_id IN (SELECT id FROM roles WHERE name IN ('Medical Laboratory Assistant','Intern','Administrative & Support Staff'))");
db.exec("DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE name IN ('Medical Laboratory Assistant','Intern','Administrative & Support Staff'))");
db.exec("DELETE FROM roles WHERE name IN ('Medical Laboratory Assistant','Intern','Administrative & Support Staff')");

const sectionId = (name: string) => {
  const row = db.prepare('SELECT id FROM sections WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
  if (row) return row.id;
  return Number(db.prepare('INSERT INTO sections (department_id, name, is_active) VALUES (NULL, ?, 1)').run(name).lastInsertRowid);
};
const haem = sectionId('Haematology');
const micro = sectionId('Microbiology');

// Bench grades wrongly created as organogram positions (image 5).
const benchPosts = ['Biomedical Scientist', 'MLS', 'LAB TECHNICIAN', 'Technician', 'INTERN'];
const postIds: Record<string, number> = {};
for (const title of benchPosts) {
  db.prepare("INSERT OR IGNORE INTO positions (title, description, is_active, is_core) VALUES (?, 'legacy bench post', 1, 0)").run(title);
  postIds[title] = (db.prepare('SELECT id FROM positions WHERE title = ?').get(title) as { id: number }).id;
}

const people: Array<[string, string, string | null, number | null]> = [
  // name, designation, personnel category, section
  ['BENEDICT ODEI-BAWUAH', 'MEDICAL LAB SCIENTIST', 'STAFF', haem],
  ['EDWARD LAAR', 'MEDICAL LAB TECHNICIAN', 'STAFF', haem],
  ['DORA SERWAA', 'LAB TECHNICIAN', 'STAFF', micro],
  ['ISAAC SAKYI SARKODIE', '', 'INTERN', haem],
  ['MARTHA BOAKYE', 'Laboratory Assistant', 'STAFF', micro],
  ['RANSFORD YAKUBU', 'Secretary', 'STAFF', null],
  ['STEPHEN APPIAH-KARIKARI', 'INTERNAL AUDITOR', 'STAFF', micro],
];
const staffIds: Record<string, number> = {};
for (const [name, designation, category, section] of people) {
  const id = Number(db.prepare(
    'INSERT INTO staff (full_name, designation, personnel_category, section_id, unit, is_active) VALUES (?, ?, ?, ?, ?, 1)',
  ).run(name, designation || null, category, section, 'HAEMATOLOGY').lastInsertRowid);   // stale unit text on purpose
  staffIds[name] = id;
}
// Somebody whose only clue is the bench post they were put in.
db.prepare("INSERT INTO staff_position_assignments (staff_id, position_id, assignment_type) VALUES (?, ?, 'primary')")
  .run(staffIds['ISAAC SAKYI SARKODIE'], postIds['INTERN']);

closeDb();

// ---- Re-open: the migration runs ------------------------------------------
db = getDb();

const fail: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  →  ${actual}${ok ? '' : `   (expected ${expected})`}`);
  if (!ok) fail.push(label);
};

const roleName = (staff: string) => (db.prepare(
  'SELECT r.name FROM staff s LEFT JOIN roles r ON r.id = s.primary_role_id WHERE s.id = ?',
).get(staffIds[staff]) as { name: string | null } | undefined)?.name ?? null;

console.log('\n— Primary roles —');
check('Designation "MEDICAL LAB SCIENTIST"', roleName('BENEDICT ODEI-BAWUAH'), 'Medical Laboratory Scientist');
check('Designation "MEDICAL LAB TECHNICIAN"', roleName('EDWARD LAAR'), 'Medical Laboratory Technician');
check('Designation "LAB TECHNICIAN"', roleName('DORA SERWAA'), 'Medical Laboratory Technician');
check('Category INTERN, no designation', roleName('ISAAC SAKYI SARKODIE'), 'Intern');
check('Designation "Laboratory Assistant"', roleName('MARTHA BOAKYE'), 'Medical Laboratory Assistant');
check('Designation "Secretary"', roleName('RANSFORD YAKUBU'), 'Administrative & Support Staff');
check('Designation "INTERNAL AUDITOR" is not a grade', roleName('STEPHEN APPIAH-KARIKARI'), null);

console.log('\n— Role rows —');
check('Biomedical Scientist renamed', (db.prepare("SELECT COUNT(*) c FROM roles WHERE name = 'Biomedical Scientist'").get() as any).c, 0);
check('Medical Laboratory Scientist exists', (db.prepare("SELECT COUNT(*) c FROM roles WHERE name = 'Medical Laboratory Scientist'").get() as any).c, 1);
check('Primary roles marked', (db.prepare("SELECT COUNT(*) c FROM roles WHERE kind = 'primary'").get() as any).c, 6);
check('Quality Manager is a position profile', (db.prepare("SELECT kind FROM roles WHERE name = 'Quality Manager'").get() as any).kind, 'position');

console.log('\n— Bench positions removed —');
for (const title of benchPosts) {
  check(`position "${title}" gone`, (db.prepare('SELECT COUNT(*) c FROM positions WHERE title = ?').get(title) as any).c, 0);
}
check('Quality Manager post kept', (db.prepare("SELECT COUNT(*) c FROM positions WHERE title = 'Quality Manager'").get() as any).c, 1);
check('Secretary post kept', (db.prepare("SELECT COUNT(*) c FROM positions WHERE title = 'Secretary'").get() as any).c, 1);

console.log('\n— Designation mirrors the grade —');
check('Benedict designation', (db.prepare('SELECT designation FROM staff WHERE id = ?').get(staffIds['BENEDICT ODEI-BAWUAH']) as any).designation, 'Medical Laboratory Scientist');
check('Benedict cadre', (db.prepare('SELECT cadre FROM staff WHERE id = ?').get(staffIds['BENEDICT ODEI-BAWUAH']) as any).cadre, 'Scientist');

console.log('\n— The stale unit text —');
check('Dora unit follows her section', (db.prepare('SELECT unit FROM staff WHERE id = ?').get(staffIds['DORA SERWAA']) as any).unit, 'Microbiology');
check('Ransford has no unit text', (db.prepare('SELECT unit FROM staff WHERE id = ?').get(staffIds['RANSFORD YAKUBU']) as any).unit, 'null');

console.log('\n— Administrative units —');
for (const name of ['Quality Office', 'Stores', 'Customer Service', 'Safety Office', 'Point-of-Care Testing']) {
  const row = db.prepare('SELECT unit_kind, is_pseudo FROM sections WHERE name = ?').get(name) as any;
  check(`${name} is administrative+pseudo`, row ? `${row.unit_kind}/${row.is_pseudo}` : 'missing', 'administrative/1');
}
check('Haematology stays clinical', (db.prepare('SELECT unit_kind FROM sections WHERE id = ?').get(haem) as any).unit_kind, 'clinical');
check('Quality Office head post linked', (db.prepare("SELECT hp.title FROM sections s JOIN positions hp ON hp.id = s.head_position_id WHERE s.name = 'Quality Office'").get() as any)?.title, 'Quality Manager');
check('Countable units exclude pseudo', (db.prepare("SELECT COUNT(*) c FROM sections WHERE is_active = 1 AND is_pseudo = 0 AND unit_kind = 'administrative'").get() as any).c, 0);

console.log('\n— Idempotence —');
closeDb();
db = getDb();
check('re-run leaves one MLS role', (db.prepare("SELECT COUNT(*) c FROM roles WHERE name = 'Medical Laboratory Scientist'").get() as any).c, 1);
check('re-run leaves one Quality Office', (db.prepare("SELECT COUNT(*) c FROM sections WHERE name = 'Quality Office'").get() as any).c, 1);
check('re-run keeps grades', roleName('BENEDICT ODEI-BAWUAH'), 'Medical Laboratory Scientist');

closeDb();
console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(' | ')}` : '\nAll checks passed.');
process.exit(fail.length ? 1 : 0);
