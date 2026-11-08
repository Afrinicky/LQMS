/**
 * The internal quality control programme, computed.
 *
 * One question, asked of a unit and a period: WAS THE PLAN FOLLOWED? Answering
 * it needs three things the run register alone cannot give —
 *
 *   what was expected   from each control's schedule, or from the frequency it
 *                       was registered with where nobody has written one;
 *   what was performed  from the runs, matched to the day and shift they were
 *                       run on rather than the day they were entered;
 *   what was accounted for  from the missed-run record, so a day the analyser
 *                       was under repair is not counted against a bench that
 *                       said so at the time.
 *
 * Nothing here records, accepts or judges a run: the evaluation of a control
 * run belongs to `iqcEvaluation.ts` and the decision to accept it belongs to a
 * person. This reads what is on the record and says where the gaps are.
 */
import {
  compliancePercent, defaultSchedule, occurrencesBetween, scheduleSummary,
  type IqcShift, type Occurrence, type OccurrenceState, type ProgrammeFrequency, type ProgrammeSchedule,
  type Weekday,
} from '../../shared/constants/iqcProgramme.js';
import { lotExpired } from '../../shared/constants/iqc.js';

type DB = any;

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

/* ============================================================================
   One control's plan
   ========================================================================= */

/**
 * The schedule a control is judged against.
 *
 * A saved row wins. Where there is none, the control's own registered
 * frequency decides, and the programme says so — "from the control's
 * frequency" is a different statement from "the supervisor set this", and a
 * screen that confuses them invites nobody to check it.
 *
 * The programme never expects runs from before the control existed, so a lot
 * registered this month does not arrive with a year of missed days behind it.
 */
export function scheduleFor(material: any, row: any | null): ProgrammeSchedule {
  const registeredOn = String(material?.created_at ?? '').slice(0, 10) || null;
  if (!row) return defaultSchedule(material?.qc_frequency, registeredOn);
  return {
    frequency: String(row.frequency ?? 'daily') as ProgrammeFrequency,
    weekdays: json<Weekday[]>(row.weekdays, []),
    shifts: json<IqcShift[]>(row.shifts, []),
    startsOn: row.starts_on ?? registeredOn,
    endsOn: row.ends_on ?? null,
    isActive: Number(row.is_active ?? 1) === 1,
    isDefault: false,
    notes: row.notes ?? null,
  };
}

/* ============================================================================
   What became of each expected run
   ========================================================================= */

export interface ProgrammeDay extends Occurrence {
  state: OccurrenceState;
  /** The run that answered for it, where one did. */
  runId: number | null;
  runNumber: string | null;
  runStatus: string | null;
  /** Why it was not run, where somebody has said. */
  reason: string | null;
  missedId: number | null;
}

export interface ProgrammeControl {
  id: number;
  materialName: string;
  testName: string;
  levelLabel: string | null;
  lotNumber: string;
  controlType: string;
  equipmentId: number | null;
  equipmentName: string | null;
  sectionId: number | null;
  expired: boolean;
  recordingBasis: string;
  analyteCount: number;
  schedule: ProgrammeSchedule & { summary: string };
  days: ProgrammeDay[];
  expected: number;
  performed: number;
  missed: number;
  excused: number;
  rejected: number;
  due: number;
  compliance: number | null;
  lastRunDate: string | null;
  /** The oldest day still unaccounted for — what the bench acts on first. */
  oldestMissed: string | null;
}

export interface ProgrammeCoverageTest {
  id: number;
  testCode: string | null;
  testName: string;
  equipmentName: string | null;
  controls: Array<{ id: number; materialName: string; levelLabel: string | null; lotNumber: string }>;
  covered: boolean;
  exemption: {
    id: number; ground: string; reason: string; reviewOn: string | null;
    approvedBy: string | null; recordedAt: string; overdue: boolean;
  } | null;
}

export interface ProgrammeAnswer {
  from: string;
  to: string;
  sectionId: number | null;
  sectionName: string | null;
  controls: ProgrammeControl[];
  coverage: ProgrammeCoverageTest[];
  counts: {
    controls: number;
    scheduled: number;
    expected: number;
    performed: number;
    missed: number;
    excused: number;
    rejected: number;
    due: number;
    compliance: number | null;
    examinations: number;
    covered: number;
    exempt: number;
    uncovered: number;
    exemptionsDue: number;
    awaitingReview: number;
    resultsWithheld: number;
  };
}

