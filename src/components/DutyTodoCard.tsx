import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, CalendarClock, CheckCircle2, ClipboardList, Clock, Eye,
  ShieldAlert, SlashIcon, Sparkles, ThumbsUp,
} from 'lucide-react';
import { useDutyReminders } from '../hooks/useDutyReminders';
import { CATEGORY_LABELS, frequencyPhrase, type ActivityCategory } from '../../shared/constants/activities';
import type { ActivityOccurrence } from '../../shared/types/api';

/**
 * "What am I on duty to do today?" — the panel the whole feature exists for.
 *
 * Three things make staff actually use a list like this, and each one is a
 * deliberate choice here rather than an accident of layout:
 *
 *   Done is one tap. Not a form, not a modal, not a navigation. An activity
 *   that takes three seconds to perform cannot take thirty seconds to record,
 *   or the recording is what gets skipped.
 *
 *   Every row says why it is yours. "On duty (duty roster)", "On this bench" —
 *   so nobody has to go and read a wall chart to find out whether the fridge
 *   chart is theirs this morning.
 *
 *   Difficulty is a thing you can report. The little "hard to do" control is
 *   not decoration: an activity people find awkward is a design defect, and
 *   this is where the evidence for fixing it comes from.
 */
const CATEGORY_TONE: Record<string, string> = {
  environmental: 'info', equipment: 'warn', quality_control: 'ok',
  reagent: 'info', stock: 'info', cleaning: 'ok', safety: 'crit',
  records: 'info', handover: 'warn', other: 'info',
};

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'done': return { label: 'Done', className: 'badge done' };
    case 'in_progress': return { label: 'Started', className: 'badge in-progress' };
    case 'missed': return { label: 'Missed', className: 'badge overdue' };
    case 'not_applicable': return { label: 'Not applicable', className: 'badge inactive' };
    default: return { label: 'To do', className: 'badge pending' };
  }
}

function DutyLine() {
  const { data } = useDutyReminders();
  if (!data) return null;
  const { duty } = data;
  if (!duty.onDuty) {
    return <p className="duty-line off">You are not on the duty roster today{duty.sectionName ? ` for ${duty.sectionName}` : ''}. Nothing is assigned to you.</p>;
  }
  const bits = [
    duty.shiftLabel ? `${duty.shiftLabel}` : null,
    duty.sectionName,
    duty.benchName ? `${duty.benchName} bench` : null,
  ].filter(Boolean);
  return (
    <p className="duty-line">
      On duty: <strong>{bits.join(' · ')}</strong>
      {(duty.rosterCarriedForward || duty.benchCarriedForward) && (
        <span className="duty-carry" title="No schedule was prepared for this month, so the previous month's is running. Ask your manager to review it.">
          <ShieldAlert size={12} /> carried forward
        </span>
      )}
    </p>
  );
}

function OccurrenceRow({ occurrence, watching = false }: { occurrence: ActivityOccurrence; watching?: boolean }) {
  const { complete, start, markNotApplicable } = useDutyReminders();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState('');
  const [ease, setEase] = useState<number | null>(null);
  const [naReason, setNaReason] = useState('');
  const [showNa, setShowNa] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = occurrence.status === 'pending' || occurrence.status === 'in_progress';
  const badge = statusBadge(occurrence.status);
  const tone = CATEGORY_TONE[occurrence.category ?? 'other'] ?? 'info';

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <li className={`duty-item${open ? '' : ' closed'}${occurrence.status === 'missed' ? ' missed' : ''}`}>
      <span className={`duty-rail ${tone}`} />
      <div className="duty-main">
        <div className="duty-title">
          {occurrence.activity_name}
          {occurrence.redesign_status && occurrence.redesign_status !== 'none' && (
            <span className="duty-chip redesign" title="Flagged to be simplified">being simplified</span>
          )}
        </div>
        <div className="duty-meta">
          <span className="badge">{CATEGORY_LABELS[(occurrence.category ?? 'other') as ActivityCategory] ?? occurrence.category}</span>
          <span>{frequencyPhrase(occurrence.frequency ?? 'daily', occurrence.interval_days ?? null)}</span>
          {occurrence.estimated_minutes ? <span><Clock size={11} /> {occurrence.estimated_minutes} min</span> : null}
          {occurrence.section_name ? <span>{occurrence.section_name}</span> : null}
          {occurrence.bench_name ? <span>{occurrence.bench_name}</span> : null}
          {occurrence.assignment_source && !watching && (
            <span className="duty-why" title="Why this is on your list">
              {occurrence.assignment_source === 'bench_schedule' ? 'on this bench'
                : occurrence.assignment_source === 'duty_roster' ? 'on duty'
                : occurrence.assignment_source === 'unit_head' ? 'as unit head'
                : occurrence.assignment_source === 'named_staff' ? 'named on it'
                : 'unit member'}
            </span>
          )}
          <span className={badge.className}>{badge.label}</span>
        </div>
        {expanded && occurrence.instructions && <p className="duty-instructions">{occurrence.instructions}</p>}
        {occurrence.status === 'done' && occurrence.completed_by_name && (
          <p className="duty-instructions">Done by {occurrence.completed_by_name}.</p>
        )}

        {expanded && open && !watching && (
          <div className="duty-expand">
            <label>
              <span>Note (optional)</span>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Anything worth recording" />
            </label>
            <div className="duty-ease">
              <span>How easy was it?</span>
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" className={`ease-dot${ease === n ? ' on' : ''}`}
                  onClick={() => setEase(ease === n ? null : n)}
                  title={['Very hard', 'Hard', 'Workable', 'Easy', 'Very easy'][n - 1]}>{n}</button>
              ))}
              <span className="duty-ease-hint">Tell us when something is awkward — that is how it gets simplified.</span>
            </div>
          </div>
        )}

        {showNa && (
          <div className="duty-expand">
            <label>
              <span>Why is this not applicable today?</span>
              <input value={naReason} onChange={e => setNaReason(e.target.value)} placeholder="Instrument out of service, unit closed…" autoFocus />
            </label>
            <div className="duty-actions">
              <button type="button" disabled={busy || !naReason.trim()}
                onClick={() => void run(async () => { await markNotApplicable(occurrence.id, naReason.trim()); setShowNa(false); })}>
                Record it
              </button>
              <button type="button" className="secondary" onClick={() => setShowNa(false)}>Cancel</button>
            </div>
          </div>
        )}

        {error && <p className="duty-error">{error}</p>}
      </div>

      <div className="duty-side">
        {watching ? (
          <span className="duty-watch" title="You see this as oversight; the staff on duty complete it"><Eye size={14} /> watching</span>
        ) : open ? (
          <>
            <button type="button" className="duty-done" disabled={busy}
              onClick={() => void run(() => complete(occurrence.id, { note: note.trim() || undefined, easeRating: ease ?? undefined }))}
              title="Mark this done">
              <CheckCircle2 size={16} /> Done
            </button>
            <div className="duty-side-links">
              {occurrence.target_route && (
                <button type="button" className="pq-link" onClick={() => navigate(occurrence.target_route!)} title="Open where this is recorded">
                  Open <ArrowRight size={12} />
                </button>
              )}
              <button type="button" className="pq-link" onClick={() => setExpanded(v => !v)}>
                {expanded ? 'Less' : 'Details'}
              </button>
              {occurrence.status === 'pending' && (
                <button type="button" className="pq-link" onClick={() => void run(() => start(occurrence.id))}>Start</button>
              )}
              <button type="button" className="pq-link" onClick={() => setShowNa(true)} title="Record why it does not apply today">
                <SlashIcon size={12} /> N/A
              </button>
            </div>
          </>
        ) : (
          <span className="duty-closed-mark"><ThumbsUp size={14} /></span>
        )}
      </div>
    </li>
  );
}

