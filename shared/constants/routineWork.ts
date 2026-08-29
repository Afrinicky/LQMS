/**
 * Routine work — the monthly log sheet, and everything that hangs off it.
 *
 * A laboratory's routine record is not a stream of readings. It is a *sheet*:
 * a month of days across the top, the things being recorded down the side, one
 * initial per cell, and a supervisor's signature at the bottom on the last day
 * of the month. The temperature chart, the bench decontamination log and the
 * freezer maintenance schedule attached to this work are all that same object
 * with different rows — which is why they are one mechanism here rather than
 * three, and why the screens can print something an assessor recognises.
 *
 * Three kinds of sheet exist:
 *
 *   environmental          a chart of readings — numbers with limits, so a cell
 *                          can be out of range and raise an excursion
 *   decontamination        a log of acts — a tick and an initial, so a cell is
 *                          done, not done, or not applicable
 *   equipment_maintenance  both: routine tasks ticked daily, and scheduled
 *                          servicing recorded weekly or monthly
 *
 * The sheet is the unit of verification, not the cell. Readings are taken all
 * month by whoever is on duty; at the end of the month the unit supervisor
 * reads the whole sheet, signs it, comments on it, and it is archived. If the
 * sheet is wrong, that is an NC — raised against the sheet, not against a
 * single reading, because a chart with three days missing is one failure of the
 * programme rather than three failures of three people.
 */

/* ============================================================================
   What kind of sheet this is
   ========================================================================= */
export const SHEET_KINDS = ['environmental', 'decontamination', 'equipment_maintenance'] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

export const SHEET_KIND_LABELS: Record<SheetKind, string> = {
  environmental: 'Environmental monitoring chart',
  decontamination: 'Decontamination log',
  equipment_maintenance: 'Equipment maintenance chart',
};

export const SHEET_KIND_SHORT: Record<SheetKind, string> = {
  environmental: 'Environment',
  decontamination: 'Decontamination',
  equipment_maintenance: 'Maintenance',
};

/** The module each sheet kind is administered from, for permissions and links. */
export const SHEET_KIND_MODULE: Record<SheetKind, string> = {
  environmental: 'facilities_safety.environment',
  decontamination: 'facilities_safety.decontamination',
  equipment_maintenance: 'equipment',
};

/** Where the sheet is worked from inside its own module. */
export const SHEET_KIND_ROUTE: Record<SheetKind, string> = {
  environmental: '/facilities-safety?tab=Environmental+Monitoring',
  decontamination: '/facilities-safety?tab=Decontamination',
  equipment_maintenance: '/equipment?tab=Maintenance',
};

/* ============================================================================
   Rows and cells
   ----------------------------------------------------------------------------
   A row is a thing being recorded: "Room temperature (18–30 °C)", "Bench tops",
   "Clean exterior with disinfectant". A cell is that row on one day, in one
   slot. Slots exist because the paper forms have them — a bench is
   decontaminated before and after work, a fridge is read morning and evening —
   and flattening AM and PM into one reading loses the fact that the afternoon
   one was never taken.
   ========================================================================= */
export const CELL_SLOTS = ['am', 'pm', 'once', 'w1', 'w2', 'w3', 'w4', 'w5'] as const;
export type CellSlot = (typeof CELL_SLOTS)[number];

export const SLOT_LABELS: Record<CellSlot, string> = {
  am: 'AM', pm: 'PM', once: '—',
  w1: 'Week 1', w2: 'Week 2', w3: 'Week 3', w4: 'Week 4', w5: 'Week 5',
};

/** Slots that fall on a day of the month rather than a week of it. */
export const DAILY_SLOTS: CellSlot[] = ['am', 'pm', 'once'];
export const WEEKLY_SLOTS: CellSlot[] = ['w1', 'w2', 'w3', 'w4', 'w5'];
export function isWeeklySlot(slot: string): boolean { return WEEKLY_SLOTS.includes(slot as CellSlot); }

/** The slot set for a row that is done N times a day. */
export function slotsForTimesPerDay(times: number): CellSlot[] {
  if (times >= 2) return ['am', 'pm'];
  return ['once'];
}

export const ROW_TYPES = ['numeric', 'tick', 'text'] as const;
export type RowType = (typeof ROW_TYPES)[number];

export const ROW_TYPE_LABELS: Record<RowType, string> = {
  numeric: 'A measured value',
  tick: 'Done / not done',
  text: 'A short written entry',
};

/**
 * What one cell says happened.
 *
 * `blank` is not stored — an absent row is an absent record, and that is the
 * whole point of the sheet. Everything else is an assertion somebody made and
 * put their initials against.
 */
