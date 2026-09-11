/**
 * Training, proved end to end.
 *
 * Two claims are being tested, and both were previously false.
 *
 * THE FIRST: a trainer who does not work here can be recorded. The register's
 * trainer was a dropdown of employees, so the week the supplier's engineer
 * trained four people on the new analyser there was nowhere to put his name and
 * the laboratory's own record said the session had no trainer. That is most of
 * the training that matters most.
 *
 * THE SECOND, and the harder one: training recorded anywhere reaches the
 * person's own file. Training lived in four places that did not know about one
 * another, so "what training has this person had?" could not be answered
 * without opening four modules and adding up by hand. The test below records
 * training on an INSTRUMENT, in Equipment Management, and then asks the
 * PERSONNEL side for that person's file — which is exactly the journey that
 * used to lose it.
 *
 *   npm run api        (in one terminal)
 *   node scripts/training-record-check.mjs
 */
const BASE = process.env.API || 'http://127.0.0.1:4430/api';
const PW = 'Passw0rd!test';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const st = await j('/setup/status');
if (!st.json?.setupComplete) {
  await j('/setup/initialize', { method: 'POST', body: { facilityName: 'Training Lab', username: 'admin', password: PW, fullName: 'Admin User' } });
}
const A = (await j('/auth/login', { method: 'POST', body: { username: 'admin', password: PW } })).json?.token;
if (!A) { console.error(`Could not sign in — is the API running on ${BASE}?`); process.exit(1); }

const stamp = Date.now().toString(36).toUpperCase();
const today = new Date().toISOString().slice(0, 10);

/* A person and an instrument to hang the test on. */
const person = await j('/staff/register', {
  method: 'POST', token: A,
  body: { surname: 'Mensah', firstName: `Akosua${stamp}`, employeeNo: `EMP-${stamp}`, personnelCategory: 'STAFF' },
});
const staffId = person.json?.staffId;
if (!staffId) { console.error('Could not create a staff record:', JSON.stringify(person.json)); process.exit(1); }

const kit = await j('/equipment', {
  method: 'POST', token: A,
  body: { equipmentNumber: `EQ-${stamp}`, name: `Sysmex XN-550 ${stamp}`, category: 'analyser', status: 'operational' },
});
const equipmentId = kit.json?.id;

/* ==========================================================================
   [1] The trainer who does not work here
   ======================================================================== */
console.log('\n[1] A session the supplier\'s engineer delivered');

const external = await j('/personnel/training', {
  method: 'POST', token: A,
  body: {
    title: `XN-550 operator training ${stamp}`,
    trainingDate: today, durationHours: 6, category: 'equipment', trainingFormat: 'bench_side',
    deliveryMode: 'external', trainerType: 'external_person',
    externalTrainerName: 'Kwame Boateng',
    externalTrainerOrganisation: 'Sysmex West Africa',
    externalTrainerQualifications: 'Certified XN-series application specialist',
    provider: 'Sysmex West Africa', equipmentId,
    effectivenessMethod: 'competency_assessment', status: 'completed',
  },
});
check('a session with an outside trainer is accepted', external.status === 201, JSON.stringify(external.json));
const eventId = external.json?.id;

const unnamed = await j('/personnel/training', {
  method: 'POST', token: A,
  body: { title: 'Nameless', trainingDate: today, deliveryMode: 'external', trainerType: 'external_person' },
});
check('an outside trainer with no name is refused — that is the gap being closed',
  unnamed.status === 400, JSON.stringify(unnamed.json));

const opened = await j(`/personnel/training/${eventId}`, { token: A });
check('the trainer\'s name is on the record', opened.json?.external_trainer_name === 'Kwame Boateng', JSON.stringify(opened.json?.external_trainer_name));
check('so is the organisation they came from', opened.json?.external_trainer_organisation === 'Sysmex West Africa');
check('and no staff trainer was stored alongside — one trainer per session',
  opened.json?.trainer_staff_id === null, String(opened.json?.trainer_staff_id));
// A follow-up with no date is one nothing can ever report as overdue, which is
// the same as not asking for it.
check('an effectiveness review was given a due date rather than left blank',
  Boolean(opened.json?.effectiveness_due_date), String(opened.json?.effectiveness_due_date));

/* ==========================================================================
   [2] Attendance is what somebody came away with, not that they were present
   ======================================================================== */
console.log('\n[2] Who was there, and what they came away with');

const att = await j(`/personnel/training/${eventId}/attendance`, {
  method: 'POST', token: A,
  body: { staffId, attendanceStatus: 'attended', outcome: 'competent' },
});
check('attendance with an outcome is recorded', att.status === 201, JSON.stringify(att.json));

const withAtt = await j(`/personnel/training/${eventId}`, { token: A });
const row = (withAtt.json?.attendance ?? [])[0];
check('the outcome is on the person\'s row, not the session\'s', row?.outcome === 'competent', JSON.stringify(row));
check('and somebody who attended a whole session inherits its hours', Number(row?.hours) === 6, String(row?.hours));

