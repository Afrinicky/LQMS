/**
 * Builds NSD-VR-001, the SECH_LIMS validation report, as a .docx.
 *
 * The report records the validation of SECH_LIMS 1.0.0 against NSD-SRS-001, its
 * controlled Software Requirements Specification. It reports what was verified
 * and what was found; it is not a change log, and it carries no account of work
 * done to the software before or after the qualification it reports.
 *
 *   npm run validate:report
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
    children: [t('Validation Report', { size: 26, color: INK })],
    spacing: { after: 100 },
    border: { top: { style: BorderStyle.SINGLE, size: 12, color: INK, space: 12 } },
  }),
  new Paragraph({
    children: [t('NSD-VR-001  ·  Version 1.0  ·  10 August 2026', { size: 22, color: MUTED })],
    spacing: { after: 800 },
  }),
);

children.push(table(
  [2400, 6960],
  ['Item', 'Detail'],
  [
    ['Document number', 'NSD-VR-001, Nicklandsales Controlled Documents'],
    ['System', 'SECH_LIMS by Nickland — Laboratory Quality Management System'],
    ['Laboratory', 'St. Elizabeth Catholic Hospital Laboratory'],
    ['Software version validated', '1.0.0'],
    ['Requirements baseline', { text: 'NSD-SRS-001 v1.0 — Software Requirements Specification (76 requirements)', bold: true }],
    ['Validation approach', 'GAMP 5 (2nd Edition) risk-based V-model, software Category 5'],
    ['Test outcomes executed', '696 — 689 passed, 0 failed, 4 deviations, 3 observations'],
    ['Requirements verified', '76 specified — 70 met, 4 deviations, 2 observations'],
    ['Release position', { text: 'Released for single-host and LAN operation, subject to five conditions', bold: true }],
    ['Report status', 'Unsigned. Takes effect on approval by the signatories in Section 10.'],
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

children.push(p('SECH_LIMS version 1.0.0 has been validated against NSD-SRS-001, its controlled Software Requirements Specification. Six hundred and ninety-six test outcomes were produced across installation, operational and performance qualification, on isolated instances of the running system. Nothing was accepted on the strength of having been written carefully.'));

children.push(p([
  t('No test case failed.', { bold: true }),
  t(' Every function the specification requires was exercised and behaved as specified, under normal, boundary and hostile conditions. Seventy of the seventy-six specified requirements are met, four carry a deviation, and two are recorded as observations because the baseline sets no pass condition for them.'),
]));

children.push(h2('1.1  The results that matter most'));

children.push(p('Three findings of this validation deserve to be read before anything else, because they are what an assessor will press hardest on.'));

children.push(bullet([
  t('The quality record survives loss of the host. ', { bold: true }),
  t('A populated laboratory was backed up, records were created and then lost, the system was restored, and everything that existed at backup time came back — including the audit trail, and including a record of the restore itself. The integrity scan on the recovered system was clean. Nineteen test cases, all passed.'),
]));
children.push(bullet([
  t('Access control does what it says and no more. ', { bold: true }),
  t('Forty-eight independent assertions confirm that the right to view is a prerequisite for every other action, that a “view only” technical authorisation cannot confer approval, that an expired authorisation confers nothing, that disabling a module cascades, and that revoking a right blocks every route to the data — including printing, exporting and QR resolution.'),
]));
children.push(bullet([
  t('The record can be shown not to have been altered. ', { bold: true }),
  t('Each audit entry carries the hash of the entry before it, and a verification function walks the chain on demand and during every routine integrity scan. A signature carries a hash of what was signed, so a record edited afterwards is flagged wherever that signature appears.'),
]));

children.push(h2('1.2  Where the system falls short of its specification'));

children.push(p('Four requirements are not met. All four concern protection of data at rest and the provenance of what is installed, and none is a defect in how the software behaves:'));

children.push(bullet('The database is not encrypted at rest (URS-DAT-07).'));
children.push(bullet('Backup packages, including copies sent off site, are not encrypted (URS-DAT-06).'));
children.push(bullet('One shipped third-party component carries a published advisory for which no fixed release exists on the public registry (URS-LC-05).'));
children.push(bullet('The distributed installer is not code-signed (URS-LC-04).'));

children.push(p('Each is described in Section 5, with its risk, its consequence and the control that stands in for it. Two of the four require the laboratory to adopt a key-custody procedure before they can be closed; a lost key would be a lost quality record, which is a decision the system owner has to make rather than one the software can make for them.'));

children.push(pull('The system does what its specification requires of it. What remains unmet is the protection of the record at rest, and the ability to prove where the installer came from.'));

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
    ['Validated configuration', 'Single Windows host; LAN operation permitted with TLS configured; synchronisation disabled'],
    ['Data held', 'Quality records: documents, personnel, competency, equipment, IQC/EQA, NC/CAPA, complaints, risks, audits, meetings, indicators, POCT, environmental monitoring'],
    ['Data not held', 'Patient identity, test requests, clinical results, result verification and dispatch'],
    ['Excluded from scope', 'Cloud synchronisation, the PostgreSQL driver, the remote portal and the native Android package — all excluded by NSD-SRS-001 §2.4 and not validated'],
  ],
));

children.push(h2('2.1  Regulatory classification'));

children.push(p('These determinations are made in NSD-SRS-001 §4.1 and set which obligations apply. They are repeated here because they govern how every result in this report should be read.'));

children.push(table(
  [2600, 1700, 5060],
  ['Question', 'Determination', 'Basis'],
  [
    ['Is it medical device / IVD software?', { text: 'No', bold: true }, 'It performs none of the functions in IVDR Annex VIII or the IMDRF “Software as a Medical Device” criteria: no patient result is generated, interpreted or communicated by it. IEC 62304 and IEC 82304-1 are applied as good-practice references, not as compliance obligations.'],
    ['Is it GxP software under 21 CFR Part 11?', { text: 'Not by jurisdiction; adopted by intent', bold: true }, 'The laboratory is not FDA-regulated. Part 11 and EU GMP Annex 11 are adopted in full as the accepted international benchmark, because the system implements an audit trail and electronic signatures and offers them to assessors as evidence.'],
    ['GAMP 5 software category', { text: 'Category 5', bold: true }, 'Bespoke application written for this laboratory; the whole application is subject to lifecycle and functional verification.'],
    ['Does it process personal data?', { text: 'Yes — staff', bold: true }, 'Names, employee numbers, contact details, occupational health and competency records. The Ghana Data Protection Act, 2012 (Act 843) applies. Patient data is out of scope by design.'],
  ],
));

children.push(h2('2.2  Standards applied'));

children.push(p('Adopted in NSD-SRS-001 §4.2. Every requirement in the baseline traces to at least one clause below, and every result in Section 6 of this report is judged against them.'));

children.push(table(
  [3600, 1400, 4360],
  ['Standard', 'Edition', 'Applied to'],
  [
    ['ISO 15189 — Medical laboratories', '2022', '§7.6 information management, §7.8 continuity, §8.4 records, and the quality processes'],
    ['ISO/IEC 17025 — Testing and calibration laboratories', '2017', '§7.11 control of data and information management'],
    ['ISO 9001 — Quality management systems', '2015', '§7.5 documented information, §8.5.6 control of changes'],
    ['ISO/IEC 27001 + 27002 — Information security', '2022', 'Annex A: access control, cryptography, logging, backup, secure development'],
    ['ISO/IEC 25010 — Systems and software quality (SQuaRE)', '2023', 'Product-quality acceptance dimensions'],
    ['ISO/IEC/IEEE 29148 — Requirements engineering', '2018', 'The structure and quality rules of the baseline specification'],
    ['ISO/IEC/IEEE 12207 — Software life cycle processes', '2017', 'Lifecycle process expectations'],
    ['ISO/IEC/IEEE 29119 — Software testing', '2021–22', 'Test documentation, design and process'],
    ['ISO 14971 — Risk management (by analogy)', '2019', 'Risk-analysis method; drives requirement criticality'],
    ['ISO 22301 — Business continuity', '2019', 'Backup and recovery qualification'],
    ['ISO 81001-1 — Health software safety and security', '2021', 'Good-practice reference'],
    ['GAMP 5 — Compliant GxP computerised systems', '2nd ed., 2022', 'Validation methodology and category determination'],
    ['21 CFR Part 11 — Electronic records and signatures', 'current', 'Audit trail and electronic signature requirements'],
    ['EU GMP Annex 11 — Computerised systems', 'current', 'Computerised-system controls throughout'],
    ['CLSI AUTO11 / GP26', 'current', 'IT security of laboratory software; QMS model'],
    ['Ghana Data Protection Act (Act 843)', '2012', '§28 security safeguards for staff personal data'],
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

children.push(p('A GAMP 5 V-model, scaled by risk. Test depth was set per requirement by the criticality assigned in the baseline and the risk assessment: every requirement rated Critical received executed, evidenced testing; Major requirements were tested by execution or by witnessed re-execution of the supplier’s verification scripts; Minor requirements were verified by inspection or analysis.'));

children.push(h2('3.1  Evidence hierarchy'));

children.push(table(
  [1800, 7560],
  ['Kind', 'Meaning'],
  [
    [{ text: 'Executed', bold: true }, 'The running system was exercised and its response captured verbatim. All operational and performance qualification results are of this kind.'],
    [{ text: 'Witnessed', bold: true }, 'The supplier’s verification scripts were re-executed on clean databases in this environment and their output captured — 587 assertions.'],
    [{ text: 'Inspected', bold: true }, 'Source, configuration or a stored artefact was examined. Used only where a property cannot be provoked from outside — for example, the form in which a session token is stored. Every such conclusion is labelled as inspected.'],
  ],
));

children.push(h2('3.2  The requirements baseline'));

children.push(p([
  t('This validation was executed against ', ),
  t('NSD-SRS-001, the controlled Software Requirements Specification', { bold: true }),
  t(' for SECH_LIMS, approved as the requirements baseline before execution began. It specifies 76 requirements, each written to be singular and verifiable, each traced to at least one clause of the standards in Section 2.2, and each carrying a criticality, a verification method and an acceptance criterion.'),
]));

children.push(p('Traceability is maintained in both directions. Every test case in this validation traces to a requirement in that document, and every requirement in that document traces to at least one test case. A test tracing to no requirement, and a requirement covered by no test, are each treated as a defect in the specification and were resolved before this report was prepared.'));

children.push(p([
  t('NSD-SRS-001 is structured to ISO/IEC/IEEE 29148:2018, and its own document control records how the baseline was established for a product that already existed — derived from the adopted standards, the laboratory’s intended use, the product documentation and the implemented behaviour, then reviewed and approved. That provenance is stated there rather than repeated here, but it bears on how this report should be read: '),
  t('the specification is the authority for what the software is required to do, and this report is the record of whether it does it.', { bold: true }),
]));

children.push(p('The baseline also records, deliberately, the areas in which it states no requirement: numeric performance and capacity targets, and usability and accessibility. Neither was agreed with the laboratory, so neither is a validation acceptance criterion, and neither was verified. Their absence is a decision on the record rather than an omission — and it is the reason two of the seventy-six requirements are reported below as not verified rather than as met or failed.'));

children.push(h2('3.3  Protocols that are executable'));

children.push(p('The operational and performance qualifications are scripts, committed alongside the code, so that re-qualifying after a change is a command rather than a fortnight of manual testing:'));

children.push(new Paragraph({
  children: [t('npm test          ·  npm run validate:oq          ·  npm run validate:pq', { font: 'Consolas', size: 19, color: ACCENT })],
  spacing: { before: 120, after: 120 },
  indent: { left: 360 },
}));

children.push(p('Each qualification suite starts its own host on a scratch data directory and refuses to run if another host is already listening on its port, so it can never reach the laboratory’s live database and can never silently inherit another run’s state. Repeatability was verified over three consecutive executions producing identical results, not assumed.'));

children.push(h2('3.4  Test environment'));

children.push(table(
  [2400, 6960],
  ['Item', 'Value'],
  [
    ['Operating system', 'Linux 6.18.5 (validation host)'],
    ['Runtime', 'Node.js v22.22.2, npm 10.9.7'],
    ['Store', 'SQLite via better-sqlite3 11.7.0, WAL journal, foreign keys enforced'],
    ['Network', 'Loopback only; isolated ports per qualification instance'],
    ['Data directory', 'A scratch directory per run. The laboratory’s own data was never touched'],
    ['Synchronisation', 'Disabled, as required by the validated configuration'],
  ],
));

children.push(spacer(160));
children.push(p([
  t('Environment limitation. ', { bold: true }),
  t('The validated configuration is a Windows desktop host; this qualification ran on Linux. Everything above the packaging layer — the API, the database, the permission resolver, the audit trail, signatures, backup and restore — is platform-independent and its results carry over. The Windows-specific layer remains to be qualified on the target machine, and is condition C-10 of the release in Section 7.'),
]));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* --------------------------------------------------------------- 4 results */
children.push(h1('4  Qualification results'));

