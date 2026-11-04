/**
 * Units, and the thousandfold error they were hiding.
 *
 * A Sysmex XN shows RET# on its own screen as 267.3 x10^9/L and transmits the
 * same reading as 0.2673 x10^6/uL. Both are correct. Both are the same
 * concentration. SECHLIMS recorded whatever arrived and never looked at the
 * unit again, so:
 *
 *   • the bench read 0.2673 beside an analyser showing 267.3, and
 *   • a control reading in one scale was charted against a target in the
 *     other, which turns a perfectly good control into a thousandfold
 *     failure, or hides a real one.
 *
 * Form was already guarded — a percentage could not fill a count, which came
 * out of the WBC differentials. Scale was not, and scale is the other half of
 * the same mistake.
 *
 * What this holds shut:
 *   the arithmetic between units, including every spelling an analyser uses;
 *   that a conversion needing a molar mass is REFUSED rather than guessed;
 *   that a reading is rescaled onto its control's unit and says so;
 *   that one which cannot be rescaled is left out and says why;
 *   and that a name matching a parameter's own name is explained, not
 *   reported as a clash with something else.
 *
 *   node scripts/units-check.mjs
 */
import {
  normaliseUnit, sameUnit, unitInfo, conversionFactor, convertValue, comparable, knownUnits,
} from '../shared/constants/units.ts';
import { mapRows } from '../server/services/iqcAnalyteMatching.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

console.log('\nThe reported case');
console.log('-----------------');
{
  const out = convertValue(267.3, '10^9/L', '10*6/uL');
  check('267.3 x10^9/L is 0.2673 x10^6/uL', out.ok && out.value === 0.2673, JSON.stringify(out));
  const back = convertValue(0.2673, '10*6/uL', '10^9/L');
  check('and 0.2673 x10^6/uL is 267.3 x10^9/L', back.ok && back.value === 267.3, JSON.stringify(back));
  check('the conversion reports the factor it used', back.ok && back.factor === 1000, String(back.factor));
  check('and reports that the number actually moved', back.ok && back.changed === true);
}

console.log('\nEvery spelling an analyser uses is the same unit');
console.log('------------------------------------------------');
for (const spelling of ['10*6/uL', '10^6/uL', '10E6/uL', 'x10(6)/uL', '×10⁶/µL', '10^6/UL', '10**6/ul']) {
  check(`${spelling} is 10^6/uL`, sameUnit(spelling, '10^6/uL'), normaliseUnit(spelling));
}
check('a superscript run is not flattened into a bigger number',
  normaliseUnit('×10⁶/µL') === '10^6/ul', normaliseUnit('×10⁶/µL'));
check('10^3/uL and 10^9/L are the same unit written two ways', sameUnit('10^3/uL', '10^9/L'));
check('10^6/uL and 10^12/L likewise', sameUnit('10^6/uL', '10^12/L'));
check('but 10^3/uL and 10^6/uL are NOT the same', !sameUnit('10^3/uL', '10^6/uL'));

console.log('\nWhat it must refuse');
console.log('-------------------');
{
  const molar = convertValue(90, 'mg/dL', 'mmol/L');
  check('mg/dL to mmol/L is refused: it needs a molar mass',
    !molar.ok && molar.reason === 'different_dimension', JSON.stringify(molar));
  check('and the refusal says why, in words', /molar mass/i.test(String(molar.note)), String(molar.note));

  check('a percentage is never rescaled into a count',
    !convertValue(6.29, '%', '10^9/L').ok);
  check('a unit nothing recognises is refused rather than assumed',
    !convertValue(5, 'squiggles/fortnight', '10^9/L').ok);
  check('a reading that is not a number is refused',
    !convertValue('CLOTTED', '10^9/L', '10^3/uL').ok);
  check('an unknown unit is reported as unknown', unitInfo('squiggles').dimension === 'unknown');
  check('no factor is offered across dimensions', conversionFactor('g/dL', 'mmol/L') === null);
}

console.log('\nOrdinary haematology is left alone');
console.log('----------------------------------');
{
  const same = convertValue(7.14, '10^3/uL', '10^9/L');
  check('7.14 x10^3/uL into 10^9/L is still 7.14', same.ok && same.value === 7.14, JSON.stringify(same));
  check('and is marked as not having moved', same.ok && same.changed === false);
  check('g/dL to g/L multiplies by ten', (() => {
    const o = convertValue(13.5, 'g/dL', 'g/L'); return o.ok && o.value === 135;
  })());
  check('the floating-point dust is trimmed', (() => {
    const o = convertValue(267.3, '10^9/L', '10^6/uL'); return o.ok && String(o.value) === '0.2673';
  })(), String(convertValue(267.3, '10^9/L', '10^6/uL').value));
}

