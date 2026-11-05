/**
 * The HumaStar's watched folder, and the file it really writes.
 *
 * Two different failures were found on one bench, and this holds both shut.
 *
 * The first is the one that stopped the laboratory: the folder was entered as
 * `C:\ProgramData\Hi\Human\LIS\ASTM\Output Worklist`, read off the analyser's
 * own Explorer window. It is a perfectly real folder — on the ANALYSER's
 * computer. SECHLIMS runs on a different machine, where that path means its own
 * disk and nothing is there. "The watched folder does not exist" was true and
 * sent somebody to check a spelling that was right all along, so each reason a
 * folder cannot be read is now separated and each says what to do.
 *
 * The second only shows itself once the first is fixed, which is why it is
 * tested here beside it: a folder on another computer is reached over SMB, read
 * with this host's clock against that host's timestamps, and written in UTF-8.
 * All three broke something.
 *
 *   node scripts/humastar-folder-check.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { diagnoseWatchPath, watchPathShape, credentialAdvice } from '../server/services/instrumentBridge/watchPath.ts';
import { decodeExport, parseAstm, astmTime } from '../server/services/instrumentBridge/protocols.ts';
import { mapAnalyte } from '../shared/constants/instruments.ts';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'tests', 'fixtures', 'humastar300sr_output_worklist.astm');

console.log('\nThe folder, and why it cannot be read');
console.log('-------------------------------------');

/* The reported fault, exactly as it was entered. */
{
  const verdict = diagnoseWatchPath('C:\\ProgramData\\Hi\\Human\\LIS\\ASTM\\Output Worklist');
  check('a drive-letter path is not reported as a missing folder', verdict.reason === 'local_path',
    `reason was ${verdict.reason}`);
  check('it says the path is on the computer SECHLIMS runs on',
    /computer SECHLIMS is running on|no [A-Z]: drive/.test(verdict.note), verdict.note);
  check('it says to share the folder and gives the network path to copy',
    Boolean(verdict.fix && verdict.fix.includes('\\\\ANALYSER-PC\\Output Worklist')), verdict.fix);
  check('the suggestion keeps the folder\'s own name', verdict.suggestion === '\\\\ANALYSER-PC\\Output Worklist',
    verdict.suggestion);
}

/* A POSIX host makes the same mistake with a rooted path. */
check('a rooted path that is not here is diagnosed the same way',
  diagnoseWatchPath('/srv/analyser/output worklist').reason === 'local_path');

/* A network path that nothing answers is a different job from a wrong folder. */
{
  const verdict = diagnoseWatchPath('\\\\NO-SUCH-PC-9f3a\\Output Worklist');
  check('an unreachable share is not called a local path',
    verdict.reason === 'share_missing' || verdict.reason === 'host_unreachable', verdict.reason);
  check('an unreachable share is not reported as readable', verdict.ok === false);
}

/* A folder that IS readable has to come back clean, or the diagnosis is worse
   than the message it replaced. */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchpath-'));
  const verdict = diagnoseWatchPath(dir);
  check('a readable folder is reported as readable', verdict.ok && verdict.reason === 'ok', verdict.note);

  const file = path.join(dir, 'one.astm');
  fs.writeFileSync(file, 'x');
  const atFile = diagnoseWatchPath(file);
  check('a file given instead of a folder says so', atFile.reason === 'not_a_folder', atFile.reason);

  check('nothing entered yet is not an error about a folder',
    diagnoseWatchPath('').reason === 'unset' && diagnoseWatchPath(null).reason === 'unset');
  fs.rmSync(dir, { recursive: true, force: true });
}

/*
 * The share that is spelled correctly, permitted correctly, and still refused.
 *
 * Windows defaults to password-protected sharing: the computer refuses an
 * unauthenticated connection before it ever consults the share's permissions,
 * so "Everyone: Read" is set, correct and never reached. Windows reports that
 * as a bad network path rather than as access denied, so it reads exactly like
 * a misspelled share name — and a laboratory spends the afternoon checking a
 * name that was right all along. That happened.
 */
{
  const advice = credentialAdvice('\\\\LABCHEMMAC003\\Output Worklist');
  check('the advice names the computer that is doing the refusing',
    advice.includes('LABCHEMMAC003'), advice);
  check('it explains why "Everyone: Read" is not reached',
    /Everyone/.test(advice) && /never reached|before it allows/.test(advice), advice);
  check('it gives the command that stores the credentials',
    /net use .*\/persistent:yes/.test(advice), advice);
  check('and names the other way out, password-protected sharing',
    /password-protected sharing/i.test(advice));
  check('and says plainly what each choice costs',
    /private to one account/.test(advice) && /everyone on the network/.test(advice), advice);
}

