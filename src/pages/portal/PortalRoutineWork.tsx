import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Clock, Eye, Lock,
  Loader2, Repeat, ShieldAlert, SlashIcon, Sparkles,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import { useDutyReminders } from '../../hooks/useDutyReminders';
import {
  CATEGORY_LABELS, TIER_HINTS, TIER_LABELS, TIER_SHORT,
  frequencyPhrase, type ActivityCategory, type ActivityTier,
} from '../../../shared/constants/activities';
import { usePortal } from './portalData';
import type { RoutineWorkResponse, RoutineActivity, ActivityOccurrence } from '../../../shared/types/api';

/**
 * Routine Work — the recurring work of the bench, done from the portal.
 *
 * Environmental charting, bench and equipment decontamination, scheduled
 * equipment maintenance, IQC: the work that is not a task somebody assigned but
 * a standing obligation of the unit. It was already being scheduled and
 * reminded on; what it lacked was a place where a member of staff could see the
 * whole programme, understand their part in it, and do their part without
 * leaving their portal.
 *
 * Two ideas run through the screen.
 *
 * The first is that competence is not the same as being rostered. Charting a
 * fridge is work anyone on duty does; accepting an IQC batch is a registered
 * scientist's; signing off a quarterly review is the supervisor's. Each
 * activity names its tier, the tier is a permission, and the "Done" control is
 * simply absent where the tier is not held — replaced by a line saying who does
 * perform it, because a technician is entitled to know their analyser is
 * serviced monthly even though they are not the one who services it.
 *
 * The second is that the programme belongs to the unit, not the person. So the
 * whole programme is shown, grouped the way a laboratory thinks about it, with
 * the reader's own part lifted to the top.
 */
const CATEGORY_ORDER: ActivityCategory[] = [
  'environmental', 'cleaning', 'equipment', 'quality_control',
  'reagent', 'stock', 'safety', 'records', 'handover', 'other',
];

const CATEGORY_TONE: Record<string, string> = {
  environmental: 'info', equipment: 'warn', quality_control: 'ok',
  reagent: 'info', stock: 'info', cleaning: 'ok', safety: 'crit',
  records: 'info', handover: 'warn', other: 'info',
};

const TIER_TONE: Record<string, string> = {
  general: 'general', technical: 'technical', supervisory: 'supervisory',
};

