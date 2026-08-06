/**
 * When a laboratory backs itself up, and how long it keeps the copies.
 *
 * The recommendations here are not arbitrary. A clinical laboratory writes all
 * day — results, controls, nonconformities, training records — so the question
 * is which hour is quiet enough to snapshot cleanly and late enough to have the
 * day's work in it. Between 01:00 and 04:00 the bench is either closed or on a
 * skeleton night shift, the WAL is not being fought over, and a backup taken
 * then contains everything filed the previous day.
 *
 * Retention follows the grandfather-father-son pattern an assessor expects:
 * enough recent copies to undo a mistake somebody noticed this week, enough
 * older ones to reach back a year without keeping 365 archives.
 */

export const BACKUP_FREQUENCIES = ['daily', 'twice_daily', 'weekly', 'custom'] as const;
export type BackupFrequency = typeof BACKUP_FREQUENCIES[number];

export type BackupSchedule = {
  /** Automatic backups run only when this is on. Manual backups always work. */
  enabled: boolean;
  frequency: BackupFrequency;
  /** 24-hour local times, "HH:MM". Daily uses the first; twice-daily the first two. */
  times: string[];
  /** For `weekly` — 0 is Sunday. Ignored otherwise. */
  daysOfWeek: number[];
  retention: {
    /** Keep every backup from the last N days. */
    daily: number;
    /** Then one per week for N weeks. */
    weekly: number;
    /** Then one per month for N months. */
    monthly: number;
  };
  /** Copy each finished backup to Google Drive, if Drive is connected. */
  syncToDrive: boolean;
};

export const DEFAULT_SCHEDULE: BackupSchedule = {
  enabled: false,
  frequency: 'daily',
  times: ['02:00'],
  daysOfWeek: [0],
  retention: { daily: 7, weekly: 4, monthly: 12 },
  syncToDrive: false,
};

/** The presets offered on the settings screen, in the order they are shown. */
export const SCHEDULE_PRESETS: Array<{
  key: BackupFrequency;
  label: string;
  detail: string;
  why: string;
  recommended?: boolean;
  apply: Partial<BackupSchedule>;
}> = [
  {
    key: 'daily',
    label: 'Every night',
    detail: '02:00',
    why: 'The bench is quiet, and the backup carries everything filed that day. Losing at most one day of records is the right trade for most laboratories.',
    recommended: true,
    apply: { frequency: 'daily', times: ['02:00'] },
  },
  {
    key: 'twice_daily',
    label: 'Twice a day',
    detail: '02:00 and 14:00',
    why: 'For a busy laboratory where half a day of lost results would hurt. The midday copy is taken over the lunch lull.',
    apply: { frequency: 'twice_daily', times: ['02:00', '14:00'] },
  },
  {
    key: 'weekly',
    label: 'Once a week',
    detail: 'Sunday 02:00',
    why: 'Only for a low-volume laboratory. A week of lost quality records is a lot to reconstruct.',
    apply: { frequency: 'weekly', times: ['02:00'], daysOfWeek: [0] },
  },
  {
    key: 'custom',
    label: 'Choose your own',
    detail: 'Pick the times',
    why: 'Set the hours that suit your shift pattern. Avoid the start of a shift, when the system is busiest.',
    apply: { frequency: 'custom' },
  },
];

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isValidTime = (t: string) => TIME_PATTERN.test(t);

/**
 * Bring a stored or submitted schedule to a shape the scheduler can rely on.
 * Anything unrecognised falls back to the default rather than throwing, so a
 * hand-edited settings row can never stop the laboratory backing itself up.
 */
