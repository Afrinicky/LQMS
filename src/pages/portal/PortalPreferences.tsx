import { useCallback, useEffect, useState } from 'react';
import { BellRing, Play, Volume2 } from 'lucide-react';
import { api } from '../../services/api';
import { playSound, primeAudio } from '../../services/sound';
import { SOUND_EVENT_LABELS, SOUND_EVENTS, type SoundEvent } from '../../../shared/constants/activities';
import { titleCase, usePortal } from './portalData';
import type { NotificationPreference, NotificationSound } from '../../../shared/types/api';

/**
 * My preferences — how this laboratory reaches this person.
 *
 * Two settings, both personal and neither needing anyone's permission: which
 * areas may raise an alert for me, and what my device does when one arrives.
 * Silencing your own bench computer at two in the morning is not an
 * administrative decision, so it is not gated like one.
 */
const PREF_MODULES = [
  'actions', 'documents', 'personnel', 'equipment', 'supplier_inventory', 'monitoring',
  'iqc', 'eqa', 'verification_validation', 'measurement_uncertainty', 'blood_bank_handover',
  'monthly_reports', 'assessments', 'meetings', 'management_review', 'quality_indicators',
  'continual_improvement', 'customer_focus', 'poct', 'nc_capa', 'risks', 'complaints',
  'facilities_safety', 'process_management', 'information_management', 'organisation',
];

type SoundSettings = {
  effective: Record<string, unknown>;
  user: Record<string, unknown> | null;
  sounds: NotificationSound[];
};