check('the shape of a path is read without touching the disk',
  watchPathShape('\\\\PC\\Share') === 'unc'
  && watchPathShape('C:\\x') === 'drive'
  && watchPathShape('/var/x') === 'posix'
  && watchPathShape('') === 'empty');

console.log('\nThe file the analyser actually writes');
console.log('-------------------------------------');

const bytes = fs.readFileSync(fixture);
const text = decodeExport(bytes);

check('the export is read as UTF-8, not mangled into Latin-1',
  text.includes('\u03bcmol') && !text.includes('\u00ce\u00bc'),
  text.includes('\u00ce\u00bc') ? 'the micro sign came through as Î¼' : 'no micromole unit found');

check('plain ASCII is unchanged by the decoder',
  decodeExport(Buffer.from('H|\\^&|||HS300SR', 'latin1')) === 'H|\\^&|||HS300SR');

check('bytes that are not UTF-8 still read as Latin-1 rather than as question marks',
  decodeExport(Buffer.from([0x41, 0xb5, 0x42])) === 'A\u00b5B');

const messages = parseAstm(text);
check('the whole file is one transmission, not one per test', messages.length === 1, `got ${messages.length}`);

const message = messages[0] ?? { results: [] };
check('the sample identifier is taken from the patient record', message.sampleId === 'TST0001', String(message.sampleId));
check('every test on the tube is carried', message.results.length === 8, `got ${message.results.length}`);

const by = Object.fromEntries(message.results.map(r => [r.code, r]));
check('a result in this analyser\'s own column is still read', by.CHOL?.value === '7.69', by.CHOL?.value);
check('the unit reaches the bench readable', by.CHOL?.unit === 'mmol / L', by.CHOL?.unit);
check('the micromole unit is a micromole', by['CREA-1']?.unit === '\u03bcmol / L', by['CREA-1']?.unit);

/* The sentinel the analyser stamps on anything it calculated rather than
   measured. The VALUE is real and must survive; the date is not a date. */
check('a calculated parameter keeps its value', by.LDLC?.value === '6.01', by.LDLC?.value);
check('the year-one sentinel is not carried as a date', by.LDLC?.completedAt === null,
  String(by.LDLC?.completedAt));
check('nor on the other calculated parameters',
  by.VLDL?.completedAt === null && by.CR?.completedAt === null);
check('a measured parameter keeps its real timestamp',
  by.CHOL?.completedAt === '2025-02-19T17:21:04', String(by.CHOL?.completedAt));
check('the run time is the first real one, never the year one',
  message.runAt === '2025-02-19T17:21:04', String(message.runAt));
check('astmTime refuses the sentinel outright', astmTime('00010101000000') === null);
check('astmTime still reads a real stamp', astmTime('20250219172104') === '2025-02-19T17:21:04');

console.log('\nWhat this analyser calls its tests');
console.log('----------------------------------');

const named = code => mapAnalyte(code, null, 'humastar_300sr');
check('HDL-C is HDL cholesterol', named('HDL-C') === 'HDL cholesterol', named('HDL-C'));
check('LDLC is LDL cholesterol', named('LDLC') === 'LDL cholesterol', named('LDLC'));
check('VLDL is VLDL cholesterol', named('VLDL') === 'VLDL cholesterol', named('VLDL'));
check('CREA-1 is creatinine', named('CREA-1') === 'Creatinine', named('CREA-1'));
check('the codes that already worked still work',
  named('CHOL') === 'Total cholesterol' && named('TG') === 'Triglycerides' && named('UREA') === 'Urea');

/*
 * CR is the one that must NOT be guessed. In this laboratory's own file it is
 * the cholesterol/HDL ratio — 7.69 ÷ 1.21 = 6.36, the value transmitted — but
 * on another analyser the same two letters are creatinine, and the assay name
 * is whatever the laboratory typed into the method. Filing a lipid ratio as a
 * renal result is worse than filing nothing, so it stays unmapped until
 * somebody who can see the analyser says what it is.
 */
check('CR is left for a person to map rather than guessed', named('CR') === 'CR', named('CR'));
check('and the arithmetic that proves why: CHOL / HDL is what CR carries',
  Math.abs(Number(by.CHOL.value) / Number(by['HDL-C'].value) - Number(by.CR.value)) < 0.01);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
