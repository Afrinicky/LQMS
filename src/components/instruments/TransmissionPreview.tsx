import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { DetailModal } from '../ui';

/* ----------------------------------------------------------------------------
   What the analyser actually sent
   ----------------------------------------------------------------------------
   The waiting list says "16 parameters", which is a count. A bench standing at
   the machine has two questions it cannot answer from a count — is this the run
   I just put on, and is what it sent sensible — and the only way to answer them
   was to take the numbers into the control form and look at them there, which
   is one press away from a control record.

   So the transmission opens first. Every parameter the analyser sent, its
   value, and which of this control's parameters it will fill: the ones that
   match, and the ones the control does not measure, named rather than silently
   dropped. Nothing is taken from it until somebody says so.

   It lives here, rather than on the module's page where it was written, because
   there are two control runs in this system — one in Process Management and one
   on the unit's own portal — and a bench looking at a transmission on one of
   them must be shown exactly what the other shows.
   ------------------------------------------------------------------------- */

/** The little a preview needs to know about a transmission before it reads it. */
export type PreviewMessage = {
  id: number;
  sample_id: string | null;
  lot_number: string | null;
  received_at: string;
  instrument_run_at: string | null;
  source_name?: string | null;
  equipment_name?: string | null;
  status?: string | null;
  status_note?: string | null;
  material_name?: string | null;
  level_label?: string | null;
  test_name?: string | null;
  /** Set when the system read this transmission as another control's. */
  matched_elsewhere?: string | null;
};

export type PreviewMapping = {
  readings: { analyteId: number; analyte: string; value: number | null; qualitativeResult?: string | null; label?: string }[];
  unmatchedLabels: string[];
  missingAnalytes: { analyteId: number; analyte: string }[];
  matched: number;
  /** The transmission itself, with the names behind its ids filled in. */
  message?: PreviewMessage & {
    parsed_values?: Array<{ code?: string; analyte?: string; value?: number | string; unit?: string | null; flag?: string | null }>;
  };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-10-02 08:14:00" written the way a person reads it.
 *
 * Read off the string rather than through a Date, deliberately. These stamps
 * carry no time zone — one is written by the host, the other by the analyser —
 * and putting them through a Date would have the browser apply its own zone to
 * a reading the analyser took in this building. Every other screen in this
 * system shows them as they are stored, and a preview that quietly shifted them
 * by an hour would be the one screen that disagreed with the rest.
 */
function stamp(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(raw);
  if (!parts) return raw || null;
  const [, year, month, dayOf, hour, minute] = parts;
  return `${dayOf} ${MONTHS[Number(month) - 1] ?? month} ${year}, ${hour}:${minute}`;
}

/** Whole days between the two days, or null when either is unreadable. */
function daysApart(a: string | null | undefined, b: string | null | undefined): number | null {
  const at = (value: string | null | undefined) => {
    const found = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim());
    return found ? Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])) : null;
  };
  const left = at(a); const right = at(b);
  if (left === null || right === null) return null;
  return Math.round((right - left) / 86_400_000);
}

const STATE_WORDS: Record<string, string> = {
  matched: 'Waiting to be accepted',
  unmatched: 'Waiting to be accepted',
  accepted: 'Already accepted onto a control run',
  rejected: 'Rejected',
};