export default function PortalPreferences() {
  const { setError, setNotice } = usePortal();
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [sound, setSound] = useState<SoundSettings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    await Promise.all([
      api<NotificationPreference[]>('/notifications/preferences').then(setPrefs).catch(() => setPrefs([])),
      api<SoundSettings>('/duty/sound-settings').then(setSound).catch(() => setSound(null)),
    ]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const flag = (moduleKey: string, field: 'in_app_enabled' | 'digest_enabled' | 'email_enabled' | 'sms_enabled') => {
    const row = prefs.find(p => p.module_key === moduleKey);
    if (!row) return field === 'in_app_enabled';
    return !!row[field];
  };

  function setFlag(moduleKey: string, field: 'in_app_enabled' | 'digest_enabled' | 'email_enabled' | 'sms_enabled', value: boolean) {
    setPrefs(prev => {
      const i = prev.findIndex(p => p.module_key === moduleKey);
      if (i === -1) {
        return [...prev, {
          id: 0, module_key: moduleKey, created_at: '',
          in_app_enabled: field === 'in_app_enabled' ? (value ? 1 : 0) : 1,
          digest_enabled: field === 'digest_enabled' ? (value ? 1 : 0) : 0,
          email_enabled: field === 'email_enabled' ? (value ? 1 : 0) : 0,
          sms_enabled: field === 'sms_enabled' ? (value ? 1 : 0) : 0,
        } as NotificationPreference];
      }
      const copy = [...prev];
      copy[i] = { ...copy[i], [field]: value ? 1 : 0 };
      return copy;
    });
  }

  async function savePrefs() {
    setSaving(true);
    try {
      const payload = PREF_MODULES.map(m => ({
        moduleKey: m,
        inAppEnabled: flag(m, 'in_app_enabled'),
        digestEnabled: flag(m, 'digest_enabled'),
        emailEnabled: flag(m, 'email_enabled'),
        smsEnabled: flag(m, 'sms_enabled'),
      }));
      await api('/notifications/preferences', { method: 'PUT', body: JSON.stringify({ preferences: payload }) });
      await load();
      setNotice('Your alert preferences have been saved.');
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }

  async function saveSound(patch: Record<string, unknown>) {
    try {
      const next = await api<SoundSettings>('/duty/sound-settings', { method: 'PUT', body: JSON.stringify(patch) });
      setSound(s => (s ? { ...s, ...next } : s));
    } catch (e) { setError((e as Error).message); }
  }

  async function followLaboratory() {
    try { await api('/duty/sound-settings', { method: 'DELETE' }); await load(); setNotice('Your device now follows the laboratory’s reminder settings.'); }
    catch (e) { setError((e as Error).message); }
  }

  const eff = (sound?.effective ?? {}) as Record<string, number | string | null>;
  const num = (key: string, fallback: number) => (typeof eff[key] === 'number' ? (eff[key] as number) : fallback);

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><BellRing size={16} /> Which areas may alert me</h3>
            <p>
              Turn an area off and it stops raising alerts for you. It does not change what you may
              open — only what interrupts you. Email and SMS are recorded but not yet delivered.
            </p>
          </div>
          <button type="button" onClick={() => void savePrefs()} disabled={saving}>
            {saving ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
        <div className="pp-scroll">
          <table className="data-table">
            <thead><tr><th>Area</th><th>In app</th><th>Daily digest</th><th>Email</th><th>SMS</th></tr></thead>
            <tbody>
              {PREF_MODULES.map(m => (
                <tr key={m}>
                  <td>{titleCase(m)}</td>
                  {(['in_app_enabled', 'digest_enabled', 'email_enabled', 'sms_enabled'] as const).map(field => (
                    <td key={field}>
                      <input type="checkbox" checked={flag(m, field)} onChange={e => setFlag(m, field, e.target.checked)}
                        aria-label={`${titleCase(m)} — ${field.replace(/_enabled$/, '').replace(/_/g, ' ')}`} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {sound && (
        <section className="portal-panel">
          <div className="pp-head">
            <div>
              <h3><Volume2 size={16} /> My reminder sounds</h3>
              <p>
                What this device does when work arrives for you. These settings are yours alone
                {sound.user ? '' : ' — you are currently following the laboratory’s defaults'}.
              </p>
            </div>
            {sound.user && <button type="button" className="secondary" onClick={() => void followLaboratory()}>Follow the laboratory again</button>}
          </div>

          <div className="pp-row-controls">
            <label className="pp-check">
              <input type="checkbox" checked={num('enabled', 1) === 1}
                onChange={e => { primeAudio(); void saveSound({ enabled: e.target.checked }); }} />
              <span>Play a sound when something needs me</span>
            </label>
            <label className="pp-check">
              <input type="checkbox" checked={num('daily_briefing_enabled', 1) === 1}
                onChange={e => void saveSound({ dailyBriefingEnabled: e.target.checked })} />
              <span>Show me the morning briefing</span>
            </label>
            <label className="pp-field">
              <span>Volume</span>
              <input type="range" min={0} max={1} step={0.05} value={num('volume', 0.6)}
                onChange={e => void saveSound({ volume: Number(e.target.value) })} />
            </label>
            <label className="pp-field">
              <span>Quiet from</span>
              <input type="time" value={String(eff.quiet_hours_start ?? '')} onChange={e => void saveSound({ quietHoursStart: e.target.value })} />
            </label>
            <label className="pp-field">
              <span>Quiet until</span>
              <input type="time" value={String(eff.quiet_hours_end ?? '')} onChange={e => void saveSound({ quietHoursEnd: e.target.value })} />
            </label>
          </div>

          <table className="data-table">
            <thead><tr><th>When</th><th>Plays</th><th /></tr></thead>
            <tbody>
              {SOUND_EVENTS.map(event => {
                const field = `sound_${event}`;
                const current = String(eff[field] ?? '');
                const paramKey = `sound${event.charAt(0).toUpperCase()}${event.slice(1)}`;
                return (
                  <tr key={event}>
                    <td>{SOUND_EVENT_LABELS[event as SoundEvent]}</td>
                    <td>
                      <select value={current} onChange={e => { primeAudio(); void saveSound({ [paramKey]: e.target.value }); }}>
                        {sound.sounds.map(s => <option key={s.sound_key} value={s.sound_key}>{s.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <button type="button" className="link-button" onClick={() => { primeAudio(); playSound(current); }}>
                        <Play size={12} /> Hear it
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
