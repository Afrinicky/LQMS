/**
 * The run form takes its date and time from the analyser's own stamp.
 *
 * A transmission carries the moment the instrument completed the test. The form
 * was stamping the moment somebody pressed Fetch, which is a different thing: a
 * control run at 06:15 on the night shift and brought in at the morning
 * handover was recorded as a morning run, and a stored moving average carrying
 * its own date was recorded as today — turning a fortnight of history into one
 * point on the chart.
 *
 *   npx tsx scripts/iqc-run-stamp-check.mts
 */
import { runStampFrom } from '../shared/constants/iqc.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const TODAY = '2026-10-05';

console.log('\n[1] What the instrument said it ran');
check('an ASTM completion time is taken as the run date and time',
  JSON.stringify(runStampFrom({ instrument_run_at: '2026-10-05T06:15:00' }, TODAY))
  === JSON.stringify({ date: '2026-10-05', time: '06:15' }),
  JSON.stringify(runStampFrom({ instrument_run_at: '2026-10-05T06:15:00' }, TODAY)));

check('a stored moving average keeps the day the analyser computed it',
  JSON.stringify(runStampFrom({ instrument_run_at: '2025-09-12T06:15:00', received_at: '2026-10-05 15:07:24' }, TODAY))
  === JSON.stringify({ date: '2025-09-12', time: '06:15' }),
  JSON.stringify(runStampFrom({ instrument_run_at: '2025-09-12T06:15:00', received_at: '2026-10-05 15:07:24' }, TODAY)));

console.log('\n[2] When the transmission states no completion time');
check('the moment it reached this host is used instead',
  JSON.stringify(runStampFrom({ instrument_run_at: null, received_at: '2026-10-05 15:07:24' }, TODAY))
  === JSON.stringify({ date: '2026-10-05', time: '15:07' }),
  JSON.stringify(runStampFrom({ instrument_run_at: null, received_at: '2026-10-05 15:07:24' }, TODAY)));

check('a date with no time still files the run on the right day',
  JSON.stringify(runStampFrom({ instrument_run_at: '2026-09-30' }, TODAY))
  === JSON.stringify({ date: '2026-09-30', time: '' }),
  JSON.stringify(runStampFrom({ instrument_run_at: '2026-09-30' }, TODAY)));

console.log('\n[3] Nothing to take, and nothing taken');
for (const [what, value] of [
  ['no transmission at all', null],
  ['a pasted sheet, which carries no stamp', {}],
  ['an unreadable stamp', { instrument_run_at: 'not a date' }],
] as Array<[string, any]>) {
  check(`${what} leaves the form's own date alone`, runStampFrom(value, TODAY) === null,
    JSON.stringify(runStampFrom(value, TODAY)));
}

console.log('\n[4] An analyser whose clock runs fast');
/*
 * A control run cannot have happened tomorrow. The form refuses a future date
 * and the record could not justify one, so the stamp is held at today rather
 * than quietly producing a run the laboratory cannot save.
 */
check('a stamp in the future is held at today, keeping its time',
  JSON.stringify(runStampFrom({ instrument_run_at: '2027-01-02T08:00:00' }, TODAY))
  === JSON.stringify({ date: TODAY, time: '08:00' }),
  JSON.stringify(runStampFrom({ instrument_run_at: '2027-01-02T08:00:00' }, TODAY)));
check('and a future date with no time likewise',
  JSON.stringify(runStampFrom({ instrument_run_at: '2027-01-02' }, TODAY))
  === JSON.stringify({ date: TODAY, time: '' }),
  JSON.stringify(runStampFrom({ instrument_run_at: '2027-01-02' }, TODAY)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