children.push(table(
  [2900, 1000, 1000, 900, 1180, 2380],
  ['Qualification', 'Cases', 'Passed', 'Failed', 'Deviations', 'What it establishes'],
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

children.push(spacer(160));
children.push(p('Three further outcomes are recorded as observations rather than as pass or fail: they capture evidence about the system — its deployment mode, its restore behaviour — where the baseline states no pass condition to judge against.'));

children.push(h2('4.1  Requirements coverage'));

children.push(table(
  [2200, 1500, 1400, 1600, 2660],
  ['Criticality', 'Specified', 'Met', 'Deviation', 'Observation'],
  [
    ['Critical', '47', '45', '2', '—'],
    ['Major', '25', '21', '2', '2'],
    ['Minor', '4', '4', '—', '—'],
    [{ text: 'Total', bold: true }, { text: '76', bold: true }, { text: '70', bold: true }, { text: '4', bold: true }, { text: '2', bold: true }],
  ],
  { align: [undefined, AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.CENTER] },
));

children.push(spacer(160));
children.push(p('The two observations are URS-INF-03 (connectivity reporting) and URS-DAT-15 (retention recorded but never enforced by automatic destruction). Both were exercised and their behaviour captured; neither carries a pass condition in the baseline to judge against, so both are recorded as evidence rather than as a verdict. URS-DAT-15 in particular is a deliberate design position: automatic destruction of quality records is a worse failure mode than over-retention.'));

children.push(p('Separately, two of the product-quality attributes in NSD-SRS-001 §11.3 — performance efficiency and interaction capability — were not verified, because the baseline states no target for either. They are neither met nor failed; they are unspecified, and §12.4 of the specification records that as a decision rather than leaving it to inference.'));

children.push(h2('4.2  The recovery test, in detail'));

children.push(p('This is the result the laboratory most needs to be able to show an assessor. A laboratory was initialised, three staff records created and confirmed in the audit trail, and a backup taken. A further record was then created — the state a restore has to roll back — and the system restored from the backup.'));

children.push(table(
  [2200, 7160],
  ['Check', 'Observed'],
  [
    ['Backup produced', 'Package written to disk with a manifest and a SHA-256 digest'],
    ['Safety snapshot', 'A pre-restore archive of current state written before any live data was touched; the restore aborts if it cannot be written'],
    ['Records returned', 'All three pre-backup records present after the restore'],
    ['Restore point honoured', 'The post-backup record correctly absent, so the recovery point is knowable'],
    ['Audit trail', 'Survived intact, and the restore itself appears in the restored trail'],
    ['Integrity of the result', 'Data-integrity scan on the recovered system: 0 issues, status “passed”'],
    ['Damaged archive refused', 'A deliberately corrupted backup was refused before live data was touched; the refusal is itself audited and the live system was unchanged'],
  ],
));

children.push(h2('4.3  A defect found in the test instrumentation'));

children.push(p('The operational qualification’s inactivity test initially aged every live session, expiring the administrator’s alongside the one under test and turning eight later cases into failures that said nothing about the system. It now ages only the session being tested, and those eight cases pass.'));

children.push(p('This is recorded because how a result was obtained is part of the evidence, and because a validation that hides mistakes in its own instrumentation is not evidence of anything. It is also worth noting where the instrumentation lives: in the test, not in the product. There is deliberately no endpoint that expires a session early, because a way to reach into sessions from outside is exactly what the control exists to prevent.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* -------------------------------------------------------------- 5 findings */
children.push(h1('5  Findings'));

children.push(p('Four requirements of NSD-SRS-001 are not met by version 1.0.0. Each is recorded below with the risk it carries, the consequence of leaving it open, and the control the laboratory is to apply in the meantime. None is a defect in how the software behaves; all four concern protection of data at rest, or the provenance of what is installed.'));

children.push(p('The complete findings register for all validation activity on this product is NSD-FR-001; this report records the findings open against version 1.0.0.'));

children.push(table(
  [1100, 1500, 3000, 3760],
  ['Ref', 'Requirement', 'Finding', 'Interim control'],
  [
    ['VF-06', 'URS-DAT-07 (Major)', 'The database is not encrypted at rest. A stolen or shared host yields every staff record — names, employee numbers, contact details, occupational-health and competency data — without authenticating to the application', 'Full-disk encryption on the host and physical security, documented in the laboratory’s information-security procedure (condition C-4)'],
    ['VF-07', 'URS-DAT-06 (Critical)', 'Backup packages are unencrypted archives holding the whole database, uploads and evidence. Copies sent off site carry the complete quality record in the clear', 'Off-site copying disabled, or restricted to an encrypted volume under laboratory control (condition C-5)'],
    ['VF-10', 'URS-LC-05 (Critical)', 'One shipped component — the spreadsheet library used by every import and export path — carries a published prototype-pollution and denial-of-service advisory with no fixed release on the public registry', 'Import paths are permission-gated and the workbooks parsed come from the laboratory itself. Continuous integration blocks on any critical advisory in shipped code, so the position cannot silently worsen'],
    ['VF-12', 'URS-LC-04 (Major)', 'The distributed installer is not code-signed. Windows warns on every install, which trains staff to dismiss the warning, and the laboratory cannot demonstrate that the installer it ran is the one the supplier built', 'Installers distributed only through a controlled channel, with their digests published and checked on receipt'],
  ],
));

children.push(h2('5.1  Why two of these are the laboratory’s decision rather than the supplier’s'));

children.push(p('VF-06 and VF-07 both turn on the same thing: a key. Encrypting the database means changing a native dependency in a build that already documents its native SQLite module as the most fragile step in packaging, and encrypting backups introduces a key that, if lost, turns every archive into noise on the day it is most needed.'));

children.push(p([
  t('A lost key is a lost quality record. ', { bold: true }),
  t('That is a trade the system owner has to make, with the hospital’s information-security function, together with a written key-custody procedure. It is not a trade a supplier should make on a laboratory’s behalf, and this report does not recommend closing either finding until that procedure exists.'),
]));

children.push(p('The integrity half of the backup problem is separate and is met: URS-DAT-04 requires that a laboratory be able to prove an archive is the one it took, and the qualification demonstrated that a corrupted archive is refused rather than restored. What remains open is confidentiality, not trustworthiness.'));

children.push(h2('5.2  Residual risk'));

children.push(p('With the interim controls in Section 5 applied, the residual risk is:'));

children.push(bullet('Loss or theft of the host machine exposes staff personal data, mitigated only by full-disk encryption and physical security rather than by the application.'));
children.push(bullet('An off-site backup copy, if the laboratory chooses to make one before VF-07 is closed, carries the quality record in a form its custodian could read.'));
children.push(bullet('A crafted spreadsheet, if one reached an authorised importer, could exploit the known advisory in the parsing library.'));
children.push(bullet('An installer substituted between the supplier and the laboratory could not be distinguished from a genuine one by signature; only by the published digest.'));

children.push(p('The system owner is asked to accept this residual risk in writing at Section 10, or to withhold release until it is reduced.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ---------------------------------------------------------- 6 conformity */
children.push(h1('6  Conformity against the standards'));

children.push(p('Judged only on what the software must do. Where a clause is satisfied by laboratory procedure rather than by software, it is recorded as procedural — the software cannot claim the credit, but neither should it be marked down for it. Clauses not listed are met in full.'));

children.push(table(
  [1600, 3400, 1500, 2860],
  ['Standard', 'Clause', 'Status', 'Basis'],
  [
    ['ISO 15189', '4.2 Confidentiality of information', { text: 'Partial', bold: true, color: AMBER }, 'Access control and transport verified; storage at rest not encrypted (VF-06, VF-07)'],
    ['ISO 15189', '7.6.2 Authorities and responsibilities', { text: 'Conforms', bold: true, color: GREEN }, 'RBAC verified over 48 assertions; sign-ins audited; duties separable'],
    ['ISO 15189', '7.6.3 Information system management', { text: 'Partial', bold: true, color: AMBER }, 'Validated before use; tamper-evidence and access protection verified; encryption at rest absent (VF-06)'],
    ['ISO 15189', '7.6.4 Protection against loss', { text: 'Conforms', bold: true, color: GREEN }, 'Demonstrated end to end by the recovery qualification'],
    ['ISO 15189', '7.8 Continuity and emergency preparedness', { text: 'Partial', bold: true, color: AMBER }, 'Recovery proven and archive authenticity verified; off-site confidentiality open (VF-07)'],
    ['ISO 15189', '8.4 Control of records', { text: 'Conforms', bold: true, color: GREEN }, 'Attributable, complete, recoverable, tamper-evident, unambiguously timestamped'],
    ['ISO 17025', '7.11.2 Validated before introduction', { text: 'Conforms', bold: true, color: GREEN }, 'This report, against an approved baseline, with a version that identifies the build'],
    ['ISO 17025', '7.11.3(a) Protection from unauthorised access', { text: 'Partial', bold: true, color: AMBER }, 'Authentication, lockout and password policy verified; at-rest encryption absent (VF-06)'],
    ['ISO 17025', '7.11.3(b)–(e)', { text: 'Conforms', bold: true, color: GREEN }, 'Tampering detectable, loss proven recoverable, integrity maintained, failures recorded'],
    ['Part 11', '11.10(c) Protection of records', { text: 'Partial', bold: true, color: AMBER }, 'Retrieval and tamper-evidence verified; encryption at rest absent (VF-06)'],
    ['Part 11', '11.10(d), (e), (g), (k)', { text: 'Conforms', bold: true, color: GREEN }, 'Access limitation, audit trail, authority checks and change control all verified'],
    ['Part 11', '11.10(h) Device checks', { text: 'Partial', bold: true, color: AMBER }, 'Device identifier and address captured on sessions and signatures; no device authorisation enforced'],
    ['Part 11', '11.50, 11.70, 11.200, 11.300 (Subpart C)', { text: 'Conforms', bold: true, color: GREEN }, 'Printed name, time and meaning recorded; signature bound to a hash of the content; a component re-entered at signing; credential and transaction safeguards verified'],
    ['Annex 11', '§3 Suppliers and service providers', { text: 'Does not', bold: true, color: RED }, 'No supplier assessment of the developer has been recorded. A laboratory obligation — see Section 7.4'],
    ['Annex 11', '§7.2, §9, §12, §14, §16', { text: 'Conforms', bold: true, color: GREEN }, 'Backups checked for accuracy, audit trails, security and access control, electronic signature, business continuity'],
    ['Annex 11', '§7.1, §17 Data protection and archiving', { text: 'Partial', bold: true, color: AMBER }, 'Integrity verified; encryption at rest absent (VF-06, VF-07)'],
    ['ISO 27001', 'A.5.3, A.5.17, A.5.18, A.8.5, A.8.15', { text: 'Conforms', bold: true, color: GREEN }, 'Segregation of duties, authentication information, access rights, secure authentication, logging'],
    ['ISO 27001', 'A.8.8 Technical vulnerabilities', { text: 'Does not', bold: true, color: RED }, 'One advisory in shipped code with no fix on the public registry (VF-10)'],
    ['ISO 27001', 'A.8.13 Information backup', { text: 'Partial', bold: true, color: AMBER }, 'Backup, retention and verified recovery in place; encryption absent (VF-07)'],
    ['ISO 27001', 'A.8.19, A.8.30 Installation and outsourced development', { text: 'Does not', bold: true, color: RED }, 'Unsigned installer (VF-12); supplier assessment outstanding'],
    ['ISO 27001', 'A.8.23, A.8.25, A.8.26, A.8.28', { text: 'Conforms', bold: true, color: GREEN }, 'Origin control, secure development lifecycle, application security requirements, secure coding'],
    ['ISO 27001', 'A.8.24 Use of cryptography', { text: 'Partial', bold: true, color: AMBER }, 'In transit and for stored credentials verified; at rest absent (VF-06, VF-07)'],
  ],
  { align: [undefined, undefined, AlignmentType.CENTER, undefined] },
));

children.push(spacer(160));

children.push(p([
  t('Every partial or failing clause traces to one of the four findings in Section 5, plus the outstanding supplier assessment. ', { bold: true }),
  t('Three of the four findings concern cryptography at rest and the fourth is a certificate. No clause is failed on the grounds of how the software behaves.'),
]));

children.push(h2('6.1  Product quality (ISO/IEC 25010)'));

children.push(table(
  [2400, 6960],
  ['Characteristic', 'Assessment'],
  [
    ['Functional suitability', 'Strong. 696 executed and witnessed outcomes, none failed, across 33 modules covering the ISO 15189 quality domains'],
    ['Reliability', 'Good. Survived malformed and hostile input; recovered fully from simulated data loss; background schedulers self-gate and fail loudly without becoming fatal'],
    ['Security', 'Access control, authentication, logging and record integrity all verified against the baseline. Cryptography at rest is the open edge (VF-06, VF-07)'],
    ['Maintainability', 'Adequate. Clear module boundaries, a single permission decision point and unusually good explanatory comments, against two very large source files — with a regression suite behind them'],
    ['Flexibility', 'Good. Deployment is configurable entirely by environment variable, and a data-access seam allows an alternative database backend without rewriting business logic'],
    ['Performance efficiency', 'Not verified. The baseline states no numeric target (NSD-SRS-001 §11.3, §12.4). No load or volume testing was performed'],
    ['Interaction capability', 'Not verified. The baseline states no usability or accessibility requirement'],
    ['Safety', 'Not applicable by design. The product produces no patient result'],
  ],
));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------- 7 decision */
children.push(h1('7  Release decision'));

children.push(p([
  t('Recommended position: release for single-host and LAN operation', { bold: true, size: 24 }),
]));

children.push(p('Version 1.0.0 meets 70 of the 76 requirements of NSD-SRS-001, fails none of them functionally, and carries four findings, each with an interim control. It is recommended for release into laboratory use subject to the conditions below and to the system owner accepting the residual risk in Section 5.2.'));

children.push(h2('7.1  Conditions of release'));

children.push(table(
  [900, 4200, 4260],
  ['Ref', 'Condition', 'Why'],
  [
    ['C-3', 'Cloud synchronisation and the PostgreSQL driver remain disabled', 'Excluded from the baseline (NSD-SRS-001 §2.4) and therefore not validated. Enabling either requires a supplementary specification, risk assessment and qualification'],
    ['C-4', 'The host is protected by full-disk encryption and physical security, documented in the laboratory’s information-security procedure', 'Interim control for VF-06'],
    ['C-5', 'Off-site backup copying is disabled, or restricted to an encrypted volume under laboratory control', 'Interim control for VF-07'],
    ['C-9', 'Host administrator accounts are restricted to named individuals, and the audit trail is reviewed at a defined frequency by somebody other than the administrator', 'The Independent Reviewer role and the audit hash chain make this reviewable; the procedure makes it happen'],
    ['C-10', 'Installation qualification on the target Windows machine is completed and appended before production use', 'This qualification ran on Linux — see Section 3.4'],
  ],
));

children.push(h2('7.2  Conditions on network operation'));

children.push(p('LAN operation is within the validated configuration, but only with transport encryption configured. The host serves HTTPS when a certificate is provided and prints an explicit warning at startup when it is bound to a network address without one. That warning is not advisory: a host serving the LAN without a certificate puts every password and every quality record on the wire in clear, and the laboratory should treat its appearance as a bar to use.'));

children.push(h2('7.3  Outstanding work on the target platform'));

children.push(p('Everything above the packaging layer is platform-independent and its results carry over from this qualification. The Windows-specific layer must still be qualified on the machine that will run it:'));

children.push(bullet('Produce the installer on Windows with the native toolchain, and confirm the native SQLite module rebuilds against the bundled Electron headers'));
children.push(bullet('Install on a clean machine and confirm the application launches'));
children.push(bullet('Confirm the database, uploads, evidence and backups live under the user data directory and never in the installation directory'));
children.push(bullet('Reinstall over an existing installation and confirm user data survives untouched'));
children.push(bullet('Execute the module route smoke test and the release-candidate checklist on the installed application'));
children.push(bullet('Confirm TLS is configured before the host is bound to the network'));

children.push(h2('7.4  Recommendations, in order'));

children.push(new Paragraph({ children: [t('Complete the Windows installation qualification in Section 7.3 before production use.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('Adopt a key-custody procedure, and on the strength of it decide VF-06 and VF-07 together. They turn on the same decision and should not be taken separately.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('Obtain a code-signing certificate and sign the installer (VF-12). The build is already configured to use one when it is present.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('Decide the spreadsheet-library question (VF-10): re-source it from the maintainer’s own registry, or replace it. Either is a supply-chain decision with regression surface, so plan it rather than drifting into it.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('Record a supplier assessment of Nickland, which EU GMP Annex 11 §3 expects and which is the one lifecycle expectation this package does not satisfy. It is a laboratory obligation, not a property of the software.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));
children.push(new Paragraph({ children: [t('Agree performance and usability requirements at the first periodic review, so that the two attributes NSD-SRS-001 leaves unspecified can be specified and verified.')], numbering: { reference: 'numbers', level: 0 }, spacing: { after: 80 } }));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------- 8 staying valid */
children.push(h1('8  Keeping the system validated'));

children.push(p('A validation is a statement about one build at one moment. Version 1.0.0 is validated against NSD-SRS-001 v1.0; the next commit is not, until something says so.'));

children.push(p('The governing rule is set by the baseline itself: no change may be made to SECH_LIMS until the requirement it satisfies has been written into NSD-SRS-001 and approved. Verification then follows the specification, and the result is recorded in a revision of this report.'));

children.push(table(
  [1600, 3400, 4360],
  ['Class', 'Definition', 'Evidence required'],
  [
    [{ text: 'Major', bold: true }, 'Touches authentication, authorisation, the audit trail, electronic signatures, backup and restore, the database schema, or enables a surface excluded from the baseline', 'Amend and approve NSD-SRS-001 first. Then: risk assessment update, the full validation suite, targeted test cases for the change, updated traceability, revised report. Approved by the system owner and the Quality Manager'],
    [{ text: 'Minor', bold: true }, 'New or changed functionality inside an existing module, not touching anything in the Major list', 'Amend the affected requirement and obtain approval, then the validation suite and the verification scripts for the affected module. Approved by the Quality Manager'],
    [{ text: 'Cosmetic', bold: true }, 'Wording, layout, colour, non-functional refactor with no behaviour change', 'Typecheck and the operational qualification suite. No amendment to the baseline required'],
    [{ text: 'Emergency', bold: true }, 'Required to restore service or prevent record loss', 'Implement, then produce Minor-class evidence and amend the baseline within five working days. Recorded as a deviation until closed'],
  ],
));

children.push(spacer(160));

children.push(p('Three further rules apply to every change: bump the version, because a build whose version cannot be tied to a commit cannot be validated; run the validation suite, which continuous integration now enforces rather than leaving to memory; and record the change in the system’s own Change Control and Software Release modules, because a change record that lives only in a version-control history is not available to an assessor.'));

children.push(h2('8.1  Periodic review'));

children.push(p('Every six months, or on closure of any finding in Section 5, whichever is sooner, recorded as a management review input. The review asks whether the deployed version is still the validated version, whether the suite still passes, whether every change since the last review was classified and evidenced, whether the interim controls are still being followed, whether new vulnerabilities have appeared, what incidents or downtime occurred, and whether the standards themselves have moved.'));

children.push(p('A full re-validation is required if the database engine changes, if a surface excluded from the baseline is enabled, if the authentication or permission model is redesigned, or after three years.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------ 9 documents */
children.push(h1('9  Supporting documents and evidence'));

children.push(p('The validation package is version-controlled in the repository alongside the code it validates, so the validated state and the validated build cannot drift apart.'));

children.push(table(
  [2100, 3200, 4060],
  ['Reference', 'Title', 'What it establishes'],
  [
    [{ text: 'NSD-SRS-001', bold: true }, 'Software Requirements Specification', '76 requirements with criticality, verification method and acceptance criterion — the baseline for this validation'],
    ['NSD-VMP-001', 'Validation Master Plan', 'Scope, standards, approach, roles, acceptance criteria'],
    ['NSD-RA-001', 'Risk Assessment', 'Function-level risk analysis driving verification depth'],
    ['NSD-PQ-001', 'IQ / OQ / PQ Protocols', 'The protocols, the test environment, and how to re-execute them'],
    ['NSD-TM-001', 'Traceability Matrix', 'Requirement to implementation to test to result, in both directions'],
    ['NSD-FR-001', 'Findings Register', 'All findings raised on this product, risk-rated, with their disposition'],
    ['NSD-GA-001', 'Standards Gap Analysis', 'Clause-by-clause conformity against the adopted standards'],
    [{ text: 'NSD-VR-001', bold: true }, 'Validation Report', 'This document'],
    ['NSD-PRC-001', 'Periodic Review and Change Control', 'Keeping the system in a validated state'],
  ],
));

children.push(spacer(160));

children.push(p('Objective evidence retained with the package: the build and installation log, the unit-test results, the 587 supplier verification assertions, and machine-readable results for all 67 operational and 19 performance qualification test cases, each recording the observed behaviour verbatim. Continuous integration retains the qualification evidence from every run for ninety days.'));

children.push(new Paragraph({ children: [new PageBreak()] }));

/* ------------------------------------------------------------- 10 approval */
children.push(h1('10  Approval'));

children.push(p('This report requires signature by the system owner, the process owner and an independent reviewer. The independent reviewer must not be the person who performed the validation, as required by EU GMP Annex 11 §2 and ISO 15189 §7.6.3.'));

children.push(p([
  t('By signing, the system owner accepts the residual risk described in Section 5.2 and undertakes to operate the system within conditions C-3, C-4, C-5, C-9 and C-10 of Section 7.', { bold: true }),
]));

children.push(spacer(300));

const sigRow = (role) => new TableRow({
  children: [
    cell([
      new Paragraph({ children: [t(role, { bold: true, size: 19 })], spacing: { after: 40 } }),
      new Paragraph({ children: [t('', { size: 19 })], spacing: { after: 200 } }),
    ], { width: 2600 }),
    cell([new Paragraph({ children: [t('Name', { size: 17, color: MUTED })], spacing: { after: 340 } })], { width: 2400 }),
    cell([new Paragraph({ children: [t('Signature', { size: 17, color: MUTED })], spacing: { after: 340 } })], { width: 2600 }),
    cell([new Paragraph({ children: [t('Date', { size: 17, color: MUTED })], spacing: { after: 340 } })], { width: 1760 }),
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
          children: [t('NSD-VR-001  ·  SECH_LIMS Validation Report  ·  Software version 1.0.0', { size: 16, color: MUTED })],
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
  const out = process.argv[2] || 'NSD-VR-001-Validation-Report.docx';
  fs.writeFileSync(out, buf);
  console.log('wrote', out, (buf.length / 1024).toFixed(0) + ' KB');
});
