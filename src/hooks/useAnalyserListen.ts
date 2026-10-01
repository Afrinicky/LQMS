import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../services/api';

/**
 * Standing ready for the analyser.
 *
 * "Fetch" is the wrong shape for most of these machines: an analyser that dials
 * in decides for itself when to transmit, and nothing here can make it. So the
 * button does the honest version of what somebody means by it — it opens the
 * door, says so, and waits.
 *
 * The watermark is the whole trick. When somebody presses it, the host hands
 * back the newest message this analyser has already sent; everything after that
 * is new. Without it the run sitting on the bench from yesterday would be taken
 * for the one they are standing at the analyser waiting for, and a QC record
 * would be written against the wrong transmission.
 *
 * It is a PAIR of marks, not one number: control runs and patient results are
 * numbered in different tables, and a single mark across both is the larger of
 * two unrelated sequences — under which the smaller table's new rows are
 * invisible, so the bench waits and nothing ever appears.
 *
 * It stops on its own. A screen left waiting for ever is a screen nobody
 * believes, and a poll nobody is watching is a poll that should not be running.
 */

export type ListenState = {
  /** Waiting for the analyser right now. */
  waiting: boolean;
  /** What the host said when the door was opened, or why it could not be. */
  note: string | null;
  /** Seconds left before it gives up. */
  remaining: number;
  problem: string | null;
};

const WINDOW_SECONDS = 120;
const POLL_MS = 2000;

/** Where each kind of message had got to when the door was opened. */
export type Watermark = { control: number; patient: number };

export function useAnalyserListen<T>(options: {
  /** Opens the door and returns the watermark. */
  arm: () => Promise<{ listening: boolean; since: Watermark; note: string }>;
  /** Everything that has arrived after the watermark, newest first. */
  poll: (since: Watermark) => Promise<T[]>;
  /** What to do with the first thing that lands. */
  onArrival: (item: T) => void | Promise<void>;
}) {
  const [state, setState] = useState<ListenState>({ waiting: false, note: null, remaining: 0, problem: null });
  // Kept in refs so the interval never closes over a stale callback, and so
  // stopping is immediate rather than "on the next tick".
  const since = useRef<Watermark>({ control: 0, patient: 0 });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const deadline = useRef(0);
  const opts = useRef(options);
  opts.current = options;

  const stop = useCallback((note?: string | null) => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    setState(s => ({ ...s, waiting: false, remaining: 0, note: note === undefined ? s.note : note }));
  }, []);

  // A screen that is closed must not leave a poll running behind it.
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const start = useCallback(async () => {
    setState({ waiting: false, note: null, remaining: 0, problem: null });
    let armed;
    try { armed = await opts.current.arm(); }
    catch (e) { setState({ waiting: false, note: null, remaining: 0, problem: errorText(e) }); return; }

    if (!armed.listening) {
      setState({ waiting: false, note: armed.note, remaining: 0, problem: null });
      return;
    }

    since.current = armed.since;
    deadline.current = Date.now() + WINDOW_SECONDS * 1000;
    setState({ waiting: true, note: armed.note, remaining: WINDOW_SECONDS, problem: null });

    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000));
      setState(s => (s.waiting ? { ...s, remaining: left } : s));
      if (left === 0) {
        stop('Nothing arrived. Press it again when the analyser is ready to send.');
        return;
      }
      void (async () => {
        let arrived: T[] = [];
        try { arrived = await opts.current.poll(since.current); }
        catch { return; /* a single failed poll is not worth ending the wait over */ }
        if (!arrived.length) return;
        stop(null);
        // Oldest first, so the earliest thing sent after the button was pressed
        // is the one taken — the order somebody at the analyser expects.
        await opts.current.onArrival(arrived[arrived.length - 1]);
      })();
    }, POLL_MS);
  }, [stop]);

  return { ...state, start, stop: () => stop(null) };
}

/** Shared by the module and the portal, so one wording is used for both. */
export async function armAnalyser(path: string, body?: Record<string, unknown>) {
  return api<{ listening: boolean; since: Watermark; note: string }>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}