function ScheduleTasks() {
  const { data } = useDutyReminders();
  const navigate = useNavigate();
  const tasks = (data?.scheduleTasks ?? []).filter(t => t.isMine);
  if (!tasks.length) return null;
  return (
    <div className="duty-schedules">
      <h4><CalendarClock size={14} /> Rosters and schedules you owe</h4>
      <ul>
        {tasks.map(task => (
          <li key={`${task.kind}:${task.month}:${task.sectionId ?? 0}`}
            role="button" tabIndex={0}
            onClick={() => navigate(task.actionUrl)}
            onKeyDown={e => { if (e.key === 'Enter') navigate(task.actionUrl); }}>
            <span className={`badge ${task.status === 'overdue' ? 'overdue' : task.status === 'carried_forward' ? 'warning' : 'due-soon'}`}>
              {task.status === 'overdue' ? 'Late' : task.status === 'carried_forward' ? 'Review' : 'Due'}
            </span>
            <span className="ds-text">{task.message}</span>
            <ArrowRight size={13} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DutyTodoCard({ limit = 8 }: { limit?: number }) {
  const { data, loading, error } = useDutyReminders();
  const [showWatching, setShowWatching] = useState(false);

  const mine = data?.mine ?? [];
  const watching = data?.watching ?? [];
  const open = mine.filter(o => o.status === 'pending' || o.status === 'in_progress');
  const done = mine.filter(o => o.status === 'done' || o.status === 'not_applicable');

  return (
    <div className="card duty-card">
      <div className="di-head">
        <div>
          <h3><ClipboardList size={16} /> My activities today</h3>
          <p>
            {loading ? 'Loading…'
              : open.length === 0 && mine.length === 0 ? 'Nothing is scheduled for you today.'
              : `${open.length} to do${done.length ? `, ${done.length} done` : ''}${data?.counts.missed ? `, ${data.counts.missed} missed` : ''}`}
          </p>
        </div>
        {watching.length > 0 && (
          <button type="button" className="pq-link" onClick={() => setShowWatching(v => !v)}>
            <Eye size={13} /> {showWatching ? 'Hide' : `${watching.length} watching`}
          </button>
        )}
      </div>

      <DutyLine />
      {error && <p className="duty-error">{error}</p>}

      {!loading && open.length === 0 && mine.length > 0 && (
        <div className="di-clear">
          <Sparkles size={18} />
          <span>Everything on your list is done. Nicely cleared.</span>
        </div>
      )}

      <ul className="duty-list">
        {[...open, ...done].slice(0, limit).map(o => <OccurrenceRow key={o.id} occurrence={o} />)}
      </ul>

      {showWatching && (
        <>
          <div className="duty-subhead">Your unit&rsquo;s activities — oversight only</div>
          <ul className="duty-list">
            {watching.slice(0, 10).map(o => <OccurrenceRow key={`w-${o.id}`} occurrence={o} watching />)}
          </ul>
        </>
      )}

      <ScheduleTasks />
    </div>
  );
}
