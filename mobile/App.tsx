/**
 * SECH_LIMS Staff Companion — mobile PWA.
 *
 * The primary mobile workspace for laboratory personnel. A light, task-oriented
 * client that reuses the Host's existing API, authentication and RBAC (see
 * src/services/api.ts): every request is same-origin to /api, so one install
 * works on the lab LAN and remotely over Tailscale / a future Cloudflare Tunnel
 * with no configuration.
 *
 * Phase 1 delivered field capture, inventory, quality and offline sync.
 * Phase 2 turns it into the primary digital workstation: a role-based dashboard,
 * a full Staff Self-Service module, a dynamic digital forms engine, mobile
 * approval workflows with electronic signatures, and QR / camera intelligence —
 * all structured for a future Capacitor native wrap (see native.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, needsHostConfig } from '../src/services/api';
import type { ApiUser } from '../shared/types/api';
import { registerNativePush, deviceInfo } from './native';
import { HostSetup } from './HostSetup';
import { CaptureScreen, type CaptureKey } from './Capture';
import { InventoryScreen } from './Inventory';
import { DocumentsScreen } from './Documents';
import { AssessmentsScreen } from './Assessments';
import { CapaScreen } from './Capa';
import { FormsScreen } from './Forms';
import { ApprovalsScreen } from './Approvals';
import { ScanScreen } from './Scan';
import { SelfServiceScreen } from './SelfService';
import { flushOutbox, outboxCount, OUTBOX_EVENT } from './net';

type PushScreen = CaptureKey | 'inventory' | 'docs' | 'assess' | 'capa' | 'forms' | 'approvals' | 'scan';

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
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  check2: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  form: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  approve: '<path d="M9 12l2 2 4-4"/><path d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

type Tab = 'home' | 'work' | 'approvals' | 'me';
type ActionRow = Record<string, unknown>;
type AlertRow = Record<string, unknown>;
type DashWidget = { key: string; label: string; value: number; tab?: string; push?: string; tone?: string };
type Dashboard = { role: string | null; roleName: string | null; staffLinked: boolean; widgets: DashWidget[]; quickActions: { key: string; label: string; push: string }[]; approvalsPending: number };

// Full launchpad of mobile areas → screen. Each is permission-gated by the Host,
// so a staff member only ever reaches what their role allows.
const AREAS: { key: string; label: string; icon: string; push?: PushScreen; tab?: Tab }[] = [
  { key: 'forms', label: 'Forms', icon: P.form, push: 'forms' },
  { key: 'scan', label: 'Scan', icon: P.scan, push: 'scan' },
  { key: 'env', label: 'Environmental', icon: P.gauge, push: 'env' },
  { key: 'equipment', label: 'Equipment', icon: P.flask, push: 'equip:maintenance' },
  { key: 'inventory', label: 'Inventory', icon: P.box, push: 'inventory' },
  { key: 'safety', label: 'Safety', icon: P.shield, push: 'safety' },
  { key: 'nc', label: 'Nonconformity', icon: P.alert, push: 'nc' },
  { key: 'capa', label: 'CAPA', icon: P.check2, push: 'capa' },
  { key: 'complaint', label: 'Complaints', icon: P.chat, push: 'complaint' },
  { key: 'docs', label: 'Documents', icon: P.doc, push: 'docs' },
  { key: 'assess', label: 'Assessments', icon: P.clipboard, push: 'assess' },
  { key: 'approvals', label: 'Approvals', icon: P.approve, push: 'approvals' },
];

function esc(v: unknown): string { return v === null || v === undefined ? '' : String(v); }
function initials(name?: string) {
  if (!name) return '–';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || (p[0]?.[0] ?? '–').toUpperCase();
}
function fmtDate(v: unknown): string {
  const t = Date.parse(esc(v).includes('T') ? esc(v) : esc(v).replace(' ', 'T'));
  return Number.isNaN(t) ? esc(v) : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function App() {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [tab, setTab] = useState<Tab>('home');
  const [capture, setCapture] = useState<PushScreen | null>(null);
  const [queued, setQueued] = useState(0);
  // Native app only: true until the user has configured a Host address.
  const [needHost, setNeedHost] = useState(needsHostConfig());

  useEffect(() => {
    if (needHost) { setBooting(false); return; }
    if (!getToken()) { setBooting(false); return; }
    api<{ user: ApiUser }>('/auth/me').then(r => setUser(r.user)).catch(() => setToken(null)).finally(() => setBooting(false));
  }, [needHost]);

  // Register the device for native push once signed in (no-op in the PWA).
  useEffect(() => {
    if (!user) return;
    void registerNativePush((endpoint, platform) =>
      api('/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint, platform, deviceInfo: deviceInfo() }) }).then(() => undefined));
  }, [user]);

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

  // Reload so the API layer picks up the newly-saved Host address (API_BASE is
  // resolved once at load).
  if (needHost) return <HostSetup onConnected={() => window.location.reload()} />;
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
        {capture === 'inventory' ? <InventoryScreen onBack={() => setCapture(null)} />
          : capture === 'docs' ? <DocumentsScreen user={user} onBack={() => setCapture(null)} />
          : capture === 'assess' ? <AssessmentsScreen onBack={() => setCapture(null)} />
          : capture === 'capa' ? <CapaScreen onBack={() => setCapture(null)} />
          : capture === 'forms' ? <FormsScreen onBack={() => setCapture(null)} />
          : capture === 'approvals' ? <ApprovalsScreen onBack={() => setCapture(null)} />
          : capture === 'scan' ? <ScanScreen onBack={() => setCapture(null)} />
          : capture ? <CaptureScreen capture={capture as CaptureKey} onBack={() => setCapture(null)} />
          : tab === 'home' ? <Home user={user} go={openTab} onCapture={setCapture} />
          : tab === 'work' ? <Work user={user} />
          : tab === 'approvals' ? <ApprovalsScreen onBack={() => openTab('home')} />
          : <SelfServiceScreen user={user} onLogout={logout} />}
      </main>

      <nav className="m-tabs">
        {([['home', 'Home', P.home], ['work', 'My Work', P.work], ['approvals', 'Approvals', P.approve], ['me', 'Me', P.user]] as [Tab, string, string][]).map(([k, lbl, ic]) => (
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

function Home({ user, go, onCapture }: { user: ApiUser; go: (t: Tab) => void; onCapture: (c: PushScreen) => void }) {
  const [dash, setDash] = useState<Dashboard | null>(null);

  useEffect(() => { api<Dashboard>('/mobile/dashboard').then(setDash).catch(() => setDash(null)); }, []);

  // Map a widget's target to a navigation action.
  const goWidget = (w: DashWidget) => {
    if (w.push) onCapture(w.push as PushScreen);
    else if (w.tab === 'work') go('work');
    else if (w.tab === 'alerts') go('work');
    else if (w.key === 'approvals') go('approvals');
  };

  return (
    <div className="m-screen">
      <div className="m-greet">
        <div className="m-greet-hi">Hello, {(user.staffName || user.fullName || 'there').split(' ')[0]}</div>
        <div className="m-greet-sub">{dash?.roleName || user.roleName || 'Laboratory staff'}</div>
      </div>

      {/* Role-based widgets */}
      <div className="m-widgets">
        {(dash?.widgets ?? []).map(w => (
          <button key={w.key} className={`m-widget ${w.tone ?? ''}`} onClick={() => goWidget(w)}>
            <div className="m-widget-n">{w.value}</div>
            <div className="m-widget-l">{w.label}</div>
          </button>
        ))}
        {!dash && <div className="m-empty" style={{ gridColumn: '1 / -1' }}>Loading your dashboard…</div>}
      </div>

      {/* Quick actions — role-filtered by the Host */}
      {dash && dash.quickActions.length > 0 && <>
        <div className="m-section-h">Quick capture</div>
        <div className="m-quick">
          {dash.quickActions.map(a => (
            <button key={a.key} className="m-quickbtn" onClick={() => onCapture(a.push as PushScreen)}>
              <span className="m-cell-ic"><Ico d={quickIcon(a.key)} size={20} /></span>{a.label}
            </button>
          ))}
        </div>
      </>}

      <div className="m-section-h">All areas</div>
      <div className="m-grid">
        {AREAS.map(a => (
          <button key={a.key} className="m-cell" onClick={() => { if (a.push) onCapture(a.push); else if (a.tab) go(a.tab); }}>
            <span className="m-cell-ic"><Ico d={a.icon} size={22} /></span>
            <span className="m-cell-l">{a.label}</span>
          </button>
        ))}
      </div>
      <p className="m-hint">Areas you don’t have permission for stay read-only on the Host. Your role determines what you can act on.</p>
    </div>
  );
}

