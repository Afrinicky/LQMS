import { useCallback, useEffect, useRef, useState } from 'react';
import { DownloadCloud, Loader2, MonitorPlay, Pause, Play, Rewind, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { Notice } from '../ui/Feedback';
import {
  LINK_MODE_LABELS, LINK_PROTOCOL_LABELS, LINK_STATE_LABELS, modeIsPassive,
  type LinkMode, type LinkProtocol,
} from '../../../shared/constants/instruments';

/** One thing the bridge did, for the window that watches it happen. */
export type BridgeEvent = {
  id: number; at: string; linkId: number;
  level: 'info' | 'in' | 'out' | 'ok' | 'warn' | 'error';
  text: string; detail?: string | null;
};

type LiveFeed = {
  link: {
    id: number; name: string; mode: string; role: string; protocol: string;
    state: string; state_detail: string | null;
    listen_host: string | null; listen_port: number | null;
    remote_host: string | null; remote_port: number | null;
    watch_path: string | null; file_pattern: string | null;
    tap_path: string | null; tap_offset: number | null;
    last_message_at: string | null; messages_received: number;
    equipment_name: string | null;
  };
  following: { file: string | null; note: string; resolvedFromFolder: boolean } | null;
  running: boolean;
  events: BridgeEvent[];
  cursor: number;
  configuration: Record<string, unknown> | null;
};

/** Only a folder or a followed log can be asked to look again. */
const CAN_FETCH = (mode: string) => mode === 'file_drop' || mode === 'lhims_tap';

/* ----------------------------------------------------------------------------
   The transmission, as it happens
   ----------------------------------------------------------------------------
   The LHIMS client puts the conversation on its own screen: what it is
   configured to do on one side, and on the other every step of every message
   as it arrives — received, queued, sent, transmitted. A laboratory running a
   sample watches it land. Nobody has to decide whether "listening" means it is
   working.

   SECHLIMS had the answer and no way to watch it. The checklist says what is
   left to do and the message list says what arrived some seconds ago, but
   neither shows a transmission HAPPENING, which is the thing somebody standing
   at the analyser actually wants.

   So: the configuration on the left, in the analyser's own terms — the ones
   somebody would type into the machine — and the live log on the right,
   colour-coded by what each line means. It is a window onto now; the record is
   under Messages and is written first, in full, before any of this.
   ------------------------------------------------------------------------- */
const LEVEL_WORD: Record<BridgeEvent['level'], string> = {
  info: 'link', in: 'received', out: 'sent', ok: 'read', warn: 'check', error: 'failed',
};

export default function LiveTransmission({ linkId, canEdit = false, onClose }: {
  linkId: number; canEdit?: boolean; onClose: () => void;
}) {
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  const [lines, setLines] = useState<BridgeEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [paused, setPaused] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<'fetch' | 'rewind' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const log = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  const poll = useCallback(async (after: number) => {
    try {
      const next = await api<LiveFeed>(`/instrument-links/${linkId}/events?after=${after}`);
      setFeed(next);
      setProblem(null);
      if (next.events.length) {
        // Capped on the client as well as the server: a window left open all
        // day must not grow until the browser struggles with it.
        setLines(current => [...current, ...next.events].slice(-400));
      }
      setCursor(next.cursor);
      return next.cursor;
    } catch (e) { setProblem(errorText(e)); return after; }
  }, [linkId]);

  useEffect(() => { void poll(0); }, [poll]);

  useEffect(() => {
    if (paused) return;
    let at = cursor;
    let live = true;
    const timer = setInterval(() => {
      if (!live) return;
      void poll(at).then(next => { at = next; });
    }, 2_000);
    return () => { live = false; clearInterval(timer); };
    // `cursor` is read once to seed the loop; the loop carries its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, poll]);

  // Follow the newest line, unless somebody has scrolled up to read something.
  useEffect(() => {
    const box = log.current;
    if (!box || !pinned.current) return;
    box.scrollTop = box.scrollHeight;
  }, [lines, showRaw]);

  function onScroll() {
    const box = log.current;
    if (!box) return;
    pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  }

  async function run(what: 'fetch' | 'rewind') {
    setBusy(what); setNote(null);
    try {
      const outcome = await api<{ ok: boolean; read: number; note: string }>(
        `/instrument-links/${linkId}/${what === 'fetch' ? 'fetch' : 'rewind'}`, { method: 'POST' });
      setNote(outcome.note);
      await poll(cursor);
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(null); }
  }

  const link = feed?.link ?? null;
  const state = link?.state ?? 'stopped';
  const running = feed?.running ?? false;
  const canFetch = Boolean(link) && CAN_FETCH(link!.mode) && (link!.role !== 'lhims_owned' || modeIsPassive(link!.mode));

  /** What somebody would type into the analyser, or into the client. */
  const setup: Array<[string, string]> = [];
  if (link?.mode === 'server') {
    setup.push(['PORT', String(link?.listen_port ?? '—')]);
    setup.push(['BIND', link?.listen_host || 'every interface']);
    setup.push(['MODE', 'server — the analyser connects here']);
  } else if (link?.mode === 'client') {
    setup.push(['EQUIPMENT_IP', String(link?.remote_host ?? '—')]);
    setup.push(['PORT', String(link?.remote_port ?? '—')]);
    setup.push(['MODE', 'client — SECHLIMS connects out']);
  } else if (link?.mode === 'file_drop') {
    setup.push(['FOLDER', String(link?.watch_path ?? '—')]);
    setup.push(['PATTERN', link?.file_pattern || 'every file']);
    setup.push(['MODE', 'watched folder']);
  } else {
    setup.push(['PATH', String(link?.tap_path ?? '—')]);
    setup.push(['FOLLOWING', feed?.following?.file ?? '—']);
    setup.push(['OFFSET', String(link?.tap_offset ?? 0)]);
    setup.push(['MODE', 'read-only copy of the client’s log']);
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal is-wide il-live" onClick={e => e.stopPropagation()}>
        <header>
          <h4><MonitorPlay size={15} /> {link?.name ?? 'Analyser'} — live transmission</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        {problem && <Notice kind="error">{problem}</Notice>}

        <div className="il-live-body">
          {/* What this link is set to — the analyser's own terms. */}
          <aside className="il-live-config">
            <h5>Active configuration</h5>
            <dl>
              <dt>Feed</dt>
              <dd>{(link && LINK_MODE_LABELS[link.mode as LinkMode]?.split(';')[0]) ?? link?.mode ?? '—'}</dd>
              <dt>Speaks</dt>
              <dd>{(link && LINK_PROTOCOL_LABELS[link.protocol as LinkProtocol]?.split('(')[0].trim()) ?? link?.protocol ?? '—'}</dd>
              <dt>Analyser</dt>
              <dd>{link?.equipment_name || link?.name || '—'}</dd>
              <dt>State</dt>
              <dd>
                <span className={`il-live-dot s-${state}${running ? ' is-live' : ''}`} />
                {LINK_STATE_LABELS[state as keyof typeof LINK_STATE_LABELS] ?? state}
              </dd>
            </dl>

            <h6>Source setup</h6>
            <pre className="il-live-setup">
              {setup.map(([key, value]) => `${key} = ${value}`).join('\n')}
            </pre>

            {feed?.following?.resolvedFromFolder && (
              <p className="il-live-hint">{feed.following.note}</p>
            )}

            <div className="il-live-acts">
              {canFetch && (
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => void run('fetch')}>
                  {busy === 'fetch' ? <Loader2 size={13} className="pd-spin" /> : <DownloadCloud size={13} />} Look now
                </button>
              )}
              {canEdit && link?.mode === 'lhims_tap' && (
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => void run('rewind')}>
                  {busy === 'rewind' ? <Loader2 size={13} className="pd-spin" /> : <Rewind size={13} />} Read from the start
                </button>
              )}
            </div>
            {note && <p className="il-live-hint is-note">{note}</p>}
          </aside>

          {/* The conversation. */}
          <section className="il-live-log">
            <div className="il-live-bar">
              <span className={`il-live-pulse${running && !paused ? ' is-live' : ''}`} />
              <strong>{running ? 'Watching' : 'Not running'}</strong>
              <span className="muted">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
              <label className="il-live-toggle">
                <input type="checkbox" checked={showRaw} onChange={e => setShowRaw(e.target.checked)} />
                Show the transmission
              </label>
              <button type="button" className="pq-link" onClick={() => setPaused(p => !p)}>
                {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
              </button>
              <button type="button" className="pq-link" onClick={() => { setLines([]); pinned.current = true; }}>Clear</button>
            </div>

            <div className="il-live-lines" ref={log} onScroll={onScroll}>
              {lines.length === 0 ? (
                <p className="muted">
                  Nothing yet. Run a sample on the analyser and transmit it as you normally would —
                  every step of it appears here as it happens.
                </p>
              ) : lines.map(line => (
                <div key={line.id} className={`il-live-line l-${line.level}`}>
                  <span className="il-live-time">{String(line.at).slice(11, 19)}</span>
                  <span className="il-live-tag">{LEVEL_WORD[line.level] ?? line.level}</span>
                  <span className="il-live-text">
                    {line.text}
                    {showRaw && line.detail && <pre className="il-live-raw">{line.detail}</pre>}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="pr-btns"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