function TierBadge({ tier, may }: { tier: string; may: boolean }) {
  const t = (tier || 'general') as ActivityTier;
  return (
    <span className={`rw-tier t-${TIER_TONE[t] ?? 'general'}${may ? '' : ' is-locked'}`}
      title={`${TIER_LABELS[t] ?? t}. ${TIER_HINTS[t] ?? ''}`}>
      {!may && <Lock size={9} />} {TIER_SHORT[t] ?? t}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   One occurrence on my list, worked in place
   ------------------------------------------------------------------------- */
function OccurrenceRow({ occurrence, mayPerform, onWorked }: {
  occurrence: ActivityOccurrence;
  mayPerform: boolean;
  onWorked: () => void;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [note, setNote] = useState('');
  const [ease, setEase] = useState<number | null>(null);
  const [naReason, setNaReason] = useState('');
  const [showNa, setShowNa] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const o = occurrence;
  const open = o.status === 'pending' || o.status === 'in_progress';
  const tone = CATEGORY_TONE[o.category ?? 'other'] ?? 'info';

  async function run(action: string, body: Record<string, unknown>) {
    setBusy(action); setProblem(null);
    try {
      await api(`/duty/occurrences/${o.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      onWorked();
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <li className={`pt-row rw-row${o.status === 'missed' ? ' sev-crit' : ''}`}>
      <span className={`pt-rail ${tone}`} />
      <div className="pt-row-main static">
        <span className="pt-row-title">
          {o.activity_name}
          {o.redesign_status && o.redesign_status !== 'none' && (
            <span className="badge warning" title="Flagged to be simplified">being simplified</span>
          )}
        </span>
        <span className="pt-row-meta">
          <span className="badge">{CATEGORY_LABELS[(o.category ?? 'other') as ActivityCategory] ?? o.category}</span>
          <span>{frequencyPhrase(o.frequency ?? 'daily', o.interval_days ?? null)}</span>
          {o.estimated_minutes ? <span><Clock size={11} /> {o.estimated_minutes} min</span> : null}
          {o.bench_name && <span>{o.bench_name}</span>}
          <TierBadge tier={o.performer_tier ?? 'general'} may={mayPerform} />
          {o.status === 'missed' && <span className="badge overdue">Missed</span>}
          {o.status === 'in_progress' && <span className="badge in-progress">Started</span>}
          {(o.status === 'done' || o.status === 'not_applicable') && (
            <span className="badge done">{o.status === 'done' ? 'Done' : 'Not applicable'}{o.completed_by_name ? ` · ${o.completed_by_name}` : ''}</span>
          )}
        </span>
        {expanded && o.instructions && <p className="duty-instructions">{o.instructions}</p>}

        {expanded && open && mayPerform && (
          <div className="rw-expand">
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
          <div className="rw-expand">
            <label>
              <span>Why does this not apply today?</span>
              <input value={naReason} onChange={e => setNaReason(e.target.value)} autoFocus
                placeholder="Instrument out of service, unit closed…" />
            </label>
            <div className="pr-btns">
              <button type="button" disabled={!naReason.trim() || !!busy}
                onClick={() => void run('not-applicable', { reason: naReason.trim() }).then(() => setShowNa(false))}>
                Record it
              </button>
              <button type="button" className="secondary" onClick={() => setShowNa(false)}>Cancel</button>
            </div>
          </div>
        )}

        {!mayPerform && open && (
          <p className="rw-locked">
            <Lock size={11} /> {TIER_LABELS[(o.performer_tier ?? 'general') as ActivityTier]} performs this one.
            It is on your unit&rsquo;s list so you know it is due.
          </p>
        )}
        {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      </div>

      <div className="pt-row-side rw-side">
        {open && mayPerform && (
          <>
            <button type="button" className="duty-done" disabled={!!busy}
              onClick={() => void run('complete', { note: note.trim() || undefined, easeRating: ease ?? undefined })}>
              {busy === 'complete' ? <Loader2 size={15} className="pd-spin" /> : <CheckCircle2 size={15} />} Done
            </button>
            <div className="duty-side-links">
              {o.target_route && (
                <button type="button" className="pq-link" onClick={() => navigate(o.target_route!)}
                  title="Open where the reading or result is recorded">
                  Record it <ArrowRight size={12} />
                </button>
              )}
              <button type="button" className="pq-link" onClick={() => setExpanded(v => !v)}>{expanded ? 'Less' : 'Details'}</button>
              {o.status === 'pending' && <button type="button" className="pq-link" disabled={!!busy} onClick={() => void run('start', {})}>Start</button>}
              <button type="button" className="pq-link" onClick={() => setShowNa(true)}><SlashIcon size={11} /> N/A</button>
            </div>
          </>
        )}
        {open && !mayPerform && <span className="rw-watch"><Eye size={14} /> not yours</span>}
        {!open && <span className="duty-closed-mark"><CheckCircle2 size={15} /></span>}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------------------
   The unit's programme, grouped the way a laboratory thinks about it
   ------------------------------------------------------------------------- */
function ProgrammeGroup({ category, rows, onOpen }: {
  category: string; rows: RoutineActivity[]; onOpen: (a: RoutineActivity) => void;
}) {
  return (
    <div className="rw-group">
      <h4 className={`rw-group-head tone-${CATEGORY_TONE[category] ?? 'info'}`}>
        {CATEGORY_LABELS[category as ActivityCategory] ?? category}
        <span>{rows.length}</span>
      </h4>
      <ul className="rw-cards">
        {rows.map(a => (
          <li key={a.id} className={`rw-card${a.mayPerform ? '' : ' is-locked'}${a.open_occurrence_id ? ' is-due' : ''}`}>
            <div className="rw-card-top">
              <span className="rw-card-name">{a.name}</span>
              <TierBadge tier={a.performer_tier} may={a.mayPerform} />
            </div>
            <div className="rw-card-meta">
              <span><Repeat size={11} /> {frequencyPhrase(a.frequency, a.interval_days ?? null)}</span>
              {a.due_time && <span><Clock size={11} /> by {a.due_time}</span>}
              {a.bench_name && <span>{a.bench_name}</span>}
              {a.equipment_name && <span>{a.equipment_name}</span>}
            </div>
            {a.description && <p className="rw-card-desc">{a.description}</p>}
            <div className="rw-card-foot">
              {a.last_done_at
                ? <span className="rw-last">Last done {String(a.last_done_at).slice(0, 10)}{a.last_done_by ? ` · ${a.last_done_by}` : ''}</span>
                : <span className="rw-last none">No record of it being done yet</span>}
              {a.open_occurrence_id && a.mayPerform && (
                <button type="button" className="pt-open" onClick={() => onOpen(a)}>Due now <ArrowRight size={12} /></button>
              )}
              {!a.mayPerform && (
                <span className="rw-who" title={TIER_HINTS[a.performer_tier as ActivityTier]}>
                  {TIER_LABELS[a.performer_tier as ActivityTier]}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The face
   ------------------------------------------------------------------------- */
export default function PortalRoutineWork() {
  const { setError } = usePortal();
  const { refresh: refreshDuty } = useDutyReminders();
  const [data, setData] = useState<RoutineWorkResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  const load = useCallback(async () => {
    try { setData(await api<RoutineWorkResponse>('/duty/routine')); }
    catch (e) { setError(errorText(e)); }
    finally { setLoading(false); }
  }, [setError]);

  useEffect(() => { void load(); }, [load]);

  // The duty panel elsewhere in the portal reads the same work, so completing
  // something here has to refresh it too or the two disagree in front of the
  // person who just did the job.
  const onWorked = useCallback(() => { void load(); void refreshDuty(); }, [load, refreshDuty]);

  const tierOf = useCallback((tier?: string | null) => {
    const t = (tier || 'general') as ActivityTier;
    if (!data) return false;
    return t === 'supervisory' ? data.tiers.supervisory : t === 'technical' ? data.tiers.technical : data.tiers.general;
  }, [data]);

  const mine = data?.mine ?? [];
  const open = mine.filter(o => o.status === 'pending' || o.status === 'in_progress');
  const closed = mine.filter(o => o.status === 'done' || o.status === 'not_applicable' || o.status === 'missed');

  const grouped = useMemo(() => {
    const rows = (data?.programme ?? []).filter(a => filter === 'all' || a.category === filter);
    const map = new Map<string, RoutineActivity[]>();
    for (const a of rows) {
      const list = map.get(a.category) ?? [];
      list.push(a);
      map.set(a.category, list);
    }
    return CATEGORY_ORDER.filter(c => map.has(c)).map(c => ({ category: c, rows: map.get(c)! }));
  }, [data, filter]);

  const categoriesPresent = useMemo(() => {
    const set = new Set((data?.programme ?? []).map(a => a.category));
    return CATEGORY_ORDER.filter(c => set.has(c));
  }, [data]);

  const scrollToDue = (a: RoutineActivity) => {
    void a;
    document.querySelector('.rw-due-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (loading) return <div className="portal-loading">Reading your unit&rsquo;s routine programme…</div>;

  const unitName = data?.duty.sectionName;

  return (
    <div className="portal-stack">
      {/* What I am carrying right now */}
      <section className="portal-panel rw-due-panel">
        <div className="pp-head">
          <div>
            <h3><ClipboardCheck size={16} /> Due from me now</h3>
            <p>
              The recurring work of the bench that is on your list today — charting, decontamination,
              equipment care, controls. Done is one tap; nothing here sends you away to record it.
            </p>
          </div>
          {open.length > 0 && <span className="pp-count">{open.length}</span>}
        </div>

        {data && !data.duty.onDuty && (
          <p className="rw-note">
            <ShieldAlert size={13} /> You are not on the duty roster today
            {unitName ? ` for ${unitName}` : ''}, so nothing is assigned to you. Your unit&rsquo;s
            programme is below.
          </p>
        )}

        {data && data.counts.blocked > 0 && (
          <p className="pp-inline-warn">
            <AlertTriangle size={13} /> {data.counts.blocked === 1 ? 'One activity on your list needs' : `${data.counts.blocked} activities on your list need`} a
            tier you do not hold. Either the roster placed the wrong person or the activity&rsquo;s tier is
            set too high — tell your unit head, and the record stays honest either way.
          </p>
        )}

        {open.length === 0 ? (
          <div className="pp-clear">
            <Sparkles size={18} />
            <span>{mine.length === 0 ? 'Nothing routine is scheduled for you today.' : 'Everything routine on your list is done.'}</span>
          </div>
        ) : (
          <ul className="pt-list">
            {open.map(o => (
              <OccurrenceRow key={o.id} occurrence={o} mayPerform={tierOf(o.performer_tier)} onWorked={onWorked} />
            ))}
          </ul>
        )}

        {closed.length > 0 && (
          <>
            <div className="rw-subhead">Already dealt with today</div>
            <ul className="pt-list">
              {closed.map(o => (
                <OccurrenceRow key={o.id} occurrence={o} mayPerform={tierOf(o.performer_tier)} onWorked={onWorked} />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* The unit's whole programme */}
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><Repeat size={16} /> {unitName ? `${unitName} — the routine programme` : 'My unit’s routine programme'}</h3>
            <p>
              Everything this bench carries, how often it comes round, and who is competent to do it.
              The whole programme is shown, including work somebody else performs — knowing the
              analyser is serviced monthly is part of knowing your bench.
            </p>
          </div>
          {data && data.counts.programme > 0 && <span className="pp-count">{data.counts.programme}</span>}
        </div>

        {categoriesPresent.length > 1 && (
          <div className="pp-filters">
            <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
              Everything<span className="pp-filter-n">{data?.counts.programme ?? 0}</span>
            </button>
            {categoriesPresent.map(c => (
              <button key={c} type="button" className={filter === c ? 'active' : ''} onClick={() => setFilter(c)}>
                {CATEGORY_LABELS[c]}
                <span className="pp-filter-n">{(data?.programme ?? []).filter(a => a.category === c).length}</span>
              </button>
            ))}
          </div>
        )}

        {grouped.length === 0 ? (
          <p className="muted">
            {unitName
              ? `No routine activities have been set up for ${unitName} yet. A unit head or the quality office adds them under Settings → Unit Activities & Reminders.`
              : 'Your account is not linked to a unit, so there is no programme to show. Ask an administrator to link your staff record to your section.'}
          </p>
        ) : (
          <div className="rw-groups">
            {grouped.map(g => <ProgrammeGroup key={g.category} category={g.category} rows={g.rows} onOpen={scrollToDue} />)}
          </div>
        )}

        {data && (
          <div className="rw-legend">
            <span className="rw-legend-title">Who performs what</span>
            {(['general', 'technical', 'supervisory'] as ActivityTier[]).map(t => (
              <span key={t} className="rw-legend-row">
                <TierBadge tier={t} may={t === 'supervisory' ? data.tiers.supervisory : t === 'technical' ? data.tiers.technical : data.tiers.general} />
                <span>{TIER_LABELS[t]} — {TIER_HINTS[t]}</span>
              </span>
            ))}
            <span className="rw-legend-foot">
              A padlock means your access profile does not hold that tier. Who holds each tier is set
              per profile under Settings → People &amp; Access, and each activity&rsquo;s tier is set on the
              activity itself.
            </span>
          </div>
        )}
      </section>
    </div>
  );
}
