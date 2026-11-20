/**
 * Two faults that cost a laboratory a day of setting up a serial analyser,
 * neither of which any test could have caught, because both are about what
 * the screen does NOT do.
 *
 *   1. A field the form collects and the save never sends. Seven of them —
 *      the serial port, its baud rate, data bits, stop bits, parity,
 *      handshake, and which end starts the conversation — were gathered by
 *      the dialog and left out of the payload. The server fell back to the
 *      stored value, found none on a new link, and refused it. Nothing was
 *      saved and nothing said so.
 *
 *   2. A dialog that reports its refusal somewhere else. The message was
 *      drawn on the page behind, which stays covered while the dialog is
 *      open, so a rejected save looked like a Save button that did nothing
 *      at all.
 *
 * Both are invisible to a type checker: every field exists, every type lines
 * up, and the code is wrong anyway. So they are checked here, statically,
 * against the source.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const failures = [];
const check = (what, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${what}`); }
  else { failures.push(what); console.log(`  FAIL  ${what}${detail ? `  — ${detail}` : ''}`); }
};

/* ==========================================================================
   1. Every field the link form holds is sent when it is saved
   ========================================================================== */
console.log('\nEvery setting the analyser-link form collects is sent when saved');
console.log('------------------------------------------------------------------');

const linkForm = readFileSync(path.join(root, 'src/pages/InstrumentLinksTab.tsx'), 'utf-8');

const emptyBlock = /const EMPTY = \{([\s\S]*?)\n\};/.exec(linkForm);
const payloadBlock = /async function save\(\)[\s\S]*?const payload = \{([\s\S]*?)\n    \};/.exec(linkForm);
check('the form’s fields can be read', Boolean(emptyBlock));
check('the save payload can be read', Boolean(payloadBlock));

if (emptyBlock && payloadBlock) {
  const keysOf = (text) => {
    // Keys only: skip anything inside a string, and ignore object values.
    const stripped = text.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
    return new Set([...stripped.matchAll(/(?:^|[,{\s])(\w+)\s*:/g)].map(m => m[1]));
  };
  const formKeys = keysOf(emptyBlock[1]);
  const sentKeys = keysOf(payloadBlock[1]);

  /*
   * Fields deliberately not sent as themselves. Each needs a reason, because
   * "it is in the list" is how the serial port came to be missing.
   */
  const exempt = new Map([
    // Split into a measured value and a unit before it goes.
    ['fetchIntervalSeconds', 'sent as a number'],
  ]);

  const missing = [...formKeys].filter(k => !sentKeys.has(k) && !exempt.has(k)).sort();
  check(`all ${formKeys.size} fields reach the server`, missing.length === 0,
    missing.length ? `never sent: ${missing.join(', ')}` : '');

  // The ones that went missing, named, so this cannot regress quietly.
  for (const key of ['serialPath', 'serialBaud', 'serialDataBits', 'serialStopBits',
    'serialParity', 'serialFlow', 'pollMode']) {
    check(`${key} is sent`, sentKeys.has(key));
  }
}

/* ==========================================================================
   2. A dialog that can save must report its own refusal
   ========================================================================== */
console.log('\nA dialog that saves shows its refusal where the person is looking');
console.log('------------------------------------------------------------------');

const dialogs = [
  ['src/pages/InstrumentLinksTab.tsx', 'LinkForm'],
  ['src/components/instruments/AnalyserModels.tsx', 'ModelEditor'],
  ['src/components/middleware/Destinations.tsx', 'EditDestination'],
];

for (const [file, component] of dialogs) {
  const source = readFileSync(path.join(root, file), 'utf-8');
  const start = source.indexOf(`function ${component}(`);
  if (start < 0) { check(`${component} exists`, false, `not found in ${file}`); continue; }
  // To the next top-level function, which is the end of this component.
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\nfunction ');
  const body = next < 0 ? rest : rest.slice(0, next);
  const shows = /<Notice|<Note\b/.test(body) && /\berror\b/.test(body);
  check(`${component} shows a failed save inside its own dialog`, shows,
    shows ? '' : 'the message would render on the screen behind it');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nA setting that is collected and not sent is a setting that silently');
  console.log('does not save. A refusal nobody can see is a button that does nothing.');
  process.exit(1);
}
