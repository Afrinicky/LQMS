/**
 * A transmitted result, as the document a laboratory hands over.
 *
 * The register already shows that a message arrived and where it went. This
 * answers the other question people actually ask of it — "what did the report
 * say?" — by laying one transmission out the way the laboratory issues it: the
 * letterhead, the patient and sample block, every parameter with its unit, the
 * analyser's own flag beside it, the reference range it was read against, and
 * whatever the instrument said about the sample in its own words.
 *
 * Three rules hold the document honest.
 *
 *   NOTHING IS RECALCULATED. The value printed is the value received and the
 *   flag printed is the flag the analyser raised. Where the laboratory's own
 *   reference interval disagrees with the instrument, both are shown; neither
 *   overrules the other.
 *
 *   NOTHING IS INVENTED. A demographic the transmission did not carry prints as
 *   a dash. Carrying one over from a previous sample, or defaulting a sex,
 *   would make the document say something nobody said.
 *
 *   THE APPEARANCE IS CONFIGURATION. Letterhead, crest, colours, columns and
 *   paper are a template row, so a laboratory changes its report without
 *   changing this system, and a second site keeps its own.
 *
 * PDF is the browser's own print-to-PDF, as everywhere else in SECHLIMS: a
 * laboratory host that never sees the internet must still be able to produce
 * one, and every machine already has a PDF printer.
 */
import {
  DEFAULT_TEMPLATE, REPORT_COLUMN_LABELS, ageInDays, flagMeaning, fontStack, outsideRange, pickRange,
  type ReferenceRange, type ReportColumn, type ReportTemplate,
} from '../../shared/constants/labReport.js';
import { rangeKey } from './resultFiller/referenceRanges.js';
import { demographicsOf, type Demographics } from './resultFiller/demographics.js';
import { readingsOf } from './resultFiller/pending.js';

type DB = any;

/* ============================================================================
   Reading the record
   ========================================================================= */
export interface ReportParameter {
  code: string;
  analyte: string;
  value: string;
  unit: string | null;
  flag: string | null;
  referenceLow: string | null;
  referenceHigh: string | null;
  referenceText: string | null;
  /** The sex or age band the range was set for, where it was set for one. */
  referencePopulation: string | null;
  /** Set only where the laboratory holds a range and the value falls outside it. */
  outside: 'high' | 'low' | null;
}

export interface ReportData {
  id: number;
  sampleId: string | null;
  lotNumber: string | null;
  kind: string;
  receivedAt: string;
  runAt: string | null;
  instrumentName: string | null;
  linkName: string | null;
  equipmentName: string | null;
  sectionName: string | null;
  peer: string | null;
  deliveries: Array<{ destination: string; state: string; at: string | null }>;
  mwStatus: string | null;
  demographics: Demographics;
  parameters: ReportParameter[];
  /** The analyser's interpretive messages, as transmitted. */
  instrumentMessages: string[];
}

const ROW_SQL = `SELECT m.id, m.sample_id, m.lot_number, m.kind, m.received_at, m.instrument_run_at,
      m.instrument_name, m.parsed_values, m.raw_message, m.peer,
      l.name AS link_name, l.profile_key, l.analyte_map,
      e.name AS equipment_name, s.name AS section_name,
      x.id AS mw_id, x.status AS mw_status
    FROM instrument_messages m
    LEFT JOIN instrument_links l ON l.id = m.link_id
    LEFT JOIN equipment_items e ON e.id = l.equipment_id
    LEFT JOIN sections s ON s.id = l.section_id
    LEFT JOIN mw_messages x ON x.instrument_message_id = m.id`;

/**
 * The ranges a result is read against, keyed by parameter.
 *
 * Two registers, in order of authority. The ranges the laboratory set FOR THE
 * REPORT come first; where it has set none for a parameter, the verification
 * module's own reference intervals are used, so a laboratory that recorded them
 * there years ago does not type them twice.
 *
 * Loaded once per report rather than per parameter, and narrowed to this
 * patient afterwards — an adult male haemoglobin range read against a newborn
 * is a wrong range printed with authority.
 */