export default function TransmissionPreview({ mapUrl, message, onUse, onClose }: {
  /** Where the mapping for this transmission is read from, control and all. */
  mapUrl: string;
  message: PreviewMessage;
  /** Taking its numbers into the form underneath. Omitted where that is not on offer. */
  onUse?: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PreviewMapping | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const next = await api<PreviewMapping>(mapUrl);
        if (live) { setDetail(next); setRefused(null); }
      } catch (e) {
        // A transmission nothing has been matched to still has a date, an
        // analyser and a sample number worth reading — which is most of why
        // somebody opened it. So the window stays, and says what it could not
        // do rather than closing with an error over the page behind it.
        if (live) setRefused(errorText(e));
      }
    })();
    return () => { live = false; };
  }, [mapUrl]);

  /**
   * Which of this control's parameters each transmitted line fills.
   *
   * Keyed on the LABEL the host recognised the reading by as well as on the
   * control's own name for it, because the two are often different: a Sysmex
   * sends PLT, the link maps it to Platelets, and the control calls the
   * parameter PLT. Keying on the control's name alone showed that line as "not
   * measured" while the summary above it counted the same line as filled.
   */
  const filled = new Map<string, { analyte: string; value: number | null; qualitativeResult?: string | null }>();
  for (const reading of detail?.readings ?? []) {
    filled.set(String(reading.analyte).toLowerCase(), reading);
    if (reading.label) filled.set(String(reading.label).toLowerCase(), reading);
  }
  const sent = detail?.message?.parsed_values ?? [];
  const total = (detail?.matched ?? 0) + (detail?.missingAnalytes.length ?? 0);

  const receivedAt = stamp(message.received_at);
  const ranAt = stamp(message.instrument_run_at);
  // Weeks between the two is the normal condition of a stored moving average,
  // not a fault — but it is the reason a list ordered by the analyser's stamp
  // looks like it is full of old controls, so it is said out loud.
  const skew = message.instrument_run_at ? daysApart(message.instrument_run_at, message.received_at) : null;
  /*
   * The control it was READ as — from the transmission's own record where the
   * list that opened it did not carry the name. The newest-few list on the run
   * form carries ids and not names, and reading only from it had a run that was
   * matched perfectly well reported as matching nothing.
   */
  const named = detail?.message?.material_name ?? message.material_name;
  const level = detail?.message?.level_label ?? message.level_label;
  const testName = detail?.message?.test_name ?? message.test_name;
  const analyser = detail?.message?.source_name ?? message.source_name;
  const instrument = detail?.message?.equipment_name ?? message.equipment_name;
  const control = named ? `${named}${level ? ` — ${level}` : ''}` : null;

  return (
    <DetailModal
      open onClose={onClose}
      title={<>{message.sample_id || 'control sample'}</>}
      subtitle={
        <>
          {analyser ? `${analyser} · ` : ''}
          {receivedAt ? `reached SECHLIMS ${receivedAt}` : 'arrival time not recorded'}
        </>
      }
      footer={
        <>
          <button type="button" className="secondary" onClick={onClose}>Close</button>
          {onUse && (
            <button type="button" disabled={busy || !detail} onClick={() => { setBusy(true); void onUse(); }}>
              {busy ? <Loader2 size={13} className="pd-spin" /> : <ArrowRight size={13} />} Use these
            </button>
          )}
        </>
      }>
      {/* Everything that is known about the transmission itself, which is
          readable whether or not a control could be mapped onto it. A bench
          deciding whether this is the run they just transmitted asks for the
          time it arrived before it asks for anything else. */}
      <dl className="iqc-tx-facts">
        <div><dt>Reached SECHLIMS</dt><dd>{receivedAt ?? '—'}</dd></div>
        <div>
          <dt>Stamped by the analyser</dt>
          <dd>{ranAt ?? <span className="muted">not stated in the transmission</span>}</dd>
        </div>
        <div><dt>Analyser</dt><dd>{analyser || <span className="muted">unnamed link</span>}</dd></div>
        {instrument && <div><dt>Instrument</dt><dd>{instrument}</dd></div>}
        <div><dt>Sample identifier</dt><dd>{message.sample_id || <span className="muted">none sent</span>}</dd></div>
        <div><dt>Lot</dt><dd>{message.lot_number || <span className="muted">none sent</span>}</dd></div>
        <div>
          <dt>Read as</dt>
          <dd>{control ?? <span className="muted">no registered control matched it</span>}
            {testName ? <span className="muted"> · {testName}</span> : null}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{STATE_WORDS[String(message.status ?? '')] ?? message.status ?? '—'}</dd>
        </div>
      </dl>

      {skew !== null && Math.abs(skew) >= 1 && (
        <p className="iqc-tx-skew">
          <AlertTriangle size={12} />
          The analyser stamped this {Math.abs(skew)} day{Math.abs(skew) === 1 ? '' : 's'}
          {skew > 0 ? ' before' : ' after'} it reached this host. That is ordinary for a stored moving average
          such as X-bar M, and worth checking on the analyser&rsquo;s clock otherwise. Lists here are ordered by
          arrival, so a run sent today is at the top whatever the machine stamped it.
        </p>
      )}

      {message.matched_elsewhere && (
        <p className="iqc-tx-skew">
          <AlertTriangle size={12} /> This was read as {message.matched_elsewhere}&rsquo;s run. Taking it here
          maps its readings onto the control you are running.
        </p>
      )}
      {message.status_note && <p className="muted">{message.status_note}</p>}

      {refused ? (
        <p className="iqc-note bad">{refused}</p>
      ) : !detail ? <p className="muted">Reading the transmission…</p> : (
        <>
          <p className="iqc-tx-summary">
            <strong>{detail.matched} of {total} of this control&rsquo;s parameters</strong> would be filled in
            from the {sent.length} the analyser sent.
            {detail.missingAnalytes.length > 0 && (
              <span> Still to enter afterwards: {detail.missingAnalytes.map(a => a.analyte).join(', ')}.</span>
            )}
          </p>

          {sent.length === 0 ? (
            <p className="muted">
              This transmission carries no readable parameters. Its raw text is kept in full under the
              analyser link&rsquo;s Messages.
            </p>
          ) : (
            <table className="iqc-tx-table">
              <thead>
                <tr><th>Parameter</th><th>Result</th><th>Fills</th></tr>
              </thead>
              <tbody>
                {sent.map((value, index) => {
                  const name = String(value.analyte ?? value.code ?? '').trim();
                  const match = filled.get(name.toLowerCase())
                    ?? filled.get(String(value.code ?? '').trim().toLowerCase());
                  return (
                    <tr key={`${name}-${index}`} className={match ? 'is-used' : ''}>
                      <td>
                        <strong>{name || '—'}</strong>
                        {value.code && value.code !== name && <span className="muted"> {value.code}</span>}
                      </td>
                      <td>
                        {String(value.value ?? '—')}
                        {value.unit ? <span className="muted"> {value.unit}</span> : null}
                        {value.flag && value.flag !== 'N' ? <span className="badge warning">{value.flag}</span> : null}
                      </td>
                      <td>
                        {match
                          ? <span className="iqc-tx-fills">{match.analyte}</span>
                          : <span className="muted">not measured by this control</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </DetailModal>
  );
}
