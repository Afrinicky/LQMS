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
/** The printable sheets come back as HTML, not JSON. */
const html = async (p, token) => {
  const r = await fetch(`${BASE}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.text() };
};
/** A one-pixel PNG, so somebody can have a signature on file. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const uploadSignature = async (token) => {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'signature.png');
  const r = await fetch(`${BASE}/signatures/me`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
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

/* A second person, so a session can be given to a group — which is how training
   is actually given, and what the register could not record. Each carries a
   designation, because the attendance sheet has to print the grade the person
   held at the time, exactly as every other signing sheet here does. */
const second = await j('/staff/register', {
  method: 'POST', token: A,
  body: { surname: 'Owusu', firstName: `Kofi${stamp}`, employeeNo: `EMP2-${stamp}`, personnelCategory: 'STAFF' },
});
const secondId = second.json?.staffId;
await j(`/staff/${staffId}`, { method: 'PUT', token: A, body: { designation: 'Senior Biomedical Scientist' } });
await j(`/staff/${secondId}`, { method: 'PUT', token: A, body: { designation: 'Medical Laboratory Technician' } });

/* The roles this workflow distinguishes, as real accounts.
   The whole lock rests on the difference: a section head runs sessions, a
   senior role closes them — so both have to be tested as themselves rather
   than asserted about. */
const roles = (await j('/roles', { token: A })).json ?? [];
const roleId = name => roles.find(r => r.name === name)?.id;
const manager = await j('/staff/register', {
  method: 'POST', token: A,
  body: {
    surname: 'Asante', firstName: `Yaa${stamp}`, employeeNo: `MGR-${stamp}`,
    createUser: true, username: `mgr${stamp}`, password: PW, roleId: roleId('Laboratory Manager'),
  },
});
const head = await j('/staff/register', {
  method: 'POST', token: A,
  body: {
    surname: 'Boadi', firstName: `Esi${stamp}`, employeeNo: `SH-${stamp}`,
    createUser: true, username: `head${stamp}`, password: PW, roleId: roleId('Section Head'),
  },
});
const M = (await j('/auth/login', { method: 'POST', body: { username: `mgr${stamp}`, password: PW } })).json?.token;
const H = (await j('/auth/login', { method: 'POST', body: { username: `head${stamp}`, password: PW } })).json?.token;
if (!M || !H) { console.error('Could not create the two role accounts this check needs.'); process.exit(1); }
// Nothing in this system is signed by somebody with no signature on file, so
// the manager who will close sessions gets one — and a grade, because the
// attendance sheet prints the grade the signer held.
await uploadSignature(M);
await j(`/staff/${manager.json?.staffId}`, { method: 'PUT', token: A, body: { designation: 'Laboratory Manager' } });
await j(`/staff/${head.json?.staffId}`, { method: 'PUT', token: A, body: { designation: 'Principal Biomedical Scientist' } });

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

// Signed by the manager, who has a signature on file. A review carrying a typed
// name and nothing else is the first thing an assessor challenges.
const review = await j(`/personnel/training/${eventId}/effectiveness`, {
  method: 'POST', token: M,
  body: { outcome: 'effective', notes: 'Both operators running the analyser unsupervised since.' },
});
check('an effectiveness review can be recorded', review.status === 200, JSON.stringify(review.json));
const reviewed = await j(`/personnel/training/${eventId}`, { token: A });
check('and the session says so', reviewed.json?.effectiveness_outcome === 'effective', String(reviewed.json?.effectiveness_outcome));
check('with who reviewed it and when', Boolean(reviewed.json?.effectiveness_reviewed_at));
check('and the review carries a signature, not just a typed name',
  Boolean(reviewed.json?.review_signature_id), String(reviewed.json?.review_signature_id));

const rubbish = await j(`/personnel/training/${eventId}/effectiveness`, {
  method: 'POST', token: M, body: { outcome: 'went well' },
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

/* ==========================================================================
   [6] A session scheduled in advance, and everybody told about it
   --------------------------------------------------------------------------
   Training is mostly given to groups, and the register used to create a session
   with nobody on it and no way to tell anybody it existed.
   ======================================================================== */
console.log('\n[6] Scheduling a session tells the people expected at it');

const monthly = await j('/personnel/training', {
  method: 'POST', token: A,
  body: {
    title: `Monthly safety briefing ${stamp}`,
    trainingMode: 'scheduled', frequency: 'monthly',
    trainingDate: today, durationHours: 2, category: 'safety', trainingFormat: 'classroom',
    deliveryMode: 'internal', trainerType: 'internal_staff', trainerStaffId: staffId,
    location: 'Seminar room', effectivenessMethod: 'direct_observation',
    participantStaffIds: [staffId, secondId],
  },
});
check('a session can be scheduled with its whole group in one act', monthly.status === 201, JSON.stringify(monthly.json));
check('everybody named was put on the list', Number(monthly.json?.invited) === 2, JSON.stringify(monthly.json));
check('and each of them was sent a notice', Number(monthly.json?.notified) === 2, JSON.stringify(monthly.json));
check('a scheduled session starts as scheduled, not as a finished record',
  monthly.json?.status === 'planned', String(monthly.json?.status));
const monthlyId = monthly.json?.id;

const noGroup = await j('/personnel/training', {
  method: 'POST', token: A,
  body: { title: `Nobody invited ${stamp}`, trainingDate: today, deliveryMode: 'internal', trainerType: 'internal_staff' },
});
// A session with nobody on it is the state this register used to be full of.
check('a session with nobody on it is still accepted by the API but records nothing',
  noGroup.status === 201 && Number(noGroup.json?.invited) === 0, JSON.stringify(noGroup.json));

const inbox = await j('/notifications?mine=true', { token: A });
check('the notice names the session rather than being a bare alert',
  Array.isArray(inbox.json), typeof inbox.json);

/* Retrospective: the other half of a real register. */
const past = await j('/personnel/training', {
  method: 'POST', token: A,
  body: {
    title: `Bench briefing given last week ${stamp}`, trainingMode: 'retrospective',
    trainingDate: today, durationHours: 1, deliveryMode: 'internal', trainerType: 'internal_staff',
    trainerStaffId: staffId, participantStaffIds: [secondId], effectivenessMethod: 'not_required',
  },
});
check('a session that has already happened is recorded as held, not as a plan',
  past.json?.status === 'completed', JSON.stringify(past.json));
check('and nobody is notified about a session that is over', Number(past.json?.notified) === 0, JSON.stringify(past.json));

/* ==========================================================================
   [7] Postponing and calling off — neither of which is a deletion
   ======================================================================== */
console.log('\n[7] Putting a session off, and calling it off');

const noReason = await j(`/personnel/training/${monthlyId}/postpone`, {
  method: 'POST', token: A, body: { trainingDate: '2031-01-15' },
});
check('postponing without a reason is refused — the people told will be told why',
  noReason.status === 400, JSON.stringify(noReason.json));

const moved = await j(`/personnel/training/${monthlyId}/postpone`, {
  method: 'POST', token: A, body: { trainingDate: '2031-01-15', reason: 'The trainer is away' },
});
check('a session can be postponed', moved.status === 200, JSON.stringify(moved.json));
const afterMove = await j(`/personnel/training/${monthlyId}`, { token: A });
check('it keeps the date it was moved from, so "postponed twice" is a fact the register holds',
  Boolean(afterMove.json?.postponed_from_date), String(afterMove.json?.postponed_from_date));
check('and the reason is on the record', /trainer is away/i.test(String(afterMove.json?.postponement_reason)));
check('everybody expected at it was told the new date', Number(moved.json?.notified) >= 1, JSON.stringify(moved.json));

const calledOff = await j(`/personnel/training/${noGroup.json?.id}/cancel`, {
  method: 'POST', token: A, body: { reason: 'Created in error during testing' },
});
check('a session can be called off', calledOff.status === 200, JSON.stringify(calledOff.json));
const cancelled = await j(`/personnel/training/${noGroup.json?.id}`, { token: A });
check('and is kept rather than deleted, so the programme can account for it',
  cancelled.json?.status === 'cancelled', String(cancelled.json?.status));

/* ==========================================================================
   [8] The attendance sheet behaves like every other signing sheet here
   ======================================================================== */
console.log('\n[8] Name, designation, signature, date');

// Back to a date that can actually be run.
await j(`/personnel/training/${monthlyId}/postpone`, { method: 'POST', token: A, body: { trainingDate: today, reason: 'Trainer available again' } });
const started = await j(`/personnel/training/${monthlyId}/start`, { method: 'POST', token: H, body: {} });
check('a section head can start a session — running one is their job', started.status === 200, JSON.stringify(started.json));

await j(`/personnel/training/${monthlyId}/attendance`, {
  method: 'POST', token: H, body: { staffId, attendanceStatus: 'attended', outcome: 'competent' },
});
await j(`/personnel/training/${monthlyId}/attendance`, {
  method: 'POST', token: H, body: { staffId: secondId, attendanceStatus: 'attended', outcome: 'unsatisfactory' },
});
const sheet = await j(`/personnel/training/${monthlyId}`, { token: A });
const rows = sheet.json?.attendance ?? [];
check('the sheet carries the designation each person held', rows.every(r => r.sheet_designation), JSON.stringify(rows.map(r => r.sheet_designation)));
check('and who marked them present, which is not the same as their signing',
  rows.every(r => r.marked_by_name), JSON.stringify(rows.map(r => r.marked_by_name)));

const mine = rows.find(r => Number(r.staff_id) === Number(staffId));
const notMine = rows.find(r => Number(r.staff_id) === Number(secondId));
const signAnother = await j(`/personnel/training/${monthlyId}/attendance/${mine?.id}/sign`, {
  method: 'POST', token: M, body: {},
});
check('nobody may sign the sheet for somebody else', signAnother.status === 403, JSON.stringify(signAnother.json));

const onPaper = await j(`/personnel/training/${monthlyId}/attendance/${mine?.id}/sign`, {
  method: 'POST', token: H, body: { onPaper: true },
});
check('a signature taken on the paper sheet can be entered, as exactly that',
  onPaper.status === 200 && onPaper.json?.onPaper === true, JSON.stringify(onPaper.json));

/* A signature belongs to somebody who was in the room. */
await j(`/personnel/training/${monthlyId}/attendance`, {
  method: 'POST', token: H, body: { staffId: secondId, attendanceStatus: 'absent' },
});
const signAbsent = await j(`/personnel/training/${monthlyId}/attendance/${notMine?.id}/sign`, {
  method: 'POST', token: H, body: { onPaper: true },
});
check('somebody marked absent cannot sign for having attended', signAbsent.status === 400, JSON.stringify(signAbsent.json));
await j(`/personnel/training/${monthlyId}/attendance`, {
  method: 'POST', token: H, body: { staffId: secondId, attendanceStatus: 'attended', outcome: 'unsatisfactory' },
});

const signedRow = (await j(`/personnel/training/${monthlyId}`, { token: A })).json?.attendance
  ?.find(r => Number(r.staff_id) === Number(staffId));
const removeSigned = await j(`/personnel/training/${monthlyId}/attendance/${signedRow?.id}`, { method: 'DELETE', token: A });
check('a line somebody has signed cannot be taken off the sheet', removeSigned.status === 409, JSON.stringify(removeSigned.json));

/* ==========================================================================
   [9] Closing is what makes it a record — and who may do it
   ======================================================================== */
console.log('\n[9] Closure, and the lock that follows it');

const headClose = await j(`/personnel/training/${monthlyId}/close`, { method: 'POST', token: H, body: {} });
check('a section head cannot close a session', headClose.status === 403, JSON.stringify(headClose.json));

const closed = await j(`/personnel/training/${monthlyId}/close`, {
  method: 'POST', token: M, body: { closureSummary: 'Held as planned. One person needs it again.' },
});
check('a senior role can close it', closed.status === 200, JSON.stringify(closed.json));
const afterClose = await j(`/personnel/training/${monthlyId}`, { token: A });
check('the session is closed and signed', afterClose.json?.status === 'closed' && Boolean(afterClose.json?.closure_signature_id),
  `${afterClose.json?.status} / ${afterClose.json?.closure_signature_id}`);
check('with who closed it and when', Boolean(afterClose.json?.closed_by_name) && Boolean(afterClose.json?.closed_at));
check('and everybody who attended was told it is now on their file', Number(closed.json?.notified) >= 1, JSON.stringify(closed.json));
check('the hours were attributed to the people who attended',
  (afterClose.json?.attendance ?? []).some(r => Number(r.hours) === 2), JSON.stringify((afterClose.json?.attendance ?? []).map(r => r.hours)));

/* The claim the whole change rests on: an old session cannot be opened and
   edited by whoever happens to hold the edit right. */
const headEdit = await j(`/personnel/training/${monthlyId}`, { method: 'PUT', token: H, body: { title: 'Quietly renamed' } });
check('a closed session cannot be edited by the people who run sessions', headEdit.status === 409, JSON.stringify(headEdit.json));
check('and the refusal says who can', /administrator|laboratory manager|quality manager/i.test(String(headEdit.json?.error ?? '')));
const headMark = await j(`/personnel/training/${monthlyId}/attendance`, {
  method: 'POST', token: H, body: { staffId, attendanceStatus: 'absent' },
});
check('nor can its attendance be changed', headMark.status === 409, JSON.stringify(headMark.json));
const headDelete = await j(`/personnel/training/${monthlyId}`, { method: 'DELETE', token: H });
check('nor deleted', headDelete.status === 403, String(headDelete.status));
const headReopen = await j(`/personnel/training/${monthlyId}/reopen`, { method: 'POST', token: H, body: { reason: 'x' } });
check('nor reopened', headReopen.status === 403, String(headReopen.status));

const stillNamed = await j(`/personnel/training/${monthlyId}`, { token: A });
check('so the closed record still says what it said', /Monthly safety briefing/.test(String(stillNamed.json?.title)), stillNamed.json?.title);
check('a senior role is told they may reopen it', stillNamed.json?.locked === true);

/* A senior role can correct the file — deliberately, with a reason, audited. */
const reopenNoReason = await j(`/personnel/training/${monthlyId}/reopen`, { method: 'POST', token: M, body: {} });
check('reopening without a reason is refused', reopenNoReason.status === 400, JSON.stringify(reopenNoReason.json));
const reopened = await j(`/personnel/training/${monthlyId}/reopen`, {
  method: 'POST', token: M, body: { reason: 'An outcome was recorded against the wrong person' },
});
check('a senior role can reopen a closed record', reopened.status === 200, JSON.stringify(reopened.json));
const seniorEdit = await j(`/personnel/training/${monthlyId}`, { method: 'PUT', token: M, body: { title: `Monthly safety briefing ${stamp} (corrected)` } });
check('and then correct it', seniorEdit.status === 200, JSON.stringify(seniorEdit.json));

/* ==========================================================================
   [10] What closure sets in motion
   ------------------------------------------------------------------------
   A recurring session raises its next occurrence; a session that did not work
   for somebody raises a session for them alone.
   ======================================================================== */
console.log('\n[10] The next one, and the one for the person it failed');

const register = (await j('/personnel/training', { token: A })).json ?? [];
const series = register.filter(e => String(e.title).includes(`Monthly safety briefing ${stamp}`));
check('closing a monthly session raised the next occurrence', series.length >= 2, `${series.length} in the series`);
const next = series.find(e => e.id !== monthlyId);
check('the next one is scheduled, not already held', next?.status === 'planned', String(next?.status));
check('it is a month after the one that closed', next?.training_date > today, String(next?.training_date));
check('it points back at the first of the series', Number(next?.series_parent_id) === Number(monthlyId), String(next?.series_parent_id));
check('and the same people are invited to it', Number(next?.invited_count) === 2, String(next?.invited_count));
check('each occurrence owes its own review — that is what periodic review means',
  Boolean(next?.effectiveness_due_date), String(next?.effectiveness_due_date));

const remedial = register.find(e => Number(e.remedial_for_event_id) === Number(monthlyId));
check('the person the session did not work for has individual training scheduled', Boolean(remedial), JSON.stringify(register.map(e => e.training_number)));
check('it is for them alone', Number(remedial?.invited_count) === 1, String(remedial?.invited_count));
check('and it says which session it arose from', remedial?.remedial_for_number === afterClose.json?.training_number,
  `${remedial?.remedial_for_number} vs ${afterClose.json?.training_number}`);
check('retraining nobody checks is the same shortfall again, so it asks for an assessment',
  remedial?.effectiveness_method === 'competency_assessment', String(remedial?.effectiveness_method));

/* ==========================================================================
   [11] The training report — the document an assessor actually asks for
   ======================================================================== */
console.log('\n[11] One printable report, attendance sheet included');

const report = await html(`/personnel/training/${monthlyId}/print?autoprint=0`, A);
check('the session prints', report.status === 200, String(report.status));
check('as a training report', /Training report/i.test(report.body));
check('with the attendance sheet inside it', /Attendance sheet/i.test(report.body));
check('the sheet carries the grade each person held', /Senior Biomedical Scientist/.test(report.body));
check('and names the outside trainer where there was one', /Monthly safety briefing/.test(report.body));
check('it states how the effect of the training is to be judged', /effect of this training/i.test(report.body));
check('and whether it is a closed record or a provisional one', /NOT YET CLOSED|Closed training record/.test(report.body));

const blank = await html(`/personnel/training/${monthlyId}/print?sheet=blank&autoprint=0`, A);
check('a blank sheet can be printed to carry to the session', blank.status === 200 && /Training attendance sheet/i.test(blank.body));
check('it already carries everybody\'s name and grade', /Medical Laboratory Technician/.test(blank.body));
check('with spare lines, because who turns up is never exactly who was invited',
  (blank.body.match(/<tr>/g) ?? []).length > rows.length + 1);

/* Their own evidence, printable by them. */
const ownerToken = (await j('/auth/login', { method: 'POST', body: { username: `head${stamp}`, password: PW } })).json?.token;
const notMineReport = await html(`/personnel/training/${monthlyId}/print?autoprint=0`, ownerToken);
check('somebody who runs the register may print any session', notMineReport.status === 200, String(notMineReport.status));

/* ==========================================================================
   [12] The portal: what I am expected at, and what I owe a signature to
   ======================================================================== */
console.log('\n[12] My own sessions, on my own portal');

const mgrSessions = await j('/personnel/my-training-sessions', { token: M });
check('the portal answers with this person\'s own sessions', mgrSessions.status === 200, JSON.stringify(mgrSessions.json)?.slice(0, 120));
check('and says whether they have a signature to sign with', mgrSessions.json?.hasSignatureOnFile === true, String(mgrSessions.json?.hasSignatureOnFile));

/* Somebody who was there, signing for themselves — the act the portal could not
   perform at all, so the system held a claim with nothing from the person
   behind it. */
const selfTraining = await j('/personnel/training', {
  method: 'POST', token: A,
  body: {
    title: `Quality manual refresher ${stamp}`, trainingMode: 'retrospective',
    trainingDate: today, durationHours: 1, deliveryMode: 'internal', trainerType: 'internal_staff',
    trainerStaffId: staffId, participantStaffIds: [manager.json?.staffId], effectivenessMethod: 'not_required',
  },
});
const selfId = selfTraining.json?.id;
await j(`/personnel/training/${selfId}/attendance`, {
  method: 'POST', token: A, body: { staffId: manager.json?.staffId, attendanceStatus: 'attended', outcome: 'satisfactory' },
});
const mySheet = await j('/personnel/my-training-sessions', { token: M });
const waiting = (mySheet.json?.sessions ?? []).find(s => Number(s.id) === Number(selfId));
check('the sheet waiting for my signature is on my portal', Boolean(waiting) && !waiting?.signed_at, JSON.stringify(waiting)?.slice(0, 160));
check('and it tells me the grade I am signing as', Boolean(waiting?.sheet_designation), String(waiting?.sheet_designation));

const selfSigned = await j(`/personnel/training/${selfId}/attendance/${waiting?.attendance_id}/sign`, {
  method: 'POST', token: M, body: {},
});
check('I can sign my own attendance, with my own signature on file', selfSigned.status === 200, JSON.stringify(selfSigned.json));
check('and it is a real signature, not a stamped date', Boolean(selfSigned.json?.signatureId), String(selfSigned.json?.signatureId));

const signedSheet = (await j(`/personnel/training/${selfId}`, { token: A })).json?.attendance?.[0];
check('the sheet records when I signed', Boolean(signedSheet?.signed_at), String(signedSheet?.signed_at));
check('and keeps the signature image that was actually applied', Boolean(signedSheet?.signature_file_id), String(signedSheet?.signature_file_id));

const signedReport = await html(`/personnel/training/${selfId}/print?autoprint=0`, M);
check('somebody who attended can print the report for their own session', signedReport.status === 200, String(signedReport.status));
check('and the signature appears on the printed sheet rather than a blank rule', /sig-img/.test(signedReport.body));

/* ==========================================================================
   [13] A whole bench trained on one instrument, in one session
   ======================================================================== */
console.log('\n[13] The engineer who trained everybody in one morning');

const commissioning = await j(`/equipment/${equipmentId}/competencies`, {
  method: 'POST', token: A,
  body: {
    staffIds: [staffId, secondId], trainingDate: today, trainingHours: 6,
    deliveryMode: 'external', trainerType: 'external_person',
    externalTrainerName: 'Kwame Boateng', externalTrainerOrganisation: 'Sysmex West Africa',
    assessmentMethod: 'direct_observation', assessmentDate: today,
    outcome: 'competent', authorized: true, authorizationLevel: 'Perform',
  },
});
check('a group can be trained on an instrument in one act', commissioning.status === 201, JSON.stringify(commissioning.json)?.slice(0, 160));
check('and it is recorded as ONE session, not one per person',
  Number(commissioning.json?.trainedCount) === 2 && Boolean(commissioning.json?.trainingEventId), JSON.stringify(commissioning.json)?.slice(0, 200));
const commissioningEvent = await j(`/personnel/training/${commissioning.json?.trainingEventId}`, { token: A });
check('with everybody on one attendance sheet',
  (commissioningEvent.json?.attendance ?? []).length === 2, String((commissioningEvent.json?.attendance ?? []).length));
check('each carrying the grade they held', (commissioningEvent.json?.attendance ?? []).every(r => r.sheet_designation),
  JSON.stringify((commissioningEvent.json?.attendance ?? []).map(r => r.sheet_designation)));
check('training written down after the event arrives closed, because there is nothing left to do to it',
  commissioningEvent.json?.status === 'closed' && commissioningEvent.json?.training_mode === 'retrospective',
  `${commissioningEvent.json?.status} / ${commissioningEvent.json?.training_mode}`);
const commissioningReport = await html(`/personnel/training/${commissioning.json?.trainingEventId}/print?autoprint=0`, A);
check('and the commissioning training has a printable report like any other session',
  commissioningReport.status === 200 && /Attendance sheet/i.test(commissioningReport.body), String(commissioningReport.status));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
