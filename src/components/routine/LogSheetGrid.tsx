import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, ClipboardList, Download, FileSpreadsheet,
  FileWarning, History, Loader2, Lock, Paperclip, Printer, RefreshCw, ScanLine,
  Signature, TrendingDown, TrendingUp, Trash2, Upload, X,
} from 'lucide-react';
import { api, API_BASE, getToken, errorText } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import { useSignatureOnFile, NO_SIGNATURE_HINT } from '../../hooks/useSignatureOnFile';
import TextField from '../ui/TextField';
import {
  SLOT_LABELS, CELL_STATUS_LABELS, CELL_SOURCE_LABELS, SHEET_STATUS_LABELS, SHEET_STATUS_HINTS,
  EXTRACTION_STATUS_LABELS, SHEET_KIND_MODULE, monthLabel, cellIsBreach,
  type CellSlot, type SheetKind,
} from '../../../shared/constants/routineWork';
import type {
  LogSheetPayload, LogSheetRow, LogSheetCell, LogCellInput, SaveCellsOutcome, SheetTrend,
} from '../../../shared/types/api';

/**
 * The monthly log sheet, on screen.
 *
 * This draws the laboratory's own form: the days of the month across the top,
 * what is being recorded down the side, AM and PM where the paper has them, and
 * an initial in every cell. A supervisor who has signed the paper chart for
 * years should recognise it at a glance, because a screen that reorganises a
 * familiar record into something "cleaner" is a screen people work around.
 *
 * Three decisions shape it.
 *
 * ONE CELL AT A TIME, SAVED AT ONCE. Charting is done standing at a fridge with
 * a thermometer, not sitting at a form. So a cell is typed and committed on
 * blur or Enter — no Save button to forget, no draft to lose when somebody else
 * needs the terminal. An out-of-range value comes straight back marked, with
 * the excursion already raised, while the person is still in front of the
 * instrument and can do something about it.
 *
 * MISSING IS VISIBLE. A blank cell is hatched, not empty. The whole value of a
 * chart is that it shows what was not done, and a grid of white boxes hides
 * exactly that.
 *
 * THE MONTH IS THE RECORD. Under the grid is what the supervisor actually needs
 * to sign: how much is recorded, what is out of range, what was never done. And
 * once it is signed the grid locks — a correction after that takes a
 * nonconformity, because changing a record somebody has attested to without
 * saying so is the one thing a QMS cannot allow.
 *
 * TIME RUNS ONE WAY. A cell for a day that has not happened is not an early
 * entry, it is a reading nobody took, so those cells are not clickable and say
 * why. The PM column of today opens when the afternoon reading is actually due,
 * because two readings taken together at 08:05 measure one moment twice and
 * hide the whole afternoon. Correcting or withdrawing today's entry is ordinary
 * work; changing one whose day has ended takes a supervisor and a written
 * reason, and the original stays legible beside it.
 *
 * The server decides all of that — this only stops somebody typing into a cell
 * that would be refused, which is a courtesy, not the control.
 */

const DAY_WIDTH = 34;

/** Minutes past midnight, locally — the clock the person at the fridge reads. */
function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

const clockLabel = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

type Props = {
  sheetId: number;
  /** Refetch anything outside this component that shows the same month. */
  onChanged?: () => void;
  /** Hide the verification block — the portal shows the grid, not the sign-off. */
  hideVerification?: boolean;
  compact?: boolean;
};