const partial = await j(`/personnel/training/${eventId}/attendance`, {
  method: 'POST', token: A, body: { staffId, attendanceStatus: 'partial', hours: 2 },
});
check('somebody who attended part of it can have their own hours', partial.status === 201);
const afterPartial = await j(`/personnel/training/${eventId}`, { token: A });
check('and gets those hours rather than the session\'s',
  Number((afterPartial.json?.attendance ?? [])[0]?.hours) === 2,
  String((afterPartial.json?.attendance ?? [])[0]?.hours));

/* ==========================================================================
   [3] The journey that used to lose a record
   ------------------------------------------------------------------------
   Recorded on the INSTRUMENT, in Equipment Management. Asked for from
   PERSONNEL. Nothing was copied by hand in between.
   ======================================================================== */
console.log('\n[3] Training recorded on an instrument reaches the personnel file');

const competence = await j(`/equipment/${equipmentId}/competencies`, {
  method: 'POST', token: A,
  body: {
    staffId, trainingDate: today, trainingHours: 3,
    deliveryMode: 'external', trainerType: 'external_person',
    externalTrainerName: 'Kwame Boateng', externalTrainerOrganisation: 'Sysmex West Africa',
    assessmentMethod: 'direct_observation', assessmentDate: today,
    outcome: 'competent', authorized: true, authorizationLevel: 'Perform',
  },
});
check('equipment competence with an outside trainer is accepted', competence.status === 201, JSON.stringify(competence.json));
check('and it raised a training event of its own', Boolean(competence.json?.trainingEventId), JSON.stringify(competence.json));

const noName = await j(`/equipment/${equipmentId}/competencies`, {
  method: 'POST', token: A,
  body: { staffId, trainerType: 'external_person', outcome: 'competent' },
});
check('the equipment form refuses an unnamed outside trainer too', noName.status === 400, JSON.stringify(noName.json));

const file = await j(`/personnel/training-record/${staffId}`, { token: A });
check('the personnel side answers with a training file', file.status === 200, JSON.stringify(file.json)?.slice(0, 120));
const entries = file.json?.entries ?? [];
check('the session the engineer gave is on it',
  entries.some(e => String(e.title).includes(`XN-550 operator training ${stamp}`)), JSON.stringify(entries.map(e => e.title)));
// The claim this whole change rests on.
check('and so is the training recorded against the instrument',
  entries.some(e => e.origin === 'equipment'), JSON.stringify(entries.map(e => `${e.origin}:${e.title}`)));
check('the outside trainer is named on it, not left blank',
  entries.some(e => String(e.trainerName).includes('Kwame Boateng')), JSON.stringify(entries.map(e => e.trainerName)));

/* The duplicate this design has to avoid: the equipment record and the event
   it raised are one piece of training, not two. */
const equipmentEntries = entries.filter(e => e.origin === 'equipment');
check('the equipment record and the event it raised appear once, not twice',
  equipmentEntries.length === 1, `${equipmentEntries.length} equipment entries`);

/* ==========================================================================
   [4] What the file adds up to
   ======================================================================== */
console.log('\n[4] The totals, stated honestly');

const summary = file.json?.summary ?? {};
check('the file counts every record', Number(summary.total) === entries.length, JSON.stringify(summary));
check('it counts the externally delivered ones', Number(summary.external) >= 2, JSON.stringify(summary));
check('and the ones given on an instrument', Number(summary.onEquipment) >= 1, JSON.stringify(summary));
// A file that quietly reports "12 hours" when half its records carry no
// duration is worse than one that admits it.
check('records with no duration are counted separately rather than hidden',
  typeof summary.withoutHours === 'number', JSON.stringify(summary));

const profile = await j(`/staff/${staffId}`, { token: A });
check('the staff profile carries the same file', Number(profile.json?.training?.summary?.total) === entries.length,
  JSON.stringify(profile.json?.training?.summary));

/* ==========================================================================
   [5] Did it work?
   ======================================================================== */
console.log('\n[5] The question a training register is asked and could not answer');

const review = await j(`/personnel/training/${eventId}/effectiveness`, {
  method: 'POST', token: A,
  body: { outcome: 'effective', notes: 'Both operators running the analyser unsupervised since.' },
});
check('an effectiveness review can be recorded', review.status === 200, JSON.stringify(review.json));
const reviewed = await j(`/personnel/training/${eventId}`, { token: A });
check('and the session says so', reviewed.json?.effectiveness_outcome === 'effective', String(reviewed.json?.effectiveness_outcome));
check('with who reviewed it and when', Boolean(reviewed.json?.effectiveness_reviewed_at));

const rubbish = await j(`/personnel/training/${eventId}/effectiveness`, {
  method: 'POST', token: A, body: { outcome: 'went well' },
});
check('an outcome outside the vocabulary is refused', rubbish.status === 400, JSON.stringify(rubbish.json));

/* The equipment file owns its own record, so editing its shadow here would be
   overwritten the next time the equipment record is saved. */
const shadowId = competence.json?.trainingEventId;
const editShadow = await j(`/personnel/training/${shadowId}`, {
  method: 'PUT', token: A, body: { title: 'Renamed behind the equipment record\'s back' },
});
check('a session raised by the equipment file cannot be edited from the training register',
  editShadow.status === 400, JSON.stringify(editShadow.json));
check('and says where the record actually lives',
  /Equipment Management/i.test(String(editShadow.json?.error ?? '')), editShadow.json?.error);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
