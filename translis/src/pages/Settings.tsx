import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../../../src/services/api';
import { useAuth } from '../../../src/hooks/useAuth';
import { PageHeader } from '../../../src/components/ui';
import { Notice } from '../../../src/components/ui/Feedback';
import { useInstallation, type ModeOption } from '../useInstallation';

/**
 * Settings.
 *
 * Three things an administrator decides, and nothing else. SECHLIMS puts its
 * laboratory identity, its people, its sections, its dropdown lists, its
 * backups and its modules here; none of that is this product's business.
 */
const TABS = ['Accounts', 'Transmission Mode', 'Data Retention'] as const;
type Tab = typeof TABS[number];

type Account = {
  id: number; username: string; fullName: string; isActive: number;
  profile: string; isAdministrator: number; createdAt: string;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="cx-row"><span className="cx-label">{label}</span><span className="cx-value">{children}</span></div>;
}

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('Accounts');
  return (
    <div className="module-page">
      <PageHeader eyebrow="TransLis" title="Settings" />
      <div className="tabs">
        {TABS.map(t => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Accounts' && <Accounts />}
      {tab === 'Transmission Mode' && <Mode />}
      {tab === 'Data Retention' && <Retention />}
    </div>
  );
}

/* ============================================================================
   Accounts
   ========================================================================= */

function Accounts() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [form, setForm] = useState({ fullName: '', username: '', password: '', profile: 'Staff' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resetting, setResetting] = useState<Account | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(async () => {
    try {
      const answer = await api<{ accounts: Account[]; profiles: string[] }>('/translis/accounts');
      setAccounts(answer.accounts); setProfiles(answer.profiles);
    } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy(true); setError(null); setMessage(null);
    try {
      await api('/translis/accounts', { method: 'POST', body: JSON.stringify(form) });
      setMessage(`${form.fullName} can now sign in.`);
      setForm({ fullName: '', username: '', password: '', profile: 'Staff' });
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function change(account: Account, body: Record<string, unknown>, said: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await api(`/translis/accounts/${account.id}`, { method: 'PUT', body: JSON.stringify(body) });
      setMessage(said);
      await load();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="card">
      <div className="section-head"><h3>Who uses this installation</h3></div>
      <p className="hint" style={{ marginTop: 0 }}>
        An <strong>Administrator</strong> configures the analysers, the destinations, the routing
        and these accounts. <strong>Staff</strong> fill results with the Result Filler and watch
        what has arrived; they change no configuration.
      </p>

      <table className="table">
        <thead>
          <tr><th>Name</th><th>Username</th><th>Access</th><th>State</th><th /></tr>
        </thead>
        <tbody>
          {accounts.map(account => (
            <tr key={account.id}>
              <td>{account.fullName}</td>
              <td><code>{account.username}</code></td>
              <td>{account.profile}</td>
              <td>{account.isActive ? 'Active' : 'Suspended'}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                <button className="secondary" disabled={busy}
                  onClick={() => { setResetting(account); setNewPassword(''); }}>Reset password</button>
                {' '}
                <button className="secondary" disabled={busy || account.id === user?.id}
                  title={account.id === user?.id ? 'You cannot change your own access here.' : undefined}
                  onClick={() => void change(account,
                    { profile: account.profile === 'Administrator' ? 'Staff' : 'Administrator' },
                    `${account.fullName} is now ${account.profile === 'Administrator' ? 'Staff' : 'an Administrator'}.`)}>
                  Make {account.profile === 'Administrator' ? 'Staff' : 'Administrator'}
                </button>
                {' '}
                <button className="secondary" disabled={busy || account.id === user?.id}
                  title={account.id === user?.id ? 'You cannot suspend your own account.' : undefined}
                  onClick={() => void change(account, { isActive: !account.isActive },
                    `${account.fullName} is ${account.isActive ? 'suspended' : 'active again'}.`)}>
                  {account.isActive ? 'Suspend' : 'Restore'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {message && <Notice kind="success">{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>

    {resetting && (
      <div className="card">
        <div className="section-head"><h3>Reset the password for {resetting.fullName}</h3></div>
        <p className="hint" style={{ marginTop: 0 }}>
          Give them the new password yourself. Nothing is sent anywhere from this computer.
        </p>
        <div className="cx-rows">
          <Row label="New password">
            <input type="text" value={newPassword} onChange={e => setNewPassword(e.target.value)}
              placeholder="At least 8 characters" autoComplete="off" />
          </Row>
        </div>
        <div className="cx-actions">
          <button className="primary" disabled={busy || newPassword.length < 8}
            onClick={() => { const who = resetting; setResetting(null);
              void change(who, { password: newPassword }, `The password for ${who.fullName} has been reset.`); }}>
            Reset it
          </button>
          <button className="secondary" onClick={() => setResetting(null)}>Cancel</button>
        </div>
      </div>
    )}

    <div className="card">
      <div className="section-head"><h3>Add somebody</h3></div>
      <div className="cx-rows">
        <Row label="Name">
          <input value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))}
            placeholder="Full name" />
        </Row>
        <Row label="Username">
          <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
            placeholder="Letters, digits, dot, dash or underscore" autoComplete="off" />
        </Row>
        <Row label="Password">
          <input type="text" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder="At least 8 characters" autoComplete="off" />
        </Row>
        <Row label="Access">
          <select value={form.profile} onChange={e => setForm(f => ({ ...f, profile: e.target.value }))}>
            {profiles.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Row>
      </div>
      <div className="cx-actions">
        <button className="primary" disabled={busy || !form.fullName || !form.username || form.password.length < 8}
          onClick={() => void create()}>Add the account</button>
      </div>
    </div>
  </>;
}

/* ============================================================================
   Transmission mode
   ========================================================================= */

function Mode() {
  const { installation, refresh } = useInstallation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lisName, setLisName] = useState('');

  useEffect(() => { if (installation) setLisName(installation.lisName); }, [installation]);

  async function save(body: Record<string, unknown>, said: string) {
    setBusy(true); setError(null); setMessage(null);
    try {
      await api('/translis/settings', { method: 'PUT', body: JSON.stringify(body) });
      setMessage(said);
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  if (!installation) return <div className="card"><p className="muted">Loading…</p></div>;

  return <>
    <div className="card">
      <div className="section-head"><h3>How this computer receives results</h3></div>
      <div className="ap-choices">
        {installation.modes.map((option: ModeOption) => (
          <button key={option.key} type="button" disabled={busy}
            className={`ap-choice${installation.mode === option.key ? ' is-on' : ''}`}
            onClick={() => void save({ mode: option.key }, `This installation is now ${option.label}.`)}>
            {option.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        {installation.modes.find(m => m.key === installation.mode)?.blurb}
      </p>
      <p className="hint">
        Changing this changes what Analyser Sync &amp; Interfacing offers. It does not alter a link
        that is already configured, and it stops nothing that is running.
      </p>

      {/* The mode also decides what this computer answers on, and that part
          cannot change until it restarts. Saying so is the difference between
          a site that works and a site whose analysers quietly reach nothing. */}
      <div className="cx-rows" style={{ marginTop: 10 }}>
        <Row label="Answering on">
          <code>{installation.network.boundTo}:{installation.network.port}</code>
          {' '}
          {installation.network.reachableFromNetwork
            ? '— reachable from the laboratory network'
            : '— this computer only'}
        </Row>
      </div>
      {installation.network.restartNeeded && (
        <Notice kind="warn">
          Close and reopen TransLis for this to take effect. Until then it is still answering on{' '}
          <code>{installation.network.boundTo}</code>.
        </Notice>
      )}
    </div>

    <div className="card">
      <div className="section-head"><h3>The receiving system</h3></div>
      <p className="hint" style={{ marginTop: 0 }}>
        What this facility's laboratory information system is called. It is used wherever a screen
        would otherwise say "the LIS".
      </p>
      <div className="cx-rows">
        <Row label="Name">
          <input value={lisName} onChange={e => setLisName(e.target.value)} placeholder="LHIMS" />
        </Row>
      </div>
      <div className="cx-actions">
        <button className="primary" disabled={busy || !lisName.trim() || lisName === installation.lisName}
          onClick={() => void save({ lisName }, 'Saved.')}>Save</button>
      </div>
      {message && <Notice kind="success">{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  </>;
}

/* ============================================================================
   Retention
   ========================================================================= */

function Retention() {
  const { installation, refresh } = useInstallation();
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { if (installation) setDays(String(installation.retentionDays)); }, [installation]);

  async function save() {
    setBusy(true); setError(null); setMessage(null);
    try {
      await api('/translis/settings', { method: 'PUT', body: JSON.stringify({ retentionDays: Number(days) }) });
      setMessage(`Results are now kept for ${days} days.`);
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  async function purge() {
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await api<{ messages: number }>('/translis/settings/purge', { method: 'POST' });
      setMessage(result.messages
        ? `Cleared the values from ${result.messages} transmission${result.messages === 1 ? '' : 's'}.`
        : 'Nothing was old enough to clear.');
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  if (!installation) return <div className="card"><p className="muted">Loading…</p></div>;

  return <>
    <div className="card">
      <div className="section-head"><h3>How long results are kept</h3></div>
      <p className="hint" style={{ marginTop: 0 }}>
        TransLis records what an analyser said, because a delivery cannot be queued, retried,
        traced or accounted for otherwise. It has no reason to hold the values once the receiving
        system has them.
      </p>
      <p className="hint">
        Past this age the result values and the raw message are removed. What stays is the proof
        that something was sent: the delivery, its attempts, its acknowledgement, its outcome, its
        trace, the hash of what was transmitted, and the sample identifier as a fingerprint rather
        than a number. A purged transmission cannot be replayed.
      </p>

      <div className="cx-rows">
        <Row label="Keep for">
          <input type="number" min={1} max={3650} value={days} onChange={e => setDays(e.target.value)}
            style={{ width: 100 }} /> days
        </Row>
        <Row label="Waiting to be cleared">
          {installation.retention.overdue > 0
            ? <strong>{installation.retention.overdue} transmission{installation.retention.overdue === 1 ? '' : 's'}</strong>
            : 'Nothing'}
        </Row>
        <Row label="Oldest held">{installation.retention.oldest ?? '—'}</Row>
      </div>

      <div className="cx-actions">
        <button className="primary" disabled={busy || days === String(installation.retentionDays)}
          onClick={() => void save()}>Save</button>
        <button className="secondary" disabled={busy || installation.retention.overdue === 0}
          onClick={() => void purge()}>Clear them now</button>
      </div>
      <p className="hint">
        The sweep also runs on its own, shortly after this computer starts and once a day after
        that, so a host switched off for a week catches up rather than waiting for midnight.
      </p>
      {message && <Notice kind="success">{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  </>;
}