function rangeIndex(db: DB): Map<string, ReferenceRange[]> {
  const index = new Map<string, ReferenceRange[]>();
  const add = (key: string, range: ReferenceRange) => {
    if (!key) return;
    const held = index.get(key);
    if (held) held.push(range);
    else index.set(key, [range]);
  };

  try {
    const rows = db.prepare(`SELECT * FROM rf_reference_ranges WHERE is_active = 1 ORDER BY id`).all() as any[];
    for (const row of rows) {
      // Keyed from the name at read time rather than from the stored column,
      // so a register written before the key was corrected still answers.
      add(rangeKey(row.analyte), {
        id: Number(row.id),
        analyte: String(row.analyte),
        sex: (row.sex || 'any') as ReferenceRange['sex'],
        ageMinDays: row.age_min_days == null ? null : Number(row.age_min_days),
        ageMaxDays: row.age_max_days == null ? null : Number(row.age_max_days),
        ageLabel: row.age_label ?? null,
        low: row.low ?? null,
        high: row.high ?? null,
        textValue: row.text_value ?? null,
        unit: row.unit ?? null,
        source: row.source ?? null,
        note: row.note ?? null,
      });
    }
  } catch { /* a database without the table falls through to the register below */ }

  try {
    const rows = db.prepare(`SELECT analyte, population, lower_limit, upper_limit, unit, clinical_decision_limit
        FROM reference_interval_records WHERE status = 'active' ORDER BY id`).all() as any[];
    for (const row of rows) {
      const key = rangeKey(row.analyte);
      // Only where the report's own register says nothing about this parameter.
      if (!key || index.has(key)) continue;
      const population = String(row.population ?? '').trim().toLowerCase();
      add(key, {
        analyte: String(row.analyte),
        sex: population.includes('male') && !population.includes('female') ? 'male'
          : population.includes('female') ? 'female' : 'any',
        ageMinDays: null,
        ageMaxDays: null,
        ageLabel: row.population ?? null,
        low: row.lower_limit == null ? null : String(row.lower_limit),
        high: row.upper_limit == null ? null : String(row.upper_limit),
        textValue: row.clinical_decision_limit ? String(row.clinical_decision_limit) : null,
        unit: row.unit ?? null,
        source: 'Verification & Validation',
        note: null,
      });
    }
  } catch { /* the report prints dashes rather than failing */ }

  return index;
}

