import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { configureSound, playEvent, primeAudio } from '../services/sound';
import { useAuth } from './useAuth';
import type { ActivityOccurrence, DutyContext, ScheduleObligation } from '../../shared/types/api';

/**
 * The signed-in person's duty day, kept live for the whole shell.
 *
 * One provider, one poll, one source of truth. The dashboard panel, the morning
 * briefing and the sidebar badge all read from here rather than each fetching
 * their own copy — three copies of "what am I supposed to do today" is three
 * chances for them to disagree in front of a member of staff.
 *
 * The sound rules live here too, and they are deliberately conservative:
 *
 *   • Nothing makes a noise on the first load. Arriving at a screen that
 *     immediately chimes about work you already knew about trains people to
 *     mute the application, which costs far more than the reminder gains.
 *   • Only genuinely new items ring, and the ringing is throttled: ten
 *     activities appearing at once is one chime, not ten.
 *   • Overdue outranks new, and a schedule deadline has a sound of its own, so
 *     a person can tell what happened without looking.
 */
export type DutyTodayPayload = {
  date: string;
  greetingName: string | null;
  duty: DutyContext;
  mine: ActivityOccurrence[];
  watching: ActivityOccurrence[];
  scheduleTasks: Array<ScheduleObligation & { ownerStaffId?: number | null }>;
  counts: { due: number; done: number; overdue: number; missed: number; watching: number };
  sounds: Array<{ event: string; soundKey: string }>;
  soundPrefs: {
    enabled: number; volume: number; repeatCount: number;
    desktopEnabled: number; mobileEnabled: number;
    quietHoursStart: string | null; quietHoursEnd: string | null;
    dailyBriefingEnabled: number;
  };
  briefingSeen: boolean;
};

type DutyContextValue = {
  data: DutyTodayPayload | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  complete: (occurrenceId: number, input?: { note?: string; easeRating?: number; minutesTaken?: number }) => Promise<void>;
  start: (occurrenceId: number) => Promise<void>;
  markNotApplicable: (occurrenceId: number, reason: string) => Promise<void>;
  briefingOpen: boolean;
  dismissBriefing: () => void;
  openBriefing: () => void;
};

const DutyReminderContext = createContext<DutyContextValue | undefined>(undefined);

/** How often the shell re-asks. Two minutes is well inside a bench's attention span. */
const POLL_MS = 2 * 60 * 1000;

