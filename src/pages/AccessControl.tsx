import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePermissions } from '../hooks/usePermissions';
import { Search, ShieldCheck, User, Users, Briefcase, RotateCcw, Info, History, BadgeCheck, ChevronDown, ChevronRight } from 'lucide-react';
import { api, errorText } from '../services/api';
import { MODULES, PERMISSION_ACTIONS } from '../../shared/constants/modules';
import {
  FEATURES, ACCESS_LEVELS, LEVEL_LABELS, LEVEL_HINTS, LEVEL_ACTIONS,
  levelForActions, featuresOfModule, type AccessLevel,
} from '../../shared/constants/features';
import type {
  ApiUser, AccessCatalogue, AccessProfilePosition, EffectiveAccess,
  PermissionMatrixData, TechnicalAuthorizationRow,
} from '../../shared/types/api';

/* ============================================================================
   ACCESS CONTROL — one model, two layers

   This screen used to be four. A Role tab, a Position tab, an Individual tab
   and an "Advanced Matrix" of raw checkboxes, each writing to a different
   table, all of them additive, none of them able to say what a person could
   actually do. A role set to "no access" was quietly re-opened by a position
   grant or a technical authorization, which is how staff ended up inside
   workspaces nobody meant to give them.

   There are now two things, and they are ordered:

     ACCESS PROFILES  the single cohort decision. Every user resolves to
                      exactly one profile, so two cohorts cannot contradict
                      each other. Organogram positions no longer carry
                      permissions of their own — a position is MAPPED to a
                      profile, and that mapping is managed here, in the same
                      place, so the merge is complete rather than cosmetic.

     INDIVIDUALS      one person, superseding their profile. This is the only
                      thing that overrules a profile, and it always wins —
                      to grant or to withdraw.

   The Advanced Matrix is folded in rather than deleted: every area row
   expands to show the exact actions its level allows, and the change history
   and technical-authorization register it used to hold are panels at the
   bottom of the profiles tab.

   One question per area, not seven checkboxes: how much access does this need?
   Anything set to "No access" is hidden entirely — not greyed out, not shown
   with a refusal after the click.
   ========================================================================= */

type Tab = 'profiles' | 'individuals';

const MODULE_LABEL = new Map(MODULES.map(m => [m.key, m.label]));

/** Areas a permission can be granted on: every feature, plus every module that
 *  was never split into features (so nothing becomes ungrantable). */
type Area = { key: string; label: string; desc: string; sensitive?: boolean; personal?: boolean };
const AREAS_BY_MODULE: { module: string; label: string; areas: Area[] }[] = MODULES
  .filter(m => !['home', 'dashboard'].includes(m.key))
  .map(m => {
    const features = featuresOfModule(m.key);
    return {
      module: m.key,
      label: m.label,
      areas: features.length
        ? features.map(f => ({ key: f.key, label: f.label, desc: f.desc, sensitive: f.sensitive, personal: f.personal }))
        : [{ key: m.key, label: m.label, desc: `The whole ${m.label} workspace.` }],
    };
  })
  .filter(g => g.areas.length > 0);

const ALL_AREAS = AREAS_BY_MODULE.flatMap(g => g.areas);
const AREA_LABEL = new Map<string, string>([
  ...FEATURES.map(f => [f.key, f.label] as [string, string]),
  ...MODULES.map(m => [m.key, m.label] as [string, string]),
]);

/** `inherit` only exists for a person: it removes their personal decision. */
type PickerLevel = AccessLevel | 'inherit';

