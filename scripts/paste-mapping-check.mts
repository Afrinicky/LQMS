/**
 * Taking a parameter mapping the laboratory already has, rather than typing it.
 *
 * The identifiers a receiving system files results under are not a thing
 * anybody remembers for thirty parameters. They are already written down — in
 * the LHIMS middleware's own ParameterMappings table, which pairs
 * InstParameterCode with ParameterID, or in a configuration file, or in a
 * spreadsheet. Pasting that beats filling in thirty boxes, and beats the
 * transposed digit that files a haemoglobin under a platelet count.
 *
 *   npx tsx scripts/paste-mapping-check.mts
 */
import { parsePastedMappings } from '../shared/constants/receivers.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const map = (text: string) => Object.fromEntries(parsePastedMappings(text).rows.map(r => [r.code, r.identifier]));

console.log('\n[1] Copied out of the middleware’s own table');
/* Exactly what the mysql client prints for
   SELECT InstParameterCode, ParameterID FROM ParameterMappings WHERE AnalyzerID='…' */
const mysql = `
+--------------------+-------------+
| InstParameterCode  | ParameterID |
+--------------------+-------------+
| WBC                |          23 |
| RBC                |          24 |
| HGB                |          25 |
| NEUT#              |          33 |
| RDW-SD             |          41 |
+--------------------+-------------+
`;
const fromMysql = map(mysql);
check('five parameters are read', Object.keys(fromMysql).length === 5, JSON.stringify(fromMysql));
check('each under the analyser’s own code', fromMysql['WBC'] === '23' && fromMysql['HGB'] === '25',
  JSON.stringify(fromMysql));
check('a code with punctuation survives', fromMysql['NEUT#'] === '33' && fromMysql['RDW-SD'] === '41',
  JSON.stringify(fromMysql));
check('the header row is not taken for a mapping',
  !('InstParameterCode' in fromMysql) && !('ParameterID' in fromMysql), JSON.stringify(Object.keys(fromMysql)));

console.log('\n[2] The ordinary shapes a laboratory pastes');
check('comma separated', map('WBC,23\nHGB,25')['WBC'] === '23');
check('tab separated', map('WBC\t23\nHGB\t25')['HGB'] === '25');
check('an equals sign', map('WBC=23')['WBC'] === '23');
check('a colon', map('WBC: 23')['WBC'] === '23');
check('aligned columns', map('WBC      23\nHGB      25')['WBC'] === '23');
check('a single space, where the identifier is last', map('WBC 23')['WBC'] === '23');
check('a code containing a space', map('Take Mode, 41')['Take Mode'] === '41', JSON.stringify(map('Take Mode, 41')));
check('a code containing a space, no comma', map('Take Mode 41')['Take Mode'] === '41', JSON.stringify(map('Take Mode 41')));
check('the identifier written first', map('23, WBC')['WBC'] === '23', JSON.stringify(map('23, WBC')));
check('a CSV header is skipped', !('code' in map('code,id\nWBC,23')), JSON.stringify(map('code,id\nWBC,23')));

console.log('\n[3] An identifier that is not a number, for a system that is not LHIMS');
check('a word is kept as it is written', map('WBC,wbc_count')['WBC'] === 'wbc_count', JSON.stringify(map('WBC,wbc_count')));

console.log('\n[4] Nothing is dropped without saying so');
const messy = parsePastedMappings('WBC,23\nthis line has no pair\n\nHGB,25');
check('the pairs are read', messy.rows.length === 2, JSON.stringify(messy.rows));
check('and the line that carried none is reported', messy.ignored.length === 1, JSON.stringify(messy.ignored));
check('a repeated code is taken once', parsePastedMappings('WBC,23\nWBC,99').rows.length === 1,
  JSON.stringify(parsePastedMappings('WBC,23\nWBC,99').rows));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
