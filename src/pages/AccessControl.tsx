import { useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck, User, Users, Briefcase, RotateCcw, Info } from 'lucide-react';
import { api } from '../services/api';
import { MODULES } from '../../shared/constants/modules';
import {
  FEATURES, ACCESS_LEVELS, LEVEL_LABELS, LEVEL_HINTS, LEVEL_ACTIONS,
  levelForActions, featuresOfModule, type AccessLevel,
} from '../../shared/constants/features';
import type { ApiUser, Position } from '../../shared/types/api';

/* ============================================================================
   ACCESS CONTROL

   The old matrix asked for 224 yes/no answers per role — 32 modules × 7
   actions — in one undifferentiated grid, with no grouping, no search and no
   sense of what a role could actually do. Granting a cohort a coherent set of
   rights meant tens of clicks, each independently wrong-clickable, and nobody
   could review the result. That is how the shipped defaults drifted far enough
   for a Technician to be able to read every colleague's appraisals.

   This screen asks one question per area instead: how much access does this
   cohort need? Areas are the features a permission can actually name, grouped
   under their module, searchable, with the confidential ones marked. The same
   control does a whole cohort or one person.
   ========================================================================= */

type Catalogue = {
  roles: Record<string, Record<string, string[]>>;
  positions: Record<string, Record<string, string[]>>;
  users: Record<string, Record<string, string[]>>;
  userOverrideKeys: { userId: number; permKey: string }[];
};

type Subject = { id: number; name: string; sub?: string };
type Scope = 'role' | 'position' | 'user';

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

