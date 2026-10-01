import { useCallback, useEffect, useState } from 'react';
import { Loader2, Radio } from 'lucide-react';
import { api, errorText } from '../services/api';
import { useAnalyserListen, type Watermark } from '../hooks/useAnalyserListen';

/**
 * "Fetch from analyser", for any screen that would otherwise ask somebody to
 * type readings the machine has already sent.
 *
 * It is the same act everywhere, so it is the same control everywhere: choose
 * the analyser when the guess is wrong, press once, and the screen stands ready
 * until a transmission lands. Pressing it does not pull — an analyser that
 * dials in decides for itself when to send, and a button that pretends
 * otherwise is a button people stop believing. It opens the door and says so.
 *
 * What arrives is handed to the caller as parsed values under this system's own
 * analyte names. Nothing is saved: the screen fills in, and a person still
 * presses save.
 */

export type AnalyserLink = {
  id: number; name: string; equipmentName: string | null;
  state: string; lastMessageAt: string | null;
  open: boolean; canFetch: boolean; suggested: boolean;
};

export type AnalyserReading = { code?: string; analyte?: string; value?: number | string; unit?: string | null };

export type AnalyserMessage = {
  id: number; sample_id: string | null; lot_number: string | null;
  received_at: string; instrument_run_at: string | null;
  kind: string; result_count: number;
  parsed_values: AnalyserReading[];
};

export default function AnalyserFetch({ module, equipmentId, sectionId, kind, label, onArrive, onError }: {
  /**
   * The module's API prefix as it is mounted, e.g. "eqa" or
   * "verification-validation" — hyphens, not the permission key. It carries
   * that module's own view right.
   */
  module: string;
  /** The instrument this work names, used only as the first guess. */
  equipmentId?: number | null;
  sectionId?: number | null;
  /** Limit to 'patient' or 'control' transmissions, or leave for both. */
  kind?: 'patient' | 'control';
  label?: string;
  onArrive: (message: AnalyserMessage) => void | Promise<void>;
  onError?: (message: string) => void;
}) {
  const [links, setLinks] = useState<AnalyserLink[] | null>(null);
  const [linkId, setLinkId] = useState('');

  useEffect(() => {
    const query = new URLSearchParams();
    if (equipmentId) query.set('equipmentId', String(equipmentId));
    if (sectionId) query.set('sectionId', String(sectionId));
    api<AnalyserLink[]>(`/${module}/analyser/links?${query}`)
      .then(rows => {
        setLinks(rows);
        // The likeliest machine, chosen for them; still a dropdown when wrong.
        setLinkId(String(rows.find(l => l.suggested && l.open)?.id ?? rows.find(l => l.open)?.id ?? rows[0]?.id ?? ''));
      })
      .catch(() => setLinks([]));
  }, [module, equipmentId, sectionId]);

  const chosen = (links ?? []).find(l => String(l.id) === linkId) ?? null;

  const poll = useCallback(async (since: Watermark) => {
    const query = new URLSearchParams({ linkId, since: String(since.patient) });
    if (kind) query.set('kind', kind);
    return api<AnalyserMessage[]>(`/${module}/analyser/messages?${query}`);
  }, [module, linkId, kind]);

  const listen = useAnalyserListen<AnalyserMessage>({
    arm: () => api<{ listening: boolean; since: Watermark; note: string }>(
      `/${module}/analyser/listen`, { method: 'POST', body: JSON.stringify({ linkId: Number(linkId) }) }),
    poll,
    onArrival: async message => {
      try { await onArrive(message); }
      catch (e) { onError?.(errorText(e)); }
    },
  });

  // Nothing is set up to transmit yet. The button still stands, disabled and
  // saying so: a control that appears only once the configuration is right
  // cannot be found by the person who needs to fix the configuration.
  const none = links !== null && links.length === 0;

  return (
    <div className="af">
      <div className="af-row">
        {(links ?? []).length > 1 && (
          <select className="af-pick" value={linkId} onChange={e => setLinkId(e.target.value)}>
            {(links ?? []).map(l => (
              <option key={l.id} value={l.id}>{l.name}{l.equipmentName ? ` · ${l.equipmentName}` : ''}</option>
            ))}
          </select>
        )}
        <button type="button" className={`iqc-fetch${listen.waiting ? ' is-waiting' : ''}`}
          disabled={!linkId}
          title={none ? 'No analyser link is set up yet' : undefined}
          onClick={() => (listen.waiting ? listen.stop() : void listen.start())}>
          {listen.waiting
            ? <><Loader2 size={13} className="pd-spin" /> Waiting… {listen.remaining}s</>
            : <><Radio size={13} /> {label ?? 'Fetch from analyser'}</>}
        </button>
      </div>
      {listen.waiting && (
        <p className="iqc-listening">
          <span className="iqc-pulse" />
          Ready. Send it from {chosen?.name ?? 'the analyser'} and the results drop in here.
        </p>
      )}
      {none && (
        <p className="iqc-hint">
          No analyser is set up on this system yet, so there is nothing to fetch from. One is added under
          Settings &rarr; Analyser Links.
        </p>
      )}
      {!listen.waiting && listen.note && <p className="iqc-hint">{listen.note}</p>}
      {listen.problem && <p className="iqc-hint crit">{listen.problem}</p>}
      {chosen && !chosen.open && !listen.waiting && !listen.note && (
        <p className="iqc-hint">Nothing will arrive on {chosen.name}: it is a link LHIMS owns.</p>
      )}
    </div>
  );
}
