import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, isPermissionDenied } from '../services/api';
import { playEvent } from '../services/sound';
import { useAuth } from './useAuth';

/**
 * Inbound communications, kept live for the whole shell.
 *
 * One provider, one poll. The popup, the topbar count and the Communication
 * workspace all read from here rather than each asking the server for itself:
 * three copies of "what has been said to me" is three chances for them to
 * disagree in front of a member of staff, and three times the traffic on a
 * laboratory LAN that also carries analyser feeds.
 *
 * The sound and popup rules are deliberately conservative, for the same reason
 * the duty reminders are (see useDutyReminders.tsx):
 *
 *   • Nothing pops up or chimes on the first load. Signing in to a screen that
 *     immediately throws four popups at you teaches people to close them
 *     without reading, which costs far more than the notice gains.
 *   • Only a genuinely new message announces itself, and only once. A message
 *     already shown is remembered for the session, so a poll that returns it
 *     again — because it is still unread — does not re-announce it.
 *   • A batch is one chime, not six.
 *   • Dismissing a popup does not mark the message read. It is still in the
 *     inbox, still unread, still counted. "I am busy" is not "I have read it".
 */

/** One inbound message, as the popup and the count need it. */
export type InboundCommunication = {
  id: number;
  communication_number: string;
  thread_id: number;
  thread_number: string | null;
  subject: string;
  preview: string;
  body: string;
  communication_type: string;
  priority: string;
  confidentiality: string;
  requires_acknowledgement: number;
  acknowledgement_due: string | null;
  sent_at: string;
  sender_name: string | null;
  my_recipient_id: number | null;
  my_delivery_status: string | null;
};

type CommunicationsContextValue = {
  /** Unread messages addressed to this person, newest first. */
  unread: InboundCommunication[];
  /** Those not yet shown as a popup and not dismissed this session. */
  popups: InboundCommunication[];
  unreadCount: number;
  available: boolean;
  refresh: () => Promise<void>;
  /** Close the popup without touching the message's read state. */
  dismissPopup: (id: number) => void;
  /** Mark read on the server and drop it from the unread list. */
  markRead: (id: number) => Promise<void>;
  /** Send a reply on the thread, then refresh. */
  reply: (id: number, body: string) => Promise<void>;
  acknowledge: (id: number) => Promise<void>;
};

const CommunicationsContext = createContext<CommunicationsContextValue | undefined>(undefined);

/** How often the shell re-asks. Fast enough to feel like a chat, cheap enough to ignore. */
const POLL_MS = 45 * 1000;

export function CommunicationsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [unread, setUnread] = useState<InboundCommunication[]>([]);
  const [available, setAvailable] = useState(true);
  // What was already waiting when this session started. Seeded on the first
  // poll and never popped up: arriving at work to six popups is how people
  // learn to close them without reading.
  const seeded = useRef<Set<number>>(new Set());
  // What has already made a noise, so a message still unread on the next poll
  // does not chime again.
  const chimed = useRef<Set<number>>(new Set());
  // Closed by hand, read, replied to or acknowledged — gone from the popup
  // stack for this session, whatever the server still reports.
  const [dismissed, setDismissed] = useState<Set<number>>(() => new Set());
  const firstLoad = useRef(true);
  const lastChimeAt = useRef(0);

  const chime = useCallback((event: string) => {
    const now = Date.now();
    // One sound per five seconds, whatever arrives. A burst of messages is a
    // single event to the person hearing it.
    if (now - lastChimeAt.current < 5000) return;
    lastChimeAt.current = now;
    playEvent(event);
  }, []);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const payload = await api<{ now: string; messages: InboundCommunication[] }>('/communications/inbox/new');
      setAvailable(true);
      const messages = payload.messages ?? [];

      if (firstLoad.current) {
        // Seed, so signing in is silent: what was waiting before this session
        // is in the inbox, not in your face.
        for (const m of messages) { seeded.current.add(m.id); chimed.current.add(m.id); }
        firstLoad.current = false;
      } else {
        const fresh = messages.filter(m => !chimed.current.has(m.id));
        if (fresh.some(m => m.priority === 'urgent')) chime('critical');
        else if (fresh.length) chime('todo');
        for (const m of fresh) chimed.current.add(m.id);
      }
      setUnread(messages);
    } catch (e) {
      // A user without the communication right gets no hub and no poll, and is
      // told nothing about it — hiding what somebody may not reach is the rule
      // everywhere else in SECH_LIMS.
      if (isPermissionDenied(e)) { setAvailable(false); setUnread([]); }
    }
  }, [user, chime]);

  useEffect(() => {
    if (!user) { setUnread([]); firstLoad.current = true; seeded.current = new Set(); chimed.current = new Set(); return; }
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // A terminal left overnight comes back to a stale list, so a refocused
    // window re-asks at once rather than waiting out the poll.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [user, load]);

  const dismissPopup = useCallback((id: number) => {
    setDismissed(prev => new Set(prev).add(id));
  }, []);

  const markRead = useCallback(async (id: number) => {
    setDismissed(prev => new Set(prev).add(id));
    await api(`/communications/${id}/read`, { method: 'POST', body: JSON.stringify({}) });
    setUnread(prev => prev.filter(m => m.id !== id));
  }, []);

  const acknowledge = useCallback(async (id: number) => {
    setDismissed(prev => new Set(prev).add(id));
    await api(`/communications/${id}/acknowledge`, { method: 'POST', body: JSON.stringify({}) });
    setUnread(prev => prev.filter(m => m.id !== id));
  }, []);

  const reply = useCallback(async (id: number, body: string) => {
    await api(`/communications/${id}/reply`, { method: 'POST', body: JSON.stringify({ body }) });
    // Replying is the strongest possible signal that it has been read, and the
    // server records that too; dropping it locally keeps the two in step.
    setDismissed(prev => new Set(prev).add(id));
    setUnread(prev => prev.filter(m => m.id !== id));
    await load();
  }, [load]);

  // A popup is for something that arrived while this person was working: not
  // already waiting when they signed in, and not closed or dealt with since.
  // At most three at once — a stack taller than that is a wall, not a notice.
  const popups = useMemo(
    () => unread.filter(m => !seeded.current.has(m.id) && !dismissed.has(m.id)).slice(0, 3),
    [unread, dismissed],
  );

  const value = useMemo<CommunicationsContextValue>(() => ({
    unread, popups, unreadCount: unread.length, available,
    refresh: async () => { await load(); },
    dismissPopup, markRead, reply, acknowledge,
  }), [unread, popups, available, load, dismissPopup, markRead, reply, acknowledge]);

  return <CommunicationsContext.Provider value={value}>{children}</CommunicationsContext.Provider>;
}

/**
 * The communication state. Returns a quiet, empty shape outside the provider so
 * a component can be dropped anywhere — including the mobile shell, which does
 * not mount the provider — without a crash.
 */
export function useCommunications(): CommunicationsContextValue {
  const ctx = useContext(CommunicationsContext);
  return ctx ?? {
    unread: [], popups: [], unreadCount: 0, available: false,
    refresh: async () => undefined,
    dismissPopup: () => undefined,
    markRead: async () => undefined,
    reply: async () => undefined,
    acknowledge: async () => undefined,
  };
}