export function normaliseSchedule(input: unknown): BackupSchedule {
  const raw = (input ?? {}) as Partial<BackupSchedule>;
  const frequency = BACKUP_FREQUENCIES.includes(raw.frequency as BackupFrequency)
    ? raw.frequency as BackupFrequency : DEFAULT_SCHEDULE.frequency;

  let times = Array.isArray(raw.times) ? raw.times.filter(t => typeof t === 'string' && isValidTime(t)) : [];
  times = [...new Set(times)].sort();
  if (times.length === 0) times = [...DEFAULT_SCHEDULE.times];
  if (frequency === 'daily' || frequency === 'weekly') times = times.slice(0, 1);
  if (frequency === 'twice_daily') times = times.slice(0, 2);
  if (frequency === 'twice_daily' && times.length === 1) times = ['02:00', '14:00'];
  times = times.slice(0, 6);

  const daysOfWeek = Array.isArray(raw.daysOfWeek)
    ? [...new Set(raw.daysOfWeek.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
    : [];

  const clamp = (v: unknown, fallback: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : fallback;
  };

  return {
    enabled: raw.enabled === true,
    frequency,
    times,
    daysOfWeek: frequency === 'weekly' && daysOfWeek.length === 0 ? [0] : daysOfWeek,
    retention: {
      daily: clamp(raw.retention?.daily, DEFAULT_SCHEDULE.retention.daily, 90),
      weekly: clamp(raw.retention?.weekly, DEFAULT_SCHEDULE.retention.weekly, 52),
      monthly: clamp(raw.retention?.monthly, DEFAULT_SCHEDULE.retention.monthly, 120),
    },
    syncToDrive: raw.syncToDrive === true,
  };
}

/** A plain-English sentence for the schedule, used on the status card. */
export function describeSchedule(s: BackupSchedule): string {
  if (!s.enabled) return 'Automatic backups are off.';
  const at = s.times.join(' and ');
  if (s.frequency === 'weekly') {
    const days = s.daysOfWeek.map(d => DAY_NAMES[d]).join(', ') || 'Sunday';
    return `Every ${days} at ${at}.`;
  }
  if (s.frequency === 'twice_daily') return `Twice a day, at ${at}.`;
  if (s.frequency === 'custom') return `Every day at ${at}.`;
  return `Every night at ${at}.`;
}

/** How far back the retention policy reaches, said once. */
export function describeRetention(r: BackupSchedule['retention']): string {
  const parts: string[] = [];
  if (r.daily > 0) parts.push(`every backup for ${r.daily} day${r.daily === 1 ? '' : 's'}`);
  if (r.weekly > 0) parts.push(`one a week for ${r.weekly} week${r.weekly === 1 ? '' : 's'}`);
  if (r.monthly > 0) parts.push(`one a month for ${r.monthly} month${r.monthly === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'Nothing is pruned automatically.';
  return `Keeps ${parts.join(', then ')}.`;
}

/**
 * The next moment this schedule is due, at or after `from`.
 *
 * Times are local to the host, because that is the clock the laboratory reads.
 * Returns null when automatic backups are off.
 */
export function nextRunAfter(s: BackupSchedule, from: Date): Date | null {
  if (!s.enabled || s.times.length === 0) return null;
  const wanted = s.frequency === 'weekly' ? new Set(s.daysOfWeek.length ? s.daysOfWeek : [0]) : null;

  // Walk forward day by day. Eight days covers a weekly schedule from any start.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + dayOffset);
    if (wanted && !wanted.has(day.getDay())) continue;
    for (const time of s.times) {
      const [h, m] = time.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
      if (at.getTime() > from.getTime()) return at;
    }
  }
  return null;
}

/**
 * Which backups a retention policy would keep, given their timestamps.
 *
 * Newest-first in, and it returns the set to KEEP — grandfather-father-son:
 * everything inside the daily window, then the newest in each ISO week, then
 * the newest in each calendar month. The very newest backup is always kept,
 * whatever the policy says, because a laboratory is never left with none.
 */
export function backupsToKeep<T extends { createdAt: string }>(
  entries: T[], retention: BackupSchedule['retention'], now: Date = new Date(),
): Set<T> {
  const keep = new Set<T>();
  const sorted = [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const dayMs = 86400000;
  const seenWeeks = new Set<string>();
  const seenMonths = new Set<string>();
  const weekOf = (d: Date) => `${d.getFullYear()}-W${Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / (7 * dayMs))}`;
  const monthOf = (d: Date) => `${d.getFullYear()}-${d.getMonth()}`;

  // The newest is always kept, whatever the policy says — a laboratory is never
  // left with none. It also claims its week and month slots, so the policy keeps
  // exactly what it describes rather than one extra.
  if (sorted.length > 0) {
    keep.add(sorted[0]);
    const at = new Date(sorted[0].createdAt);
    if (!Number.isNaN(at.getTime())) { seenWeeks.add(weekOf(at)); seenMonths.add(monthOf(at)); }
  }

  for (const e of sorted) {
    const at = new Date(e.createdAt);
    if (Number.isNaN(at.getTime())) { keep.add(e); continue; } // unreadable date: never prune it
    const ageDays = (now.getTime() - at.getTime()) / dayMs;

    if (ageDays <= retention.daily) { keep.add(e); continue; }

    // ISO-ish week key: year + week number, good enough to bucket by week.
    const weekKey = weekOf(at);
    if (ageDays <= retention.daily + retention.weekly * 7 && !seenWeeks.has(weekKey)) {
      seenWeeks.add(weekKey); keep.add(e); continue;
    }

    const monthKey = monthOf(at);
    const monthsOld = (now.getFullYear() - at.getFullYear()) * 12 + (now.getMonth() - at.getMonth());
    if (monthsOld <= retention.monthly && !seenMonths.has(monthKey)) {
      seenMonths.add(monthKey); keep.add(e);
    }
  }
  return keep;
}

/**
 * The latest scheduled moment at or before `now`.
 *
 * This is what makes a missed backup catch up rather than vanish: a host that
 * was switched off at 02:00 asks, when it comes back at 09:30, "was a backup
 * due since the last one I took?" — and this answers yes, at 02:00.
 */
export function mostRecentDue(schedule: BackupSchedule, now: Date): Date | null {
  if (!schedule.enabled || schedule.times.length === 0) return null;
  const wanted = schedule.frequency === 'weekly'
    ? new Set(schedule.daysOfWeek.length ? schedule.daysOfWeek : [0]) : null;
  for (let back = 0; back <= 8; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (wanted && !wanted.has(day.getDay())) continue;
    for (const time of [...schedule.times].sort().reverse()) {
      const [h, m] = time.split(':').map(Number);
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
      if (at.getTime() <= now.getTime()) return at;
    }
  }
  return null;
}