function LevelPicker({ value, onChange, disabled }: { value: AccessLevel; onChange: (l: AccessLevel) => void; disabled?: boolean }) {
  return (
    <div className={`lvl-picker lvl-${value}`} role="group" aria-label="Access level">
      {ACCESS_LEVELS.map(l => (
        <button
          key={l}
          type="button"
          disabled={disabled}
          className={value === l ? 'active' : ''}
          title={LEVEL_HINTS[l]}
          onClick={() => onChange(l)}
        >
          {LEVEL_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

export function AccessControl() {
  const [scope, setScope] = useState<Scope>('role');
  const [subjectId, setSubjectId] = useState<number | null>(null);
  const [roles, setRoles] = useState<{ id: number; name: string; description?: string }[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = () => api<Catalogue>('/permissions/catalogue').then(setCatalogue).catch(e => setError((e as Error).message));

  useEffect(() => {
    reload();
    api<{ id: number; name: string; description?: string }[]>('/roles').then(r => { setRoles(r); if (r.length) setSubjectId(s => s ?? r[0].id); }).catch(() => undefined);
    api<Position[]>('/positions').then(setPositions).catch(() => undefined);
    api<ApiUser[]>('/users').then(setUsers).catch(() => undefined);
  }, []);

  const subjects: Subject[] = useMemo(() => {
    if (scope === 'role') return roles.map(r => ({ id: r.id, name: r.name, sub: r.description }));
    if (scope === 'position') return positions.filter(p => !!p.isActive).map(p => ({ id: p.id, name: p.title }));
    return users.map(u => ({ id: u.id, name: u.fullName || u.username, sub: u.roleName ?? undefined }));
  }, [scope, roles, positions, users]);

  // Switching cohort keeps a valid selection rather than leaving the page blank.
  useEffect(() => {
    if (subjects.length && !subjects.some(s => s.id === subjectId)) setSubjectId(subjects[0].id);
  }, [subjects, subjectId]);

  const held = useMemo(() => {
    if (!catalogue || subjectId === null) return {} as Record<string, string[]>;
    const bucket = scope === 'role' ? catalogue.roles : scope === 'position' ? catalogue.positions : catalogue.users;
    return bucket[String(subjectId)] ?? {};
  }, [catalogue, scope, subjectId]);

  const overriddenKeys = useMemo(
    () => new Set((catalogue?.userOverrideKeys ?? []).filter(o => o.userId === subjectId).map(o => o.permKey)),
    [catalogue, subjectId],
  );

  // For a person, the level they inherit from their role — so the screen can
  // say what an override is actually changing.
  const inheritedFromRole = useMemo(() => {
    if (scope !== 'user' || !catalogue || subjectId === null) return null;
    const user = users.find(u => u.id === subjectId);
    if (!user) return null;
    return catalogue.roles[String(user.roleId)] ?? {};
  }, [scope, catalogue, subjectId, users]);

  const levelOf = (areaKey: string): AccessLevel => {
    if (scope === 'user' && !overriddenKeys.has(areaKey) && inheritedFromRole) {
      return levelForActions(inheritedFromRole[areaKey] ?? []);
    }
    return levelForActions(held[areaKey] ?? []);
  };

  async function setLevel(areaKey: string, level: AccessLevel) {
    setBusy(areaKey); setError(null); setNotice(null);
    try {
      await api('/permissions/level', { method: 'POST', body: JSON.stringify({ scope, subjectId, permKey: areaKey, level }) });
      await reload();
      setNotice(`${LEVEL_LABELS[level]} set for “${AREA_LABEL.get(areaKey) ?? areaKey}”.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function clearOverride(areaKey: string) {
    setBusy(areaKey); setError(null);
    try {
      await api(`/permissions/user-override/${subjectId}/${encodeURIComponent(areaKey)}`, { method: 'DELETE' });
      await reload();
      setNotice('Personal override removed — this person follows their role again.');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function applyModule(moduleKey: string, level: AccessLevel) {
    const group = AREAS_BY_MODULE.find(g => g.module === moduleKey);
    if (!group) return;
    setBusy(moduleKey); setError(null);
    try {
      for (const area of group.areas) {
        await api('/permissions/level', { method: 'POST', body: JSON.stringify({ scope, subjectId, permKey: area.key, level }) });
      }
      await reload();
      setNotice(`${LEVEL_LABELS[level]} applied to all of ${MODULE_LABEL.get(moduleKey) ?? moduleKey}.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  const q = query.trim().toLowerCase();
  const groups = AREAS_BY_MODULE
    .map(g => ({ ...g, areas: g.areas.filter(a => !q || a.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q)) }))
    .filter(g => g.areas.length > 0);

  const subject = subjects.find(s => s.id === subjectId);
  const grantedCount = AREAS_BY_MODULE.flatMap(g => g.areas).filter(a => levelOf(a.key) !== 'none').length;
  const totalAreas = AREAS_BY_MODULE.flatMap(g => g.areas).length;

  return (
    <div className="access-control">
      <div className="ac-intro card">
        <span className="ac-intro-ico"><ShieldCheck size={20} /></span>
        <div>
          <h3>Who can do what</h3>
          <p>
            Pick a cohort — a role, a position, or one person — then set how much access it needs in each
            area. Levels build on each other: <strong>View</strong> reads, <strong>Contribute</strong> adds,
            <strong> Manage</strong> changes and exports, <strong>Full</strong> also approves and archives.
            Anything set to <strong>No access</strong> is hidden entirely, not greyed out.
          </p>
        </div>
      </div>

      <div className="ac-scope">
        {([
          ['role', 'Roles', Users, 'Everyone with this role — the usual way to grant access'],
          ['position', 'Positions', Briefcase, 'Anyone holding this organogram position'],
          ['user', 'Individuals', User, 'One person, overriding their role'],
        ] as [Scope, string, typeof Users, string][]).map(([key, label, Icon, hint]) => (
          <button key={key} type="button" className={scope === key ? 'active' : ''} title={hint} onClick={() => setScope(key)}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      <div className="ac-body">
        <aside className="ac-subjects">
          <div className="ac-subject-list">
            {subjects.map(s => (
              <button key={s.id} type="button" className={s.id === subjectId ? 'active' : ''} onClick={() => setSubjectId(s.id)}>
                <strong>{s.name}</strong>
                {s.sub && <span>{s.sub}</span>}
              </button>
            ))}
            {subjects.length === 0 && <p className="muted" style={{ padding: 12 }}>Nothing to configure here yet.</p>}
          </div>
        </aside>

        <section className="ac-areas">
          <div className="ac-areas-head">
            <div>
              <h3>{subject?.name ?? 'Select a cohort'}</h3>
              <p className="muted">
                {grantedCount} of {totalAreas} areas granted
                {scope === 'user' && <> · areas not overridden follow the person’s role</>}
              </p>
            </div>
            <div className="ac-search">
              <Search size={15} />
              <input placeholder="Find an area — appraisals, suppliers, approvals…" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
          </div>

          {error && <div className="error">{error}</div>}
          {notice && <div className="notice-ok">{notice}</div>}

          {groups.map(group => (
            <div key={group.module} className="ac-group">
              <div className="ac-group-head">
                <h4>{group.label}</h4>
                <div className="ac-group-bulk">
                  <span className="muted">Set all:</span>
                  {(['none', 'view', 'manage'] as AccessLevel[]).map(l => (
                    <button key={l} type="button" className="secondary" disabled={busy === group.module || subjectId === null}
                      onClick={() => applyModule(group.module, l)}>
                      {LEVEL_LABELS[l]}
                    </button>
                  ))}
                </div>
              </div>

              <ul className="ac-list">
                {group.areas.map(area => {
                  const level = levelOf(area.key);
                  const inherited = scope === 'user' && !overriddenKeys.has(area.key);
                  return (
                    <li key={area.key} className={`ac-row${area.sensitive ? ' sensitive' : ''}`}>
                      <div className="ac-row-main">
                        <div className="ac-row-title">
                          {area.label}
                          {area.sensitive && <span className="ac-tag warn" title="Confidential or laboratory-defining">Sensitive</span>}
                          {area.personal && <span className="ac-tag" title="Everyone always reaches their own record here; this level controls what they see of other people's">Personal data</span>}
                          {inherited && <span className="ac-tag muted">From role</span>}
                        </div>
                        <p>{area.desc}</p>
                        {level !== 'none' && (
                          <p className="ac-actions">Allows: {LEVEL_ACTIONS[level].map(a => a.replace('_', '/')).join(' · ')}</p>
                        )}
                      </div>
                      <div className="ac-row-control">
                        <LevelPicker value={level} disabled={busy === area.key || subjectId === null} onChange={l => setLevel(area.key, l)} />
                        {scope === 'user' && overriddenKeys.has(area.key) && (
                          <button type="button" className="ac-reset" title="Remove the override and follow the role again"
                            onClick={() => clearOverride(area.key)}>
                            <RotateCcw size={12} /> Follow role
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {groups.length === 0 && (
            <div className="card"><div className="empty-state"><span className="es-ico"><Info size={24} /></span>
              <h3>No areas match “{query}”</h3><p>Try a different word, or clear the search.</p></div></div>
          )}
        </section>
      </div>
    </div>
  );
}

const AREA_LABEL = new Map<string, string>([
  ...FEATURES.map(f => [f.key, f.label] as [string, string]),
  ...MODULES.map(m => [m.key, m.label] as [string, string]),
]);

export default AccessControl;
