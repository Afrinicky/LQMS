import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A throwaway database, so the check never touches a laboratory's own data.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sechlims-check-'));
process.env.SECH_LIMS_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ } });
const { getDb, closeDb } = await import('../server/db/database.js');
const { seedDefaults } = await import('../server/db/seed.js');
const um = await import('../server/services/unitMembership.js');
const duty = await import('../server/services/dutyService.js');
const appt = await import('../server/services/appointments.js');

const db = getDb();
seedDefaults();

const fail: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  →  ${actual}${ok ? '' : `   (expected ${expected})`}`);
  if (!ok) fail.push(label);
};
const sec = (n: string) => (db.prepare('SELECT id FROM sections WHERE name = ?').get(n) as any).id;
const haem = sec('Haematology'), micro = sec('Microbiology');
const qualityOffice = sec('Quality Office');

const mls = (db.prepare("SELECT id FROM roles WHERE name = 'Medical Laboratory Scientist'").get() as any).id;
const staffId = Number(db.prepare(
  "INSERT INTO staff (full_name, designation, primary_role_id, section_id, unit, is_active) VALUES ('AMA MENSAH', 'Medical Laboratory Scientist', ?, ?, 'Haematology', 1)",
).run(mls, haem).lastInsertRowid);

const month = um.currentMonth();
const schedId = Number(db.prepare(
  "INSERT INTO reassignment_schedules (schedule_number, month, status) VALUES ('RS-TEST-1', ?, 'approved')",
).run(month).lastInsertRowid);
const rowHaem = Number(db.prepare(
  "INSERT INTO reassignment_rows (schedule_id, unit_label, section_id, member_ids) VALUES (?, 'Haematology', ?, ?)",
).run(schedId, haem, JSON.stringify([staffId])).lastInsertRowid);
const rowMicro = Number(db.prepare(
  "INSERT INTO reassignment_rows (schedule_id, unit_label, section_id, member_ids) VALUES (?, 'Microbiology', ?, '[]')",
).run(schedId, micro).lastInsertRowid);

console.log('\n— Before: the reported bug —');
check('starts in Haematology', duty.unitAssignments(db, month).get(staffId)?.sectionName, 'Haematology');

console.log('\n— Register → memo —');
const moved = um.setClinicalUnit(db, { staffId, sectionId: micro, source: 'test' });
check('move accepted', moved.ok && moved.changed, 'true');
check('staff.section_id moved', (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any).section_id, micro);
check('derived unit text follows', (db.prepare('SELECT unit FROM staff WHERE id = ?').get(staffId) as any).unit, 'Microbiology');
check('memo: removed from Haematology row', (db.prepare('SELECT member_ids FROM reassignment_rows WHERE id = ?').get(rowHaem) as any).member_ids, '[]');
check('memo: added to Microbiology row', (db.prepare('SELECT member_ids FROM reassignment_rows WHERE id = ?').get(rowMicro) as any).member_ids, JSON.stringify([staffId]));
check('work now routes to Microbiology', duty.unitAssignments(db, month).get(staffId)?.sectionName, 'Microbiology');

console.log('\n— Memo → register —');
db.prepare('UPDATE reassignment_rows SET member_ids = ? WHERE id = ?').run(JSON.stringify([staffId]), rowHaem);
db.prepare('UPDATE reassignment_rows SET member_ids = ? WHERE id = ?').run('[]', rowMicro);
const back = um.applyMemoToRegister(db, schedId, null);
check('memo moved 1 person', back, 1);
check('register followed the memo', (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any).section_id, haem);
check('unit text followed too', (db.prepare('SELECT unit FROM staff WHERE id = ?').get(staffId) as any).unit, 'Haematology');

console.log('\n— Appointment to a clinical unit supervisor post —');
const microPost = (db.prepare("SELECT id FROM positions WHERE title = 'Microbiology Unit Supervisor'").get() as any).id;
db.prepare('UPDATE positions SET supervises_section_id = ? WHERE id = ?').run(micro, microPost);
const r1 = appt.appoint(db, { positionId: microPost, staffId, kind: 'holder' });
check('appointment accepted', r1.ok, 'true');
check('clinical unit moved to Microbiology', (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any).section_id, micro);
check('unit head recorded', (db.prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(micro) as any).head_staff_id, staffId);
check('work routes to the unit they now run', duty.unitAssignments(db, month).get(staffId)?.sectionName, 'Microbiology');

console.log('\n— Appointment to an ADMINISTRATIVE unit head post —');
const qmPost = (db.prepare("SELECT id FROM positions WHERE title = 'Quality Manager'").get() as any).id;
// Deliberately NOT wired up here: the migration links the post to the unit,
// which is what makes the head follow the appointment on its own.
check('Quality Manager post supervises the Quality Office',
  (db.prepare('SELECT supervises_section_id AS s FROM positions WHERE id = ?').get(qmPost) as any).s, qualityOffice);
const r2 = appt.appoint(db, { positionId: qmPost, staffId, kind: 'holder' });
check('appointment accepted', r2.ok, 'true');
check('clinical unit UNCHANGED', (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any).section_id, micro);
const units = um.unitsForStaff(db, staffId);
check('clinical unit still Microbiology', units.clinical?.name, 'Microbiology');
check('Quality Office added as additional', units.additional.map(u => u.name).join(','), 'Quality Office');
check('and they head it', (db.prepare('SELECT head_staff_id AS h FROM sections WHERE id = ?').get(qualityOffice) as any).h, staffId);

console.log('\n— Standing down from the administrative post —');
appt.vacate(db, { positionId: qmPost, staffId });
check('administrative membership removed', um.unitsForStaff(db, staffId).additional.length, 0);
check('the office is vacant again', (db.prepare('SELECT head_staff_id AS h FROM sections WHERE id = ?').get(qualityOffice) as any).h, 'null');
check('clinical unit still Microbiology', (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any).section_id, micro);

console.log('\n— An office changes hands cleanly —');
{
  const successor = Number(db.prepare(
    "INSERT INTO staff (full_name, designation, primary_role_id, section_id, is_active) VALUES ('KOJO ANNAN', 'Medical Laboratory Scientist', ?, ?, 1)",
  ).run(mls, haem).lastInsertRowid);
  const qmPost2 = (db.prepare("SELECT id FROM positions WHERE title = 'Quality Manager'").get() as any).id;
  appt.appoint(db, { positionId: qmPost2, staffId, kind: 'holder' });
  appt.appoint(db, { positionId: qmPost2, staffId: successor, kind: 'holder' });
  const members = db.prepare('SELECT staff_id AS s FROM staff_unit_memberships WHERE section_id = ?').all(qualityOffice) as Array<{ s: number }>;
  check('only the new holder sits in the office', members.map(m => m.s).join(','), String(successor));
  check('and the office names them', (db.prepare('SELECT head_staff_id AS h FROM sections WHERE id = ?').get(qualityOffice) as any).h, successor);
  appt.vacate(db, { positionId: qmPost2, staffId: successor });
}

console.log('\n— Clinical lookups do not offer the offices —');
{
  const clinical = db.prepare("SELECT COUNT(*) c FROM sections WHERE is_active = 1 AND IFNULL(unit_kind,'clinical') = 'clinical' AND name = 'Quality Office'").get() as any;
  check('the Quality Office is not a clinical unit', clinical.c, 0);
}

console.log('\n— Cross-unit grant —');
db.prepare("INSERT INTO staff_unit_grants (staff_id, section_id, level) VALUES (?, ?, 'contribute')").run(staffId, haem);
check('grant level read back', um.unitGrantLevel(db, staffId, haem), 'contribute');
check('no grant elsewhere', um.unitGrantLevel(db, staffId, qualityOffice), 'null');
check('workable units include the grant', [...um.workableUnitIds(db, staffId)].sort().join(','), [micro, haem].sort().join(','));
db.prepare("UPDATE staff_unit_grants SET expires_at = '2020-01-01' WHERE staff_id = ?").run(staffId);
check('an expired grant gives nothing', um.unitGrantLevel(db, staffId, haem), 'null');

console.log('\n— An administrative unit is not a clinical unit —');
const bad = um.setClinicalUnit(db, { staffId, sectionId: qualityOffice, source: 'test' });
check('refused', bad.ok, 'false');
check('clinical unit untouched', (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any).section_id, micro);

closeDb();
console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(' | ')}` : '\nAll checks passed.');
process.exit(fail.length ? 1 : 0);