function quickIcon(key: string): string {
  return key.startsWith('equip') ? P.flask : key === 'env' ? P.gauge : key === 'safety' ? P.shield
    : key === 'nc' ? P.alert : key === 'inventory' ? P.box : key === 'forms' ? P.form : P.work;
}

function Work({ user }: { user: ApiUser }) {
  const [rows, setRows] = useState<ActionRow[] | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<'tasks' | 'alerts'>('tasks');

  useEffect(() => {
    if (!user.staffId) { setRows([]); } else {
      api<ActionRow[]>(`/actions?assignedToStaffId=${user.staffId}`).then(setRows).catch(e => setErr((e as Error).message));
    }
    api<AlertRow[]>('/notifications/live-alerts?scope=mine').then(setAlerts).catch(() => setAlerts([]));
  }, [user.staffId]);

  const open = (rows ?? []).filter(r => { const s = String(r.status ?? '').toLowerCase(); return s !== 'closed' && s !== 'completed'; });
  const done = (rows ?? []).filter(r => { const s = String(r.status ?? '').toLowerCase(); return s === 'closed' || s === 'completed'; });

  return (
    <div className="m-screen">
      <div className="m-screen-h">My work</div>
      <div className="m-seg">
        <button className={sub === 'tasks' ? 'active' : ''} onClick={() => setSub('tasks')}>Tasks{open.length ? ` (${open.length})` : ''}</button>
        <button className={sub === 'alerts' ? 'active' : ''} onClick={() => setSub('alerts')}>Alerts{alerts.length ? ` (${alerts.length})` : ''}</button>
      </div>
      {sub === 'tasks' ? <>
        {!user.staffId && <p className="m-empty">Your login isn’t linked to a staff profile yet, so no personal tasks can be shown.</p>}
        {err && <p className="m-err">{err}</p>}
        {rows === null && !err && <p className="m-empty">Loading…</p>}
        {rows && open.length === 0 && user.staffId && <p className="m-empty">No open tasks assigned to you. 🎉</p>}
        {open.map((r, i) => <ActionCard key={i} r={r} />)}
        {done.length > 0 && <div className="m-section-h" style={{ marginTop: 18 }}>Recently completed</div>}
        {done.slice(0, 8).map((r, i) => <ActionCard key={'d' + i} r={r} done />)}
      </> : <>
        {alerts.length === 0 && <p className="m-empty">No alerts for you right now. ✅</p>}
        {alerts.map((a, i) => {
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
      </>}
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
