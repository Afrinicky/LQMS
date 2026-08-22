import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

/**
 * A numeric box that lets you type a number.
 *
 * Written the obvious way — `onChange={e => setForm({ ...form, qty:
 * Number(e.target.value) })}` — a numeric field fights whoever is using it,
 * because `Number('')` is 0 and `Number('-')` is NaN:
 *
 *   · Clearing the box puts a 0 straight back into it. To replace 40 with 5
 *     you have to select the 0 and overtype it, and if you do not notice, you
 *     save a quantity of 50 or 05.
 *   · A minus sign alone parses to NaN, React hands the input a value it
 *     cannot show, and the character disappears as it is typed. A freezer
 *     range of −20 °C simply cannot be entered.
 *   · The same goes for a lone decimal point on the way to "0.5".
 *
 * The cause is that the parsed number was being treated as the thing being
 * edited. It is not: the TEXT is what is being edited, and the number is what
 * that text currently means. So the text lives here, and the parsed value is
 * reported upward — `null` while the box is empty or holds something not yet a
 * number, so the caller decides what an empty box means for its own form.
 *
 * Props from outside only reach the text while the box does not have the
 * caret. That is what stops a parent storing 0 for an empty box from pushing
 * that 0 back mid-keystroke. On blur the text is re-drawn from the value that
 * was actually stored, so "007" or "1." tidies itself up and what is on screen
 * is what will be saved.
 *
 * Clicking in also selects what is there. A quantity box sitting at its
 * default of 0 otherwise turns "40" into "040" — which parses to the right
 * number, but reads as a mistake and becomes one the moment somebody stops to
 * correct it. Selecting on entry means typing replaces, which is what a
 * numeric box is expected to do; a second click still places the caret for
 * anyone editing rather than replacing.
 */
export default function NumberField({
  value, onValue, ...rest
}: {
  /** The stored number. `null`/`undefined` show an empty box. */
  value: number | null | undefined;
  /** The number the box now means — `null` when it is empty or mid-entry. */
  onValue: (value: number | null) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>) {
  const format = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? '' : String(v));
  const [text, setText] = useState(() => format(value));
  const focused = useRef(false);

  // While the caret is in the box, what was typed wins. Outside that — a form
  // cleared after saving, a record loaded into an editor — the stored value wins.
  useEffect(() => {
    if (!focused.current) setText(format(value));
    // format is pure; re-running on `value` alone is the whole point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      {...rest}
      type="number"
      value={text}
      onFocus={e => { focused.current = true; e.target.select(); rest.onFocus?.(e); }}
      onBlur={e => { focused.current = false; setText(format(value)); rest.onBlur?.(e); }}
      onChange={e => {
        const typed = e.target.value;
        setText(typed);
        const parsed = typed.trim() === '' ? null : Number(typed);
        onValue(parsed !== null && Number.isFinite(parsed) ? parsed : null);
      }}
    />
  );
}
