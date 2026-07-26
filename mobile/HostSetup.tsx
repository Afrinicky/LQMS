/**
 * Host-connection screen (native app).
 *
 * The installed native app is not served by the Host, so it needs to know where
 * the Host is. The user enters the Host address once — a LAN IP on the lab
 * Wi-Fi, a Tailscale address, or a Cloudflare Tunnel URL — and it is saved and
 * reused. The PWA never shows this screen (it is served same-origin).
 */
import { useState } from 'react';
import { setApiBaseOverride, getApiBaseOverride } from '../src/services/api';

const FLASK = 'M9 3h6M10 3v6.5L5.2 17a2 2 0 0 0 1.7 3h10.2a2 2 0 0 0 1.7-3L14 9.5V3M7.5 14h9';

function normalise(input: string): string | null {
  let v = input.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;    // default to http for LAN
  try { const u = new URL(v); return `${u.protocol}//${u.host}`; } catch { return null; }
}

export function HostSetup({ onConnected }: { onConnected: () => void }) {
  const [value, setValue] = useState(getApiBaseOverride() ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function connect() {
    setErr(null);
    const base = normalise(value);
    if (!base) { setErr('Enter a valid address, e.g. 192.168.1.20:4317'); return; }
    setBusy(true);
    try {
      // Verify the Host is reachable before saving, so a typo is caught here.
      const res = await fetch(`${base}/api/health`, { method: 'GET' });
      if (!res.ok) throw new Error(`Host responded ${res.status}`);
      await res.json().catch(() => ({}));
      setApiBaseOverride(base);
      onConnected();
    } catch (e) {
      setErr(`Could not reach the Host at ${base}. Check the address and that you are on the same network. (${(e as Error).message})`);
    } finally { setBusy(false); }
  }

  return (
    <div className="m-login">
      <div className="m-login-card">
        <span className="m-brandmark"><svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">{FLASK.split('M').filter(Boolean).map((s, i) => <path key={i} d={'M' + s} />)}</svg></span>
        <h1>Connect to Host</h1>
        <p className="m-sub">Enter your laboratory Host address. Ask your administrator if you are unsure.</p>
        <label className="m-lbl">Host address</label>
        <input value={value} onChange={e => setValue(e.target.value)} placeholder="192.168.1.20:4317" autoCapitalize="none" autoCorrect="off" inputMode="url" />
        <p className="m-fieldhint" style={{ margin: '6px 0 0' }}>LAN IP (e.g. 192.168.1.20:4317), a Tailscale address, or a https tunnel URL.</p>
        <button className="m-btn primary block" disabled={busy} onClick={connect}>{busy ? 'Connecting…' : 'Connect'}</button>
        {err && <p className="m-err">{err}</p>}
      </div>
      <p className="m-login-foot">SECH_LIMS Staff Companion · by Nickland</p>
    </div>
  );
}
