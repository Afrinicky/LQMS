/**
 * Builds the SECH_LIMS computerised system validation report as a .docx.
 */
const fs = require('node:fs');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  PageBreak, Header, Footer, PageNumber, TableOfContents, LevelFormat,
  convertInchesToTwip,
} = require('docx');

/* ------------------------------------------------------------------ palette */
const INK = '15211F';
const ACCENT = '0F5C58';
const MUTED = '4A5A56';
const RULE = 'CCD4D0';
const HEAD_BG = 'E7EDEB';
const ALT_BG = 'F4F7F6';
const RED = 'A02C1F';
const AMBER = '8A6410';
const GREEN = '2F6B3A';

const CONTENT_W = 9360; // US Letter, 1" margins

/* -------------------------------------------------------------- primitives */
const t = (text, opts = {}) => new TextRun({ text, font: 'Calibri', size: 20, color: INK, ...opts });

const p = (text, opts = {}) => new Paragraph({
  children: Array.isArray(text) ? text : [t(text, opts.run || {})],
  spacing: { after: opts.after ?? 120, line: 276 },
  alignment: opts.align,
  ...(opts.indent ? { indent: opts.indent } : {}),
  ...(opts.border ? { border: opts.border } : {}),
});

const h1 = (text) => new Paragraph({
  text, heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 160 },
});
const h2 = (text) => new Paragraph({
  text, heading: HeadingLevel.HEADING_2,
  spacing: { before: 280, after: 120 },
});
const h3 = (text) => new Paragraph({
  text, heading: HeadingLevel.HEADING_3,
  spacing: { before: 220, after: 100 },
});

const bullet = (text, level = 0) => new Paragraph({
  children: Array.isArray(text) ? text : [t(text)],
  numbering: { reference: 'bullets', level },
  spacing: { after: 80, line: 276 },
});

const spacer = (h = 120) => new Paragraph({ text: '', spacing: { after: h } });

const cell = (content, opts = {}) => new TableCell({
  width: { size: opts.width, type: WidthType.DXA },
  shading: opts.bg ? { type: ShadingType.CLEAR, fill: opts.bg, color: 'auto' } : undefined,
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  verticalAlign: 'top',
  columnSpan: opts.span,
  children: (Array.isArray(content) ? content : [content]).map(c =>
    typeof c === 'string'
      ? new Paragraph({
          children: [t(c, { bold: opts.bold, color: opts.color, size: opts.size ?? 19 })],
          spacing: { after: 0, line: 252 },
          alignment: opts.align,
        })
      : c),
});

/** A table from a header row + body rows, with column widths in DXA. */
function table(widths, header, rows, opts = {}) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: header.map((text, i) =>
      cell(text, { width: widths[i], bg: HEAD_BG, bold: true, size: 18, align: opts.align?.[i] })),
  });
  const bodyRows = rows.map((r, ri) => new TableRow({
    children: r.map((c, i) => {
      const isObj = c && typeof c === 'object' && !Array.isArray(c) && 'text' in c;
      return cell(isObj ? c.text : c, {
        width: widths[i],
        bg: ri % 2 === 1 ? ALT_BG : undefined,
        bold: isObj ? c.bold : undefined,
        color: isObj ? c.color : undefined,
        align: opts.align?.[i],
      });
    }),
  }));
  return new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
      left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    },
    rows: [headerRow, ...bodyRows],
  });
}

const pull = (text) => new Paragraph({
  children: [t(text, { italics: true, size: 24, color: ACCENT })],
  spacing: { before: 200, after: 200, line: 300 },
  indent: { left: 360 },
  border: { left: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 12 } },
});

/* ==================================================================== body */

const children = [];

/* --------------------------------------------------------------- title page */
children.push(
  new Paragraph({ text: '', spacing: { after: 1400 } }),
  new Paragraph({
    children: [t('COMPUTERISED SYSTEM VALIDATION', { size: 20, color: ACCENT, bold: true, characterSpacing: 60 })],
    spacing: { after: 200 },
  }),
  new Paragraph({
    children: [t('SECH_LIMS by Nickland', { size: 52, bold: true, color: INK })],
    spacing: { after: 80 },
  }),
  new Paragraph({
    children: [t('Laboratory Quality Management System', { size: 30, color: MUTED })],
    spacing: { after: 400 },
  }),
  new Paragraph({
    children: [t('Validation Report, Remediation and Re-qualification', { size: 26, color: INK })],
    spacing: { after: 100 },
    border: { top: { style: BorderStyle.SINGLE, size: 12, color: INK, space: 12 } },
  }),
  new Paragraph({
    children: [t('Version 1.0.0  ·  10 August 2026', { size: 22, color: MUTED })],
    spacing: { after: 800 },
  }),
);

children.push(table(
  [2400, 6960],
  ['Item', 'Detail'],
  [
    ['System', 'SECH_LIMS by Nickland — Laboratory Quality Management System'],
    ['Laboratory', 'St. Elizabeth Catholic Hospital Laboratory'],
    ['Version validated', '1.0.0 (originally validated at 0.1.0, commit dc73f10)'],
    ['Validation approach', 'GAMP 5 (2nd Edition) risk-based V-model, software Category 5'],
    ['Test outcomes executed', '696 — 689 passed, 0 failed, 4 deviations, 3 observations'],
    ['Findings raised / closed', '25 raised · 21 closed · 4 open, each an owner decision with an interim control'],
    ['Release position', { text: 'Full release for single-host and LAN operation, subject to five conditions', bold: true }],
    ['Report status', 'Unsigned. Takes effect on approval by the signatories in Section 12.'],
  ],
));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------------ contents */
children.push(h1('Contents'));
children.push(new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }));
children.push(new Paragraph({
  children: [t('If the contents list is blank, right-click it in Word and choose “Update Field”.', { size: 17, color: MUTED, italics: true })],
  spacing: { before: 200 },
}));
children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------- 1 executive summary */
children.push(h1('1  Executive summary'));

children.push(p('SECH_LIMS was validated by executing it. Six hundred and ninety-six test outcomes were produced across installation, operational and performance qualification, on isolated instances of the running system, at controlled versions of the code. Nothing was accepted on the strength of having been written carefully.'));

children.push(p([
  t('Nothing the system claims to do was found not to work.', { bold: true }),
  t(' No test case failed, at either the original validation or the re-qualification that followed remediation. The laboratory-facing functions — document control, personnel and competency, equipment and calibration, internal quality control, EQA, nonconformity and CAPA, internal audit, management review, and the twenty-odd modules around them — behaved as specified under normal, boundary and hostile conditions.'),
]));