export const CELL_STATUSES = ['normal', 'warning', 'out_of_range', 'critical', 'done', 'not_done', 'na'] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

export const CELL_STATUS_LABELS: Record<CellStatus, string> = {
  normal: 'In range',
  warning: 'Approaching a limit',
  out_of_range: 'Out of range',
  critical: 'Critically out of range',
  done: 'Done',
  not_done: 'Not done',
  na: 'Not applicable',
};

/** A cell that must be explained: it raises an excursion and blocks a clean month. */
export function cellIsBreach(status?: string | null): boolean {
  return status === 'out_of_range' || status === 'critical' || status === 'not_done';
}

/** Where a cell's value came from. Matters for an assessor and for trust. */
export const CELL_SOURCES = ['manual', 'device', 'import', 'extraction', 'instrument'] as const;
export type CellSource = (typeof CELL_SOURCES)[number];

export const CELL_SOURCE_LABELS: Record<CellSource, string> = {
  manual: 'Typed in',
  device: 'Read from a data logger',
  import: 'Loaded from a file',
  extraction: 'Read off a scanned chart',
  instrument: 'Sent by the instrument',
};

/* ============================================================================
   The life of a sheet
   ========================================================================= */
export const SHEET_STATUSES = ['open', 'submitted', 'verified', 'archived'] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];

export const SHEET_STATUS_LABELS: Record<SheetStatus, string> = {
  open: 'In use this month',
  submitted: 'Submitted for verification',
  verified: 'Verified by the supervisor',
  archived: 'Archived',
};

export const SHEET_STATUS_HINTS: Record<SheetStatus, string> = {
  open: 'Readings are still being recorded on it. Anyone on duty in the unit may fill a cell.',
  submitted: 'The month is closed and the sheet is waiting for the unit supervisor to read and sign it.',
  verified: 'The supervisor has signed it. It can no longer be edited; a correction needs an NC.',
  archived: 'Filed in the central archive with its signature and comments.',
};

/** A sheet stops accepting entries once it has been signed. */
export function sheetIsLocked(status?: string | null): boolean {
  return status === 'verified' || status === 'archived';
}

/* ============================================================================
   How the environment is logged
   ----------------------------------------------------------------------------
   A laboratory reads its fridges by hand or it fits data loggers. Both are
   legitimate; showing both to a laboratory that only does one is how a screen
   becomes noise. So the mode is a setting, and the screens obey it.

   'automated' still keeps the manual entry — a logger that has flat-lined, or a
   reading taken while it was being calibrated, has to be correctable by hand or
   the record becomes something nobody can fix.
   ========================================================================= */
export const LOGGING_MODES = ['manual', 'automated'] as const;
export type LoggingMode = (typeof LOGGING_MODES)[number];

export const LOGGING_MODE_LABELS: Record<LoggingMode, string> = {
  manual: 'Read and recorded by staff',
  automated: 'Automatic data loggers',
};

export const LOGGING_MODE_HINTS: Record<LoggingMode, string> = {
  manual: 'Staff read each thermometer and enter the value. Nothing about data loggers is shown anywhere.',
  automated: 'Data loggers record on their own. Staff can still correct a reading or enter one by hand when a logger has failed.',
};

/* ============================================================================
   Recording the month from a scan or a chart photograph
   ----------------------------------------------------------------------------
   Many laboratories will keep charting on paper for a while yet. Rather than
   pretend otherwise, the month's paper chart can be attached and read back into
   the sheet, cell by cell, and whatever could not be read is left for the
   person to correct. The attachment is capped: a system that quietly
   accumulates a 12 MB photograph per fridge per month becomes unusable in a
   year, on the sort of hardware this runs on.
   ========================================================================= */
export const DEFAULT_ATTACHMENT_MB = 4;
export const MAX_ATTACHMENT_MB = 15;

export const EXTRACTION_STATUSES = ['none', 'pending', 'partial', 'complete', 'failed'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  none: 'Nothing attached',
  pending: 'Being read',
  partial: 'Partly read — some cells need correcting',
  complete: 'Read in full',
  failed: 'Could not be read',
};

/**
 * How confident the reader was about a cell it produced. Anything below this is
 * presented to the person as "check this" rather than accepted silently —
 * handwriting on a ward chart is exactly where a confident wrong number does
 * the most damage.
 */
export const EXTRACTION_REVIEW_THRESHOLD = 0.85;

