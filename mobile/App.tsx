/**
 * SECH_LIMS Staff Companion — mobile PWA (M0 foundation + M1 "My Work & Me").
 *
 * A light, task-oriented mobile client served by the Host at /m. It reuses the
 * Host's existing API, authentication and RBAC (see src/services/api.ts): every
 * request is same-origin to /api, so the same install works on the lab LAN and
 * remotely over Tailscale with no configuration. Later phases (M2+) add field
 * capture, inventory, quality and offline sync per docs/MOBILE_COMPANION_APP_PLAN.md.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from '../src/services/api';
import type { ApiUser } from '../shared/types/api';
import { CaptureScreen, type CaptureKey } from './Capture';
import { flushOutbox, outboxCount, OUTBOX_EVENT } from './net';

// ---- tiny inline icon set (no external deps; keeps the bundle light) ----
type IconProps = { d: string; size?: number };
const Ico = ({ d, size = 22 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: d }} />
);
const P = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  work: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  flask: '<path d="M9 3h6"/><path d="M10 3v6.5L5.2 17a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.5V3"/><path d="M7.5 14h9"/>',
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M12 12 8 8"/><path d="M3 12a9 9 0 0 1 18 0"/>',
  box: '<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/><path d="M9 14l2 2 4-4"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

type Tab = 'home' | 'work' | 'alerts' | 'me';
type ActionRow = Record<string, unknown>;
type AlertRow = Record<string, unknown>;

// Roadmap of mobile areas. `ready` ones are live now (M1); the rest render as
// "Soon" so staff can see what's coming without hitting dead ends.
const AREAS: { key: string; label: string; icon: string; ready?: boolean; tab?: Tab; cap?: CaptureKey }[] = [
  { key: 'work', label: 'My tasks', icon: P.work, ready: true, tab: 'work' },
  { key: 'alerts', label: 'Alerts', icon: P.alert, ready: true, tab: 'alerts' },
  { key: 'me', label: 'My profile', icon: P.user, ready: true, tab: 'me' },
  { key: 'env', label: 'Environmental', icon: P.gauge, ready: true, cap: 'env' },
  { key: 'equipment', label: 'Equipment', icon: P.flask, ready: true, cap: 'equip:maintenance' },
  { key: 'inventory', label: 'Inventory', icon: P.box },
  { key: 'nc', label: 'Nonconformities', icon: P.alert },
  { key: 'docs', label: 'Documents', icon: P.doc },
  { key: 'assess', label: 'Assessments', icon: P.clipboard },
];

function esc(v: unknown): string { return v === null || v === undefined ? '' : String(v); }
function initials(name?: string) {
  if (!name) return '–';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || (p[0]?.[0] ?? '–').toUpperCase();
}
function fmtDate(v: unknown): string {
  const s = esc(v); if (!s) return '';
  const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
  return Number.isNaN(t) ? s : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function App() {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>('home');
  const [capture, setCapture] = useState<CaptureKey | null>(null);
  const [queued, setQueued] = useState(0);

  useEffect(() => {
    if (!getToken()) { setBooting(false); return; }
    api<{ user: ApiUser }>('/auth/me').then(r => setUser(r.user)).catch(() => setToken(null)).finally(() => setBooting(false));
  }, []);

  // Offline outbox: reflect the queued count and flush on reconnect / app load.
  useEffect(() => {
    const refresh = () => setQueued(outboxCount());
    const onOnline = () => { void flushOutbox().then(refresh); };
    refresh();
    void flushOutbox().then(refresh);
    window.addEventListener(OUTBOX_EVENT, refresh);
    window.addEventListener('online', onOnline);
    return () => { window.removeEventListener(OUTBOX_EVENT, refresh); window.removeEventListener('online', onOnline); };
  }, [user]);

  const openTab = useCallback((t: Tab) => { setCapture(null); setTab(t); }, []);
  const onLoggedIn = useCallback((u: ApiUser) => { setUser(u); setTab('home'); }, []);
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setToken(null); setUser(null);
  }, []);

  if (booting) return <div className="m-splash"><span className="m-brandmark"><Ico d={P.flask} size={26} /></span><div className="m-spin" /></div>;
  if (!user) return <Login onLoggedIn={onLoggedIn} />;

  return (
    <div className="m-app">
      <header className="m-top">
        <span className="m-brandmark small"><Ico d={P.flask} size={18} /></span>
        <div className="m-top-title">
          <strong>SECH_LIMS</strong><span>Staff Companion</span>
        </div>
        {queued > 0 && <span className="m-outbox" title="Captures waiting to sync">{queued} queued</span>}
        <span className="m-avatar" title={user.fullName}>{initials(user.staffName || user.fullName)}</span>
      </header>

      <main className="m-content">
        {capture ? <CaptureScreen capture={capture} onBack={() => setCapture(null)} />
          : tab === 'home' ? <Home user={user} go={openTab} onCapture={setCapture} />
          : tab === 'work' ? <Work user={user} />
          : tab === 'alerts' ? <Alerts />
          : <Me user={user} onLogout={logout} />}
      </main>

      <nav className="m-tabs">
        {([['home', 'Home', P.home], ['work', 'My Work', P.work], ['alerts', 'Alerts', P.bell], ['me', 'Me', P.user]] as [Tab, string, string][]).map(([k, lbl, ic]) => (
          <button key={k} className={`m-tab ${tab === k && !capture ? 'active' : ''}`} onClick={() => openTab(k)}>
            <Ico d={ic} size={21} /><span>{lbl}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: (u: ApiUser) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true); setErr(null);
    try {
      const r = await api<{ token: string; user: ApiUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setToken(r.token); onLoggedIn(r.user);
    } catch (e) { setErr((e as Error).message || 'Sign in failed'); } finally { setBusy(false); }
  }

  return (
    <div className="m-login">
      <form className="m-login-card" onSubmit={submit}>
        <span className="m-brandmark"><Ico d={P.flask} size={26} /></span>
        <h1>SECH_LIMS</h1>
        <p className="m-sub">Staff Companion · sign in with your laboratory account</p>
        <label className="m-lbl">Username</label>
        <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" />
        <label className="m-lbl">Password</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" />
        <button className="m-btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {err && <p className="m-err">{err}</p>}
      </form>
      <p className="m-login-foot">Connects to your laboratory Host over the network. by Nickland</p>
    </div>
  );
}

function Home({ user, go, onCapture }: { user: ApiUser; go: (t: Tab) => void; onCapture: (c: CaptureKey) => void }) {
  const [openActions, setOpenActions] = useState<number | null>(null);
  const [alertCount, setAlertCount] = useState<number | null>(null);

  useEffect(() => {
    if (user.staffId) {
      api<ActionRow[]>(`/actions?assignedToStaffId=${user.staffId}`)
        .then(rows => setOpenActions(rows.filter(r => String(r.status ?? '').toLowerCase() !== 'closed' && String(r.status ?? '').toLowerCase() !== 'completed').length))
        .catch(() => setOpenActions(0));
    } else setOpenActions(0);
    api<AlertRow[]>('/notifications/live-alerts?scope=mine').then(a => setAlertCount(a.length)).catch(() => setAlertCount(null));
  }, [user.staffId]);

  return (
    <div className="m-screen">
      <div className="m-greet">
        <div className="m-greet-hi">Hello, {(user.staffName || user.fullName || 'there').split(' ')[0]}</div>
        <div className="m-greet-sub">{user.roleName || 'Laboratory staff'}</div>
      </div>

      <div className="m-summary">
        <button className="m-stat" onClick={() => go('work')}>
          <div className="m-stat-n">{openActions ?? '–'}</div>
          <div className="m-stat-l">Open tasks</div>
        </button>
        <button className="m-stat" onClick={() => go('alerts')}>
          <div className="m-stat-n">{alertCount ?? '–'}</div>
          <div className="m-stat-l">My alerts</div>
        </button>
      </div>

      <div className="m-section-h">Quick capture</div>
      <div className="m-quick">
        <button className="m-quickbtn" onClick={() => onCapture('env')}><span className="m-cell-ic"><Ico d={P.gauge} size={20} /></span>Reading</button>
        <button className="m-quickbtn" onClick={() => onCapture('equip:maintenance')}><span className="m-cell-ic"><Ico d={P.flask} size={20} /></span>Maintenance</button>
        <button className="m-quickbtn" onClick={() => onCapture('equip:breakdown')}><span className="m-cell-ic alert"><Ico d={P.alert} size={20} /></span>Breakdown</button>
      </div>

      <div className="m-section-h">Quick access</div>
      <div className="m-grid">
        {AREAS.map(a => (
          <button key={a.key} className={`m-cell ${a.ready ? '' : 'soon'}`}
            onClick={() => { if (!a.ready) return; if (a.cap) onCapture(a.cap); else if (a.tab) go(a.tab); }} disabled={!a.ready}>
            <span className="m-cell-ic"><Ico d={a.icon} size={22} /></span>
            <span className="m-cell-l">{a.label}</span>
            {!a.ready && <span className="m-soon">Soon</span>}
          </button>
        ))}
      </div>
      <p className="m-hint">More areas roll out progressively. Inventory, nonconformities and documents are next.</p>
    </div>
  );
}

function Work({ user }: { user: ApiUser }) {
  const [rows, setRows] = useState<ActionRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user.staffId) { setRows([]); return; }
    api<ActionRow[]>(`/actions?assignedToStaffId=${user.staffId}`)
      .then(setRows).catch(e => setErr((e as Error).message));
  }, [user.staffId]);

  const open = (rows ?? []).filter(r => { const s = String(r.status ?? '').toLowerCase(); return s !== 'closed' && s !== 'completed'; });
  const done = (rows ?? []).filter(r => { const s = String(r.status ?? '').toLowerCase(); return s === 'closed' || s === 'completed'; });

  return (
    <div className="m-screen">
      <div className="m-screen-h">My tasks</div>
      {!user.staffId && <p className="m-empty">Your login isn’t linked to a staff profile yet, so no personal tasks can be shown. Ask your administrator to link your account.</p>}
      {err && <p className="m-err">{err}</p>}
      {rows === null && !err && <p className="m-empty">Loading…</p>}
      {rows && open.length === 0 && user.staffId && <p className="m-empty">No open tasks assigned to you. 🎉</p>}
      {open.map((r, i) => <ActionCard key={i} r={r} />)}
      {done.length > 0 && <div className="m-section-h" style={{ marginTop: 18 }}>Recently completed</div>}
      {done.slice(0, 8).map((r, i) => <ActionCard key={'d' + i} r={r} done />)}
    </div>
  );
}

function ActionCard({ r, done }: { r: ActionRow; done?: boolean }) {
  const title = esc(r.title || r.description || 'Task');
  const status = esc(r.status || 'Open');
  const due = fmtDate(r.due_date);
  const overdue = !done && r.due_date && Date.parse(String(r.due_date).replace(' ', 'T')) < Date.now();
  return (
    <div className={`m-item ${done ? 'muted' : ''}`}>
      <span className={`m-item-ic ${done ? 'ok' : ''}`}><Ico d={done ? P.check : P.work} size={18} /></span>
      <div className="m-item-body">
        <div className="m-item-title">{title}</div>
        <div className="m-item-meta">
          <span className="m-chip">{status}</span>
          {due && <span className={overdue ? 'm-due over' : 'm-due'}>{overdue ? 'Overdue · ' : 'Due '}{due}</span>}
        </div>
      </div>
    </div>
  );
}

function Alerts() {
  const [rows, setRows] = useState<AlertRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<AlertRow[]>('/notifications/live-alerts?scope=mine').then(setRows).catch(e => setErr((e as Error).message));
  }, []);
  return (
    <div className="m-screen">
      <div className="m-screen-h">My alerts</div>
      {err && <p className="m-err">{err}</p>}
      {rows === null && !err && <p className="m-empty">Loading…</p>}
      {rows && rows.length === 0 && <p className="m-empty">No alerts for you right now. ✅</p>}
      {(rows ?? []).map((a, i) => {
        const sev = String(a.severity || a.level || a.priority || '').toLowerCase();
        const cls = sev.includes('crit') || sev.includes('high') ? 'crit' : sev.includes('warn') || sev.includes('med') ? 'warn' : '';
        return (
          <div className={`m-item alert ${cls}`} key={i}>
            <span className="m-item-ic alert"><Ico d={P.alert} size={18} /></span>
            <div className="m-item-body">
              <div className="m-item-title">{esc(a.title || a.message || a.label || 'Alert')}</div>
              <div className="m-item-meta">
                {a.module && <span className="m-chip">{esc(a.module)}</span>}
                {(a.message && a.title) && <span className="m-due">{esc(a.message)}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Me({ user, onLogout }: { user: ApiUser; onLogout: () => void }) {
  const rows: [string, string][] = [
    ['Name', esc(user.staffName || user.fullName)],
    ['Role', esc(user.roleName || '—')],
    ['Username', esc(user.username)],
    ['Staff profile', user.staffId ? `Linked (#${user.staffId})` : 'Not linked'],
  ];
  return (
    <div className="m-screen">
      <div className="m-me-head">
        <span className="m-avatar big">{initials(user.staffName || user.fullName)}</span>
        <div>
          <div className="m-me-name">{esc(user.staffName || user.fullName)}</div>
          <div className="m-me-role">{esc(user.roleName || 'Laboratory staff')}</div>
        </div>
      </div>
      <div className="m-card">
        {rows.map(([k, v]) => (<div className="m-kv" key={k}><span>{k}</span><strong>{v}</strong></div>))}
      </div>
      <button className="m-btn danger block" onClick={onLogout}><Ico d={P.logout} size={18} /> Sign out</button>
      <p className="m-hint" style={{ textAlign: 'center' }}>SECH_LIMS Staff Companion · by Nickland</p>
    </div>
  );
}