children.push(h2('1.1  What the first validation found'));

children.push(p('Two results stood out, and both are the kind an assessor presses hardest on.'));

children.push(bullet([
  t('The disaster-recovery capability is real. ', { bold: true }),
  t('A populated laboratory was backed up, records were created and then lost, the system was restored, and everything that existed at backup time came back — including the audit trail, and including a record of the restore itself. The integrity scan on the recovered system was clean.'),
]));
children.push(bullet([
  t('The permission model is genuinely well built. ', { bold: true }),
  t('Forty-eight independent assertions confirm that the right to view is a prerequisite for every other action, that a “view only” technical authorisation cannot confer approval, that an expired authorisation confers nothing, that disabling a module cascades, and that revoking a right blocks every route to the data — including printing, exporting and QR resolution.'),
]));

children.push(p('Against that, twenty-five findings were raised. Not one was a broken feature. Every one was a control that ISO 15189 §7.6, EU GMP Annex 11, 21 CFR Part 11 or ISO/IEC 27001 requires, which the build did not implement. Eight were critical, and the result was summarised in one sentence:'));

children.push(pull('What the laboratory does with this system conforms to the standards; what protects the system does not yet.'));

children.push(h2('1.2  What has since changed'));

children.push(p('Twenty-one of the twenty-five findings are closed, and every qualification was re-run against the corrected build. The system now audits who signs in, locks an account after five failed attempts, asks for a password at the moment a signature is given, chains each audit entry to the one before it, and refuses to restore a backup whose digest does not match. Passwords follow one policy in one place instead of four. Sessions die of inactivity. A version number moves, with the commit stamped in.'));

children.push(p('Underneath that sits the change that keeps the rest true: a regression test suite and a continuous-integration workflow that runs the typecheck, the unit tests, both qualification suites and all twelve verification scripts before either packaging workflow is allowed to start.'));

children.push(table(
  [3400, 2980, 2980],
  ['Measure', 'At first validation (0.1.0)', 'After remediation (1.0.0)'],
  [
    ['Test outcomes executed', '664', { text: '696', bold: true }],
    ['Failures', '0', { text: '0', bold: true }],
    ['Deviations', '20', { text: '4', bold: true, color: GREEN }],
    ['Critical findings open', '8', { text: '2', bold: true, color: GREEN }],
    ['Requirements met', '49 of 75', { text: '69 of 75', bold: true, color: GREEN }],
    ['Release position', 'Conditional — single host only', { text: 'Full, subject to five conditions', bold: true }],
  ],
  { align: [undefined, AlignmentType.CENTER, AlignmentType.CENTER] },
));