/* ============================================================================
   Decontamination frameworks
   ----------------------------------------------------------------------------
   The laboratory sets the general programme; a unit head adds what their own
   room needs. Neither should start from an empty form, so the general ones ship
   as frameworks: a name, a sensible frequency and the instruction text, ready
   to use as-is or to edit on the way in.
   ========================================================================= */
export const DECON_SCOPES = ['general', 'unit'] as const;
export type DeconScope = (typeof DECON_SCOPES)[number];

export const DECON_SCOPE_LABELS: Record<DeconScope, string> = {
  general: 'Laboratory-wide',
  unit: 'Added by the unit',
};

export const DECON_SCOPE_HINTS: Record<DeconScope, string> = {
  general: 'Set once for the whole laboratory. Every unit carries it; a unit head can adjust its frequency but not remove it.',
  unit: 'Added by this unit for its own room or equipment. Only this unit carries it.',
};

export const DECON_FREQUENCIES = ['twice_daily', 'daily', 'weekly', 'fortnightly', 'monthly', 'quarterly'] as const;
export type DeconFrequency = (typeof DECON_FREQUENCIES)[number];

export const DECON_FREQUENCY_LABELS: Record<DeconFrequency, string> = {
  twice_daily: 'Twice daily (before and after work)',
  daily: 'Daily',
  weekly: 'Weekly',
  fortnightly: 'Every two weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
};

/** How the decontamination frequency maps onto the scheduling engine. */
export const DECON_TO_ACTIVITY_FREQUENCY: Record<DeconFrequency, string> = {
  twice_daily: 'daily', daily: 'daily', weekly: 'weekly',
  fortnightly: 'fortnightly', monthly: 'monthly', quarterly: 'quarterly',
};

export function deconTimesPerDay(frequency: string): number {
  return frequency === 'twice_daily' ? 2 : 1;
}

export interface DeconFramework {
  key: string;
  name: string;
  surfaceType: string;
  frequency: DeconFrequency;
  decontaminant: string;
  method: string;
  instructions: string;
}

/**
 * The general programme, as most laboratories actually run it. These are
 * frameworks, not rules: a laboratory that mops twice a day or wipes its
 * centrifuge weekly edits the frequency on the way in and the schedule follows.
 */