export function DutyReminderProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [data, setData] = useState<DutyTodayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [briefingOpen, setBriefingOpen] = useState(false);

  // What we have already made a noise about. A ref rather than state: changing
  // it must never re-render, and it must survive across polls.
  const announced = useRef<Set<number>>(new Set());
  const announcedSchedules = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);
  const lastChimeAt = useRef(0);

  const chime = useCallback((event: string) => {
    const now = Date.now();
    // One sound per five seconds, whatever arrives. A batch of new work is a
    // single event to the person hearing it.
    if (now - lastChimeAt.current < 5000) return;
    lastChimeAt.current = now;
    playEvent(event);
  }, []);

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!user) return;
    try {
      const payload = await api<DutyTodayPayload>('/duty/today');
      setError(null);

      configureSound({
        preferences: {
          enabled: payload.soundPrefs.enabled !== 0,
          volume: Number(payload.soundPrefs.volume ?? 0.7),
          repeatCount: Number(payload.soundPrefs.repeatCount ?? 1),
          desktopEnabled: payload.soundPrefs.desktopEnabled !== 0,
          mobileEnabled: payload.soundPrefs.mobileEnabled !== 0,
          quietHoursStart: payload.soundPrefs.quietHoursStart,
          quietHoursEnd: payload.soundPrefs.quietHoursEnd,
          dailyBriefingEnabled: payload.soundPrefs.dailyBriefingEnabled !== 0,
        },
        events: payload.sounds,
      });

      const openItems = payload.mine.filter(o => o.status === 'pending' || o.status === 'in_progress');
      if (firstLoad.current) {
        // Seed the "already seen" set so the first poll is silent.
        for (const item of payload.mine) announced.current.add(item.id);
        for (const task of payload.scheduleTasks) announcedSchedules.current.add(`${task.kind}:${task.month}:${task.sectionId ?? 0}:${task.status}`);
      } else if (!opts.silent) {
        const fresh = openItems.filter(o => !announced.current.has(o.id));
        const overdue = fresh.filter(o => o.occurrence_date < payload.date);
        const critical = fresh.filter(o => o.priority === 'critical');
        if (critical.length) chime('critical');
        else if (overdue.length) chime('overdue');
        else if (fresh.length) chime('todo');
        for (const item of fresh) announced.current.add(item.id);

        const freshSchedules = payload.scheduleTasks.filter(task => {
          const key = `${task.kind}:${task.month}:${task.sectionId ?? 0}:${task.status}`;
          if (announcedSchedules.current.has(key)) return false;
          announcedSchedules.current.add(key);
          return task.isMine;
        });
        if (freshSchedules.length) chime('schedule');
      }

      // The morning briefing: once per calendar day, only when there is
      // something on the list, and only if the person has not turned it off.
      if (firstLoad.current && !payload.briefingSeen && payload.soundPrefs.dailyBriefingEnabled !== 0
          && (openItems.length > 0 || payload.scheduleTasks.some(t => t.isMine))) {
        setBriefingOpen(true);
        playEvent('briefing');
      }

      firstLoad.current = false;
      setData(payload);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user, chime]);

  useEffect(() => {
    if (!user) { setData(null); setLoading(false); firstLoad.current = true; return; }
    primeAudio();
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // A laptop that has been asleep since yesterday comes back to a stale list,
    // so a refocused window re-asks immediately rather than waiting out the poll.
    const onFocus = () => void load({ silent: true });
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [user, load]);

  const refresh = useCallback(async () => { await load({ silent: true }); }, [load]);

  const complete = useCallback(async (occurrenceId: number, input: { note?: string; easeRating?: number; minutesTaken?: number } = {}) => {
    await api(`/duty/occurrences/${occurrenceId}/complete`, { method: 'POST', body: JSON.stringify(input) });
    await load({ silent: true });
  }, [load]);

  const start = useCallback(async (occurrenceId: number) => {
    await api(`/duty/occurrences/${occurrenceId}/start`, { method: 'POST', body: JSON.stringify({}) });
    await load({ silent: true });
  }, [load]);

  const markNotApplicable = useCallback(async (occurrenceId: number, reason: string) => {
    await api(`/duty/occurrences/${occurrenceId}/not-applicable`, { method: 'POST', body: JSON.stringify({ reason }) });
    await load({ silent: true });
  }, [load]);

  const dismissBriefing = useCallback(() => {
    setBriefingOpen(false);
    void api('/duty/briefing-seen', { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined);
  }, []);

  const value = useMemo<DutyContextValue>(() => ({
    data, loading, error, refresh, complete, start, markNotApplicable,
    briefingOpen, dismissBriefing, openBriefing: () => setBriefingOpen(true),
  }), [data, loading, error, refresh, complete, start, markNotApplicable, briefingOpen, dismissBriefing]);

  return <DutyReminderContext.Provider value={value}>{children}</DutyReminderContext.Provider>;
}

/**
 * The duty state. Returns a quiet, empty shape outside the provider so a
 * component can be dropped anywhere — including the mobile shell, which does
 * not mount the provider — without a crash.
 */
export function useDutyReminders(): DutyContextValue {
  const ctx = useContext(DutyReminderContext);
  return ctx ?? {
    data: null, loading: false, error: null,
    refresh: async () => undefined,
    complete: async () => undefined,
    start: async () => undefined,
    markNotApplicable: async () => undefined,
    briefingOpen: false,
    dismissBriefing: () => undefined,
    openBriefing: () => undefined,
  };
}