console.log('\nMay two readings be compared at all?');
console.log('------------------------------------');
check('a reading and a target in reconcilable units may be compared',
  comparable('10*6/uL', '10^9/L').ok);
check('and the factor between them is reported', comparable('10*6/uL', '10^9/L').factor === 1000);
check('units that cannot be reconciled may NOT be compared', !comparable('mg/dL', 'mmol/L').ok);
check('a percentage may not be compared against a count', !comparable('%', '10^9/L').ok);
// A laboratory that has never entered units must not have its quality control
// stop overnight, so silence on either side is not treated as a contradiction.
check('silence on either side is not a contradiction', comparable('', '10^9/L').ok && comparable('10^9/L', '').ok);

console.log('\nA control run, which is where a wrong unit becomes a wrong verdict');
console.log('------------------------------------------------------------------');
{
  const control = [
    { id: 1, analyte: 'RET#', unit: '10^9/L' },
    { id: 2, analyte: 'RET%', unit: '%' },
    { id: 3, analyte: 'WBC', unit: '10^9/L' },
    { id: 4, analyte: 'GLUC', unit: 'mmol/L' },
  ];
  const grid = [['RET#', 0.2673], ['RET%', 6.29], ['WBC', 7.14], ['GLUC', 90]];
  const units = ['10*6/uL', '%', '10^3/uL', 'mg/dL'];
  const m = mapRows(grid, control, units);
  const by = Object.fromEntries(m.readings.map(r => [r.analyte, r]));

  check('the reticulocyte count is rescaled onto the control’s unit',
    by['RET#']?.value === 267.3, String(by['RET#']?.value));
  check('and keeps what it was before, so the change can be audited',
    by['RET#']?.originalValue === 0.2673 && by['RET#']?.converted?.factor === 1000,
    JSON.stringify(by['RET#']?.converted));
  check('and records the unit the analyser actually sent',
    by['RET#']?.sourceUnit === '10*6/uL', String(by['RET#']?.sourceUnit));
  check('a percentage is untouched', by['RET%']?.value === 6.29 && !by['RET%']?.converted);
  check('a reading already in the right scale is untouched',
    by['WBC']?.value === 7.14 && !by['WBC']?.converted);

  check('a reading that cannot be reconciled is NOT placed', by['GLUC'] === undefined);
  check('it is reported as a unit conflict instead of silently dropped',
    m.unitConflicts.length === 1 && m.unitConflicts[0].analyte === 'GLUC',
    JSON.stringify(m.unitConflicts));
  check('the conflict names both units and the reason',
    /mg\/dL/.test(m.unitConflicts[0]?.note ?? '') && /mmol\/L/.test(m.unitConflicts[0]?.note ?? ''),
    m.unitConflicts[0]?.note);
  check('and the parameter shows as missing from the run, which is visible',
    m.missingAnalytes.some(a => a.analyte === 'GLUC'));

  // The whole point: unconverted, this run would have been charted against a
  // target a thousandfold away.
  check('nothing is placed in the analyser’s own scale by accident',
    !m.readings.some(r => r.value === 0.2673));
}

console.log('\nA laboratory that states no units keeps working');
console.log('-----------------------------------------------');
{
  const control = [{ id: 1, analyte: 'WBC', unit: null }, { id: 2, analyte: 'HGB', unit: '' }];
  const m = mapRows([['WBC', 6.2], ['HGB', 13.1]], control, ['10^9/L', null]);
  check('readings are placed when the control states no unit', m.matched === 2, JSON.stringify(m.readings));
  check('and nothing is reported as a conflict', m.unitConflicts.length === 0);
}
{
  // The path every pasted spreadsheet still takes: no units supplied at all.
  const control = [{ id: 1, analyte: 'WBC', unit: '10^9/L' }];
  const m = mapRows([['WBC', 6.2]], control);
  check('a pasted grid with no units behaves exactly as before', m.matched === 1 && m.readings[0].value === 6.2);
}

console.log('\nThe picker has something to offer');
console.log('---------------------------------');
{
  const units = knownUnits();
  check('the known units are listed', units.length > 20, `${units.length} listed`);
  check('and include the two from this fault',
    units.some(u => u.canonical === '10^9/L') && units.some(u => u.canonical === '10^6/uL'));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