export const DECON_FRAMEWORKS: DeconFramework[] = [
  {
    key: 'bench_tops', name: 'Bench tops', surfaceType: 'bench', frequency: 'twice_daily',
    decontaminant: '0.5% sodium hypochlorite, followed by 70% alcohol',
    method: 'Wipe down the whole working surface, allow the stated contact time, then wipe with alcohol.',
    instructions: 'Bench tops are decontaminated before work begins and again after work ends. Record each with your initials.',
  },
  {
    key: 'floors', name: 'Floors', surfaceType: 'floor', frequency: 'daily',
    decontaminant: '0.5% sodium hypochlorite',
    method: 'Damp mop the whole floor working from the cleanest area towards the door.',
    instructions: 'Mop after the day\'s work. Spillages are decontaminated immediately and separately, not held for this.',
  },
  {
    key: 'sinks', name: 'Sinks and hand-wash basins', surfaceType: 'sink', frequency: 'daily',
    decontaminant: '0.5% sodium hypochlorite',
    method: 'Scrub the bowl, taps and splash-back; flush the trap through with disinfectant.',
    instructions: 'Done at the end of the day, after the last hand-wash.',
  },
  {
    key: 'biosafety_cabinet', name: 'Biosafety cabinet / work station', surfaceType: 'equipment_surface', frequency: 'twice_daily',
    decontaminant: '70% alcohol',
    method: 'Wipe the work surface, side walls and inside of the sash before and after each session.',
    instructions: 'Never use hypochlorite alone on stainless steel without an alcohol rinse — it pits the surface.',
  },
  {
    key: 'centrifuge_area', name: 'Centrifuge and its surround', surfaceType: 'equipment_surface', frequency: 'daily',
    decontaminant: '70% alcohol',
    method: 'Wipe the rotor chamber, buckets and the bench immediately around the instrument.',
    instructions: 'Any breakage inside the rotor is decontaminated at once and recorded as an incident, not held for the daily entry.',
  },
  {
    key: 'waste_bins', name: 'Waste bins and sharps stands', surfaceType: 'waste', frequency: 'daily',
    decontaminant: '0.5% sodium hypochlorite',
    method: 'Wipe the outside of every bin and stand; replace liners.',
    instructions: 'Record after the day\'s waste has gone out.',
  },
  {
    key: 'door_handles', name: 'Door handles, light switches and telephone', surfaceType: 'touch_point', frequency: 'daily',
    decontaminant: '70% alcohol',
    method: 'Wipe every hand-contact point in the unit.',
    instructions: 'The points people touch on the way out matter most — do this last.',
  },
  {
    key: 'fridge_exterior', name: 'Refrigerator and freezer exteriors', surfaceType: 'equipment_surface', frequency: 'weekly',
    decontaminant: '0.5% sodium hypochlorite',
    method: 'Wipe doors, handles and the outer casing.',
    instructions: 'The interior is decontaminated as part of the equipment maintenance schedule, not here.',
  },
  {
    key: 'windows', name: 'Windows, sills and blinds', surfaceType: 'building', frequency: 'weekly',
    decontaminant: 'Detergent solution',
    method: 'Wash the sills and the inner face of the glass; dust blinds.',
    instructions: 'Weekly. Note any broken or ill-fitting window as a facility fault.',
  },
  {
    key: 'ceiling_fans', name: 'Ceiling fans and air-conditioner grilles', surfaceType: 'building', frequency: 'monthly',
    decontaminant: 'Detergent solution',
    method: 'Switch off at the isolator, wipe blades and grilles, clean or replace filters.',
    instructions: 'Monthly, and always before the sheet is signed off. Dust from a fan lands on the bench.',
  },
  {
    key: 'cobwebs', name: 'Cobwebs, ceilings and high surfaces', surfaceType: 'building', frequency: 'monthly',
    decontaminant: 'Dry removal, then detergent',
    method: 'Remove cobwebs from the corners and the ceiling, wipe high ledges and the tops of cupboards.',
    instructions: 'Monthly. Record any water staining or damage to the ceiling as a facility fault.',
  },
  {
    key: 'walls', name: 'Walls and painted surfaces', surfaceType: 'building', frequency: 'monthly',
    decontaminant: 'Detergent solution',
    method: 'Wash down splash zones behind benches and sinks; spot-clean the rest.',
    instructions: 'Monthly, or immediately after any splash.',
  },
  {
    key: 'cold_room', name: 'Cold room / store room', surfaceType: 'room', frequency: 'monthly',
    decontaminant: '0.5% sodium hypochlorite',
    method: 'Empty the shelving in sections, wipe shelves and floor, return stock in date order.',
    instructions: 'Monthly. Anything expired found during this is removed and recorded against stock, not put back.',
  },
];

/* ============================================================================
   How a control's results get into the system
   ----------------------------------------------------------------------------
   A malaria RDT control is one line: reactive, initials, done. An FBC control
   is twenty-three parameters, three levels, every day — and typing 69 numbers
   off a printout is how control records stop being kept.

   So a control declares which ways its results may be entered, and the bench
   picks whichever suits the moment. All of them land in the same run: the entry
   method is how the numbers arrived, never what they mean.
   ========================================================================= */
export const IQC_ENTRY_METHODS = ['manual', 'paste', 'worksheet', 'upload', 'scan', 'instrument'] as const;
export type IqcEntryMethod = (typeof IQC_ENTRY_METHODS)[number];

export const IQC_ENTRY_METHOD_LABELS: Record<IqcEntryMethod, string> = {
  manual: 'Type each value',
  paste: 'Paste a table',
  worksheet: 'Fill a spreadsheet',
  upload: 'Upload the analyser\'s file',
  scan: 'Scan the printout',
  instrument: 'Take it from the instrument',
};

export const IQC_ENTRY_METHOD_HINTS: Record<IqcEntryMethod, string> = {
  manual: 'One box per parameter, in the order the control defines. Right for a handful of parameters.',
  paste: 'Copy the block of results out of Excel or Word and paste it straight onto the control\'s table. The columns are matched by name, so the two tables do not have to be in the same order.',
  worksheet: 'Open the control\'s table as a spreadsheet in the browser, paste into it, adjust rows until each parameter lines up, then save. The same grid the system stores, edited the way a bench actually works.',
  upload: 'Upload the file the analyser exported — CSV, Excel or a Word table. The analyser\'s own export layout is remembered per instrument so the columns land in the right place.',
  scan: 'Photograph or scan the analyser\'s printout. The system reads what it can and puts anything it is unsure of in front of you to confirm before the run is saved.',
  instrument: 'The analyser sends its control results over the network. Runs arrive on their own and wait on the bench for someone to accept them.',
};

/** Only a multi-parameter control needs the heavy machinery. */
export const BULK_ENTRY_METHODS: IqcEntryMethod[] = ['paste', 'worksheet', 'upload', 'scan', 'instrument'];