/** A test name and a control's test name are the same string, loosely compared. */
export function testKey(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The programme for one unit over one period.
 *
 * The period is the caller's: a month for the calendar, a fortnight for the
 * board's prompt, a year for a management review. Everything is derived, so
 * the answer is the same whoever asks and whenever.
 */
export function programmeFor(db: DB, options: {
  sectionId: number | null;
  from: string;
  to: string;
  /** Only this control, for a single control's own schedule page. */
  materialId?: number | null;
}): ProgrammeAnswer {
  const { sectionId, from, to } = options;
  const now = today();

  const where: string[] = ['m.is_active = 1'];
  const args: any[] = [];
  if (sectionId != null) {
    where.push('COALESCE(m.performing_section_id, m.section_id, e.section_id) = ?');
    args.push(sectionId);
  }
  if (options.materialId) { where.push('m.id = ?'); args.push(options.materialId); }

  const materials = db.prepare(`SELECT m.*, e.name AS equipment_name,
        COALESCE(m.performing_section_id, m.section_id, e.section_id) AS resolved_section_id
      FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id
      WHERE ${where.join(' AND ')}
      ORDER BY e.name, m.test_name, m.material_name, m.level_label`).all(...args) as any[];

  const ids = materials.map(m => Number(m.id));
  const placeholders = ids.length ? ids.map(() => '?').join(', ') : '0';

  const schedules = new Map<number, any>();
  for (const row of db.prepare(`SELECT * FROM iqc_schedules WHERE iqc_material_id IN (${placeholders})`)
    .all(...ids) as any[]) schedules.set(Number(row.iqc_material_id), row);

  /*
   * The runs that answered for the period.
   *
   * By the day they were RUN, never the day they were entered: a run caught up
   * on a week later belongs to the morning it was performed, which is the
   * whole point of allowing it to be entered at all. A re-read of a previously
   * run sample answers for the control too — it is what the laboratory did
   * that day in place of the control material, and refusing to count it would
   * report a miss for a bench that did the right thing.
   */
  const runs = db.prepare(`SELECT id, iqc_material_id, run_date, run_time, shift, status, run_number, reviewed_at,
        patient_results_released
      FROM iqc_runs
      WHERE iqc_material_id IN (${placeholders}) AND run_date >= ? AND run_date <= ?
      ORDER BY run_date, COALESCE(run_time, ''), id`).all(...ids, from, to) as any[];

  const missedRows = db.prepare(`SELECT * FROM iqc_missed_runs
      WHERE iqc_material_id IN (${placeholders}) AND due_date >= ? AND due_date <= ?`)
    .all(...ids, from, to) as any[];

  const lastRuns = new Map<number, string>();
  for (const row of db.prepare(`SELECT iqc_material_id, MAX(run_date) AS last_date FROM iqc_runs
      WHERE iqc_material_id IN (${placeholders}) GROUP BY iqc_material_id`).all(...ids) as any[]) {
    lastRuns.set(Number(row.iqc_material_id), String(row.last_date));
  }

  const analyteCounts = new Map<number, number>();
  for (const row of db.prepare(`SELECT iqc_material_id, COUNT(*) AS n FROM iqc_analytes
      WHERE is_active = 1 AND iqc_material_id IN (${placeholders}) GROUP BY iqc_material_id`).all(...ids) as any[]) {
    analyteCounts.set(Number(row.iqc_material_id), Number(row.n));
  }

  const controls: ProgrammeControl[] = materials.map(material => {
    const id = Number(material.id);
    const schedule = scheduleFor(material, schedules.get(id) ?? null);
    const expected = occurrencesBetween(schedule, from, to);

    const ownRuns = runs.filter(r => Number(r.iqc_material_id) === id);
    const ownMissed = missedRows.filter(r => Number(r.iqc_material_id) === id);

    /*
     * Which run answered which expected one.
     *
     * By day, and by shift where the plan names shifts. A run recorded without
     * a shift still answers for the day: the bench ran the control, and
     * refusing it for a blank dropdown would be bookkeeping standing in front
     * of the work. It answers for the EARLIEST shift still open, so three runs
     * on a three-shift day close three expectations and not one.
     */
    const taken = new Set<number>();
    const days: ProgrammeDay[] = expected.map(occurrence => {
      const index = ownRuns.findIndex((r, i) =>
        !taken.has(i) && String(r.run_date) === occurrence.date
        && (!occurrence.shift || !r.shift || String(r.shift) === occurrence.shift));
      const run = index >= 0 ? ownRuns[index] : null;
      if (index >= 0) taken.add(index);

      if (run) {
        const state: OccurrenceState = run.status === 'out_of_control' ? 'rejected'
          : run.status === 'warning' ? 'warning' : 'in_control';
        return {
          ...occurrence, state, runId: Number(run.id), runNumber: run.run_number ?? null,
          runStatus: String(run.status), reason: null, missedId: null,
        };
      }

      const excuse = ownMissed.find(r => String(r.due_date) === occurrence.date
        && String(r.shift ?? '') === String(occurrence.shift ?? ''));
      if (excuse) {
        return {
          ...occurrence, state: 'excused', runId: null, runNumber: null, runStatus: null,
          reason: String(excuse.reason), missedId: Number(excuse.id),
        };
      }
      // Today is not yet a failure, and neither is a day that has not come.
      const state: OccurrenceState = occurrence.date >= now ? 'due' : 'missed';
      return { ...occurrence, state, runId: null, runNumber: null, runStatus: null, reason: null, missedId: null };
    });

    const performed = days.filter(d => d.state === 'in_control' || d.state === 'warning' || d.state === 'rejected').length;
    const missed = days.filter(d => d.state === 'missed').length;
    const excused = days.filter(d => d.state === 'excused').length;
    const rejected = days.filter(d => d.state === 'rejected').length;
    const due = days.filter(d => d.state === 'due').length;

    return {
      id,
      materialName: material.material_name,
      testName: material.test_name,
      levelLabel: material.level_label ?? null,
      lotNumber: material.lot_number,
      controlType: material.control_type,
      equipmentId: material.equipment_id ?? null,
      equipmentName: material.equipment_name ?? null,
      sectionId: material.resolved_section_id ?? null,
      expired: Boolean(lotExpired(material.expiry_date, now, material.recording_basis)),
      recordingBasis: material.recording_basis ?? 'prospective',
      analyteCount: analyteCounts.get(id) ?? 0,
      schedule: { ...schedule, summary: scheduleSummary(schedule) },
      days,
      expected: days.length,
      performed, missed, excused, rejected, due,
      compliance: compliancePercent(performed, missed),
      lastRunDate: lastRuns.get(id) ?? null,
      oldestMissed: days.find(d => d.state === 'missed')?.date ?? null,
    };
  });

  /* ---------------------------------------------------------- coverage */
  const coverage = coverageFor(db, sectionId, controls);

  const performed = controls.reduce((n, c) => n + c.performed, 0);
  const missed = controls.reduce((n, c) => n + c.missed, 0);

  // Runs of this unit's controls that nobody has signed off, and runs whose
  // failure still withholds patient results. The programme is where somebody
  // goes to see the state of quality control, so it says both.
  const outstanding = ids.length
    ? db.prepare(`SELECT
          SUM(CASE WHEN reviewed_at IS NULL AND status != 'in_control' THEN 1 ELSE 0 END) AS awaiting,
          SUM(CASE WHEN patient_results_released = 0 THEN 1 ELSE 0 END) AS withheld
        FROM iqc_runs WHERE iqc_material_id IN (${placeholders})`).get(...ids) as any
    : { awaiting: 0, withheld: 0 };

  return {
    from, to, sectionId,
    sectionName: sectionId == null ? null
      : (db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId) as any)?.name ?? null,
    controls,
    coverage,
    counts: {
      controls: controls.length,
      scheduled: controls.filter(c => c.schedule.isActive && c.schedule.frequency !== 'event').length,
      expected: controls.reduce((n, c) => n + c.expected, 0),
      performed,
      missed,
      excused: controls.reduce((n, c) => n + c.excused, 0),
      rejected: controls.reduce((n, c) => n + c.rejected, 0),
      due: controls.reduce((n, c) => n + c.due, 0),
      compliance: compliancePercent(performed, missed),
      examinations: coverage.length,
      covered: coverage.filter(t => t.covered).length,
      exempt: coverage.filter(t => !t.covered && t.exemption).length,
      uncovered: coverage.filter(t => !t.covered && !t.exemption).length,
      exemptionsDue: coverage.filter(t => t.exemption?.overdue).length,
      awaitingReview: Number(outstanding?.awaiting ?? 0),
      resultsWithheld: Number(outstanding?.withheld ?? 0),
    },
  };
}