children.push(spacer(200));
children.push(p('The four findings that remain open are not oversights. Each is a decision the laboratory has to own — encryption keys somebody must be willing to custody, a dependency whose fix is not published on npm, and a code-signing certificate somebody has to buy. Implementing any of them unilaterally would have been the wrong call, and each carries a documented interim control.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ----------------------------------------------- 2 system and classification */
children.push(h1('2  The system, and what kind of system it is'));

children.push(p('SECH_LIMS records, routes and evidences the laboratory’s quality processes. It does not acquire results from analysers, does not calculate or report patient results, and issues no output on which a clinical decision is directly made. Records referencing laboratory work use request and specimen references rather than patient identifiers. Patient registration, test requests, clinical result entry, verification and dispatch all remain with LHIMS/Lightwave.'));

children.push(table(
  [2400, 6960],
  ['Attribute', 'Detail'],
  [
    ['Architecture', 'Electron desktop host · React + Vite renderer · Node/Express REST API · SQLite (better-sqlite3, WAL journal)'],
    ['Size', 'Approximately 73,600 lines of TypeScript across 33 functional modules'],
    ['Optional surfaces', 'LAN clients, installable PWA, Capacitor Android build, read-only remote portal, PostgreSQL cloud-sync driver'],
    ['Validated configuration', 'Single Windows host, sync disabled; LAN operation permitted once TLS is configured'],
    ['Data held', 'Quality records: documents, personnel, competency, equipment, IQC/EQA, NC/CAPA, complaints, risks, audits, meetings, indicators, POCT, environmental monitoring'],
    ['Data not held', 'Patient identity, test requests, clinical results, result verification and dispatch'],
  ],
));

children.push(h2('2.1  Regulatory classification'));

children.push(p('Two determinations shape everything that follows, and both are worth stating plainly rather than leaving implicit.'));

children.push(table(
  [2600, 1700, 5060],
  ['Question', 'Determination', 'Basis'],
  [
    ['Is it medical device / IVD software?', { text: 'No', bold: true }, 'It performs none of the functions in IVDR Annex VIII or the IMDRF “Software as a Medical Device” criteria: no patient result is generated, interpreted or communicated by it. IEC 62304 and IEC 82304-1 are therefore applied as good-practice references, not as compliance obligations.'],
    ['Is it GxP software under 21 CFR Part 11?', { text: 'Not by jurisdiction; yes by intent', bold: true }, 'The laboratory is not FDA-regulated. Part 11 and EU GMP Annex 11 are nevertheless applied in full as the accepted international benchmark, because the system implements an audit trail and electronic signatures and offers them to assessors as evidence.'],
    ['GAMP 5 software category', { text: 'Category 5', bold: true }, 'Bespoke application written for this laboratory; the whole application is subject to lifecycle and functional verification.'],
    ['Does it process personal data?', { text: 'Yes — staff', bold: true }, 'Names, employee numbers, contact details, occupational health and competency records. The Ghana Data Protection Act, 2012 (Act 843) applies. Patient data is out of scope by design.'],
  ],
));

children.push(h2('2.2  Standards applied'));

children.push(table(
  [3600, 1400, 4360],
  ['Standard', 'Edition', 'Applied as'],
  [
    ['ISO 15189 — Medical laboratories', '2022', 'Primary. §7.6 information management, §7.8 continuity, §8.4 records'],
    ['ISO/IEC 17025 — Testing and calibration laboratories', '2017', 'Primary. §7.11 control of data and information management'],
    ['ISO 9001 — Quality management systems', '2015', '§7.5 documented information, §8.5.6 change control'],
    ['ISO/IEC 27001 + 27002 — Information security', '2022', 'Annex A: access control, cryptography, logging, backup, secure development'],
    ['ISO/IEC 25010 — Systems and software quality (SQuaRE)', '2023', 'Product-quality characteristics as acceptance dimensions'],
    ['ISO/IEC/IEEE 29119 — Software testing', '2021–22', 'Test documentation, design and process structure'],
    ['ISO/IEC/IEEE 12207 — Software life cycle processes', '2017', 'Lifecycle process expectations'],
    ['ISO 14971 — Risk management (by analogy)', '2019', 'Risk-analysis method'],
    ['ISO 22301 — Business continuity', '2019', 'Backup and recovery qualification'],
    ['ISO 81001-1 — Health software safety and security', '2021', 'Good-practice reference'],
    ['GAMP 5 — Compliant GxP computerised systems', '2nd ed., 2022', 'Validation methodology'],
    ['21 CFR Part 11 — Electronic records and signatures', 'current', 'Benchmark for audit trail and electronic signature'],
    ['EU GMP Annex 11 — Computerised systems', 'current', 'Benchmark for computerised system controls'],
    ['CLSI AUTO11 / GP26', 'current', 'IT security of laboratory software; QMS model'],
    ['Ghana Data Protection Act (Act 843)', '2012', 'Personal-data safeguards for staff records'],
  ],
));

children.push(spacer(160));
children.push(p([
  t('Explicitly out of scope: ', { bold: true }),
  t('SLIPTA, Ghana Accreditation Service scoring, accreditation scoring and star ratings. The product excludes these by design, and this validation does not assess them.'),
]));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------- 3 approach */
children.push(h1('3  How the validation was done'));

children.push(p('A GAMP 5 V-model, scaled by risk. Test depth was set per function by a risk assessment: every function rated high risk received executed, evidenced testing; medium-risk functions were covered by the supplier’s own verification scripts, re-executed and witnessed here; low-risk functions were covered by build verification and design review.'));

children.push(h2('3.1  Evidence hierarchy'));

children.push(table(
  [1800, 7560],
  ['Kind', 'Meaning'],
  [
    [{ text: 'Executed', bold: true }, 'The running system was exercised and its response captured verbatim. All operational and performance qualification results are of this kind.'],
    [{ text: 'Witnessed', bold: true }, 'The supplier’s verification scripts were re-executed on clean databases in this environment and their output captured — 587 assertions.'],
    [{ text: 'Inspected', bold: true }, 'A control was evaluated by reading source, used only where behaviour cannot be provoked from outside — for example, the absence of a hash chain on a database table. Every such conclusion is labelled as inspected in the findings register.'],
  ],
));

children.push(h2('3.2  A limitation worth stating first'));

children.push(p('No baseline specification existed before this validation. The project held design and planning documents but no controlled user requirements specification, no functional or design specification, and no supplier assessment. The 75 requirements used here were reconstructed from the standards, the product documentation and the implemented behaviour, then adopted as the baseline going forward.'));

children.push(p('This is a legitimate retrospective-validation route under GAMP 5 for a system already built, and it is recorded as a finding in its own right. Its consequence has to be understood clearly: this validation proves what the system does, and that what it does is fit for use. It cannot prove that what it does is what somebody specified in advance. From this baseline onward, change control requires specification before change.'));

children.push(h2('3.3  Two protocols that are executable'));

children.push(p('The operational and performance qualifications were written as scripts and committed alongside the code, so re-qualifying after a change is a two-minute command rather than a fortnight of manual testing:'));

children.push(new Paragraph({
  children: [t('npm test          ·  npm run validate:oq          ·  npm run validate:pq', { font: 'Consolas', size: 19, color: ACCENT })],
  spacing: { before: 120, after: 120 },
  indent: { left: 360 },
}));

children.push(p('Each qualification suite starts its own host on a scratch data directory and refuses to run if another host is already listening on its port, so it can never reach the laboratory’s live database and can never silently inherit another run’s state. Repeatability was verified over three consecutive executions producing identical results, not assumed.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* --------------------------------------------------------------- 4 results */
children.push(h1('4  Qualification results'));

children.push(p('Everything below was executed against version 1.0.0 after remediation. Nothing was carried forward from the first validation on trust.'));

children.push(table(
  [2900, 1000, 1000, 900, 1180, 2380],
  ['Qualification', 'Cases', 'Passed', 'Failed', 'Deviations', 'What it covers'],
  [
    ['IQ — build and installation', '120', '120', '0', '0', 'Install from lockfile, typecheck across ~73,600 lines, structural integrity, production build, dependency audit'],
    ['Unit regression suite', '23', '23', '0', '0', 'Credential policy, audit hash chain including tamper detection, backup integrity, permission resolver'],
    ['Supplier verification scripts', '467', '467', '0', '0', 'RBAC, account lifecycle, IQC and its import/export, alerting, backup scheduling and off-site destinations'],
    ['OQ — operational controls', '67', '60', '0', '4', 'Setup, authentication, authorisation, audit trail, electronic signatures, data integrity, robustness, lifecycle'],
    ['PQ — backup and recovery', '19', '19', '0', '0', 'Full backup, simulated loss, restore, verification of what returned, refusal of a damaged archive'],
    [{ text: 'Total', bold: true }, { text: '696', bold: true }, { text: '689', bold: true }, { text: '0', bold: true }, { text: '4', bold: true }, ''],
  ],
  { align: [undefined, AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.CENTER, undefined] },
));

children.push(h2('4.1  The recovery test, in detail'));

children.push(p('This is the result the laboratory most needs to be able to show. A laboratory was initialised, three staff records created and confirmed in the audit trail, and a backup taken. A further record was then created — the state a restore has to roll back — and the system restored from the backup.'));

children.push(table(
  [2200, 7160],
  ['Check', 'Observed'],
  [
    ['Backup produced', 'Package written to disk with a manifest and a SHA-256 digest'],
    ['Safety snapshot', 'A pre-restore archive of current state written before any live data was touched; the restore aborts if it cannot be written'],
    ['Records returned', 'All three pre-backup records present after the restore'],
    ['Restore point honoured', 'The post-backup record correctly absent'],
    ['Audit trail', 'Survived intact, and the restore itself appears in the restored trail'],
    ['Integrity of the result', 'Data-integrity scan on the recovered system: 0 issues, status “passed”'],
    ['Damaged archive', 'A deliberately corrupted backup was refused with HTTP 409 before live data was touched; the refusal is itself audited and the live system was unchanged'],
  ],
));

children.push(h2('4.2  Two regressions found by re-running, not by reading'));

children.push(p('Remediation broke two things. Both were caught by re-executing the suites rather than by inspecting the diff, and both are recorded because how a defect was found is part of the evidence.'));

children.push(bullet([
  t('Sessions could not be created. ', { bold: true }),
  t('Storing digests instead of tokens left the old NOT NULL token column in place, and every sign-in returned an error. The table is now rebuilt during migration; old sessions are dropped rather than carried over, which is the correct outcome anyway.'),
]));
children.push(bullet([
  t('A new account could no longer be deleted. ', { bold: true }),
  t('Password history counted as “laboratory history” in the deletion-impact check, so an unused account was blocked from deletion by its own credential bookkeeping. Credential history is now disposable with the account.'),
]));

children.push(p('The second was caught by a supplier verification script written months before this work, failing 6 of its 37 assertions. That is precisely the argument for having a regression suite and running it in CI — an argument which proved itself within an hour of being made.'));

children.push(h2('4.3  A defect in the test suite, not in the system'));

children.push(p('The operational qualification’s own inactivity test initially aged every live session, expiring the administrator’s alongside the one under test and turning eight later cases into failures that said nothing about the system. It now ages only the session being tested.'));

children.push(p('This was the second defect this validation found in its own instrumentation — the first was a harness that signalled the wrong process and left a host running between executions, so a second run silently reported the first run’s database as failures. Both are recorded rather than quietly corrected, because a validation that hides its own mistakes is not evidence of anything. It is also worth noting where the instrumentation lives: in the test, not in the product. There is deliberately no endpoint that expires a session early, because a way to reach into sessions from outside is exactly what the control exists to prevent.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* -------------------------------------------------------------- 5 findings */
children.push(h1('5  Findings raised'));

children.push(p('Twenty-five findings, none of them a broken function. Every one is a control the standards require that the build did not implement, or a lifecycle practice that was missing. That distinction is why the first release decision was conditional rather than rejected.'));

children.push(h2('5.1  Critical findings'));

children.push(table(
  [900, 2800, 4260, 1400],
  ['Ref', 'Finding', 'Why it mattered', 'Status'],
  [
    ['VF-01', 'No transport encryption', 'Every password and record would cross the hospital network in clear the moment LAN mode was enabled — which the product documentation instructs administrators to do', { text: 'Closed', bold: true, color: GREEN }],
    ['VF-02', 'No lockout on failed sign-ins', 'Twenty-five consecutive wrong passwords drew no lockout, no throttling and no alert; the correct password then succeeded normally', { text: 'Closed', bold: true, color: GREEN }],
    ['VF-03', 'Sign-ins not audited', 'The system could not answer “who had access, and when” — the question ISO 15189 §7.6.2 exists to make answerable', { text: 'Closed', bold: true, color: GREEN }],
    ['VF-04', 'Signatures needed no re-authentication', 'An unattended signed-in workstation let anyone apply another person’s approval to a CAPA, a document release or a competency sign-off', { text: 'Closed', bold: true, color: GREEN }],
    ['VF-05', 'Audit trail not tamper-evident', 'No route could alter it — that was verified, and is a real strength — but anyone with host file access could rewrite history undetectably', { text: 'Closed', bold: true, color: GREEN }],
    ['VF-06', 'Database not encrypted at rest', 'A stolen host yields every staff record without ever authenticating to the application', { text: 'Open', bold: true, color: AMBER }],
    ['VF-07', 'Backups unencrypted, including off-site', 'The complete quality record leaves the building in the clear', { text: 'Open', bold: true, color: AMBER }],
    ['VF-08', 'Backup integrity unprovable', 'A corrupted or substituted archive would be restored over live data and nothing would notice', { text: 'Closed', bold: true, color: GREEN }],
  ],
));

children.push(h2('5.2  Major and minor findings'));

children.push(table(
  [900, 3100, 3960, 1400],
  ['Ref', 'Finding', 'Resolution', 'Status'],
  [
    ['VF-09', 'No automated regression suite', 'Vitest adopted; 23 tests covering the credential policy, the audit chain, backup integrity and the permission resolver', { text: 'Closed', color: GREEN }],
    ['VF-10', 'Dependency vulnerabilities', 'Reduced from 45 advisories to 31; the shipped software now carries one. See Section 7', { text: 'Open', color: AMBER }],
    ['VF-11', 'Version identifier frozen at 0.1.0', 'Version moved to 1.0.0; CI stamps the commit into the build and the About endpoint reports it', { text: 'Closed', color: GREEN }],
    ['VF-12', 'Installer unsigned', 'Requires a code-signing certificate the laboratory must obtain. See Section 7', { text: 'Open', color: AMBER }],
    ['VF-13', 'Signatures not bound to content', 'Each signature stores a hash of the record as signed; a later edit is flagged wherever the signature appears', { text: 'Closed', color: GREEN }],
    ['VF-14', 'Signature-to-audit link non-deterministic', 'The audit service returns the id of the row it wrote instead of the signature guessing at the newest row', { text: 'Closed', color: GREEN }],
    ['VF-15', 'No security response headers', 'Content-Security-Policy and five others set on every response', { text: 'Closed', color: GREEN }],
    ['VF-16', 'Cross-origin policy accepted anything', 'Replaced with an allow-list covering loopback, the configured public URL and the host’s own LAN addresses', { text: 'Closed', color: GREEN }],
    ['VF-17', 'Audit timestamps without a time zone', 'Entries carry ISO-8601 UTC with an explicit marker; older rows are reported as unchained rather than back-filled', { text: 'Closed', color: GREEN }],
    ['VF-18', 'No inactivity timeout', 'Sessions die after 30 minutes idle, alongside the 12-hour absolute expiry', { text: 'Closed', color: GREEN }],
    ['VF-19', 'Password policy was length only', 'The literal password “password” was accepted. One policy now, in one place, applied at all four setting points', { text: 'Closed', color: GREEN }],
    ['VF-20', 'Session tokens stored reusably', 'The token column is gone; sessions are looked up by digest, so reading the database yields nothing usable', { text: 'Closed', color: GREEN }],
    ['VF-21', 'No specification baseline', 'The reconstructed requirements are adopted as the controlled baseline; change control now requires specification first', { text: 'Closed', color: GREEN }],
    ['VF-22', 'Verification not enforced in CI', 'A verify workflow runs everything, and both packaging workflows now wait for it', { text: 'Closed', color: GREEN }],
    ['VF-23', 'Verification scripts had hidden prerequisites', 'The execution order is documented and enforced by the CI workflow', { text: 'Closed', color: GREEN }],
    ['VF-24', 'Duties not separable', 'An Independent Reviewer role reads the audit trail and holds no administrative right over what it reviews', { text: 'Closed', color: GREEN }],
    ['VF-25', 'Retention recorded but not enforced', 'No change, and none wanted: automatic destruction of quality records is a worse failure mode than over-retention', { text: 'Accepted', color: MUTED }],
  ],
));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------ 6 remediation */
children.push(h1('6  What the remediation actually changed'));

children.push(h2('6.1  Knowing who did what'));

children.push(p('Successful sign-ins, failed sign-ins, blocked attempts, lockouts and sign-outs are now written to the audit trail with username, IP address, device and time. An access review — which ISO 15189 §7.6.2 requires the laboratory to perform, and for which the system already provided a module — can be answered from the system’s own records rather than from memory.'));

children.push(h2('6.2  Making tampering visible'));

children.push(p('Each audit entry carries the SHA-256 of the entry before it. A verification endpoint walks the chain, and the routine data-integrity scan does the same on every run.'));

children.push(p([
  t('The promise here is narrow and worth stating exactly. ', { bold: true }),
  t('A hash chain cannot make a SQLite file immutable — nothing in application code can, because the file belongs to whoever administers the host. What it does is make tampering visible: a rewritten or deleted entry breaks the chain from that point on, and the break is dated. The unit tests prove this by editing the database behind the application’s back and confirming the verifier reports it. Detectable tampering is the honest form of “safeguarded against tampering” on this platform, and it is a great deal better than the nothing that was there before.'),
]));

children.push(p('Entries written before chaining began are reported as unchained rather than back-filled. Back-filling a chain over history nobody can vouch for would produce a document that looks like proof and is not one.'));

children.push(h2('6.3  Making a signature mean something'));

children.push(p('Signing now takes the signer’s password at the moment of signing. A valid session alone is refused, a wrong password is refused, and the refused attempt is itself audited — because an attempt to sign as somebody else is exactly the kind of event worth keeping.'));

children.push(p('Each signature also stores a hash of the record as it stood when it was signed, so a record edited afterwards is flagged wherever that signature is displayed. Without this, a signature said only that somebody approved something on a Tuesday; with it, a signature can demonstrate what was actually approved.'));

children.push(p('One distinction was introduced deliberately. Acknowledging a controlled document or an announcement is an attributable act worth recording, but it is not an approval and should not be dressed as one. Acknowledgements are recorded through a separate path and marked as such, so “Kwame read this” and “Kwame approved this” stay visibly different things in the evidence.'));

children.push(h2('6.4  Protecting the way in'));

children.push(table(
  [2600, 6760],
  ['Control', 'Behaviour'],
  [
    ['Account lockout', 'Five consecutive failures lock the account for fifteen minutes. The lock is checked before the password, so continuing to guess buys nothing, and it holds even against the correct password'],
    ['Password policy', 'Minimum twelve characters; no common passwords; no runs or repeats; not the person’s own name or username; no reuse of the last five. Applied identically at account creation, administrator reset, self-service change and first-administrator setup'],
    ['Session storage', 'Sessions are looked up by SHA-256 digest. The plain token column is gone, so read access to the database yields nothing usable'],
    ['Session lifetime', 'Thirty minutes of inactivity, or twelve hours absolute, whichever comes first'],
    ['Transport', 'HTTPS when a certificate is configured. A host bound to the network without one prints an explicit startup warning naming what is at stake'],
    ['Cross-origin', 'An allow-list: loopback, the Vite dev server, the configured public URL, the host’s own LAN addresses, and anything the laboratory names explicitly'],
    ['Segregation of duties', 'An Independent Reviewer role reads the audit trail, the system-audit findings and the records, and holds no administrative right over the system it reviews'],
  ],
));

children.push(h2('6.5  Proving a backup is the backup'));

children.push(p('Every backup records a SHA-256. The digest is checked before a restore, and a mismatch refuses the restore outright rather than overwriting live data. An archive with no recorded digest — one taken before this existed, or carried in from another machine — is reported as unverifiable rather than as good or bad, because that is what it is. The system does not pretend to have checked something it could not.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------- 7 still open */
children.push(h1('7  What was deliberately left open'));

children.push(p('Four findings remain. None is an oversight; each is a decision with consequences the laboratory has to own, and implementing any of them unilaterally would have been the wrong call.'));

children.push(h2('7.1  VF-06 — the database is not encrypted at rest'));
children.push(p('Encrypting the SQLite file needs SQLCipher, which means changing a native dependency in a build that already documents its native SQLite module as the most fragile step in packaging. It also needs a key custody procedure, because a lost key is a lost quality record. That trade belongs to the system owner and the hospital’s IT security, not to the supplier to impose.'));
children.push(p([t('Interim control: ', { bold: true }), t('full-disk encryption on the host and physical security, documented in the laboratory’s information-security procedure.')]));

children.push(h2('7.2  VF-07 — backups are not encrypted'));
children.push(p('The same reasoning, more sharply. Backups are the laboratory’s last line of defence, and the backup subsystem currently passes 158 assertions covering scheduling, retention that never prunes to zero, off-site copying and restore. Encrypting the archive introduces a key that, if lost, turns every backup into noise on the day it is needed most.'));
children.push(p('The integrity half of this problem is now closed: a laboratory can prove an archive is the one it took. The confidentiality half needs a key-custody decision first.'));
children.push(p([t('Interim control: ', { bold: true }), t('keep off-site copying disabled, or point it at an encrypted volume under the laboratory’s control.')]));

children.push(h2('7.3  VF-10 — one dependency carries an unfixed advisory'));
children.push(p('The spreadsheet library used for imports and exports is at the last version published to npm; its maintainer publishes fixes only from a separate registry. Closing this means either re-sourcing the dependency from a non-npm registry or replacing it, and it is used by IQC import and export, staff import, monthly reports and the register exports. Either route is a supply-chain decision with real regression surface.'));
children.push(p([t('Mitigation in place: ', { bold: true }), t('every import path is permission-gated, and the workbooks the system parses come from the laboratory itself rather than from strangers. Continuous integration now blocks on any critical advisory in shipped code, so this cannot quietly get worse. The other thirty advisories are all in build tooling and none of it reaches a running installation.')]));

children.push(h2('7.4  VF-12 — the installer is unsigned'));
children.push(p('This needs a code-signing certificate the laboratory must purchase. The build is ready for one: the packaging tool picks up a certificate from the environment when it exists. Until then Windows warns on every install, which trains staff to dismiss the warning, and the laboratory cannot demonstrate that the installer it ran is the one the supplier built.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ---------------------------------------------------------- 8 conformity */
children.push(h1('8  Conformity against the standards'));

children.push(p('Judged only on what the software must do. Where a clause is satisfied by laboratory procedure rather than by software, it is recorded as procedural — the software cannot claim the credit, but neither should it be marked down for it.'));

children.push(p('The table below lists every clause the first validation recorded as partial or failing, and where it stands now. Clauses already conforming are not repeated.'));

children.push(table(
  [1600, 3400, 1500, 2860],
  ['Standard', 'Clause', 'Now', 'Basis'],
  [
    ['ISO 15189', '4.2 Confidentiality of information', { text: 'Partial', bold: true, color: AMBER }, 'Transport closed (VF-01); storage at rest open (VF-06, VF-07)'],
    ['ISO 15189', '7.6.2 Authorities and responsibilities', { text: 'Conforms', bold: true, color: GREEN }, 'VF-02, VF-03, VF-24 closed'],
    ['ISO 15189', '7.6.3 Information system management', { text: 'Partial', bold: true, color: AMBER }, 'Tamper-evidence and access protection closed; encryption at rest open (VF-06)'],
    ['ISO 15189', '7.8 Continuity and emergency preparedness', { text: 'Partial', bold: true, color: AMBER }, 'Archive authenticity closed (VF-08); off-site confidentiality open (VF-07)'],
    ['ISO 15189', '8.4 Control of records', { text: 'Conforms', bold: true, color: GREEN }, 'VF-05 and VF-17 closed; retention accepted as procedural'],
    ['ISO 17025', '7.11.2 Validated before introduction', { text: 'Conforms', bold: true, color: GREEN }, 'This package, with a version that now identifies the build (VF-11)'],
    ['ISO 17025', '7.11.3(a) Protected from unauthorised access', { text: 'Partial', bold: true, color: AMBER }, 'VF-01, VF-02, VF-19 closed; VF-06 open'],
    ['ISO 17025', '7.11.3(b) Safeguarded against tampering and loss', { text: 'Conforms', bold: true, color: GREEN }, 'Loss proven by the recovery test; tampering now detectable (VF-05)'],
    ['ISO 17025', '7.11.3(c)–(d) Supplier spec; maintained integrity', { text: 'Conforms', bold: true, color: GREEN }, 'VF-21 baseline adopted; VF-09 regression suite in place'],
    ['21 CFR Part 11', '11.10(c) Protection of records', { text: 'Partial', bold: true, color: AMBER }, 'VF-05 closed; VF-06 open'],
    ['21 CFR Part 11', '11.10(d) Limiting system access', { text: 'Conforms', bold: true, color: GREEN }, 'VF-01, VF-02, VF-19 closed'],
    ['21 CFR Part 11', '11.10(e) Secure, time-stamped audit trails', { text: 'Conforms', bold: true, color: GREEN }, 'VF-03, VF-05, VF-17 closed'],
    ['21 CFR Part 11', '11.10(h) Device checks', { text: 'Partial', bold: true, color: AMBER }, 'Device and IP captured; no device authorisation enforced'],
    ['21 CFR Part 11', '11.10(k) Systems documentation and change control', { text: 'Conforms', bold: true, color: GREEN }, 'VF-11, VF-21, VF-22 closed'],
    ['21 CFR Part 11', '11.70 Signature/record linking', { text: 'Conforms', bold: true, color: GREEN }, 'VF-13 closed — signatures bound to a hash of what was signed'],
    ['21 CFR Part 11', '11.200 Signature components', { text: 'Conforms', bold: true, color: GREEN }, 'VF-04 closed — was the only outright failure in Subpart C'],
    ['21 CFR Part 11', '11.300(b), (d) Credentials; transaction safeguards', { text: 'Conforms', bold: true, color: GREEN }, 'VF-19, VF-02, VF-03 closed'],
    ['Annex 11', '§3 Suppliers and service providers', { text: 'Does not', bold: true, color: RED }, 'No supplier assessment of the developer has been recorded — see Section 9.4'],
    ['Annex 11', '§7.1, §17 Data protection; archiving', { text: 'Partial', bold: true, color: AMBER }, 'Integrity closed; encryption at rest open (VF-06, VF-07)'],
    ['Annex 11', '§7.2 Backups checked for accuracy', { text: 'Conforms', bold: true, color: GREEN }, 'VF-08 closed and demonstrated by refusing a damaged archive'],
    ['Annex 11', '§9 Audit trails', { text: 'Conforms', bold: true, color: GREEN }, 'VF-03, VF-05 closed'],
    ['Annex 11', '§12.1, §12.3, §12.4 Security and access control', { text: 'Conforms', bold: true, color: GREEN }, 'VF-01, VF-02, VF-18, VF-03 closed'],
    ['Annex 11', '§14 Electronic signature', { text: 'Conforms', bold: true, color: GREEN }, 'VF-04, VF-13 closed'],
    ['ISO 27001', 'A.5.3, A.5.17, A.5.18, A.8.5 Access and credentials', { text: 'Conforms', bold: true, color: GREEN }, 'VF-02, VF-19, VF-20, VF-24 closed'],
    ['ISO 27001', 'A.8.8 Technical vulnerabilities', { text: 'Does not', bold: true, color: RED }, 'VF-10 open — one advisory in shipped code with no fix on npm'],
    ['ISO 27001', 'A.8.13 Information backup', { text: 'Partial', bold: true, color: AMBER }, 'Integrity closed (VF-08); encryption open (VF-07)'],
    ['ISO 27001', 'A.8.15 Logging', { text: 'Conforms', bold: true, color: GREEN }, 'VF-03 closed'],
    ['ISO 27001', 'A.8.19, A.8.30 Installation; outsourced development', { text: 'Does not', bold: true, color: RED }, 'VF-12 open (unsigned installer); supplier assessment outstanding'],
    ['ISO 27001', 'A.8.23, A.8.25, A.8.26 Origin control; secure development', { text: 'Conforms', bold: true, color: GREEN }, 'VF-16, VF-09, VF-15, VF-22 closed'],
    ['ISO 27001', 'A.8.24 Use of cryptography', { text: 'Partial', bold: true, color: AMBER }, 'In transit and for stored tokens closed; at rest open (VF-06, VF-07)'],
  ],
  { align: [undefined, undefined, AlignmentType.CENTER, undefined] },
));

children.push(spacer(160));

children.push(p([
  t('Every remaining gap traces to one of the four open findings, plus the supplier assessment. ', { bold: true }),
  t('Three of the four are about cryptography at rest and the fourth is a certificate. Nothing that remains is a defect in how the system behaves.'),
]));

children.push(spacer(120));

children.push(p([
  t('The electronic-signature provisions of Part 11 Subpart C, which the first validation recorded as not met, are now satisfied: '),
  t('§11.50 ', { bold: true }),
  t('(printed name, date, time and meaning), '),
  t('§11.70 ', { bold: true }),
  t('(signature bound to its record, now cryptographically), and '),
  t('§11.200 ', { bold: true }),
  t('(a signature component re-entered at the moment of signing). Signatures in SECH_LIMS may now be described in laboratory procedures as electronic signatures rather than as system-recorded approvals.'),
]));

children.push(h2('8.1  Product quality (ISO/IEC 25010)'));

children.push(table(
  [2400, 6960],
  ['Characteristic', 'Assessment'],
  [
    ['Functional suitability', 'Strong. 696 executed and witnessed outcomes, none failed, across 33 modules covering the ISO 15189 quality domains'],
    ['Reliability', 'Good. Survived malformed and hostile input; recovered fully from simulated data loss; schedulers self-gate and fail loudly without becoming fatal'],
    ['Security', 'Much improved and no longer the weakest characteristic. Authorisation was always well built; authentication, logging and record integrity now match it. Cryptography at rest remains the open edge'],
    ['Maintainability', 'Mixed. Clear module boundaries, a single permission decision point and unusually good explanatory comments, against two very large source files — now with a regression suite behind them'],
    ['Performance efficiency', 'Adequate but unmeasured. No load or volume testing was in scope; the permission resolver recomputes grants per request, which is untested at multi-client scale'],
    ['Interaction capability', 'Not assessed. No usability or accessibility evaluation was in scope'],
    ['Safety', 'Not applicable by design. No patient result is produced or reported'],
  ],
));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------- 9 decision */
children.push(h1('9  Release decision'));

children.push(p([
  t('Recommended position: full release for single-host and LAN operation', { bold: true, size: 24 }),
]));

children.push(p('This is a change from the conditional release that followed the first validation, and it rests on the four remaining findings all being owner decisions with documented interim controls rather than unaddressed defects.'));

children.push(h2('9.1  Conditions that still apply'));

children.push(table(
  [900, 4200, 4260],
  ['Ref', 'Condition', 'Why'],
  [
    ['C-3', 'Cloud synchronisation and the PostgreSQL driver remain disabled', 'Excluded from validation scope. Enabling either invalidates this validation and requires a supplementary risk assessment and operational qualification'],
    ['C-4', 'Host protected by full-disk encryption and physical security, documented in the information-security procedure', 'Interim control for VF-06'],
    ['C-5', 'Off-site backup copying disabled, or restricted to an encrypted volume under laboratory control', 'Interim control for VF-07'],
    ['C-9', 'Host administrator accounts restricted to named individuals; the audit trail reviewed at a defined frequency by somebody other than the administrator', 'Supported now by the Independent Reviewer role and the hash chain, which give the reviewer something to verify'],
    ['C-10', 'Installation qualification on the target Windows platform completed and appended before production use', 'Unchanged by this work. See Section 9.3'],
  ],
));

children.push(h2('9.2  Conditions lifted'));

children.push(table(
  [3200, 6160],
  ['Condition', 'Why it no longer applies'],
  [
    ['Loopback only; no LAN mode', 'TLS is supported. LAN deployment now requires a certificate to be configured, and the host warns loudly if it is not'],
    ['No mobile or LAN clients', 'Permitted once a certificate is in place'],
    ['Manual verification of every backup', 'Verification is automatic, and a bad archive is refused rather than restored'],
    ['Signatures described as “system-recorded approvals”', 'Re-authentication and content binding are in place; they may be described as electronic signatures'],
    ['Workstation locking enforced procedurally', 'Reduced to good practice — a thirty-minute inactivity timeout now backs it'],
  ],
));

children.push(h2('9.3  Outstanding work on the target platform'));

children.push(p('This qualification ran on Linux. Everything above the packaging layer — the API, the database, the permission resolver, the audit trail, signatures, backup and restore — is platform-independent and its results carry over. The Windows-specific layer must still be qualified on the machine that will run it:'));

children.push(bullet('Produce the installer on Windows with the native toolchain, and confirm the native SQLite module rebuilds against the bundled Electron headers'));
children.push(bullet('Install on a clean machine and confirm the application launches'));
children.push(bullet('Confirm the database, uploads, evidence and backups live under the user data directory and never in the installation directory'));
children.push(bullet('Reinstall over an existing installation and confirm user data survives untouched'));
children.push(bullet('Execute the module route smoke test and the release-candidate checklist on the installed application'));
children.push(bullet('Confirm TLS is configured before the host is bound to the network'));

children.push(h2('9.4  Recommendations, in order'));

children.push(new Paragraph({ children: [t('1.  Complete the Windows installation qualification in Section 9.3 before production use.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('2.  Decide the encryption question — VF-06 and VF-07 together, since both turn on the same key-custody procedure. Until that decision is made, C-4 and C-5 are what stands in for it.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('3.  Obtain a code-signing certificate (VF-12). The build is ready for one.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('4.  Decide the spreadsheet-library question (VF-10): re-source it from the maintainer’s own registry, or replace it. Either is a supply-chain decision with regression surface, so plan it rather than drifting into it.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('5.  Record a supplier assessment of the developer, which Annex 11 §3 expects and which remains the one lifecycle expectation this package does not satisfy.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------- 10 staying valid */
children.push(h1('10  Keeping the system validated'));

children.push(p('A validation is a statement about one build at one moment. Version 1.0.0 is validated; the next commit is not, until something says so.'));

children.push(table(
  [1600, 3400, 4360],
  ['Class', 'Definition', 'Evidence required'],
  [
    [{ text: 'Major', bold: true }, 'Touches authentication, authorisation, the audit trail, electronic signatures, backup and restore, the database schema, or enables a previously disabled surface', 'Risk assessment update, the full validation suite, targeted test cases for the change, updated traceability and summary report. Approved by the system owner and the Quality Manager'],
    [{ text: 'Minor', bold: true }, 'New or changed functionality inside an existing module, not touching anything in the Major list', 'The validation suite, the verification scripts for the affected module, an updated requirement entry. Approved by the Quality Manager'],
    [{ text: 'Cosmetic', bold: true }, 'Wording, layout, colour, non-functional refactor with no behaviour change', 'Typecheck and the operational qualification suite'],
    [{ text: 'Emergency', bold: true }, 'Fix required to restore service or prevent record loss', 'Apply, then produce Minor-class evidence within five working days; recorded as a deviation until closed'],
  ],
));

children.push(spacer(160));

children.push(p('Four rules apply to every change: specify before building, so the requirements baseline stays current; bump the version, because a build whose version cannot be tied to a commit cannot be validated; run the validation suite, now enforced by continuous integration rather than by memory; and record the change in the system’s own Change Control and Software Release modules, because a change record that lives only in a version-control history is not available to an assessor.'));

children.push(h2('10.1  Periodic review'));

children.push(p('Every six months, or on closure of the remaining findings, whichever is sooner, recorded as a management review input. The review asks whether the deployed version is still the validated version, whether the suite still passes, whether every change since the last review was classified and evidenced, whether the interim controls are still being followed, whether new vulnerabilities have appeared, what incidents or downtime occurred, and whether the standards themselves have moved.'));

children.push(p('A full re-validation is required if the database engine changes, if cloud synchronisation or the remote portal is enabled, if the authentication or permission model is redesigned, or after three years.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------ 11 documents */
children.push(h1('11  Supporting documents and evidence'));

children.push(p('The full validation package is version-controlled in the repository alongside the code it validates, so the validated state and the validated build cannot drift apart.'));

children.push(table(
  [1000, 3600, 4760],
  ['Doc', 'Title', 'What it establishes'],
  [
    ['01', 'Validation Master Plan', 'Scope, standards, approach, roles, acceptance criteria'],
    ['02', 'User Requirements Specification', '75 testable requirements traced to standard clauses — the controlled baseline'],
    ['03', 'Risk Assessment', 'Function-level risk analysis driving test depth'],
    ['04', 'IQ / OQ / PQ Protocols', 'The protocols, the test environment, and how to re-execute'],
    ['05', 'Traceability Matrix', 'Requirement to design to test to result, in both directions'],
    ['06', 'Deviations and Findings Register', 'All 25 findings, risk-rated, with corrective actions'],
    ['07', 'Standards Gap Analysis', 'Clause-by-clause conformity against fourteen standards'],
    ['08', 'Validation Summary Report', 'The original conclusion at version 0.1.0, retained unchanged'],
    ['09', 'Periodic Review and Change Control', 'Keeping the system in a validated state'],
    ['10', 'Remediation and Re-qualification', 'What was fixed, what was not, and the re-run results'],
  ],
));

children.push(spacer(160));

children.push(p('Objective evidence retained with the package: the build and installation log, the unit-test results, the 587 supplier verification assertions, and machine-readable results for all 67 operational and 19 performance qualification test cases. Continuous integration retains the qualification evidence from every run for ninety days.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------- 12 approval */
children.push(h1('12  Approval'));

children.push(p('This report requires signature by the system owner, the process owner and an independent reviewer. The independent reviewer must not be the person who performed the validation, as required by EU GMP Annex 11 §2 and ISO 15189 §7.6.3.'));

children.push(p([
  t('By signing, the system owner accepts the residual risk described in Section 7 and undertakes to operate the system within conditions C-3, C-4, C-5, C-9 and C-10 of Section 9.', { bold: true }),
]));

children.push(spacer(300));

const sigRow = (role) => new TableRow({
  children: [
    cell([
      new Paragraph({ children: [t(role, { bold: true, size: 19 })], spacing: { after: 40 } }),
      new Paragraph({ children: [t('', { size: 19 })], spacing: { after: 200 } }),
    ], { width: 2600 }),
    cell([
      new Paragraph({ children: [t('Name', { size: 17, color: MUTED })], spacing: { after: 340 } }),
    ], { width: 2400 }),
    cell([
      new Paragraph({ children: [t('Signature', { size: 17, color: MUTED })], spacing: { after: 340 } }),
    ], { width: 2600 }),
    cell([
      new Paragraph({ children: [t('Date', { size: 17, color: MUTED })], spacing: { after: 340 } }),
    ], { width: 1760 }),
  ],
});

children.push(new Table({
  columnWidths: [2600, 2400, 2600, 1760],
  width: { size: 9360, type: WidthType.DXA },
  borders: {
    top: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE },
    left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' },
  },
  rows: [
    new TableRow({
      tableHeader: true,
      children: [
        cell('Role', { width: 2600, bg: HEAD_BG, bold: true, size: 18 }),
        cell('Name', { width: 2400, bg: HEAD_BG, bold: true, size: 18 }),
        cell('Signature', { width: 2600, bg: HEAD_BG, bold: true, size: 18 }),
        cell('Date', { width: 1760, bg: HEAD_BG, bold: true, size: 18 }),
      ],
    }),
    sigRow('Validation lead'),
    sigRow('System owner (Laboratory Manager)'),
    sigRow('Process owner (Quality Manager)'),
    sigRow('Independent reviewer'),
  ],
}));

children.push(spacer(400));
children.push(new Paragraph({
  children: [t('This report records the outcome of a validation exercise and takes effect only on approval by the signatories above.', { italics: true, size: 18, color: MUTED })],
  border: { top: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 12 } },
}));

/* ================================================================= document */

const doc = new Document({
  creator: 'SECH_LIMS validation',
  title: 'SECH_LIMS — Computerised System Validation Report',
  description: 'Validation, remediation and re-qualification of SECH_LIMS 1.0.0',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 20, color: INK } },
      heading1: {
        run: { font: 'Calibri', size: 30, bold: true, color: ACCENT },
        paragraph: { spacing: { before: 360, after: 160 } },
      },
      heading2: {
        run: { font: 'Calibri', size: 24, bold: true, color: INK },
        paragraph: { spacing: { before: 280, after: 120 } },
      },
      heading3: {
        run: { font: 'Calibri', size: 21, bold: true, color: MUTED },
        paragraph: { spacing: { before: 220, after: 100 } },
      },
    },
  },
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 460, hanging: 260 } } } },
          { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 900, hanging: 260 } } } },
        ],
      },
      {
        reference: 'numbers',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '', alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 460, hanging: 260 } } } },
        ],
      },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          children: [t('SECH_LIMS  ·  Computerised System Validation Report  ·  Version 1.0.0', { size: 16, color: MUTED })],
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 6 } },
          spacing: { after: 200 },
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [
            t('10 August 2026', { size: 16, color: MUTED }),
            t('          Page ', { size: 16, color: MUTED }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED, font: 'Calibri' }),
            t(' of ', { size: 16, color: MUTED }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: MUTED, font: 'Calibri' }),
          ],
        })],
      }),
    },
    children,
  }],
});

Packer.toBuffer(doc).then(buf => {
  const out = process.argv[2] || 'SECH_LIMS-Validation-Report.docx';
  fs.writeFileSync(out, buf);
  console.log('wrote', out, (buf.length / 1024).toFixed(0) + ' KB');
});