export const DEFAULT_ENTRY_METHODS: IqcEntryMethod[] = ['manual'];

export function parseEntryMethods(value: unknown): IqcEntryMethod[] {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  const list = Array.isArray(raw) ? raw : [];
  const kept = list.filter((m): m is IqcEntryMethod => IQC_ENTRY_METHODS.includes(m as IqcEntryMethod));
  // Typing values in is always available: a control whose file upload is broken
  // at 2am must still be recordable.
  return kept.includes('manual') ? kept : ['manual', ...kept];
}

function safeParse(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

/* ============================================================================
   Instrument feeds
   ----------------------------------------------------------------------------
   The analysers here already speak TCP/IP — that is how patient results reach
   the LIS. A control run is the same message with a control identifier in it,
   so the feed does not need a second connection: it needs to recognise the
   control sample and route it here instead of to a patient record.
   ========================================================================= */
export const FEED_TRANSPORTS = ['tcp_server', 'tcp_client', 'serial', 'file_drop', 'http_post'] as const;
export type FeedTransport = (typeof FEED_TRANSPORTS)[number];

export const FEED_TRANSPORT_LABELS: Record<FeedTransport, string> = {
  tcp_server: 'The system listens; the analyser connects',
  tcp_client: 'The system connects to the analyser',
  serial: 'Serial cable (RS-232)',
  file_drop: 'The analyser writes a file to a watched folder',
  http_post: 'The analyser or middleware posts to the system',
};

export const FEED_PROTOCOLS = ['astm', 'hl7', 'delimited', 'custom'] as const;
export type FeedProtocol = (typeof FEED_PROTOCOLS)[number];

export const FEED_PROTOCOL_LABELS: Record<FeedProtocol, string> = {
  astm: 'ASTM E1394 (most haematology and chemistry analysers)',
  hl7: 'HL7 v2 ORU',
  delimited: 'Plain delimited text',
  custom: 'Something else — mapped by hand',
};

export const FEED_MESSAGE_STATUSES = ['received', 'matched', 'unmatched', 'accepted', 'rejected'] as const;
export type FeedMessageStatus = (typeof FEED_MESSAGE_STATUSES)[number];

export const FEED_MESSAGE_STATUS_LABELS: Record<FeedMessageStatus, string> = {
  received: 'Received, not yet read',
  matched: 'Matched to a control — waiting to be accepted',
  unmatched: 'Could not be matched to any control',
  accepted: 'Accepted as a control run',
  rejected: 'Rejected by the bench',
};

/* ============================================================================
   Small shared helpers
   ========================================================================= */
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Days in the month a 'YYYY-MM' names. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return 31;
  return new Date(y, m, 0).getDate();
}

/** 'August 2026' from '2026-08'. */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** The month a date falls in, as 'YYYY-MM'. */
export function monthOf(date: string): string { return date.slice(0, 7); }

/** Which week-of-month column a day belongs to: 1–7 → w1, 8–14 → w2, … */
export function weekSlotForDay(day: number): CellSlot {
  const index = Math.min(4, Math.floor((day - 1) / 7));
  return (['w1', 'w2', 'w3', 'w4', 'w5'] as CellSlot[])[index];
}

/* ============================================================================
   Equipment maintenance frameworks
   ----------------------------------------------------------------------------
   Maintenance comes in two kinds and they are not variations of one thing.

   ROUTINE is what the laboratory does to its own instrument — the daily clean,
   the weekly check, the monthly descale. It is frequent, internal, and it is
   what actually keeps the instrument working.

   SCHEDULED is the service visit: quarterly, half-yearly or annual, usually by
   the manufacturer's engineer, usually against a contract. It is infrequent,
   external, and it is what an assessor asks to see the certificate for.

   Both belong on the same chart, on different axes — daily tasks across the
   days, everything else across the weeks — which is exactly how the paper
   freezer schedule is laid out. What follows are starting points a laboratory
   uses as-is or edits; nothing here overrides a manufacturer's manual, and the
   screens say so.
   ========================================================================= */
