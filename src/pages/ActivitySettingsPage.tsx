import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, ClipboardList, Lightbulb, Play, Plus, RefreshCw,
  Sparkles, Volume2, Wand2,
} from 'lucide-react';
import { api } from '../services/api';
import { usePermissions } from '../hooks/usePermissions';
import { useFocusTarget, focusAttr } from '../hooks/useFocusTarget';
import { configureSound, playEvent, playSpec, primeAudio } from '../services/sound';
import {
  ACTIVITY_CATEGORIES, ACTIVITY_FREQUENCIES, ASSIGN_MODES, ASSIGN_MODE_LABELS,
  CATEGORY_LABELS, EASE_RATING_LABELS, FREQUENCY_LABELS, REDESIGN_STATUS_LABELS,
  REDESIGN_STATUSES, SOUND_EVENTS, SOUND_EVENT_LABELS, frequencyPhrase,
  type ActivityCategory, type ActivityFrequency, type AssignMode, type RedesignStatus, type SoundEvent,
} from '../../shared/constants/activities';
import type {
  NotificationSound, Section, SchedulingPolicy, SoundSettingsResponse, Staff, UnitActivity,
} from '../../shared/types/api';

/**
 * Unit Activities & Reminders — where the daily work of a unit is defined, and
 * where the laboratory decides how loudly the system asks for it.
 *
 * Four tabs, each answering one question:
 *
 *   Unit Activities    what recurring work exists, and who it lands on
 *   Simplification     which of it staff find hard, and what is being done
 *   Scheduling policy  when rosters are due, and what happens if they are not
 *   Reminder sounds    what the desktop and the phone actually play
 *
 * The Simplification tab is not an afterthought. The laboratory's own rule is
 * that staff comply with what is easy, so an activity people keep missing is
 * treated here as something to redesign, with the staff's own ease ratings as
 * the evidence — not as a list of people to chase.
 */
const TABS = ['Unit Activities', 'Simplification', 'Scheduling policy', 'Reminder sounds'];

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type Bench = { id: number; section_id: number; name: string; code: string | null; is_active: number };
type Proposal = {
  sourceKey: string; name: string; category: string; frequency: string;
  sectionId: number | null; sectionName: string | null; targetRoute: string;
  instructions: string; estimatedMinutes: number;
};

const BLANK_FORM = {
  activityCode: '', name: '', description: '', instructions: '',
  category: 'environmental' as ActivityCategory,
  sectionId: '', benchId: '', equipmentId: '',
  frequency: 'daily' as ActivityFrequency, intervalDays: '', dayOfMonth: '',
  weekdays: [] as number[],
  dueTime: '', assignMode: 'on_duty' as AssignMode, responsibleStaffId: '',
  priority: 'normal', estimatedMinutes: '', evidenceRequired: false,
  notifyLeadership: true, targetRoute: '', targetModuleKey: '',
};

/* ============================================================================
   Unit activities
   ========================================================================= */