export default function LogSheetGrid({ sheetId, onChanged, hideVerification, compact }: Props) {
  const [data, setData] = useState<LogSheetPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [showVerify, setShowVerify] = useState(false);
  const { hasSignature } = useSignatureOnFile();

  const load = useCallback(async () => {
    try { setData(await api<LogSheetPayload>(`/routine-sheets/${sheetId}`)); setProblem(null); }
    catch (e) { setProblem(errorText(e)); }
    finally { setLoading(false); }
  }, [sheetId]);

  useEffect(() => { void load(); }, [load]);

  const cellIndex = useMemo(() => {
    const map = new Map<string, LogSheetCell>();
    for (const cell of data?.cells ?? []) map.set(`${cell.row_id}:${cell.day}:${cell.slot}`, cell);
    return map;
  }, [data]);

  const save = useCallback(async (cells: LogCellInput[]) => {
    if (!cells.length) return;
    setBusy('save'); setProblem(null);
    try {
      const result = await api<LogSheetPayload & SaveCellsOutcome>(
        `/routine-sheets/${sheetId}/cells`, { method: 'POST', body: JSON.stringify({ cells }) });
      setData(result);
      // A refusal is reported, never swallowed. Somebody who believes they
      // charted a reading they did not is worse off than somebody told plainly
      // that they cannot chart it yet.
      if (result.refused?.length) {
        setProblem(result.refused[0].reason);
        setNotice(null);
      } else if (result.breaches?.length) {
        setProblem(null);
        const first = result.breaches[0];
        setNotice(`${first.label}, day ${first.day}: ${first.value} is out of range. An excursion has been raised — add a note to the cell.`);
      } else {
        setProblem(null);
        setNotice(result.cleared ? 'Entry withdrawn.' : result.amended ? 'Entry amended.' : null);
      }
      onChanged?.();
    } catch (e) { setProblem(errorText(e)); }
    finally { setBusy(null); }
  }, [sheetId, onChanged]);

  if (loading) return <p className="muted">Opening the sheet…</p>;
  if (!data) return <p className="pd-error"><AlertTriangle size={13} /> {problem ?? 'That sheet could not be opened.'}</p>;

  const { sheet, rows, completeness, permissions } = data;
  const editable = Boolean(permissions?.canRecord) && !sheet.locked;
  const mayAmend = Boolean(permissions?.canVerify);
  const days = Array.from({ length: sheet.days }, (_, i) => i + 1);
  const daily = rows.filter(r => r.cadence !== 'weekly');
  const weekly = rows.filter(r => r.cadence === 'weekly');
  const today = new Date();
  // Local date, which is the date the person at the fridge is standing in — the
  // ISO string is UTC and would open tomorrow's column an hour early in Accra
  // and close today's early elsewhere.
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const currentMonth = localToday.slice(0, 7) === sheet.month;
  const todayDay = currentMonth ? today.getDate() : null;
  // A month wholly in the past has no future cells; a future month has nothing
  // but. `null` means every day of this sheet has already happened.
  const lastOpenDay = localToday.slice(0, 7) > sheet.month ? sheet.days
    : currentMonth ? today.getDate() : 0;
  const pmOpen = nowMinutes() >= (sheet.pmOpensAt ?? 15 * 60);

  return (
    <div className={`ls-wrap${compact ? ' is-compact' : ''}`}>
      <header className="ls-head">
        <div>
          <h4>{sheet.title}</h4>
          <p className="ls-sub">
            {sheet.sectionName ? `${sheet.sectionName} · ` : ''}{monthLabel(sheet.month)}
            {sheet.subtitle ? ` · ${sheet.subtitle}` : ''}
          </p>
        </div>
        <div className="ls-head-right">
          <span className={`ls-status s-${sheet.status}`} title={SHEET_STATUS_HINTS[sheet.status]}>
            {sheet.locked && <Lock size={11} />} {SHEET_STATUS_LABELS[sheet.status]}
          </span>
          <SheetActions sheet={sheet} editable={editable} onReload={load} onProblem={setProblem} />
        </div>
      </header>

      {sheet.locked && (
        <div className="ls-locked">
          <Lock size={12} />
          <div className="ls-locked-text">
            Signed {String(sheet.verified_at ?? '').slice(0, 10)}
            {sheet.verifiedByName ? ` by ${sheet.verifiedByName}` : ''}. Corrections require a nonconformity.
            {sheet.verification_comments && <span className="ls-locked-note">{sheet.verification_comments}</span>}
          </div>
          {/* The signature itself, not just who typed their name. A verified
              month is expected to carry it, on screen as on the paper form. */}
          {sheet.signature?.image && (
            <figure className="ls-sig">
              <img src={sheet.signature.image} alt={`Signature of ${sheet.verifiedByName ?? sheet.signature.signer_name ?? 'the reviewer'}`} />
              <figcaption>E-SIG-{sheet.signature.id}</figcaption>
            </figure>
          )}
        </div>
      )}
      {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      {notice && (
        <p className="ls-breach-note">
          <AlertTriangle size={13} /> {notice}
          <button type="button" className="pq-link" onClick={() => setNotice(null)}>Dismiss</button>
        </p>
      )}

      {completeness.needsReview > 0 && (
        <ExtractionReview sheetId={sheetId} count={completeness.needsReview} note={sheet.extraction_note} onDone={load} />
      )}

      <div className="ls-scroll" style={{ ['--ls-day' as string]: `${DAY_WIDTH}px` }}>
        {daily.length > 0 && (
          <table className="ls-grid">
            <thead>
              <tr>
                <th className="ls-rowhead">Entry</th>
                <th className="ls-slot" />
                {days.map(d => (
                  <th key={d} className={d === todayDay ? 'is-today' : ''}>{d}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {daily.map(row => (
                <RowBlock key={row.id} row={row} days={days} todayDay={todayDay}
                  cellIndex={cellIndex} editable={editable} onSave={save}
                  lastOpenDay={lastOpenDay} pmOpen={pmOpen}
                  pmOpensAt={sheet.pmOpensAt ?? 15 * 60} pmDueAt={sheet.pmDueAt ?? 16 * 60}
                  mayAmend={mayAmend}
                  noteFor={noteFor} setNoteFor={setNoteFor} />
              ))}
            </tbody>
          </table>
        )}

        {weekly.length > 0 && (
          <table className="ls-grid ls-weeks">
            <thead>
              <tr>
                <th className="ls-rowhead">Weekly &amp; monthly</th>
                {['Week 1', 'Week 2', 'Week 3', 'Week 4', 'Week 5'].map(w => <th key={w}>{w}</th>)}
              </tr>
            </thead>
            <tbody>
              {weekly.map(row => (
                <tr key={row.id}>
                  <th className="ls-rowhead" title={row.label}>{row.label}</th>
                  {[1, 2, 3, 4, 5].map(week => {
                    const slot = (row.slots.length === 1 ? row.slots[0] : row.slots[week - 1] ?? `w${week}`) as CellSlot;
                    // A week that has not started yet cannot be ticked: a
                    // monthly service recorded for week 5 on the 3rd is not an
                    // early entry, it is a service nobody performed.
                    const weekStarted = lastOpenDay >= (week - 1) * 7 + 1;
                    return (
                      <CellBox key={week} row={row} day={week} slot={slot}
                        cell={cellIndex.get(`${row.id}:${week}:${slot}`)}
                        editable={editable} onSave={save} wide
                        closed={!weekStarted}
                        closedReason={`Week ${week} has not started`}
                        sameDay={false} mayAmend={mayAmend}
                        noteFor={noteFor} setNoteFor={setNoteFor} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {rows.length === 0 && (
          <p className="muted">
            This sheet has no rows yet. Set the parameters on the asset, or add maintenance tasks to the instrument.
          </p>
        )}
      </div>

      <Legend />

      <TrendPanel trends={data.trends ?? []} />

      <MonthSummary data={data} />

      {!hideVerification && permissions?.canVerify && !sheet.locked && (
        <div className="ls-verify-bar">
          {/* Said before the form is filled in rather than after it is submitted:
              the server refuses to sign for anybody with no signature on file. */}
          <button type="button" className="ls-primary" disabled={hasSignature === false}
            title={hasSignature === false ? NO_SIGNATURE_HINT : undefined}
            onClick={() => setShowVerify(true)}>
            <Signature size={14} /> Review and sign off {monthLabel(sheet.month)}
          </button>
          {hasSignature === false && <span className="ls-nosig">{NO_SIGNATURE_HINT}</span>}
          {sheet.status === 'submitted' && (
            <button type="button" className="pq-link" disabled={busy === 'reopen'}
              onClick={async () => {
                setBusy('reopen');
                try { setData(await api(`/routine-sheets/${sheetId}/reopen`, { method: 'POST' })); }
                catch (e) { setProblem(errorText(e)); } finally { setBusy(null); }
              }}>Put it back into use</button>
          )}
        </div>
      )}

      {!hideVerification && editable && sheet.status === 'open' && completeness.monthEnded && (
        <p className="ls-submit-hint">
          {monthLabel(sheet.month)} has ended.{' '}
          <button type="button" className="pq-link" disabled={busy === 'submit'}
            onClick={async () => {
              setBusy('submit');
              try { setData(await api(`/routine-sheets/${sheetId}/submit`, { method: 'POST' })); onChanged?.(); }
              catch (e) { setProblem(errorText(e)); } finally { setBusy(null); }
            }}>Submit it to the supervisor</button>{' '}
          so it can be verified and filed.
        </p>
      )}

      {showVerify && (
        <VerifyDialog sheetId={sheetId} data={data} onClose={() => setShowVerify(false)}
          onDone={next => { setData(next); setShowVerify(false); onChanged?.(); }} />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   One row of the sheet — one line per slot, with an initials line under it,
   exactly as the paper form has it
   ------------------------------------------------------------------------- */
function RowBlock({ row, days, todayDay, cellIndex, editable, onSave, lastOpenDay, pmOpen,
  pmOpensAt, pmDueAt, mayAmend, noteFor, setNoteFor }: {
  row: LogSheetRow; days: number[]; todayDay: number | null;
  cellIndex: Map<string, LogSheetCell>;
  editable: boolean; onSave: (cells: LogCellInput[]) => void;
  /** The last day of this month that has actually happened. */
  lastOpenDay: number;
  /** Whether the afternoon reading is due yet, by the laboratory's own clock. */
  pmOpen: boolean;
  pmOpensAt: number; pmDueAt: number;
  mayAmend: boolean;
  noteFor: string | null; setNoteFor: (key: string | null) => void;
}) {
  return (
    <>
      {row.slots.map((slot, index) => (
        <tr key={slot} className={index === 0 ? 'ls-row-first' : ''}>
          {index === 0 && (
            <th className="ls-rowhead" rowSpan={row.slots.length} title={row.label}>
              {row.label}
              {row.unit && <span className="ls-unit">{row.unit}</span>}
            </th>
          )}
          <th className="ls-slot">{SLOT_LABELS[slot as CellSlot] ?? slot}</th>
          {days.map(day => {
            // Three states, and they are not the same. A future day is closed
            // outright. Today's PM is closed until the afternoon. Everything
            // else is open, and whether it is today decides whether changing it
            // is ordinary work or an amendment.
            const future = day > lastOpenDay;
            const earlyPm = !future && day === todayDay && slot === 'pm' && !pmOpen;
            return (
              <CellBox key={day} row={row} day={day} slot={slot as CellSlot}
                cell={cellIndex.get(`${row.id}:${day}:${slot}`)}
                editable={editable} onSave={onSave} isToday={day === todayDay}
                closed={future || earlyPm}
                closedReason={future
                  ? 'Not yet due'
                  : `Afternoon reading due at ${clockLabel(pmDueAt)} — opens from ${clockLabel(pmOpensAt)}`}
                sameDay={day === todayDay}
                mayAmend={mayAmend}
                noteFor={noteFor} setNoteFor={setNoteFor} />
            );
          })}
        </tr>
      ))}
    </>
  );
}

/* ----------------------------------------------------------------------------
   One cell
   ------------------------------------------------------------------------- */
function CellBox({ row, day, slot, cell, editable, onSave, isToday, wide, closed, closedReason,
  sameDay, mayAmend, noteFor, setNoteFor }: {
  row: LogSheetRow; day: number; slot: CellSlot; cell?: LogSheetCell;
  editable: boolean; onSave: (cells: LogCellInput[]) => void;
  isToday?: boolean; wide?: boolean;
  /** The day, or the afternoon, has not arrived. Nothing may be written here. */
  closed?: boolean;
  closedReason?: string;
  /** Whether this cell belongs to today, which decides correction vs amendment. */
  sameDay?: boolean;
  /** Whether the reader may change an entry whose day has ended. */
  mayAmend?: boolean;
  noteFor: string | null; setNoteFor: (key: string | null) => void;
}) {
  const key = `${row.id}:${day}:${slot}`;
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [amending, setAmending] = useState<{ value: string; clear: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);

  // Writable is narrower than editable: the sheet may be open and this
  // particular cell still shut, because its day has not happened.
  const writable = editable && !closed;
  const amended = Number(cell?.amendment_count ?? 0) > 0;

  const breach = cell ? cellIsBreach(cell.status) : false;
  const classes = [
    'ls-cell',
    !cell ? 'is-blank' : '',
    breach ? 'is-breach' : '',
    cell?.status === 'warning' ? 'is-warn' : '',
    cell?.status === 'na' ? 'is-na' : '',
    cell?.needs_review ? 'is-review' : '',
    isToday ? 'is-today' : '',
    wide ? 'is-wide' : '',
    closed ? 'is-closed' : '',
    amended ? 'is-amended' : '',
  ].filter(Boolean).join(' ');

  const title = closed
    ? `${row.label} — day ${day} ${SLOT_LABELS[slot] ?? slot}: ${closedReason ?? 'not open for recording yet'}`
    : cell
      ? [
          `${row.label} — day ${day} ${SLOT_LABELS[slot] ?? slot}`,
          CELL_STATUS_LABELS[cell.status as keyof typeof CELL_STATUS_LABELS] ?? cell.status,
          cell.reading_time ? `read at ${cell.reading_time}` : null,
          cell.recorded_by_name ? `by ${cell.recorded_by_name}` : null,
          CELL_SOURCE_LABELS[cell.source as keyof typeof CELL_SOURCE_LABELS] ?? cell.source,
          cell.note ? `Note: ${cell.note}` : null,
          amended ? `Amended ${String(cell.last_amended_at ?? '').slice(0, 10)}: ${cell.last_amend_reason ?? ''}` : null,
          cell.needs_review ? 'Read off the attached chart — confirm it.' : null,
        ].filter(Boolean).join(' · ')
      : `${row.label} — day ${day} ${SLOT_LABELS[slot] ?? slot}: nothing recorded`;

  /** Turn what was typed into the write the server expects. */
  function inputFor(value: string, amendReason?: string): LogCellInput | null {
    const text = value.trim();
    if (!text) return null;
    const upper = text.toUpperCase();
    const base = { rowId: row.id, day, slot, ...(amendReason ? { amendReason } : {}) };
    if (upper === 'NA' || upper === 'N/A') return { ...base, na: true };
    if (row.row_type === 'numeric') {
      const num = Number(text);
      return Number.isNaN(num) ? null : { ...base, value: num };
    }
    if (row.row_type === 'text') return { ...base, text };
    return { ...base, done: !['N', 'NO', 'X'].includes(upper) };
  }

  function commit(value: string) {
    setEditing(false);
    const text = value.trim();
    if (!text) return;
    // Changing an entry whose day has ended is an amendment, not a correction:
    // ask for the reason here rather than letting the server refuse it and
    // making somebody retype the number.
    if (cell && !sameDay) {
      if (!mayAmend) return;
      setAmending({ value: text, clear: false });
      return;
    }
    const input = inputFor(text);
    if (input) onSave([input]);
  }

  /**
   * Withdraw the entry.
   *
   * On the day, that is ordinary: the wrong box, a value typed against the
   * wrong fridge. Afterwards it takes the reason and the amendment trail, the
   * same as changing it — a deletion is the largest change there is.
   */
  function withdraw() {
    if (!cell || !writable) return;
    if (sameDay) { onSave([{ rowId: row.id, day, slot, clear: true }]); return; }
    if (mayAmend) setAmending({ value: '', clear: true });
  }

  // A tick row does not need a text box: one click is done, a second is
  // "not done", a third clears the assertion. That is three states in the
  // place a paper form has a tick and a blank.
  function cycleTick() {
    if (!writable) return;
    if (!cell) { onSave([{ rowId: row.id, day, slot, done: true }]); return; }
    if (!sameDay) {
      // A tick recorded on a day that has ended is a record like any other.
      if (!mayAmend) return;
      const next = cell.status === 'done' ? 'N' : cell.status === 'not_done' ? 'NA' : 'Y';
      setAmending({ value: next, clear: false });
      return;
    }
    if (cell.status === 'done') { onSave([{ rowId: row.id, day, slot, done: false }]); return; }
    if (cell.status === 'not_done') { onSave([{ rowId: row.id, day, slot, na: true }]); return; }
    onSave([{ rowId: row.id, day, slot, done: true }]);
  }

  if (editing && row.row_type !== 'tick') {
    return (
      <td className={classes}>
        <input ref={inputRef} className="ls-input" defaultValue={draft}
          inputMode={row.row_type === 'numeric' ? 'decimal' : 'text'}
          onBlur={e => commit(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); }
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
          }} />
      </td>
    );
  }

  const display = !cell ? ''
    : cell.status === 'na' ? 'N/A'
    : row.row_type === 'numeric' ? (cell.value_num ?? '')
    : row.row_type === 'text' ? (cell.value_text ?? '')
    : cell.status === 'not_done' ? '✗' : '✓';

  return (
    <td className={classes} title={title} aria-disabled={closed || undefined}
      onClick={() => {
        if (!writable) return;
        if (row.row_type === 'tick') cycleTick();
        else if (cell && !sameDay) {
          if (!mayAmend) return;
          setAmending({ value: cell.value_num != null ? String(cell.value_num) : cell.value_text ?? '', clear: false });
        } else { setDraft(cell?.value_num != null ? String(cell.value_num) : cell?.value_text ?? ''); setEditing(true); }
      }}
      onContextMenu={e => {
        // Right-click writes the note. On a chart, the note is what turns
        // "8.4 °C" into a record somebody can defend at an audit. It also
        // reaches the one way to withdraw an entry, which has no other home on
        // a grid where every cell is one click wide.
        if (!writable || !cell) return;
        e.preventDefault();
        setNoteFor(noteFor === key ? null : key);
      }}>
      <span className="ls-value">{display}</span>
      {cell?.initials && <span className="ls-ini">{cell.initials}</span>}
      {cell?.note && <span className="ls-hasnote" title={cell.note}>•</span>}
      {amended && <span className="ls-amended" title={`Amended: ${cell?.last_amend_reason ?? ''}`}>△</span>}
      {noteFor === key && cell && (
        <NotePopover
          cell={cell} sameDay={Boolean(sameDay)} mayAmend={Boolean(mayAmend)}
          onClose={() => setNoteFor(null)}
          onWithdraw={() => { setNoteFor(null); withdraw(); }}
          onSave={note => {
            onSave([{
              rowId: row.id, day, slot, note,
              value: cell.value_num, text: cell.value_text,
              done: cell.status === 'done' ? true : cell.status === 'not_done' ? false : undefined,
              // A note is not a change to the reading, so it never needs an
              // amendment reason of its own — writing down what was done about
              // an excursion a week ago is exactly what the chart wants.
            }]);
            setNoteFor(null);
          }} />
      )}
      {amending && (
        <AmendPopover
          rowLabel={row.label} day={day} slot={slot}
          cell={cell} clear={amending.clear} value={amending.value}
          numeric={row.row_type === 'numeric'}
          onCancel={() => setAmending(null)}
          onConfirm={(value, reason) => {
            setAmending(null);
            if (amending.clear) { onSave([{ rowId: row.id, day, slot, clear: true, amendReason: reason }]); return; }
            const input = inputFor(value, reason);
            if (input) onSave([input]);
          }} />
      )}
    </td>
  );
}

function NotePopover({ cell, sameDay, mayAmend, onSave, onWithdraw, onClose }: {
  cell: LogSheetCell; sameDay: boolean; mayAmend: boolean;
  onSave: (note: string) => void; onWithdraw: () => void; onClose: () => void;
}) {
  const [note, setNote] = useState(cell.note ?? '');
  const canWithdraw = sameDay || mayAmend;
  return (
    <div className="ls-note-pop" onClick={e => e.stopPropagation()}>
      <label>
        <span>{cellIsBreach(cell.status) ? 'What was done about it?' : 'Note'}</span>
        <TextField as="textarea" rows={3} value={note} onValue={setNote} autoFocus
          placeholder={cellIsBreach(cell.status)
            ? 'Door found ajar, closed and re-read at 09:20; contents transferred to fridge 2.'
            : 'Anything worth recording about this entry'} />
      </label>
      {Number(cell.amendment_count ?? 0) > 0 && (
        <p className="ls-pop-amended">
          <History size={11} /> Amended {String(cell.last_amended_at ?? '').slice(0, 10)}
          {cell.last_amend_reason ? `: ${cell.last_amend_reason}` : ''}
        </p>
      )}
      <div className="pr-btns">
        <button type="button" onClick={() => onSave(note.trim())}>Save note</button>
        {canWithdraw && (
          <button type="button" className="ls-withdraw" onClick={onWithdraw}
            title={sameDay ? 'Withdraw this entry' : 'Withdraw — a reason is recorded'}>
            <Trash2 size={12} /> Withdraw
          </button>
        )}
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Changing, or withdrawing, an entry whose day has ended.
 *
 * The reason is not a formality and the wording says so. The record has already
 * been read — the morning handover saw it, the excursion register counted it,
 * results may have been released against it — so what an assessor wants is what
 * was wrong, how that was established, and who says so. The original stays
 * legible beside the new value either way (ISO 15189:2022 §8.4).
 */
function AmendPopover({ rowLabel, day, slot, cell, clear, value, numeric, onConfirm, onCancel }: {
  rowLabel: string; day: number; slot: CellSlot; cell?: LogSheetCell;
  clear: boolean; value: string; numeric: boolean;
  onConfirm: (value: string, reason: string) => void;
  onCancel: () => void;
}) {
  const [next, setNext] = useState(value);
  const [reason, setReason] = useState('');
  const was = cell?.value_num != null ? String(cell.value_num) : cell?.value_text ?? (cell?.status ?? '—');
  const ready = reason.trim().length >= 10 && (clear || next.trim().length > 0);

  return (
    <div className="ls-note-pop ls-amend-pop" onClick={e => e.stopPropagation()}>
      <p className="ls-amend-head">
        <History size={12} />
        <span>
          Day {day} {SLOT_LABELS[slot] ?? slot} has closed. The current entry ({was}) is kept on record.
        </span>
      </p>

      {!clear && (
        <label>
          <span>New value</span>
          <TextField value={next} onValue={setNext} autoFocus
            inputMode={numeric ? 'decimal' : 'text'}
            placeholder={numeric ? 'The corrected reading' : 'Y, N or NA'} />
        </label>
      )}

      <label>
        <span>Reason</span>
        <TextField as="textarea" rows={3} value={reason} onValue={setReason}
          autoFocus={clear}
          placeholder={clear
            ? 'Recorded against the wrong asset; entered on Refrigerator 2.'
            : 'Transcribed as 4.4; the logger read 14.4. Corrected against the printout.'} />
      </label>

      <div className="pr-btns">
        <button type="button" disabled={!ready} onClick={() => onConfirm(next, reason.trim())}>
          {clear ? 'Withdraw' : 'Amend'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
      {!ready && <p className="ls-amend-hint">A reason of at least a sentence is required.</p>}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What the supervisor is actually signing
   ------------------------------------------------------------------------- */
function MonthSummary({ data }: { data: LogSheetPayload }) {
  const { completeness: c, sheet } = data;
  const tone = c.percent >= 95 ? 'ok' : c.percent >= 80 ? 'warn' : 'crit';
  return (
    <div className="ls-summary">
      <div className={`ls-stat tone-${tone}`}>
        <strong>{c.percent}%</strong>
        <span>recorded — {c.recorded} of {c.expected}</span>
      </div>
      <div className={`ls-stat ${c.missingCount ? 'tone-warn' : 'tone-ok'}`}>
        <strong>{c.missingCount}</strong>
        <span>never recorded</span>
      </div>
      <div className={`ls-stat ${c.breaches ? 'tone-crit' : 'tone-ok'}`}>
        <strong>{c.breaches}</strong>
        <span>out of range or not done</span>
      </div>
      {c.unexplainedBreaches > 0 && (
        <p className="ls-summary-warn">
          <AlertTriangle size={12} /> {c.unexplainedBreaches} without a note. Right-click the cell to add one.
        </p>
      )}
      {c.missingCount > 0 && c.missing.length > 0 && (
        <details className="ls-missing">
          <summary>Which entries are missing</summary>
          <ul>
            {c.missing.slice(0, 24).map((m, i) => (
              <li key={i}>{m.label} — day {m.day} {SLOT_LABELS[m.slot as CellSlot] ?? m.slot}</li>
            ))}
            {c.missingCount > 24 && <li className="muted">…and {c.missingCount - 24} more</li>}
          </ul>
        </details>
      )}
      {sheet.nc && (
        <p className="ls-nc">
          <FileWarning size={12} /> Nonconformity {sheet.nc.nc_number} was raised against this month ({sheet.nc.status}).
        </p>
      )}
      {sheet.verification_comments && (
        <p className="ls-comments"><strong>Reviewer&rsquo;s comments:</strong> {sheet.verification_comments}</p>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="ls-legend">
      <span><i className="ls-sw" /> Recorded</span>
      <span><i className="ls-sw crit" /> Out of range / not done</span>
      <span><i className="ls-sw warn" /> Approaching a limit</span>
      <span><i className="ls-sw na" /> Not applicable</span>
      <span><i className="ls-sw blank" /> Nothing recorded</span>
      <span><i className="ls-sw closed" /> Not yet due</span>
      <span><i className="ls-sw amended" /> Amended</span>
      <span className="ls-legend-hint">Click to record · right-click for notes</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   What the month shows that no single reading does
   ----------------------------------------------------------------------------
   Every reading in range and the fridge failing anyway is the case this exists
   for. The findings are computed on the server from the month already on the
   sheet — the same run rules a Levey-Jennings chart uses, because a laboratory
   that knows what "ten on one side of the mean" means should not have to learn
   a second vocabulary for a fridge.
   ------------------------------------------------------------------------- */
function TrendPanel({ trends }: { trends: SheetTrend[] }) {
  const [open, setOpen] = useState<number | null>(0);
  if (!trends.length) return null;

  const act = trends.filter(t => t.severity === 'act').length;
  const icon = (kind: SheetTrend['kind']) =>
    kind === 'rising' ? <TrendingUp size={13} />
    : kind === 'falling' ? <TrendingDown size={13} />
    : <AlertTriangle size={13} />;

  return (
    <div className={`ls-trends${act ? ' has-act' : ''}`}>
      <div className="ls-trends-head">
        <strong>
          Trends
          <span className="ls-trend-n">{trends.length}</span>
          {act > 0 && <span className="ls-trend-act">{act} to review</span>}
        </strong>
        <span>Patterns across the month that individual readings do not show.</span>
      </div>
      <ul>
        {trends.map((trend, i) => (
          <li key={i} className={`t-${trend.severity}`}>
            <button type="button" onClick={() => setOpen(open === i ? null : i)}>
              {icon(trend.kind)}
              <span className="ls-trend-row">
                <span className="ls-trend-label">{trend.rowLabel}</span>
                <span className="ls-trend-summary">{trend.summary}</span>
              </span>
            </button>
            {open === i && <p className="ls-trend-meaning">{trend.meaning}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Paper in, paper out
   ------------------------------------------------------------------------- */
function SheetActions({ sheet, editable, onReload, onProblem }: {
  sheet: LogSheetPayload['sheet']; editable: boolean;
  onReload: () => void; onProblem: (message: string) => void;
}) {
  const { can } = usePermissions();
  // Taking a whole month out to Excel, or loading one back in, is not the same
  // right as filling in a cell: it is how a month gets rewritten wholesale, so
  // the laboratory reserves it. The server enforces this; the screen must agree
  // with it rather than offering a button that comes back refused.
  const moduleKey = SHEET_KIND_MODULE[sheet.sheet_kind as SheetKind] ?? 'facilities_safety';
  const mayExport = can(moduleKey, 'export');
  const mayImport = can(moduleKey, 'import');
  const [busy, setBusy] = useState<string | null>(null);
  const attachRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  function openAuthed(path: string) {
    // The export endpoints need the bearer token, which a plain link cannot
    // send, so the file is fetched and handed to the browser as a blob.
    setBusy(path);
    fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (path.endsWith('/print')) {
          const win = window.open(url, '_blank');
          if (!win) throw new Error('Your browser blocked the print window. Allow pop-ups for this site and try again.');
        } else {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${sheet.title.replace(/[^a-z0-9]+/gi, '_')}_${sheet.month}.xlsx`;
          anchor.click();
        }
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      })
      .catch(e => onProblem(errorText(e)))
      .finally(() => setBusy(null));
  }

  async function upload(path: string, file: File) {
    setBusy(path);
    const body = new FormData();
    body.append('file', file);
    try { await api(path, { method: 'POST', body }); onReload(); }
    catch (e) { onProblem(errorText(e)); }
    finally { setBusy(null); }
  }

  return (
    <div className="ls-actions">
      <button type="button" className="pq-link" onClick={() => openAuthed(`/routine-sheets/${sheet.id}/print`)}
        title="The sheet as the laboratory knows it, ready to print or save as PDF">
        {busy?.endsWith('/print') ? <Loader2 size={12} className="pd-spin" /> : <Printer size={12} />} Print
      </button>
      {mayExport && (
        <button type="button" className="pq-link" onClick={() => openAuthed(`/routine-sheets/${sheet.id}/export.xlsx`)}
          title="The grid and a listing of every entry. Restricted to laboratory leadership.">
          <Download size={12} /> Excel
        </button>
      )}
      {editable && (
        <>
          <button type="button" className="pq-link" onClick={() => openAuthed(`/routine-sheets/${sheet.id}/template.xlsx`)}
            title="A blank month in exactly this shape — fill it offline and load it back">
            <FileSpreadsheet size={12} /> Blank month
          </button>
          {mayImport && (
            <>
              <button type="button" className="pq-link" onClick={() => importRef.current?.click()}
                title="Load a filled blank month back in. Restricted to laboratory leadership.">
                <Upload size={12} /> Load a month
              </button>
              <input ref={importRef} type="file" hidden accept=".xlsx,.xls,.csv"
                onChange={e => { const f = e.target.files?.[0]; if (f) void upload(`/routine-sheets/${sheet.id}/import`, f); e.target.value = ''; }} />
            </>
          )}
          <button type="button" className="pq-link" onClick={() => attachRef.current?.click()}
            title="Attach this month's paper chart, so the record and the paper stay together">
            <Paperclip size={12} /> {sheet.attachment ? 'Replace chart' : 'Attach chart'}
          </button>
          <input ref={attachRef} type="file" hidden accept="image/*,.pdf,.xlsx,.csv,.docx"
            onChange={e => { const f = e.target.files?.[0]; if (f) void upload(`/routine-sheets/${sheet.id}/attachment`, f); e.target.value = ''; }} />
        </>
      )}
      {sheet.attachment && <Attachment sheet={sheet} editable={editable} onReload={onReload} onProblem={onProblem} />}
    </div>
  );
}

function Attachment({ sheet, editable, onReload, onProblem }: {
  sheet: LogSheetPayload['sheet']; editable: boolean; onReload: () => void; onProblem: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <span className="ls-attach">
      <Paperclip size={11} /> {sheet.attachment?.original_name}
      <span className="ls-attach-state">{EXTRACTION_STATUS_LABELS[sheet.extraction_status as keyof typeof EXTRACTION_STATUS_LABELS] ?? sheet.extraction_status}</span>
      {editable && (
        <button type="button" className="pq-link" disabled={busy}
          title="Read what is on the attached chart into the grid. Anything it is unsure of is put in front of you to confirm."
          onClick={async () => {
            setBusy(true);
            try { await api(`/routine-sheets/${sheet.id}/extract`, { method: 'POST' }); onReload(); }
            catch (e) { onProblem(errorText(e)); }
            finally { setBusy(false); }
          }}>
          {busy ? <Loader2 size={11} className="pd-spin" /> : <ScanLine size={11} />} Read it in
        </button>
      )}
    </span>
  );
}

/* ----------------------------------------------------------------------------
   Confirming what a reader was unsure of
   ------------------------------------------------------------------------- */
function ExtractionReview({ sheetId, count, note, onDone }: {
  sheetId: number; count: number; note?: string | null; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="ls-review">
      <ScanLine size={14} />
      <div>
        <strong>{count} {count === 1 ? 'entry was' : 'entries were'} read off the attached chart and need confirming.</strong>
        <p>{note || 'They are outlined on the grid. Check each against the chart, correct anything that is wrong by clicking it, then confirm the rest. The month cannot be signed while entries are still unconfirmed.'}</p>
      </div>
      <button type="button" className="pq-link" disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await api(`/routine-sheets/${sheetId}/confirm-review`, { method: 'POST', body: JSON.stringify({ all: true }) }); onDone(); }
          finally { setBusy(false); }
        }}>
        {busy ? <Loader2 size={12} className="pd-spin" /> : <Check size={12} />} I have checked them all
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The supervisor's sign-off
   ------------------------------------------------------------------------- */
function VerifyDialog({ sheetId, data, onClose, onDone }: {
  sheetId: number; data: LogSheetPayload; onClose: () => void; onDone: (next: LogSheetPayload) => void;
}) {
  const [comments, setComments] = useState('');
  const [raiseNc, setRaiseNc] = useState(data.completeness.missingCount > 0 || data.completeness.unexplainedBreaches > 0);
  const [acknowledge, setAcknowledge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const c = data.completeness;

  async function submit() {
    setBusy(true); setProblem(null);
    try {
      const next = await api<LogSheetPayload>(`/routine-sheets/${sheetId}/verify`, {
        method: 'POST',
        body: JSON.stringify({ comments, raiseNc, acknowledgeGaps: acknowledge || c.missingCount === 0 }),
      });
      onDone(next);
    } catch (e) {
      setProblem(errorText(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="ls-modal-back" onClick={onClose}>
      <div className="ls-modal" onClick={e => e.stopPropagation()}>
        <header>
          <h4><Signature size={15} /> Verify {monthLabel(data.sheet.month)}</h4>
          <button type="button" className="pq-link" onClick={onClose}><X size={14} /></button>
        </header>

        <p className="ls-modal-lead">
          You are signing for the whole month of <strong>{data.sheet.title}</strong> — for what was recorded and
          for what was not. Your name, the time, this device and these figures go into the signature.
        </p>

        <ul className="ls-verify-facts">
          <li className={c.percent >= 95 ? 'ok' : 'warn'}>{c.recorded} of {c.expected} entries recorded ({c.percent}%)</li>
          <li className={c.missingCount ? 'warn' : 'ok'}>{c.missingCount} never recorded</li>
          <li className={c.breaches ? 'crit' : 'ok'}>{c.breaches} out of range or not done{c.unexplainedBreaches ? `, ${c.unexplainedBreaches} with nothing recorded about what was done` : ''}</li>
          {c.needsReview > 0 && <li className="crit">{c.needsReview} entries read off a scan are still unconfirmed</li>}
        </ul>

        {c.needsReview > 0 && (
          <p className="pd-error">
            <AlertTriangle size={13} /> Confirm the scanned entries first. Signing for numbers nobody has checked
            against the chart is signing for a guess.
          </p>
        )}

        <label>
          <span>Comments</span>
          <TextField as="textarea" rows={3} value={comments} onValue={setComments}
            placeholder="Two readings missed over the public holiday; fridge 2 serviced on the 14th and re-verified." />
        </label>

        {c.missingCount > 0 && (
          <label className="ls-check">
            <input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} />
            <span>
              I have read the {c.missingCount} missing {c.missingCount === 1 ? 'entry' : 'entries'} listed above and
              am signing the month as it stands. This is recorded in the signature.
            </span>
          </label>
        )}

        <label className="ls-check">
          <input type="checkbox" checked={raiseNc} onChange={e => setRaiseNc(e.target.checked)} />
          <span>
            Raise a nonconformity against this month
            {(c.missingCount > 0 || c.unexplainedBreaches > 0) && <em> — recommended: the gaps above are a failure of the programme, not of one person, and an NC is where that gets fixed.</em>}
          </span>
        </label>

        {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}

        <div className="pr-btns">
          <button type="button" disabled={busy || (c.missingCount > 0 && !acknowledge) || c.needsReview > 0} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="pd-spin" /> : <Signature size={14} />} Sign and verify
          </button>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   The index of a unit's sheets for a month — used by the portal and the modules
   ------------------------------------------------------------------------- */
/**
 * Choosing which sheet to work on.
 *
 * Down a column beside the grid it stole a quarter of the screen to list, very
 * often, one fridge. As a strip of coloured chips it was worse: ragged widths,
 * a different border colour on nearly every item, and no alignment to read down.
 *
 * So it is a plain uniform grid. Equal columns, one neutral border, the name and
 * the percentage in fixed positions so the eye can scan a column of figures
 * rather than hunt across chips. Status is a single small dot — colour marks the
 * one or two that need attention instead of decorating all thirteen.
 */
export function SheetPicker({ sheets, activeId, onPick, horizontal }: {
  sheets: Array<{ subject: any; sheet: any; completeness: any }>;
  activeId: number | null;
  onPick: (sheetId: number) => void;
  /** Lay the sheets above the grid rather than in a column beside it. */
  horizontal?: boolean;
}) {
  if (!sheets.length) return null;
  return (
    <ul className={`ls-picker${horizontal ? ' is-grid' : ''}`}>
      {sheets.map(({ subject, sheet, completeness }) => {
        const percent = completeness?.percent ?? 0;
        const tone = !sheet ? 'none' : percent >= 95 ? 'ok' : percent >= 70 ? 'warn' : 'crit';
        const active = sheet?.id === activeId;
        return (
          <li key={subject.id}>
            <button type="button" className={`ls-pick t-${tone}${active ? ' is-active' : ''}`}
              aria-current={active || undefined}
              onClick={() => sheet && onPick(sheet.id)}>
              <span className="ls-pick-dot" aria-hidden="true" />
              <span className="ls-pick-body">
                <span className="ls-pick-name" title={subject.subject_name ?? subject.name}>
                  {subject.subject_name ?? subject.name}
                </span>
                <span className="ls-pick-meta">
                  {sheet ? (
                    <>
                      <span className="ls-pick-pct">{percent}%</span>
                      {completeness?.breaches > 0 && <span className="crit">{completeness.breaches} out of range</span>}
                      {sheet.status !== 'open' && (
                        <span className="ls-pick-status">
                          {SHEET_STATUS_LABELS[sheet.status as keyof typeof SHEET_STATUS_LABELS]}
                        </span>
                      )}
                    </>
                  ) : <span>Not started</span>}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export { ClipboardList as LogSheetIcon, RefreshCw as RefreshIcon, CheckCircle2 as DoneIcon };