/* ============================================================================
   Which examinations are in the programme at all
   ----------------------------------------------------------------------------
   The unit's own test menu is the denominator. ISO 15189:2022 §7.3.7.1 wants a
   quality control procedure for each examination, so a test on the menu with
   neither a control nor a recorded exemption is a gap — and it is one the unit
   head can close in two clicks from here.

   A test that belongs to a panel is represented by its panel: nobody runs a
   control "for MCHC", they run it for the full blood count, and listing the
   parameters would report seventeen uncontrolled tests where there are nine.
   ========================================================================= */
export function coverageFor(db: DB, sectionId: number | null, controls: ProgrammeControl[]): ProgrammeCoverageTest[] {
  if (sectionId == null) return [];
  const tests = db.prepare(`SELECT t.id, t.test_code, t.test_name, e.name AS equipment_name
      FROM lab_test_catalog t LEFT JOIN equipment_items e ON e.id = t.equipment_id
      WHERE t.section_id = ? AND COALESCE(t.status, 'active') = 'active' AND t.parent_test_id IS NULL
      ORDER BY t.test_name`).all(sectionId) as any[];

  const byTest = new Map<string, ProgrammeControl[]>();
  for (const control of controls) {
    const key = testKey(control.testName);
    byTest.set(key, [...(byTest.get(key) ?? []), control]);
  }

  const exemptions = new Map<number, any>();
  for (const row of db.prepare(`SELECT x.*, s.full_name AS approved_by_name
      FROM iqc_test_exemptions x LEFT JOIN staff s ON s.id = x.approved_by_staff_id
      WHERE x.is_active = 1`).all() as any[]) exemptions.set(Number(row.test_id), row);

  const now = today();
  return tests.map(test => {
    const matched = byTest.get(testKey(test.test_name)) ?? [];
    const exemption = exemptions.get(Number(test.id)) ?? null;
    return {
      id: Number(test.id),
      testCode: test.test_code ?? null,
      testName: test.test_name,
      equipmentName: test.equipment_name ?? null,
      controls: matched.map(c => ({
        id: c.id, materialName: c.materialName, levelLabel: c.levelLabel, lotNumber: c.lotNumber,
      })),
      covered: matched.length > 0,
      exemption: exemption ? {
        id: Number(exemption.id),
        ground: String(exemption.ground ?? 'other'),
        reason: String(exemption.reason),
        reviewOn: exemption.review_on ?? null,
        approvedBy: exemption.approved_by_name ?? null,
        recordedAt: String(exemption.created_at),
        overdue: Boolean(exemption.review_on && String(exemption.review_on) < now),
      } : null,
    };
  });
}