/** The analyser's own interpretive text — "Lymphocytosis", "Blasts?" and so on. */
function interpretiveMessages(demographics: Demographics, raw: string | null): string[] {
  const found = [...demographics.comments];
  const text = String(raw ?? '');
  // Sysmex and several others carry IP messages as comment records; some write
  // them as a flagging segment instead. Both are text about this sample.
  for (const line of text.split(/[\r\n\x02\x03]+/)) {
    const match = line.match(/^\d?C\|\d+\|[^|]*\|([^|]+)\|/);
    if (match) {
      const value = match[1].replace(/\^/g, ' ').trim();
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found.filter(line => line.length > 1).slice(0, 16);
}

export function collectReport(db: DB, id: number): ReportData | null {
  const row = db.prepare(`${ROW_SQL} WHERE m.id = ?`).get(id) as any;
  if (!row) return null;

  const demographics = demographicsOf(row.raw_message, row.instrument_run_at ?? row.received_at);
  const index = rangeIndex(db);
  const patient = {
    sex: demographics.sex,
    ageDays: ageInDays(demographics.birthDate, row.instrument_run_at ?? row.received_at),
  };
  const parameters: ReportParameter[] = readingsOf(row).map(reading => {
    // Looked up by the analyser's own mnemonic, by this system's name for it,
    // and by what the dictionary calls it — so a range set once under HGB is
    // found for a result that arrived as Haemoglobin.
    const candidates = index.get(rangeKey(reading.analyte)) ?? index.get(rangeKey(reading.code)) ?? [];
    const reference = pickRange(candidates, patient);
    const low = reference?.low ?? null;
    const high = reference?.high ?? null;
    return {
      code: reading.code,
      analyte: reading.analyte,
      value: reading.value,
      unit: reading.unit,
      flag: reading.flag,
      referenceLow: low,
      referenceHigh: high,
      referenceText: reference?.textValue ?? null,
      referencePopulation: reference && (reference.sex !== 'any' || reference.ageLabel)
        ? [reference.sex !== 'any' ? reference.sex : '', reference.ageLabel ?? ''].filter(Boolean).join(' · ')
        : null,
      outside: outsideRange(reading.value, low, high),
    };
  });

  let deliveries: ReportData['deliveries'] = [];
  if (row.mw_id) {
    try {
      deliveries = (db.prepare(`SELECT d.state, d.delivered_at, dest.name AS destination
          FROM mw_deliveries d LEFT JOIN mw_destinations dest ON dest.id = d.destination_id
          WHERE d.message_id = ? ORDER BY d.id`).all(row.mw_id) as any[])
        .map(d => ({ destination: d.destination ?? 'Destination', state: String(d.state), at: d.delivered_at ?? null }));
    } catch { deliveries = []; }
  }

  return {
    id: Number(row.id),
    sampleId: row.sample_id ?? null,
    lotNumber: row.lot_number ?? null,
    kind: String(row.kind ?? 'unknown'),
    receivedAt: String(row.received_at),
    runAt: row.instrument_run_at ?? null,
    instrumentName: row.instrument_name ?? null,
    linkName: row.link_name ?? null,
    equipmentName: row.equipment_name ?? null,
    sectionName: row.section_name ?? null,
    peer: row.peer ?? null,
    deliveries,
    mwStatus: row.mw_status ?? null,
    demographics,
    parameters,
    instrumentMessages: interpretiveMessages(demographics, row.raw_message),
  };
}

/* ============================================================================
   The template
   ========================================================================= */
export function loadTemplate(db: DB, code?: string | null): ReportTemplate {
  let row: any = null;
  try {
    row = code
      ? db.prepare('SELECT * FROM rf_report_templates WHERE template_code = ?').get(code)
      : db.prepare('SELECT * FROM rf_report_templates ORDER BY is_default DESC, id LIMIT 1').get();
  } catch { row = null; }

  let facility = '';
  try {
    facility = String((db.prepare('SELECT facility_name FROM laboratory_profile WHERE id = 1').get() as any)?.facility_name ?? '');
  } catch { /* a report without a facility name still prints */ }

  if (!row) return { ...DEFAULT_TEMPLATE, facility: DEFAULT_TEMPLATE.facility || facility };

  const columns = (() => {
    try { return JSON.parse(row.columns ?? '') as ReportColumn[]; } catch { return DEFAULT_TEMPLATE.columns; }
  })();

  return {
    id: Number(row.id),
    templateCode: String(row.template_code),
    name: String(row.name),
    organisation: row.organisation ?? '',
    facility: row.facility || facility,
    addressLine: row.address_line ?? '',
    contactLine: row.contact_line ?? '',
    reportTitle: row.report_title ?? '',
    footerText: row.footer_text ?? '',
    logoDataUri: row.logo_data_uri ?? null,
    accentColour: row.accent_colour || DEFAULT_TEMPLATE.accentColour,
    textColour: row.text_colour || DEFAULT_TEMPLATE.textColour,
    headerStyle: row.header_style || DEFAULT_TEMPLATE.headerStyle,
    font: row.font || DEFAULT_TEMPLATE.font,
    paper: row.paper || DEFAULT_TEMPLATE.paper,
    density: row.density || DEFAULT_TEMPLATE.density,
    marginMm: Number(row.margin_mm ?? DEFAULT_TEMPLATE.marginMm),
    columns: Array.isArray(columns) && columns.length ? columns : DEFAULT_TEMPLATE.columns,
    showLogo: Number(row.show_logo) === 1,
    showFlagLegend: Number(row.show_flag_legend) === 1,
    showInstrumentMessages: Number(row.show_instrument_messages) === 1,
    showSignature: Number(row.show_signature) === 1,
    signatureLine: row.signature_line || DEFAULT_TEMPLATE.signatureLine,
    showDeliveryState: Number(row.show_delivery_state) === 1,
    showRangePopulation: Number(row.show_range_population) === 1,
    watermark: row.watermark ?? '',
    disclaimer: row.disclaimer ?? '',
    isDefault: Number(row.is_default) === 1,
  };
}

/* ============================================================================
   Rendering
   ========================================================================= */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const dash = '<span class="none">—</span>';
const show = (value: unknown): string => {
  const text = String(value ?? '').trim();
  return text ? esc(text) : dash;
};

/** `2026-09-16 11:17:24` as the report prints it. */
function stamp(value: string | null | undefined): string {
  if (!value) return '';
  const text = String(value).replace('T', ' ');
  return text.slice(0, 19);
}

function dayOf(value: string | null | undefined): string {
  return value ? String(value).replace('T', ' ').slice(0, 10) : '';
}

/**
 * What this document is called.
 *
 * The template's own title wins. Otherwise the laboratory section that owns the
 * analyser names it, because a haematology analyser's report is a haematology
 * report and saying so is what makes the document recognisable.
 */
function titleOf(data: ReportData, template: ReportTemplate): string {
  if (template.reportTitle.trim()) return template.reportTitle.trim().toUpperCase();
  if (data.kind === 'control') return 'QUALITY CONTROL REPORT';
  const section = String(data.sectionName ?? '').trim();
  if (section) return `${section.toUpperCase()} REPORT`;
  return 'LABORATORY REPORT';
}

function headerBlock(data: ReportData, template: ReportTemplate): string {
  const lines = [
    template.organisation && `<div class="org">${esc(template.organisation)}</div>`,
    template.facility && `<div class="fac">${esc(template.facility)}</div>`,
    template.addressLine && `<div class="addr">${esc(template.addressLine)}</div>`,
    template.contactLine && `<div class="addr">${esc(template.contactLine)}</div>`,
    `<div class="doctitle">${esc(titleOf(data, template))}</div>`,
  ].filter(Boolean).join('\n');

  const crest = template.showLogo && template.logoDataUri
    ? `<img src="${esc(template.logoDataUri)}" alt="" />` : '';

  return `<header class="head ${esc(template.headerStyle)}">
  <div class="crest">${crest}</div>
  <div class="titles">${lines}</div>
  <div class="analyser">${esc(data.instrumentName ?? data.equipmentName ?? '')}</div>
</header>`;
}

function identityBlock(data: ReportData): string {
  const d = data.demographics;
  const cells: Array<[string, string]> = [
    ['Patient ID', d.patientId ?? ''],
    ['Age', d.age ?? ''],
    ['Reported', stamp(data.runAt ?? data.receivedAt)],
    ['Name', d.patientName ?? ''],
    ['Sex', d.sex ?? ''],
    ['Birth', d.birthDate ?? ''],
    ['Sample No.', data.sampleId ?? ''],
    ['Doctor', d.doctor ?? ''],
    ['Ward', d.ward ?? ''],
  ];
  if (data.kind === 'control') {
    cells[0] = ['Control lot', data.lotNumber ?? ''];
    cells[3] = ['Control', data.sampleId ?? ''];
  }
  return `<section class="identity">
  ${cells.map(([label, value]) => `<div><span>${esc(label)}</span><strong>${show(value)}</strong></div>`).join('\n  ')}
</section>`;
}

function referenceCell(parameter: ReportParameter, template: ReportTemplate): string {
  const population = template.showRangePopulation && parameter.referencePopulation
    ? `<span class="pop">${esc(parameter.referencePopulation)}</span>` : '';
  if (parameter.referenceLow != null || parameter.referenceHigh != null) {
    return `( ${esc(parameter.referenceLow ?? '')} – ${esc(parameter.referenceHigh ?? '')} )${population}`;
  }
  if (parameter.referenceText) return `${esc(parameter.referenceText)}${population}`;
  return dash;
}

function parameterTable(data: ReportData, template: ReportTemplate): string {
  const columns = template.columns.length ? template.columns : DEFAULT_TEMPLATE.columns;
  const head = columns.map(column => `<th class="c-${column}">${esc(REPORT_COLUMN_LABELS[column])}</th>`).join('');

  const body = data.parameters.map(parameter => {
    const meaning = flagMeaning(parameter.flag);
    const tone = meaning === 'none' ? '' : ` t-${meaning}`;
    const cell = (column: ReportColumn): string => {
      if (column === 'parameter') return `<td class="c-parameter">${esc(parameter.analyte)}${parameter.analyte !== parameter.code ? `<span class="code">${esc(parameter.code)}</span>` : ''}</td>`;
      if (column === 'result') return `<td class="c-result${tone}">${show(parameter.value)}</td>`;
      // The flag is printed as the analyser sent it, including the one that
      // means "normal" — it is part of what was received. It is just not
      // shouted: a column of bold marks on an unremarkable count is how a
      // reader stops seeing the one that matters.
      if (column === 'flag') return `<td class="c-flag${tone || ' t-none'}">${parameter.flag ? esc(parameter.flag) : ''}</td>`;
      if (column === 'unit') return `<td class="c-unit">${parameter.unit ? esc(parameter.unit) : ''}</td>`;
      if (column === 'reference') return `<td class="c-reference">${referenceCell(parameter, template)}</td>`;
      return `<td class="c-method">${esc(data.instrumentName ?? data.equipmentName ?? '')}</td>`;
    };
    return `<tr>${columns.map(cell).join('')}</tr>`;
  }).join('\n');

  if (!data.parameters.length) {
    return `<p class="empty">No parameter could be read out of this transmission.</p>`;
  }
  return `<table class="results"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function messagesBlock(data: ReportData, template: ReportTemplate): string {
  if (!template.showInstrumentMessages || !data.instrumentMessages.length) return '';
  return `<section class="messages">
  <h4>Analyser messages</h4>
  <ul>${data.instrumentMessages.map(line => `<li>${esc(line)}</li>`).join('')}</ul>
</section>`;
}

function legendBlock(data: ReportData, template: ReportTemplate): string {
  if (!template.showFlagLegend) return '';
  const used = new Map<string, string>();
  for (const parameter of data.parameters) {
    if (!parameter.flag) continue;
    const meaning = flagMeaning(parameter.flag);
    if (meaning === 'none') continue;
    used.set(parameter.flag, meaning === 'high' ? 'Above the analyser’s range'
      : meaning === 'low' ? 'Below the analyser’s range'
      : meaning === 'critical' ? 'Critical' : 'Flagged by the analyser');
  }
  if (!used.size) return '';
  return `<p class="legend">${Array.from(used.entries()).map(([flag, meaning]) => `<span><b>${esc(flag)}</b> ${esc(meaning)}</span>`).join('')}</p>`;
}

function provenanceBlock(data: ReportData, template: ReportTemplate): string {
  const parts = [
    data.linkName && `Received from ${esc(data.linkName)}`,
    data.receivedAt && `at ${esc(stamp(data.receivedAt))}`,
  ].filter(Boolean).join(' ');
  const delivery = template.showDeliveryState && data.deliveries.length
    ? `<div class="delivery">${data.deliveries.map(d => `${esc(d.destination)}: ${esc(d.state)}${d.at ? ` (${esc(stamp(d.at))})` : ''}`).join(' · ')}</div>`
    : '';
  return `<div class="provenance">${parts}${delivery}</div>`;
}

function signatureBlock(template: ReportTemplate): string {
  if (!template.showSignature) return '';
  return `<section class="sign">
  <div><span class="rule"></span><em>${esc(template.signatureLine || 'Authorised by')}</em></div>
  <div><span class="rule"></span><em>Date</em></div>
</section>`;
}

/** One report, as a complete page. Several of these stack into one document. */
export function renderReportPage(data: ReportData, template: ReportTemplate): string {
  return `<article class="sheet">
  ${template.watermark ? `<div class="watermark">${esc(template.watermark)}</div>` : ''}
  ${headerBlock(data, template)}
  ${identityBlock(data)}
  ${parameterTable(data, template)}
  ${legendBlock(data, template)}
  ${messagesBlock(data, template)}
  ${template.disclaimer ? `<p class="disclaimer">${esc(template.disclaimer)}</p>` : ''}
  ${signatureBlock(template)}
  ${provenanceBlock(data, template)}
  ${template.footerText ? `<footer class="foot">${esc(template.footerText)}</footer>` : ''}
</article>`;
}

function styles(template: ReportTemplate): string {
  const compact = template.density === 'compact';
  return `@page { size: ${template.paper}; margin: ${template.marginMm}mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0; background: #f1f3f7; color: ${template.textColour};
  font-family: ${fontStack(template.font)}; font-size: ${compact ? 10.5 : 11.5}px; line-height: 1.45; }
.toolbar { background: #eef3fb; border-bottom: 1px solid #c9d8ef; padding: 9px 14px; display: flex; gap: 12px; align-items: center; font-size: 12px; font-family: Arial, sans-serif; }
.toolbar button { font: inherit; padding: 6px 16px; border: 1px solid ${template.accentColour}; background: ${template.accentColour}; color: #fff; border-radius: 4px; cursor: pointer; }
.toolbar span { color: #44506a; }
.sheet { position: relative; background: #fff; width: ${template.paper === 'A5' ? '148mm' : template.paper === 'Letter' ? '216mm' : '210mm'};
  min-height: ${template.paper === 'A5' ? '210mm' : template.paper === 'Letter' ? '279mm' : '297mm'};
  margin: 14px auto; padding: ${template.marginMm}mm; box-shadow: 0 2px 14px rgba(16, 28, 54, 0.14); }
.sheet + .sheet { page-break-before: always; }
.watermark { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 68px; font-weight: 700; color: ${template.accentColour}; opacity: 0.07; transform: rotate(-26deg);
  letter-spacing: 0.08em; pointer-events: none; }

.head { display: grid; grid-template-columns: 74px minmax(0, 1fr) 74px; align-items: center; gap: 10px;
  border-bottom: 2px solid ${template.accentColour}; padding-bottom: 8px; }
.head .crest { grid-column: 1; }
.head .titles { grid-column: 2; text-align: center; }
.head .analyser { grid-column: 3; }
.head .crest img { max-width: 70px; max-height: 70px; object-fit: contain; }
.head.left .titles { text-align: left; }
.head.minimal { grid-template-columns: 1fr; border-bottom-width: 1px; }
.head.minimal .crest, .head.minimal .analyser { display: none; }
.head .org { font-size: ${compact ? 14 : 16}px; font-weight: 700; letter-spacing: 0.01em; color: ${template.accentColour}; }
.head .fac { font-size: ${compact ? 12 : 13.5}px; font-weight: 600; }
.head .addr { font-size: ${compact ? 10 : 11}px; }
.head .doctitle { margin-top: 3px; font-size: ${compact ? 11.5 : 13}px; font-weight: 700; letter-spacing: 0.06em; }
.head .analyser { font-size: 9.5px; text-align: right; color: #6b7280; }
${template.font === 'mixed' ? `.head .titles, table.results th { font-family: "Times New Roman", Times, Georgia, serif; }` : ''}
${template.font === 'mono-values' ? `.c-result, .c-reference, .c-unit { font-family: ui-monospace, "Courier New", monospace; }` : ''}
.head.banded { border-bottom: 0; }
.head.banded .titles { background: ${template.accentColour}; color: #fff; padding: 9px 12px; border-radius: 4px; }
.head.banded .org, .head.banded .fac, .head.banded .doctitle { color: #fff; }

.identity { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px 18px; margin: 10px 0 8px;
  border-bottom: 1px solid #111; padding-bottom: 8px; }
.identity > div { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.identity span { font-size: 10px; color: #4b5563; min-width: 68px; }
.identity strong { font-weight: 600; font-size: ${compact ? 10.5 : 11.5}px; word-break: break-word; }

table.results { width: 100%; border-collapse: collapse; margin-top: 4px; }
table.results th { text-align: left; font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
  border-bottom: 1.5px solid #111; padding: ${compact ? '3px 6px' : '5px 6px'}; }
table.results td { padding: ${compact ? '2.5px 6px' : '4px 6px'}; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
table.results tr:last-child td { border-bottom: 0; }
.c-result, .c-flag { font-variant-numeric: tabular-nums; }
th.c-result, td.c-result { text-align: right; width: 76px; }
th.c-flag, td.c-flag { width: 34px; text-align: center; font-weight: 700; }
td.c-flag.t-none { font-weight: 400; color: #9ca3af; }
th.c-unit, td.c-unit { width: 96px; color: #4b5563; }
th.c-reference, td.c-reference { width: 150px; color: #374151; }
td.c-reference .pop { display: block; font-size: 8.5px; color: #9ca3af; }
th.c-parameter, td.c-parameter { width: 32%; font-weight: 600; }
td.c-parameter { font-weight: 600; }
td.c-parameter .code { font-weight: 400; color: #9ca3af; font-size: 9.5px; margin-left: 6px; }
td.t-high, td.t-critical { color: #b91c1c; }
td.t-low { color: #1d4ed8; }
td.t-abnormal { color: #b45309; }
.none { color: #9ca3af; }
.empty { font-size: 11px; color: #6b7280; padding: 10px 0; }

.legend { margin: 8px 0 0; font-size: 9.5px; color: #4b5563; display: flex; gap: 14px; flex-wrap: wrap; }
.legend b { color: ${template.accentColour}; }
.messages { margin-top: 10px; border-top: 1px solid #d1d5db; padding-top: 7px; }
.messages h4 { margin: 0 0 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #4b5563; }
.messages ul { margin: 0; padding-left: 16px; font-size: 10.5px; }
.disclaimer { margin-top: 9px; font-size: 9.5px; color: #4b5563; }
.sign { display: flex; gap: 40px; margin-top: ${compact ? 18 : 28}px; }
.sign > div { flex: 1; }
.sign .rule { display: block; border-bottom: 1px solid #111; height: 22px; }
.sign em { font-style: normal; font-size: 9.5px; color: #4b5563; }
.provenance { margin-top: 12px; font-size: 9px; color: #6b7280; display: flex; justify-content: space-between; gap: 12px; }
.foot { margin-top: 6px; border-top: 1px solid #d1d5db; padding-top: 5px; font-size: 9px; color: #6b7280; }

@media print {
  body { background: #fff; }
  .toolbar { display: none; }
  .sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
}`;
}

export interface RenderOptions {
  autoprint?: boolean;
  /** Draw the browser toolbar above the sheet. Off for Word, on for the screen. */
  toolbar?: boolean;
  printedBy?: string | null;
}

/** One or many reports as a complete HTML document. */
export function renderReportDocument(reports: ReportData[], template: ReportTemplate, options: RenderOptions = {}): string {
  const title = reports.length === 1
    ? `${titleOf(reports[0], template)}${reports[0].sampleId ? ` — ${reports[0].sampleId}` : ''}`
    : `Laboratory reports (${reports.length})`;
  const toolbar = options.toolbar === false ? '' : `<div class="toolbar">
  <button onclick="window.print()">Print / Save as PDF</button>
  <span>${esc(reports.length)} report${reports.length === 1 ? '' : 's'}${options.printedBy ? ` · prepared by ${esc(options.printedBy)}` : ''}</span>
</div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>${styles(template)}</style>
</head><body>
${toolbar}
${reports.map(report => renderReportPage(report, template)).join('\n')}
${options.autoprint ? '<script>window.addEventListener("load", () => setTimeout(() => window.print(), 350));</script>' : ''}
</body></html>`;
}

/* ============================================================================
   The same report as a workbook
   ========================================================================= */
export const REPORT_HEADERS = [
  'Sample', 'Patient ID', 'Patient', 'Sex', 'Age', 'Ward', 'Doctor',
  'Analyser', 'Run at', 'Received at', 'Kind',
  'Parameter', 'Code', 'Result', 'Unit', 'Flag', 'Reference low', 'Reference high',
] as const;

export function reportRows(reports: ReportData[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const report of reports) {
    const d = report.demographics;
    const lead = [
      report.sampleId ?? '', d.patientId ?? '', d.patientName ?? '', d.sex ?? '', d.age ?? '',
      d.ward ?? '', d.doctor ?? '',
      report.instrumentName ?? report.equipmentName ?? report.linkName ?? '',
      stamp(report.runAt), stamp(report.receivedAt), report.kind,
    ];
    if (!report.parameters.length) { rows.push([...lead, '', '', '', '', '', '', '']); continue; }
    for (const parameter of report.parameters) {
      rows.push([...lead, parameter.analyte, parameter.code, parameter.value,
        parameter.unit ?? '', parameter.flag ?? '', parameter.referenceLow ?? '', parameter.referenceHigh ?? '']);
    }
  }
  return rows;
}

/** A filename a person can find again: the sample, then the day. */
export function reportFilename(reports: ReportData[], extension: string): string {
  if (reports.length === 1) {
    const sample = String(reports[0].sampleId ?? reports[0].id).replace(/[^\w.-]+/g, '_');
    return `Lab_report_${sample}_${dayOf(reports[0].receivedAt)}.${extension}`;
  }
  return `Lab_reports_${reports.length}_${new Date().toISOString().slice(0, 10)}.${extension}`;
}