function LevelPicker({ value, onChange, disabled, withInherit }: {
  value: PickerLevel; onChange: (l: PickerLevel) => void; disabled?: boolean; withInherit?: boolean;
}) {
  const options: PickerLevel[] = withInherit ? ['inherit', ...ACCESS_LEVELS] : [...ACCESS_LEVELS];
  return (
    <div className={`lvl-picker lvl-${value}`} role="group" aria-label="Access level">
      {options.map(l => (
        <button
          key={l}
          type="button"
          disabled={disabled}
          className={value === l ? 'active' : ''}
          title={l === 'inherit' ? 'Follow the access profile — no personal decision recorded.' : LEVEL_HINTS[l]}
          onClick={() => onChange(l)}
        >
          {l === 'inherit' ? 'Follow profile' : LEVEL_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

/* ==========================================================================
   Shared area list
   --------------------------------------------------------------------------
   Both tabs ask the same question of the same areas; only what a row shows
   beside the picker differs. Keeping one list means the two tabs can never
   drift into describing access differently.
   ========================================================================= */
function AreaList({
  levelOf, onSet, onBulk, busy, query, note, extra, withInherit,
}: {
  levelOf: (areaKey: string) => PickerLevel;
  onSet: (areaKey: string, level: PickerLevel) => void;
  onBulk?: (moduleKey: string, level: AccessLevel) => void;
  busy: string | null;
  query: string;
  note?: (areaKey: string) => React.ReactNode;
  extra?: (areaKey: string) => React.ReactNode;
  withInherit?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const groups = AREAS_BY_MODULE
    .map(g => ({ ...g, areas: g.areas.filter(a => !q || a.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)) }))
    .filter(g => g.areas.length > 0);

  if (groups.length === 0) {
    return (
      <div className="card"><div className="empty-state"><span className="es-ico"><Info size={24} /></span>
        <h3>No areas match “{query}”</h3><p>Try a different word, or clear the search.</p></div></div>
    );
  }

  return <>
    {groups.map(group => (
      <div key={group.module} className="ac-group">
        <div className="ac-group-head">
          <h4>{group.label}</h4>
          {onBulk && (
            <div className="ac-group-bulk">
              <span className="muted">Set all:</span>
              {(['none', 'view', 'manage'] as AccessLevel[]).map(l => (
                <button key={l} type="button" className="secondary" disabled={busy === group.module}
                  onClick={() => onBulk(group.module, l)}>
                  {LEVEL_LABELS[l]}
                </button>
              ))}
            </div>
          )}
        </div>

        <ul className="ac-list">
          {group.areas.map(area => {
            const level = levelOf(area.key);
            const shown: AccessLevel = level === 'inherit' ? 'none' : level;
            const open = expanded === area.key;
            return (
              <li key={area.key} className={`ac-row${area.sensitive ? ' sensitive' : ''}`}>
                <div className="ac-row-main">
                  <div className="ac-row-title">
                    {area.label}
                    {area.sensitive && <span className="ac-tag warn" title="Confidential or laboratory-defining">Sensitive</span>}
                    {area.personal && <span className="ac-tag" title="Everyone always reaches their own record here; this level controls what they see of other people's">Personal data</span>}
                    {note?.(area.key)}
                  </div>
                  <p>{area.desc}</p>
                  {/* The Advanced Matrix, folded in: the exact actions the
                      chosen level allows, on request rather than as a grid of
                      hundreds of checkboxes nobody could review. */}
                  <button type="button" className="ac-advanced-toggle" onClick={() => setExpanded(open ? null : area.key)}>
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {open ? 'Hide' : 'Show'} exact actions
                  </button>
                  {open && (
                    <div className="ac-advanced">
                      {PERMISSION_ACTIONS.map(action => {
                        const on = level !== 'inherit' && LEVEL_ACTIONS[shown].includes(action);
                        return (
                          <span key={action} className={`ac-act ${on ? 'on' : 'off'}`} title={on ? `Allowed: ${action}` : `Not allowed: ${action}`}>
                            {action.replace('_', ' / ')}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {extra?.(area.key)}
                </div>
                <div className="ac-row-control">
                  <LevelPicker value={level} disabled={busy === area.key} withInherit={withInherit}
                    onChange={l => onSet(area.key, l)} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    ))}
  </>;
}

/* ==========================================================================
   Tab 1 — Access profiles (roles, positions and the advanced matrix, merged)
   ========================================================================= */
function ProfilesTab({ catalogue, reload }: { catalogue: AccessCatalogue | null; reload: () => Promise<void> }) {
  const { can } = usePermissions();
  const [profileId, setProfileId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reference, setReference] = useState<PermissionMatrixData | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [newProfile, setNewProfile] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    api<PermissionMatrixData>('/permissions/matrix').then(setReference).catch(() => setReference(null));
  }, []);

  const profiles = catalogue?.profiles ?? [];
  useEffect(() => {
    if (profiles.length && !profiles.some(p => p.id === profileId)) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  const held = useMemo(
    () => (profileId === null ? {} : catalogue?.roles?.[String(profileId)] ?? {}),
    [catalogue, profileId],
  );
  const levelOf = useCallback((areaKey: string): AccessLevel => levelForActions(held[areaKey] ?? []), [held]);

  const profile = profiles.find(p => p.id === profileId);
  const isAdminProfile = Number(profile?.isAdministrator) === 1;

  const positionsHere: AccessProfilePosition[] = (catalogue?.positions ?? []).filter(p => p.isActive !== 0);
  const mappedHere = positionsHere.filter(p => p.accessProfileId === profileId);
  const unmapped = positionsHere.filter(p => p.accessProfileId === null && p.holderCount > 0);

  async function setLevel(areaKey: string, level: PickerLevel) {
    if (level === 'inherit' || profileId === null) return;
    setBusy(areaKey); setError(null); setNotice(null);
    try {
      await api('/permissions/level', { method: 'POST', body: JSON.stringify({ scope: 'profile', subjectId: profileId, permKey: areaKey, level }) });
      await reload();
      setNotice(`${LEVEL_LABELS[level]} set for “${AREA_LABEL.get(areaKey) ?? areaKey}”.`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function applyModule(moduleKey: string, level: AccessLevel) {
    if (profileId === null) return;
    setBusy(moduleKey); setError(null); setNotice(null);
    try {
      // The server expands a module to every area inside it, so one call sets
      // the whole workspace coherently instead of a burst of per-area writes
      // that could half-fail and leave a contradiction behind.
      await api('/permissions/level', { method: 'POST', body: JSON.stringify({ scope: 'profile', subjectId: profileId, permKey: moduleKey, level }) });
      await reload();
      setNotice(`${LEVEL_LABELS[level]} applied to all of ${MODULE_LABEL.get(moduleKey) ?? moduleKey}.`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function mapPosition(positionId: number, accessProfileId: number | null) {
    setBusy(`pos-${positionId}`); setError(null); setNotice(null);
    try {
      await api(`/positions/${positionId}/access-profile`, { method: 'PUT', body: JSON.stringify({ accessProfileId }) });
      await reload();
      setNotice(accessProfileId === null
        ? 'Position unmapped — the people holding it follow the profile on their own account.'
        : 'Position mapped. Everyone holding it now works under this access profile.');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function createProfile() {
    const name = newProfile.trim();
    if (!name) return;
    setBusy('new'); setError(null); setNotice(null);
    try {
      const created = await api<{ id: number }>('/roles', { method: 'POST', body: JSON.stringify({ name }) });
      setNewProfile('');
      await reload();
      setProfileId(created.id);
      // A new profile grants nothing until somebody decides otherwise — least
      // privilege by default, rather than a blank that quietly inherits.
      setNotice(`“${name}” created with no access anywhere. Grant it what the job needs.`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function renameProfile(name: string) {
    if (profileId === null || !name.trim()) { setRenaming(null); return; }
    setBusy('rename'); setError(null);
    try {
      await api(`/roles/${profileId}`, { method: 'PUT', body: JSON.stringify({ name: name.trim(), description: profile?.description ?? null }) });
      await reload();
      setNotice('Access profile renamed.');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); setRenaming(null); }
  }

  async function deleteProfile() {
    if (profileId === null || !profile) return;
    if (!confirm(`Remove the “${profile.name}” access profile? Nobody may be working under it.`)) return;
    setBusy('delete'); setError(null);
    try {
      await api(`/roles/${profileId}`, { method: 'DELETE' });
      setProfileId(null);
      await reload();
      setNotice('Access profile removed.');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  const grantedCount = ALL_AREAS.filter(a => levelOf(a.key) !== 'none').length;

  return (
    <div className="ac-body">
      <aside className="ac-subjects">
        <div className="ac-subject-head"><Users size={14} /> Access profiles</div>
        <div className="ac-subject-list">
          {profiles.map(p => (
            <button key={p.id} type="button" className={p.id === profileId ? 'active' : ''} onClick={() => setProfileId(p.id)}>
              <strong>{p.name}</strong>
              <span>{p.accountCount} {p.accountCount === 1 ? 'account' : 'accounts'}{Number(p.isAdministrator) === 1 ? ' · administrator' : ''}</span>
            </button>
          ))}
          {profiles.length === 0 && <p className="muted" style={{ padding: 12 }}>No access profiles yet.</p>}
        </div>
        <div className="ac-add-profile">
          <input
            value={newProfile}
            placeholder="Add a profile — Night shift, Locum…"
            onChange={e => setNewProfile(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void createProfile(); } }}
          />
          {can('settings', 'create') && <button type="button" className="secondary" disabled={busy === 'new' || !newProfile.trim()} onClick={() => void createProfile()}>Add</button>}
        </div>

        {/* Positions, merged in. They no longer hold permissions; they say
            which profile their holders work under, which is the whole reason
            a position and a role could disagree before. */}
        <div className="ac-subject-head"><Briefcase size={14} /> Organogram positions</div>
        <div className="ac-positions">
          {positionsHere.map(p => (
            <label key={p.id} className="ac-position">
              <span className="ac-position-title">{p.title}<em>{p.holderCount} {p.holderCount === 1 ? 'holder' : 'holders'}</em></span>
              <select
                value={p.accessProfileId ?? ''}
                disabled={busy === `pos-${p.id}`}
                onChange={e => mapPosition(p.id, e.target.value === '' ? null : Number(e.target.value))}
              >
                <option value="">Follows the person’s own profile</option>
                {profiles.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            </label>
          ))}
          {positionsHere.length === 0 && <p className="muted" style={{ padding: 12 }}>No active positions.</p>}
        </div>
      </aside>

      <section className="ac-areas">
        <div className="ac-areas-head">
          <div>
            {renaming !== null
              ? <input className="ac-rename" autoFocus value={renaming}
                  onChange={e => setRenaming(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void renameProfile(renaming); if (e.key === 'Escape') setRenaming(null); }}
                  onBlur={() => void renameProfile(renaming)} />
              : <h3>
                  {profile?.name ?? 'Select an access profile'}
                  {profile && !isAdminProfile && <>
                    <button type="button" className="ac-reset" style={{ marginLeft: 10 }} onClick={() => setRenaming(profile.name)}>Rename</button>
                    <button type="button" className="ac-reset" style={{ marginLeft: 8 }} disabled={busy === 'delete'} onClick={() => void deleteProfile()}>Remove</button>
                  </>}
                </h3>}
            <p className="muted">
              {grantedCount} of {ALL_AREAS.length} areas granted
              {mappedHere.length > 0 && <> · applies to {mappedHere.map(p => p.title).join(', ')}</>}
            </p>
          </div>
          <div className="ac-search">
            <Search size={15} />
            <input placeholder="Find an area — appraisals, suppliers, approvals…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {notice && <div className="notice-ok">{notice}</div>}
        {isAdminProfile && (
          <div className="notice-warn">
            This is the administrator profile. Narrowing it can lock the laboratory out of its own
            configuration — change it only when another administrator account exists.
          </div>
        )}
        {unmapped.length > 0 && (
          <div className="notice-warn">
            {unmapped.length} {unmapped.length === 1 ? 'position holds staff but is' : 'positions hold staff but are'} not mapped
            to an access profile: {unmapped.slice(0, 6).map(p => p.title).join(', ')}{unmapped.length > 6 ? '…' : ''}.
            Those people follow the profile on their own account. Map them on the left to decide it here instead.
          </div>
        )}

        {profileId !== null && (
          <AreaList levelOf={levelOf} onSet={setLevel} onBulk={applyModule} busy={busy} query={query} />
        )}

        {/* ── The former Advanced Matrix, as reference rather than a second
              place to edit access ─────────────────────────────────────── */}
        <div className="ac-group">
          <div className="ac-group-head">
            <h4><BadgeCheck size={15} style={{ verticalAlign: '-2px' }} /> Technical authorizations</h4>
          </div>
          <p className="muted" style={{ padding: '0 4px 8px' }}>
            Who is authorised to perform, review, verify or approve technical work. This is a competency
            record, kept for ISO 15189. It no longer changes anybody’s software access — a competency note
            quietly widening someone’s rights was one of the contradictions this screen removed. Grant the
            rights on the profile above, or to the person under Individuals.
          </p>
          <table className="data-table">
            <thead><tr><th>Who</th><th>Area</th><th>Section</th><th>Level</th><th>Status</th><th>Expires</th></tr></thead>
            <tbody>
              {(reference?.technicalAuthorizations ?? []).slice(0, 40).map((t: TechnicalAuthorizationRow) => (
                <tr key={t.id}>
                  <td>{t.staff_name || t.position_title || '—'}</td>
                  <td>{AREA_LABEL.get(t.module_key) ?? t.module_key}</td>
                  <td>{t.section_name || '—'}</td>
                  <td>{t.level}</td>
                  <td>{t.is_active ? 'Active' : 'Withdrawn'}</td>
                  <td>{t.expires_at || '—'}</td>
                </tr>
              ))}
              {(reference?.technicalAuthorizations ?? []).length === 0 && (
                <tr><td colSpan={6} className="muted">No technical authorizations recorded.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="ac-group">
          <div className="ac-group-head">
            <h4><History size={15} style={{ verticalAlign: '-2px' }} /> Change history</h4>
            <button type="button" className="secondary" onClick={() => setShowHistory(v => !v)}>{showHistory ? 'Hide' : 'Show'}</button>
          </div>
          {showHistory && (
            <table className="data-table">
              <thead><tr><th>When</th><th>Who</th><th>Change</th><th>Detail</th></tr></thead>
              <tbody>
                {(reference?.auditHistory ?? []).slice(0, 60).map(a => (
                  <tr key={a.id}>
                    <td>{a.created_at}</td>
                    <td>{a.actor_name || a.actor_username || 'System'}</td>
                    <td>{a.action} · {a.entity}</td>
                    <td className="muted" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.new_value ?? ''}</td>
                  </tr>
                ))}
                {(reference?.auditHistory ?? []).length === 0 && <tr><td colSpan={4} className="muted">Nothing recorded yet.</td></tr>}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

/* ==========================================================================
   Tab 2 — Individuals (supersedes the profile, always)
   ========================================================================= */
function IndividualsTab({ catalogue, reload }: { catalogue: AccessCatalogue | null; reload: () => Promise<void> }) {
  const { can } = usePermissions();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [userId, setUserId] = useState<number | null>(null);
  const [effective, setEffective] = useState<EffectiveAccess | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { api<ApiUser[]>('/users').then(setUsers).catch(() => setUsers([])); }, []);
  useEffect(() => {
    if (users.length && !users.some(u => u.id === userId)) setUserId(users[0].id);
  }, [users, userId]);

  const loadEffective = useCallback(async () => {
    if (userId === null) { setEffective(null); return; }
    try { setEffective(await api<EffectiveAccess>(`/permissions/effective/${userId}`)); }
    catch { setEffective(null); }
  }, [userId]);
  useEffect(() => { void loadEffective(); }, [loadEffective]);

  const byKey = useMemo(() => {
    const map = new Map<string, EffectiveAccess['areas'][number]>();
    for (const a of effective?.areas ?? []) map.set(a.permKey, a);
    return map;
  }, [effective]);

  const overriddenKeys = useMemo(
    () => new Set((catalogue?.userOverrideKeys ?? []).filter(o => o.userId === userId).map(o => o.permKey)),
    [catalogue, userId],
  );

  const levelOf = useCallback((areaKey: string): PickerLevel => {
    const row = byKey.get(areaKey);
    if (!row) return 'inherit';
    if (row.overrideLevel !== null) return row.overrideLevel as AccessLevel;
    return 'inherit';
  }, [byKey]);

  async function setLevel(areaKey: string, level: PickerLevel) {
    if (userId === null) return;
    setBusy(areaKey); setError(null); setNotice(null);
    try {
      await api('/permissions/level', { method: 'POST', body: JSON.stringify({ scope: 'user', subjectId: userId, permKey: areaKey, level }) });
      await reload(); await loadEffective();
      setNotice(level === 'inherit'
        ? `“${AREA_LABEL.get(areaKey) ?? areaKey}” now follows the access profile again.`
        : `${LEVEL_LABELS[level]} set for this person on “${AREA_LABEL.get(areaKey) ?? areaKey}” — this overrides their profile.`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function clearAll() {
    if (userId === null) return;
    setBusy('all'); setError(null);
    try {
      await api(`/permissions/user-override/${userId}`, { method: 'DELETE' });
      await reload(); await loadEffective();
      setNotice('Every personal decision removed — this person follows their access profile.');
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  const user = users.find(u => u.id === userId);
  const overrideCount = overriddenKeys.size;

  return (
    <div className="ac-body">
      <aside className="ac-subjects">
        <div className="ac-subject-head"><User size={14} /> People</div>
        <div className="ac-subject-list">
          {users.map(u => (
            <button key={u.id} type="button" className={u.id === userId ? 'active' : ''} onClick={() => setUserId(u.id)}>
              <strong>{u.fullName || u.username}</strong>
              <span>{u.roleName ?? 'No profile'}{u.isActive ? '' : ' · inactive'}</span>
            </button>
          ))}
          {users.length === 0 && <p className="muted" style={{ padding: 12 }}>No login accounts yet.</p>}
        </div>
      </aside>

      <section className="ac-areas">
        <div className="ac-areas-head">
          <div>
            <h3>{user?.fullName || user?.username || 'Select a person'}</h3>
            <p className="muted">
              {effective?.profile
                ? <>Follows <strong>{effective.profile.name}</strong>{effective.via === 'position' && effective.positionTitle ? ` (from the ${effective.positionTitle} position)` : ''}</>
                : 'No access profile'}
              {overrideCount > 0 && <> · {overrideCount} personal {overrideCount === 1 ? 'decision' : 'decisions'} overriding it</>}
            </p>
          </div>
          <div className="ac-search">
            <Search size={15} />
            <input placeholder="Find an area…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
        </div>

        <div className="ac-intro card" style={{ marginTop: 0 }}>
          <span className="ac-intro-ico"><User size={18} /></span>
          <div>
            <p style={{ margin: 0 }}>
              What you set here <strong>overrides this person’s access profile</strong>, to grant or to withdraw,
              and nothing else can overrule it. Areas left on <strong>Follow profile</strong> take whatever the
              profile says, now and whenever it changes.
            </p>
          </div>
        </div>

        {error && <div className="error">{error}</div>}
        {notice && <div className="notice-ok">{notice}</div>}
        {overrideCount > 0 && (
          <p className="muted" style={{ padding: '0 4px' }}>
            {can('settings', 'edit') && <button type="button" className="ac-reset" disabled={busy === 'all'} onClick={clearAll}>
              <RotateCcw size={12} /> Remove all personal decisions
            </button>}
          </p>
        )}

        {userId !== null && (
          <AreaList
            levelOf={levelOf}
            onSet={setLevel}
            busy={busy}
            query={query}
            withInherit
            note={areaKey => {
              const row = byKey.get(areaKey);
              if (!row) return null;
              if (row.overrideLevel !== null) return <span className="ac-tag warn">Personal · overrides profile</span>;
              return <span className="ac-tag muted">From profile: {LEVEL_LABELS[row.profileLevel as AccessLevel] ?? row.profileLevel}</span>;
            }}
            extra={areaKey => {
              const row = byKey.get(areaKey);
              if (!row) return null;
              return (
                <p className="ac-actions">
                  Effective: <strong>{LEVEL_LABELS[row.effectiveLevel as AccessLevel] ?? row.effectiveLevel}</strong>
                  {row.actions.length > 0 && <> — {row.actions.map(a => a.replace('_', '/')).join(' · ')}</>}
                </p>
              );
            }}
          />
        )}
      </section>
    </div>
  );
}

/* ==========================================================================
   The screen
   ========================================================================= */
export function AccessControl() {
  const [tab, setTab] = useState<Tab>('profiles');
  const [catalogue, setCatalogue] = useState<AccessCatalogue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { setCatalogue(await api<AccessCatalogue>('/permissions/catalogue')); }
    catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return (
    <div className="access-control">
      <div className="ac-intro card">
        <span className="ac-intro-ico"><ShieldCheck size={20} /></span>
        <div>
          <h3>Who can do what</h3>
          <p>
            Two things decide access, in this order. An <strong>access profile</strong> is the one cohort
            decision — every person works under exactly one, and organogram positions are mapped to a profile
            rather than carrying rights of their own, so nothing can contradict anything.
            An <strong>individual</strong> decision then overrides that profile for one person, to grant or to
            withdraw, and always wins. Levels build on each other: <strong>View</strong> reads,
            <strong> Contribute</strong> adds, <strong>Manage</strong> changes and exports,
            <strong> Full</strong> also approves and archives. Anything set to <strong>No access</strong> is
            hidden entirely — not greyed out, and not a refusal after the click.
          </p>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="ac-scope">
        <button type="button" className={tab === 'profiles' ? 'active' : ''} onClick={() => setTab('profiles')}
          title="Roles, positions and the action detail, in one place">
          <Users size={15} /> Access profiles
        </button>
        <button type="button" className={tab === 'individuals' ? 'active' : ''} onClick={() => setTab('individuals')}
          title="One person, overriding their profile">
          <User size={15} /> Individuals
        </button>
      </div>

      {tab === 'profiles'
        ? <ProfilesTab catalogue={catalogue} reload={reload} />
        : <IndividualsTab catalogue={catalogue} reload={reload} />}
    </div>
  );
}

export default AccessControl;