/* ============================================================================
   What the laboratory has not accounted for
   ----------------------------------------------------------------------------
   Read by the notification scan, so a missed control reaches the person
   responsible instead of waiting to be noticed. Bounded to a recent window: a
   programme switched on over a laboratory with a year of history must raise
   today's omissions, not three hundred of last year's.
   ========================================================================= */
export function missedRunsRecently(db: DB, days = 14): Array<{
  materialId: number; materialName: string; levelLabel: string | null; lotNumber: string;
  sectionId: number | null; missed: number; oldest: string; testName: string;
}> {
  const to = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); // yesterday: today is not yet late
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const answer = programmeFor(db, { sectionId: null, from, to });
  return answer.controls
    .filter(control => control.missed > 0)
    .map(control => ({
      materialId: control.id,
      materialName: control.materialName,
      levelLabel: control.levelLabel,
      lotNumber: control.lotNumber,
      testName: control.testName,
      sectionId: control.sectionId,
      missed: control.missed,
      oldest: control.oldestMissed ?? from,
    }));
}

/** Examinations with neither a control nor a recorded exemption, laboratory-wide. */
export function uncontrolledExaminations(db: DB): Array<{
  testId: number; testName: string; sectionId: number; sectionName: string | null;
}> {
  const out: Array<{ testId: number; testName: string; sectionId: number; sectionName: string | null }> = [];
  const sections = db.prepare(`SELECT DISTINCT t.section_id AS id, s.name
      FROM lab_test_catalog t LEFT JOIN sections s ON s.id = t.section_id
      WHERE t.section_id IS NOT NULL AND COALESCE(t.status, 'active') = 'active'`).all() as any[];
  const today = new Date().toISOString().slice(0, 10);
  for (const section of sections) {
    const answer = programmeFor(db, { sectionId: Number(section.id), from: today, to: today });
    for (const test of answer.coverage) {
      if (test.covered || test.exemption) continue;
      out.push({ testId: test.id, testName: test.testName, sectionId: Number(section.id), sectionName: section.name ?? null });
    }
  }
  return out;
}