function ActivityCatalogue({ sections, staff, onChanged }: { sections: Section[]; staff: Staff[]; onChanged: () => void }) {
  const { can } = usePermissions();
  const mayEdit = can('personnel.activities', 'edit');
  const mayCreate = can('personnel.activities', 'create');

  const [activities, setActivities] = useState<UnitActivity[]>([]);
  const [benches, setBenches] = useState<Bench[]>([]);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [form, setForm] = useState({ ...BLANK_FORM });
  const [editing, setEditing] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [filterSection, setFilterSection] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const params = filterSection ? `?sectionId=${filterSection}` : '';
      setActivities(await api<UnitActivity[]>(`/duty/activities${params}`));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [filterSection]);

  useEffect(() => { void load(); }, [load]);
  useFocusTarget(activities);

  // Benches are per unit, so the picker reloads when the unit changes.
  useEffect(() => {
    if (!form.sectionId) { setBenches([]); return; }
    api<Bench[]>(`/scheduling/sections/${form.sectionId}/benches`).then(setBenches).catch(() => setBenches([]));
  }, [form.sectionId]);

  function editActivity(activity: UnitActivity) {
    let weekdays: number[] = [];
    try { weekdays = activity.weekdays ? JSON.parse(activity.weekdays) : []; } catch { weekdays = []; }
    setForm({
      activityCode: activity.activity_code,
      name: activity.name,
      description: activity.description ?? '',
      instructions: activity.instructions ?? '',
      category: activity.category as ActivityCategory,
      sectionId: String(activity.section_id ?? ''),
      benchId: String(activity.bench_id ?? ''),
      equipmentId: String(activity.equipment_id ?? ''),
      frequency: activity.frequency as ActivityFrequency,
      intervalDays: String(activity.interval_days ?? ''),
      dayOfMonth: String(activity.day_of_month ?? ''),
      weekdays,
      dueTime: activity.due_time ?? '',
      assignMode: activity.assign_mode as AssignMode,
      responsibleStaffId: String(activity.responsible_staff_id ?? ''),
      priority: activity.priority,
      estimatedMinutes: String(activity.estimated_minutes ?? ''),
      evidenceRequired: activity.evidence_required === 1,
      notifyLeadership: activity.notify_leadership === 1,
      targetRoute: activity.target_route ?? '',
      targetModuleKey: activity.target_module_key ?? '',
    });
    setEditing(activity.id);
    setShowForm(true);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    const body = {
      ...form,
      sectionId: form.sectionId || null,
      benchId: form.benchId || null,
      equipmentId: form.equipmentId || null,
      responsibleStaffId: form.responsibleStaffId || null,
      intervalDays: form.intervalDays || null,
      dayOfMonth: form.dayOfMonth || null,
      estimatedMinutes: form.estimatedMinutes || null,
      weekdays: form.weekdays,
    };
    try {
      if (editing) {
        await api(`/duty/activities/${editing}`, { method: 'PUT', body: JSON.stringify(body) });
        setNotice('Activity updated. The lists rebuild on the next refresh.');
      } else {
        await api('/duty/activities', { method: 'POST', body: JSON.stringify(body) });
        setNotice('Activity added, and today\'s occurrences raised for whoever is on duty.');
      }
      setForm({ ...BLANK_FORM }); setEditing(null); setShowForm(false);
      await load(); onChanged();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function loadProposals() {
    setBusy(true); setError(null);
    try { setProposals(await api<Proposal[]>('/duty/activities-proposals')); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function adopt(sourceKeys: string[] | null) {
    setBusy(true); setError(null);
    try {
      const result = await api<{ created: number }>('/duty/activities-proposals/adopt', {
        method: 'POST', body: JSON.stringify(sourceKeys ? { sourceKeys } : {}),
      });
      setNotice(`${result.created} activit${result.created === 1 ? 'y' : 'ies'} created from your existing configuration.`);
      setProposals(null);
      await load(); onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  async function deactivate(activity: UnitActivity) {
    if (!confirm(`Stop scheduling "${activity.name}"? Completed records are kept.`)) return;
    try { await api(`/duty/activities/${activity.id}`, { method: 'DELETE' }); await load(); onChanged(); }
    catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <div className="card">
        <div className="di-head">
          <div>
            <h3><ClipboardList size={16} /> Unit activities</h3>
            <p>The recurring work each unit does. Each one lands on whoever the duty roster places in that unit — never on a fixed name unless you say so.</p>
          </div>
          <div className="head-actions">
            {mayCreate && <button type="button" className="secondary" onClick={() => void loadProposals()} disabled={busy}>
              <Wand2 size={15} /> Suggest from my configuration
            </button>}
            {mayCreate && <button type="button" onClick={() => { setForm({ ...BLANK_FORM }); setEditing(null); setShowForm(v => !v); }}>
              <Plus size={15} /> New activity
            </button>}
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {notice && <div className="notice-ok">{notice}</div>}

        {proposals && (
          <div className="proposal-box">
            <h4><Lightbulb size={15} /> Built from what you have already told the system</h4>
            {proposals.length === 0
              ? <p className="muted">Nothing new to suggest — every registered asset, instrument schedule and monitoring parameter already has an activity.</p>
              : <>
                <p className="muted">Your environmental assets, equipment maintenance programmes and monitoring parameters each imply an activity. Accept them and the bench sees them today.</p>
                <ul className="proposal-list">
                  {proposals.map(p => (
                    <li key={p.sourceKey}>
                      <strong>{p.name}</strong>
                      <span className="badge">{FREQUENCY_LABELS[p.frequency as ActivityFrequency] ?? p.frequency}</span>
                      {p.sectionName && <span className="badge">{p.sectionName}</span>}
                      <span className="muted">{p.instructions}</span>
                    </li>
                  ))}
                </ul>
                <div className="duty-actions">
                  <button type="button" disabled={busy} onClick={() => void adopt(null)}>Create all {proposals.length}</button>
                  <button type="button" className="secondary" onClick={() => setProposals(null)}>Not now</button>
                </div>
              </>}
          </div>
        )}

        {showForm && (
          <form className="form-grid activity-form" onSubmit={submit}>
            <label>Name<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="Morning fridge temperature chart" /></label>
            <label>Code<input value={form.activityCode} onChange={e => setForm({ ...form, activityCode: e.target.value })} placeholder="auto" disabled={Boolean(editing)} /></label>
            <label>Kind of work
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value as ActivityCategory })}>
                {ACTIVITY_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
              </select>
            </label>
            <label>Unit
              <select value={form.sectionId} onChange={e => setForm({ ...form, sectionId: e.target.value, benchId: '' })}>
                <option value="">Choose a unit…</option>
                {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>How often
              <select value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value as ActivityFrequency })}>
                {ACTIVITY_FREQUENCIES.map(f => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
              </select>
            </label>
            {form.frequency === 'custom_days' && (
              <label>Every N days<input type="number" min={1} value={form.intervalDays} onChange={e => setForm({ ...form, intervalDays: e.target.value })} /></label>
            )}
            {['monthly', 'quarterly', 'biannual', 'annual'].includes(form.frequency) && (
              <label>Day of the month<input type="number" min={1} max={31} value={form.dayOfMonth} onChange={e => setForm({ ...form, dayOfMonth: e.target.value })} placeholder="1" /></label>
            )}
            {['daily', 'per_shift', 'weekly', 'fortnightly'].includes(form.frequency) && (
              <label className="wide">Days
                <div className="weekday-picker">
                  {WEEKDAY_NAMES.map((name, index) => (
                    <button key={name} type="button"
                      className={form.weekdays.includes(index) ? 'on' : ''}
                      onClick={() => setForm({
                        ...form,
                        weekdays: form.weekdays.includes(index)
                          ? form.weekdays.filter(d => d !== index)
                          : [...form.weekdays, index].sort(),
                      })}>{name.slice(0, 3)}</button>
                  ))}
                  <span className="muted">{form.weekdays.length ? '' : form.frequency === 'weekly' || form.frequency === 'fortnightly' ? 'Defaults to Monday' : 'Every day'}</span>
                </div>
              </label>
            )}
            <label>Who does it
              <select value={form.assignMode} onChange={e => setForm({ ...form, assignMode: e.target.value as AssignMode })}>
                {ASSIGN_MODES.map(m => <option key={m} value={m}>{ASSIGN_MODE_LABELS[m]}</option>)}
              </select>
            </label>
            {form.assignMode === 'bench' && (
              <label>Bench
                <select value={form.benchId} onChange={e => setForm({ ...form, benchId: e.target.value })}>
                  <option value="">Choose a bench…</option>
                  {benches.filter(b => b.is_active).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            )}
            {form.assignMode === 'named_staff' && (
              <label>Member of staff
                <select value={form.responsibleStaffId} onChange={e => setForm({ ...form, responsibleStaffId: e.target.value })}>
                  <option value="">Choose…</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                </select>
              </label>
            )}
            <label>Due by (time)<input type="time" value={form.dueTime} onChange={e => setForm({ ...form, dueTime: e.target.value })} /></label>
            <label>Takes about (min)<input type="number" min={1} value={form.estimatedMinutes} onChange={e => setForm({ ...form, estimatedMinutes: e.target.value })} placeholder="3" /></label>
            <label>Priority
              <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                <option value="low">Low</option><option value="normal">Normal</option>
                <option value="high">High</option><option value="critical">Critical</option>
              </select>
            </label>
            <label className="wide">How to do it (shown on the to-do)
              <input value={form.instructions} onChange={e => setForm({ ...form, instructions: e.target.value })}
                placeholder="Read and chart the temperature; record any corrective action." />
            </label>
            <label className="wide">Where it is recorded (link)
              <input value={form.targetRoute} onChange={e => setForm({ ...form, targetRoute: e.target.value })}
                placeholder="/monitoring?tab=Enter%20Reading" />
            </label>
            <label className="inline"><input type="checkbox" checked={form.notifyLeadership} onChange={e => setForm({ ...form, notifyLeadership: e.target.checked })} />
              <span>Show it to the unit head and managers as oversight</span></label>
            <label className="inline"><input type="checkbox" checked={form.evidenceRequired} onChange={e => setForm({ ...form, evidenceRequired: e.target.checked })} />
              <span>Evidence expected on completion</span></label>
            <div className="duty-actions">
              <button type="submit" disabled={busy}>{editing ? 'Save changes' : 'Create activity'}</button>
              <button type="button" className="secondary" onClick={() => { setShowForm(false); setEditing(null); setForm({ ...BLANK_FORM }); }}>Cancel</button>
            </div>
          </form>
        )}

        <div className="filters">
          <label><span>Unit</span>
            <select value={filterSection} onChange={e => setFilterSection(e.target.value)}>
              <option value="">All units</option>
              {sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>

        {activities.length === 0
          ? <div className="di-clear"><Sparkles size={18} /><span>No activities yet. &ldquo;Suggest from my configuration&rdquo; builds a starter set from the assets and instruments you have already registered.</span></div>
          : <table className="data-table">
            <thead><tr><th>Activity</th><th>Unit</th><th>How often</th><th>Who</th><th>Record</th><th>Ease</th><th /></tr></thead>
            <tbody>
              {activities.map(a => {
                const total = Number(a.missed_count ?? 0) + Number((a as { done_count?: number }).done_count ?? 0);
                const missRate = total ? Math.round((Number(a.missed_count ?? 0) / total) * 100) : null;
                return (
                  <tr key={a.id} {...focusAttr('unit_activities', a.id)}>
                    <td>
                      <strong>{a.name}</strong>
                      {a.redesign_status !== 'none' && <span className="badge in-progress">{REDESIGN_STATUS_LABELS[a.redesign_status as RedesignStatus]}</span>}
                      {a.instructions && <div className="muted">{a.instructions}</div>}
                    </td>
                    <td>{a.section_name ?? <span className="muted">—</span>}</td>
                    <td>{frequencyPhrase(a.frequency, a.interval_days)}{a.due_time ? <div className="muted">by {a.due_time}</div> : null}</td>
                    <td>{ASSIGN_MODE_LABELS[a.assign_mode as AssignMode] ?? a.assign_mode}{a.bench_name ? <div className="muted">{a.bench_name}</div> : null}</td>
                    <td>{missRate === null ? <span className="muted">no history</span>
                      : <span className={`badge ${missRate >= 40 ? 'overdue' : missRate > 0 ? 'warning' : 'done'}`}>{100 - missRate}% done</span>}</td>
                    <td>{a.avg_ease ? `${Number(a.avg_ease).toFixed(1)} / 5` : <span className="muted">—</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {mayEdit && <button type="button" className="pq-link" onClick={() => editActivity(a)}>Edit</button>}
                      {can('personnel.activities', 'void_archive') && <button type="button" className="pq-link" onClick={() => void deactivate(a)}>Stop</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>}
      </div>
    </>
  );
}

/* ============================================================================
   Simplification — the redesign programme
   ========================================================================= */
function Simplification({ onChanged }: { onChanged: () => void }) {
  const { can } = usePermissions();
  const mayEdit = can('personnel.activities', 'edit');
  const [activities, setActivities] = useState<UnitActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; status: RedesignStatus; note: string; rating: number | null } | null>(null);

  const load = useCallback(async () => {
    try { setActivities(await api<UnitActivity[]>('/duty/activities')); setError(null); }
    catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useFocusTarget(activities);

  async function saveFlag() {
    if (!editing) return;
    try {
      await api(`/duty/activities/${editing.id}/redesign`, {
        method: 'POST',
        body: JSON.stringify({ status: editing.status, note: editing.note, simplicityRating: editing.rating }),
      });
      setNotice('Flag updated.');
      setEditing(null);
      await load(); onChanged();
    } catch (e) { setError((e as Error).message); }
  }

  // Hardest first: the ones with the worst completion rate and the worst
  // ratings, because those are the ones a redesign actually buys something on.
  const ranked = useMemo(() => [...activities].map(a => {
    const missed = Number(a.missed_count ?? 0);
    const done = Number((a as { done_count?: number }).done_count ?? 0);
    const total = missed + done;
    const missRate = total ? missed / total : 0;
    const ease = a.avg_ease === null || a.avg_ease === undefined ? null : Number(a.avg_ease);
    // A simple friction score: how often it fails, and how hard people say it is.
    const friction = missRate * 100 + (ease !== null ? (5 - ease) * 12 : 0);
    return { activity: a, missed, done, total, missRate, ease, friction };
  }).sort((a, b) => b.friction - a.friction), [activities]);

  const flagged = ranked.filter(r => r.activity.redesign_status !== 'none');
  const candidates = ranked.filter(r => r.activity.redesign_status === 'none' && (r.missRate >= 0.25 || (r.ease !== null && r.ease <= 3)));

  return (
    <>
      <div className="card">
        <h3><Lightbulb size={16} /> Make it easy and it gets done</h3>
        <p>
          Staff comply with what is simple. An activity that keeps being missed is usually awkward to perform or awkward to record,
          so it is treated here as a design problem to fix rather than a discipline problem to chase. Flag anything that needs
          redesigning; the flag travels with the activity so everybody working on it can see it is being simplified.
        </p>
        {error && <div className="error">{error}</div>}
        {notice && <div className="notice-ok">{notice}</div>}
      </div>

      <div className="card">
        <h3>Flagged for redesign</h3>
        {flagged.length === 0
          ? <p className="muted">Nothing is flagged. Anything below can be flagged in one click.</p>
          : <table className="data-table">
            <thead><tr><th>Activity</th><th>Status</th><th>Why</th><th>Ease</th><th /></tr></thead>
            <tbody>
              {flagged.map(({ activity, ease }) => (
                <tr key={activity.id} {...focusAttr('unit_activities', activity.id)}>
                  <td><strong>{activity.name}</strong><div className="muted">{activity.section_name}</div></td>
                  <td><span className="badge in-progress">{REDESIGN_STATUS_LABELS[activity.redesign_status as RedesignStatus]}</span></td>
                  <td>{activity.redesign_note || <span className="muted">no note</span>}</td>
                  <td>{ease !== null ? `${ease.toFixed(1)} / 5` : <span className="muted">—</span>}</td>
                  <td>{mayEdit && <button type="button" className="pq-link"
                    onClick={() => setEditing({ id: activity.id, status: activity.redesign_status as RedesignStatus, note: activity.redesign_note ?? '', rating: activity.simplicity_rating ?? null })}>
                    Update</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      <div className="card">
        <h3><AlertTriangle size={15} /> Worth simplifying</h3>
        {candidates.length === 0
          ? <div className="di-clear"><CheckCircle2 size={18} /><span>Nothing is showing signs of friction. Every activity is being completed, and staff are not reporting difficulty.</span></div>
          : <table className="data-table">
            <thead><tr><th>Activity</th><th>Unit</th><th>Completed</th><th>Staff rate it</th><th /></tr></thead>
            <tbody>
              {candidates.map(({ activity, missRate, ease, total }) => (
                <tr key={activity.id} {...focusAttr('unit_activities', activity.id)}>
                  <td><strong>{activity.name}</strong><div className="muted">{frequencyPhrase(activity.frequency, activity.interval_days)}</div></td>
                  <td>{activity.section_name}</td>
                  <td>
                    <span className={`badge ${missRate >= 0.4 ? 'overdue' : 'warning'}`}>{Math.round((1 - missRate) * 100)}%</span>
                    <div className="muted">of {total} occurrences</div>
                  </td>
                  <td>{ease !== null ? <>{ease.toFixed(1)} / 5<div className="muted">{EASE_RATING_LABELS[Math.round(ease)]}</div></> : <span className="muted">not rated yet</span>}</td>
                  <td>{mayEdit && <button type="button" className="pq-link"
                    onClick={() => setEditing({ id: activity.id, status: 'flagged', note: '', rating: ease ? Math.round(ease) : null })}>
                    Flag for redesign</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>}
      </div>

      {editing && (
        <div className="briefing-backdrop" role="dialog" aria-modal="true">
          <div className="card briefing" style={{ maxWidth: 520 }}>
            <h3>Flag for redesign</h3>
            <div className="form-grid">
              <label>Status
                <select value={editing.status} onChange={e => setEditing({ ...editing, status: e.target.value as RedesignStatus })}>
                  {REDESIGN_STATUSES.map(s => <option key={s} value={s}>{REDESIGN_STATUS_LABELS[s]}</option>)}
                </select>
              </label>
              <label>How simple is it now?
                <select value={editing.rating ?? ''} onChange={e => setEditing({ ...editing, rating: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Not rated</option>
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} — {EASE_RATING_LABELS[n]}</option>)}
                </select>
              </label>
              <label className="wide">What needs to change?
                <input value={editing.note} onChange={e => setEditing({ ...editing, note: e.target.value })}
                  placeholder="Too many fields; combine the chart and the corrective action into one screen" />
              </label>
            </div>
            <div className="duty-actions">
              <button type="button" onClick={() => void saveFlag()}>Save</button>
              <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ============================================================================
   Scheduling policy
   ========================================================================= */
function SchedulingPolicyTab() {
  const { can } = usePermissions();
  const mayEdit = can('settings', 'edit');
  const [policy, setPolicy] = useState<SchedulingPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api<SchedulingPolicy>('/duty/policy').then(setPolicy).catch(e => setError((e as Error).message)); }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!policy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await api<SchedulingPolicy>('/duty/policy', {
        method: 'PUT',
        body: JSON.stringify({
          rosterDueDaysBefore: policy.roster_due_days_before,
          reassignmentDueDaysBefore: policy.reassignment_due_days_before,
          benchDueDaysBefore: policy.bench_due_days_before,
          reminderLeadDays: policy.reminder_lead_days,
          autoCarryForward: policy.auto_carry_forward === 1,
          benchInheritGaps: policy.bench_inherit_gaps === 1,
          activityGenerationDays: policy.activity_generation_days,
          missedGraceHours: policy.missed_grace_hours,
          notifyLeadershipDaily: policy.notify_leadership_daily === 1,
          briefingHour: policy.briefing_hour,
        }),
      });
      setPolicy(saved); setNotice('Policy saved.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function runTick() {
    setBusy(true); setError(null);
    try {
      await api('/duty/run-tick', { method: 'POST', body: JSON.stringify({}) });
      setNotice('Schedules carried forward where needed, and today\'s activity lists rebuilt.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  if (!policy) return <div className="card">{error ? <p className="form-error">{error}</p> : 'Loading…'}</div>;
  const num = (key: keyof SchedulingPolicy) => (e: { target: { value: string } }) => setPolicy({ ...policy, [key]: Number(e.target.value) } as SchedulingPolicy);
  const flag = (key: keyof SchedulingPolicy) => (e: { target: { checked: boolean } }) => setPolicy({ ...policy, [key]: e.target.checked ? 1 : 0 } as SchedulingPolicy);

  return (
    <div className="card">
      <h3>Scheduling policy</h3>
      <p>
        When each schedule must exist, and what the system does when it does not. The duty roster and unit reassignment belong to the
        laboratory manager and quality manager; the bench schedules belong to the unit heads and are due later, because they follow
        the unit assignments rather than preceding them.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}

      <form className="form-grid" onSubmit={save}>
        <label>Duty roster due (days before the month starts)
          <input type="number" min={0} max={60} value={policy.roster_due_days_before} onChange={num('roster_due_days_before')} disabled={!mayEdit} /></label>
        <label>Unit reassignment due (days before)
          <input type="number" min={0} max={60} value={policy.reassignment_due_days_before} onChange={num('reassignment_due_days_before')} disabled={!mayEdit} /></label>
        <label>Bench schedules due (days before)
          <input type="number" min={0} max={60} value={policy.bench_due_days_before} onChange={num('bench_due_days_before')} disabled={!mayEdit} /></label>
        <label>Start reminding (days before the deadline)
          <input type="number" min={1} max={60} value={policy.reminder_lead_days} onChange={num('reminder_lead_days')} disabled={!mayEdit} /></label>
        <label>Raise activities this far ahead (days)
          <input type="number" min={1} max={90} value={policy.activity_generation_days} onChange={num('activity_generation_days')} disabled={!mayEdit} /></label>
        <label>Grace before an activity counts as missed (hours)
          <input type="number" min={0} max={48} value={policy.missed_grace_hours} onChange={num('missed_grace_hours')} disabled={!mayEdit} /></label>

        <label className="inline"><input type="checkbox" checked={policy.auto_carry_forward === 1} onChange={flag('auto_carry_forward')} disabled={!mayEdit} />
          <span>If a month starts without a schedule, carry the previous month&rsquo;s forward automatically</span></label>
        <label className="inline"><input type="checkbox" checked={policy.bench_inherit_gaps === 1} onChange={flag('bench_inherit_gaps')} disabled={!mayEdit} />
          <span>When benches are carried forward, place newly assigned staff into the benches that leavers vacated</span></label>
        <label className="inline"><input type="checkbox" checked={policy.notify_leadership_daily === 1} onChange={flag('notify_leadership_daily')} disabled={!mayEdit} />
          <span>Show unit activities to the unit head and managers as oversight</span></label>

        {mayEdit && (
          <div className="duty-actions">
            <button type="submit" disabled={busy}>Save policy</button>
            <button type="button" className="secondary" onClick={() => void runTick()} disabled={busy}>
              {busy ? <RefreshCw size={14} className="spin" /> : <Play size={14} />} Apply now
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

/* ============================================================================
   Reminder sounds
   ========================================================================= */
function ReminderSounds() {
  const { can } = usePermissions();
  const mayEditLaboratory = can('settings', 'edit');
  const [data, setData] = useState<SoundSettingsResponse | null>(null);
  const [scope, setScope] = useState<'user' | 'laboratory'>('user');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await api<SoundSettingsResponse & { builtins?: unknown }>('/duty/sound-settings');
      setData(payload);
      const base = scope === 'laboratory' ? payload.laboratory : (payload.user ?? payload.effective);
      setDraft({ ...base });
      configureSound({ sounds: payload.sounds as Array<{ sound_key: string; tone_spec?: string | null }> });
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, [scope]);

  useEffect(() => { primeAudio(); void load(); }, [load]);

  const sounds: NotificationSound[] = data?.sounds ?? [];

  function preview(soundKey: string) {
    primeAudio();
    const sound = sounds.find(s => s.sound_key === soundKey);
    if (sound?.tone_spec) {
      try { playSpec(JSON.parse(sound.tone_spec), Number(draft.volume ?? 0.7)); return; } catch { /* fall through */ }
    }
    playEvent('todo', { force: true });
  }

  async function save() {
    setError(null); setNotice(null);
    const body = {
      enabled: draft.enabled !== 0,
      volume: Number(draft.volume ?? 0.7),
      desktopEnabled: draft.desktop_enabled !== 0,
      mobileEnabled: draft.mobile_enabled !== 0,
      repeatCount: Number(draft.repeat_count ?? 1),
      quietHoursStart: draft.quiet_hours_start ?? '',
      quietHoursEnd: draft.quiet_hours_end ?? '',
      dailyBriefingEnabled: draft.daily_briefing_enabled !== 0,
      soundTodo: draft.sound_todo, soundReminder: draft.sound_reminder,
      soundOverdue: draft.sound_overdue, soundCritical: draft.sound_critical,
      soundSchedule: draft.sound_schedule, soundBriefing: draft.sound_briefing,
    };
    try {
      await api(scope === 'laboratory' ? '/duty/sound-settings/laboratory' : '/duty/sound-settings',
        { method: 'PUT', body: JSON.stringify(body) });
      setNotice(scope === 'laboratory' ? 'Laboratory default saved. It applies to everyone who has not set their own.' : 'Your sounds are saved.');
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function resetMine() {
    try { await api('/duty/sound-settings', { method: 'DELETE' }); setNotice('Your override is cleared — you follow the laboratory default again.'); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  if (!data) return <div className="card">{error ? <p className="form-error">{error}</p> : 'Loading…'}</div>;

  return (
    <div className="card">
      <div className="di-head">
        <div>
          <h3><Volume2 size={16} /> Reminder sounds</h3>
          <p>What the desktop app and the phone play when work lands on your list. Sounds are generated on the device, so they work offline and sound the same everywhere.</p>
        </div>
        {mayEditLaboratory && (
          <div className="head-actions">
            <button type="button" className={scope === 'user' ? '' : 'secondary'} onClick={() => setScope('user')}>My sounds</button>
            <button type="button" className={scope === 'laboratory' ? '' : 'secondary'} onClick={() => setScope('laboratory')}>Laboratory default</button>
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice-ok">{notice}</div>}
      {scope === 'user' && !data.user && <p className="muted">You are currently following the laboratory default. Changing anything here creates your own settings.</p>}

      <div className="form-grid">
        <label className="inline"><input type="checkbox" checked={draft.enabled !== 0} onChange={e => setDraft({ ...draft, enabled: e.target.checked ? 1 : 0 })} />
          <span>Play sounds at all</span></label>
        <label className="inline"><input type="checkbox" checked={draft.desktop_enabled !== 0} onChange={e => setDraft({ ...draft, desktop_enabled: e.target.checked ? 1 : 0 })} />
          <span>On the desktop app</span></label>
        <label className="inline"><input type="checkbox" checked={draft.mobile_enabled !== 0} onChange={e => setDraft({ ...draft, mobile_enabled: e.target.checked ? 1 : 0 })} />
          <span>On the mobile app</span></label>
        <label className="inline"><input type="checkbox" checked={draft.daily_briefing_enabled !== 0} onChange={e => setDraft({ ...draft, daily_briefing_enabled: e.target.checked ? 1 : 0 })} />
          <span>Show the start-of-day briefing</span></label>
        <label>Volume
          <input type="range" min={0} max={1} step={0.05} value={Number(draft.volume ?? 0.7)}
            onChange={e => setDraft({ ...draft, volume: Number(e.target.value) })} />
          <span className="muted">{Math.round(Number(draft.volume ?? 0.7) * 100)}%</span>
        </label>
        <label>Ring this many times
          <input type="number" min={1} max={5} value={Number(draft.repeat_count ?? 1)} onChange={e => setDraft({ ...draft, repeat_count: Number(e.target.value) })} /></label>
        <label>Quiet from
          <input type="time" value={String(draft.quiet_hours_start ?? '')} onChange={e => setDraft({ ...draft, quiet_hours_start: e.target.value })} /></label>
        <label>Quiet until
          <input type="time" value={String(draft.quiet_hours_end ?? '')} onChange={e => setDraft({ ...draft, quiet_hours_end: e.target.value })} /></label>
      </div>
      <p className="muted">Quiet hours silence everything except a critical alert — a failing freezer still makes a noise at three in the morning.</p>

      <table className="data-table">
        <thead><tr><th>When</th><th>Sound</th><th /></tr></thead>
        <tbody>
          {SOUND_EVENTS.map(event => {
            const key = `sound_${event}`;
            return (
              <tr key={event}>
                <td>{SOUND_EVENT_LABELS[event as SoundEvent]}</td>
                <td>
                  <select value={String(draft[key] ?? '')} onChange={e => setDraft({ ...draft, [key]: e.target.value })}>
                    {sounds.map(s => <option key={s.sound_key} value={s.sound_key}>{s.label}</option>)}
                  </select>
                </td>
                <td><button type="button" className="pq-link" onClick={() => preview(String(draft[key] ?? 'chime_soft'))}>
                  <Play size={12} /> Hear it</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="duty-actions">
        <button type="button" onClick={() => void save()}>Save {scope === 'laboratory' ? 'laboratory default' : 'my sounds'}</button>
        {scope === 'user' && data.user && <button type="button" className="secondary" onClick={() => void resetMine()}>Follow the laboratory default</button>}
      </div>
    </div>
  );
}

/* ============================================================================
   The page
   ========================================================================= */
export function ActivitySettingsPage() {
  const [tab, setTab] = useState(TABS[0]);
  const [sections, setSections] = useState<Section[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
  }, []);

  return (
    <div>
      <div className="card">
        <h3>Unit Activities &amp; Reminders</h3>
        <p>
          Everything a unit is supposed to do on a repeating basis — environmental charting, equipment checks, controls, reagent changes,
          cleaning — defined once here and then placed, every day, on whoever the duty roster puts in that unit. Leadership sees the same
          list as oversight; the to-do itself stays with the people on duty.
        </p>
      </div>

      <div className="tabs">
        {TABS.map(name => (
          <button key={name} type="button" className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>

      {tab === 'Unit Activities' && <ActivityCatalogue sections={sections} staff={staff} onChanged={() => setVersion(v => v + 1)} />}
      {tab === 'Simplification' && <Simplification key={version} onChanged={() => setVersion(v => v + 1)} />}
      {tab === 'Scheduling policy' && <SchedulingPolicyTab />}
      {tab === 'Reminder sounds' && <ReminderSounds />}
    </div>
  );
}