export const MAINTENANCE_KINDS = ['routine', 'scheduled'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export const MAINTENANCE_KIND_LABELS: Record<MaintenanceKind, string> = {
  routine: 'Routine — done in-house',
  scheduled: 'Scheduled servicing — usually an external engineer',
};

export const MAINTENANCE_KIND_HINTS: Record<MaintenanceKind, string> = {
  routine: 'Daily, weekly or monthly care carried out by the staff who use the instrument. It goes on the unit\'s routine work.',
  scheduled: 'Quarterly, half-yearly or annual servicing, normally under contract. It is planned ahead, and the engineer\'s report is the record.',
};

export const MAINTENANCE_FREQUENCIES = ['twice_daily', 'daily', 'weekly', 'monthly', 'quarterly', 'biannual', 'annual'] as const;
export type MaintenanceFrequency = (typeof MAINTENANCE_FREQUENCIES)[number];

export const MAINTENANCE_FREQUENCY_LABELS: Record<MaintenanceFrequency, string> = {
  twice_daily: 'Twice daily', daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly',
  quarterly: 'Quarterly', biannual: 'Twice a year', annual: 'Yearly',
};

export interface MaintenanceTaskFramework {
  task: string;
  frequency: MaintenanceFrequency;
  kind: MaintenanceKind;
  guidance?: string;
  consumable?: string;
  tier?: 'general' | 'technical' | 'supervisory';
}

export interface MaintenanceFramework {
  key: string;
  label: string;
  /** The equipment archetypes and name patterns this framework suits. */
  matches: string[];
  tasks: MaintenanceTaskFramework[];
}

export const MAINTENANCE_FRAMEWORKS: MaintenanceFramework[] = [
  {
    key: 'microscope', label: 'Microscope', matches: ['microscope'],
    tasks: [
      { task: 'Clean the eyepieces and objective lenses', frequency: 'daily', kind: 'routine', consumable: 'Lens tissue and lens cleaner', guidance: 'Lens tissue only, in a spiral from the centre outwards. Never solvent on a plastic-mounted lens, and never the same tissue twice.' },
      { task: 'Remove immersion oil from the 100× objective', frequency: 'daily', kind: 'routine', consumable: 'Lens tissue', guidance: 'At the end of every session. Oil left overnight hardens and dissolves the lens cement.' },
      { task: 'Clean the stage and stage clips', frequency: 'daily', kind: 'routine', guidance: 'Wipe off oil, stain and mountant with 70% alcohol; dry.' },
      { task: 'Cover the microscope', frequency: 'daily', kind: 'routine', guidance: 'Dust cover on once the lamp has cooled. Dust on an objective is the commonest cause of poor resolution.' },
      { task: 'Wipe the body, focus knobs and condenser', frequency: 'weekly', kind: 'routine' },
      { task: 'Check and clean the condenser and field diaphragm; reset Köhler illumination', frequency: 'weekly', kind: 'routine', tier: 'technical' },
      { task: 'Check the lamp and spare bulb, and the mains lead for damage', frequency: 'weekly', kind: 'routine' },
      { task: 'Check the mechanical stage movement and focus for drift or stiffness', frequency: 'monthly', kind: 'routine', tier: 'technical' },
      { task: 'Check the objectives for fungal growth, especially in the rainy season', frequency: 'monthly', kind: 'routine', tier: 'technical', guidance: 'Look through each objective at a blank field. Fungal filaments across the lens are a write-off if left.' },
      { task: 'Full service, alignment and optical clean by the service engineer', frequency: 'annual', kind: 'scheduled', tier: 'supervisory' },
    ],
  },
  {
    key: 'refrigerator_freezer', label: 'Refrigerator / freezer', matches: ['refrigerator', 'fridge', 'freezer', 'cold room'],
    tasks: [
      { task: 'Clean the exterior with disinfectant', frequency: 'daily', kind: 'routine' },
      { task: 'Discard samples older than the retention period', frequency: 'weekly', kind: 'routine', guidance: 'Against the laboratory\'s stated retention, not by eye.' },
      { task: 'Clean the interior — shelves, drawers and door seal — with disinfectant', frequency: 'weekly', kind: 'routine', guidance: 'Move stock to a second unit or a cool box first; never leave it on the bench.' },
      { task: 'Rearrange contents and check nothing blocks the air circulation', frequency: 'weekly', kind: 'routine' },
      { task: 'Defrost and check the door seal and hinges', frequency: 'monthly', kind: 'routine' },
      { task: 'Clean the condenser coils and check the compressor', frequency: 'quarterly', kind: 'scheduled', tier: 'technical' },
      { task: 'Verify the thermometer against a calibrated reference', frequency: 'annual', kind: 'scheduled', tier: 'supervisory' },
    ],
  },
  {
    key: 'centrifuge', label: 'Centrifuge', matches: ['centrifuge'],
    tasks: [
      { task: 'Wipe the rotor chamber, buckets and lid', frequency: 'daily', kind: 'routine', guidance: 'Any breakage inside the chamber is decontaminated at once and recorded as an incident, not held for this entry.' },
      { task: 'Check the buckets and trunnions for cracks and corrosion', frequency: 'weekly', kind: 'routine', tier: 'technical' },
      { task: 'Check the lid interlock and the brake', frequency: 'weekly', kind: 'routine', tier: 'technical' },
      { task: 'Lubricate the trunnion pins', frequency: 'monthly', kind: 'routine', tier: 'technical' },
      { task: 'Verify the speed with a tachometer and the timer against a stopwatch', frequency: 'biannual', kind: 'scheduled', tier: 'technical' },
      { task: 'Service and rotor inspection by the service engineer', frequency: 'annual', kind: 'scheduled', tier: 'supervisory' },
    ],
  },
  {
    key: 'analyser', label: 'Analyser (haematology / chemistry)', matches: ['analyser', 'analyzer'],
    tasks: [
      { task: 'Start-up checks and background count', frequency: 'daily', kind: 'routine', tier: 'technical' },
      { task: 'Clean the probe and wash the sample path', frequency: 'daily', kind: 'routine', tier: 'technical' },
      { task: 'Check reagent and waste levels', frequency: 'daily', kind: 'routine' },
      { task: 'Shutdown wash with the manufacturer\'s cleaning solution', frequency: 'daily', kind: 'routine', tier: 'technical' },
      { task: 'Wipe the exterior and the sample area', frequency: 'daily', kind: 'routine' },
      { task: 'Deep clean of the flow cell / cuvette and aspiration line', frequency: 'weekly', kind: 'routine', tier: 'technical' },
      { task: 'Clean or replace filters and check tubing for wear', frequency: 'monthly', kind: 'routine', tier: 'technical' },
      { task: 'Preventive service, calibration check and software check by the engineer', frequency: 'biannual', kind: 'scheduled', tier: 'supervisory' },
    ],
  },
  {
    key: 'autoclave', label: 'Autoclave', matches: ['autoclave', 'steriliser', 'sterilizer'],
    tasks: [
      { task: 'Check water level and drain the chamber', frequency: 'daily', kind: 'routine' },
      { task: 'Clean the chamber, door gasket and drain strainer', frequency: 'weekly', kind: 'routine' },
      { task: 'Run and record a biological indicator', frequency: 'weekly', kind: 'routine', tier: 'technical' },
      { task: 'Check the safety valve and pressure gauge', frequency: 'monthly', kind: 'routine', tier: 'technical' },
      { task: 'Pressure vessel inspection and certification', frequency: 'annual', kind: 'scheduled', tier: 'supervisory', guidance: 'A statutory inspection in most jurisdictions. Keep the certificate with the equipment record.' },
    ],
  },
  {
    key: 'biosafety_cabinet', label: 'Biosafety cabinet', matches: ['biosafety', 'cabinet', 'laminar', 'hood'],
    tasks: [
      { task: 'Disinfect the work surface, walls and inside of the sash', frequency: 'twice_daily', kind: 'routine' },
      { task: 'Check the airflow indicator / magnehelic reading against its normal range', frequency: 'daily', kind: 'routine', tier: 'technical' },
      { task: 'Clean under the work tray', frequency: 'weekly', kind: 'routine' },
      { task: 'Check and clean the UV lamp, and record its hours', frequency: 'monthly', kind: 'routine', tier: 'technical' },
      { task: 'Airflow certification and HEPA integrity test by a certifying engineer', frequency: 'annual', kind: 'scheduled', tier: 'supervisory' },
    ],
  },
  {
    key: 'incubator_waterbath', label: 'Incubator / water bath', matches: ['incubator', 'water bath', 'waterbath', 'oven'],
    tasks: [
      { task: 'Check and record the temperature', frequency: 'daily', kind: 'routine' },
      { task: 'Check the water level and top up with distilled water', frequency: 'daily', kind: 'routine' },
      { task: 'Empty, clean and refill; check for scale and algae', frequency: 'weekly', kind: 'routine' },
      { task: 'Clean the interior, shelves and door seal', frequency: 'monthly', kind: 'routine' },
      { task: 'Verify the temperature against a calibrated reference thermometer', frequency: 'annual', kind: 'scheduled', tier: 'technical' },
    ],
  },
  {
    key: 'generic', label: 'General instrument', matches: [],
    tasks: [
      { task: 'Wipe the exterior and check for damage', frequency: 'daily', kind: 'routine' },
      { task: 'Check that it is working within its stated conditions', frequency: 'weekly', kind: 'routine' },
      { task: 'Clean thoroughly and check cables, seals and moving parts', frequency: 'monthly', kind: 'routine' },
      { task: 'Preventive service by the service provider', frequency: 'annual', kind: 'scheduled', tier: 'supervisory' },
    ],
  },
];

/** The framework that best suits a piece of equipment, by archetype and name. */
export function frameworkForEquipment(name?: string | null, archetype?: string | null): MaintenanceFramework {
  const hay = String(name ?? '').toLowerCase();
  for (const framework of MAINTENANCE_FRAMEWORKS) {
    if (framework.matches.some(m => hay.includes(m))) return framework;
  }
  if (archetype === 'analyser' || archetype === 'poct') {
    return MAINTENANCE_FRAMEWORKS.find(f => f.key === 'analyser')!;
  }
  return MAINTENANCE_FRAMEWORKS.find(f => f.key === 'generic')!;
}

/** How a maintenance frequency maps onto the scheduling engine. */
export const MAINTENANCE_TO_ACTIVITY_FREQUENCY: Record<MaintenanceFrequency, string> = {
  twice_daily: 'daily', daily: 'daily', weekly: 'weekly', monthly: 'monthly',
  quarterly: 'quarterly', biannual: 'biannual', annual: 'annual',
};

/* ============================================================================
   Registering something new to chart
   ----------------------------------------------------------------------------
   The presets exist because the acceptable range is the part that gets left
   blank, and a chart with no range records numbers rather than control. Each
   one is the range the laboratory would set anyway; every value is editable
   before it is saved, because a range is a decision the laboratory owns and no
   default should quietly become one.
   ========================================================================= */

export interface ChartParameterPreset {
  label: string;
  unit: string;
  minValue: number | null;
  maxValue: number | null;
  decimalPlaces: number;
}

export interface EnvironmentalChartPreset {
  key: string;
  label: string;
  /** How often it is normally read. */
  frequency: string;
  parameters: ChartParameterPreset[];
}

export const ENVIRONMENTAL_CHART_PRESETS: EnvironmentalChartPreset[] = [
  {
    key: 'refrigerator', label: 'Refrigerator', frequency: 'twice_daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: 2, maxValue: 8, decimalPlaces: 1 }],
  },
  {
    key: 'blood_bank_fridge', label: 'Blood bank refrigerator', frequency: 'twice_daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: 2, maxValue: 6, decimalPlaces: 1 }],
  },
  {
    key: 'freezer', label: 'Freezer', frequency: 'twice_daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: -25, maxValue: -15, decimalPlaces: 1 }],
  },
  {
    key: 'ultra_low_freezer', label: 'Ultra-low freezer (−80)', frequency: 'daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: -86, maxValue: -65, decimalPlaces: 1 }],
  },
  {
    key: 'cold_room', label: 'Cold room', frequency: 'twice_daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: 2, maxValue: 8, decimalPlaces: 1 }],
  },
  {
    key: 'incubator', label: 'Incubator', frequency: 'daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: 35, maxValue: 37, decimalPlaces: 1 }],
  },
  {
    key: 'co2_incubator', label: 'CO₂ incubator', frequency: 'daily',
    parameters: [
      { label: 'Temperature', unit: '°C', minValue: 36, maxValue: 38, decimalPlaces: 1 },
      { label: 'CO₂', unit: '%', minValue: 4.5, maxValue: 5.5, decimalPlaces: 1 },
    ],
  },
  {
    key: 'water_bath', label: 'Water bath', frequency: 'daily',
    parameters: [{ label: 'Temperature', unit: '°C', minValue: 36.5, maxValue: 37.5, decimalPlaces: 1 }],
  },
  {
    key: 'room', label: 'Room', frequency: 'daily',
    parameters: [
      { label: 'Temperature', unit: '°C', minValue: 18, maxValue: 25, decimalPlaces: 1 },
      { label: 'Humidity', unit: '%', minValue: 30, maxValue: 70, decimalPlaces: 0 },
    ],
  },
  {
    key: 'other', label: 'Something else', frequency: 'daily',
    parameters: [{ label: '', unit: '', minValue: null, maxValue: null, decimalPlaces: 1 }],
  },
];

/** How often a chart is read. Kept plain, because it is read by the bench. */
export const CHART_FREQUENCIES: { key: string; label: string }[] = [
  { key: 'twice_daily', label: 'Twice a day — morning and afternoon' },
  { key: 'daily', label: 'Once a day' },
  { key: 'weekly', label: 'Once a week' },
  { key: 'continuous', label: 'Continuously, by a data logger' },
];
