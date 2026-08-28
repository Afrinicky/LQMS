import { useEffect, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * A text box that keeps typing instant on a page of any size.
 *
 * Every register in SECH_LIMS is one enormous page component holding a dozen
 * tabs, a form and a table. Written the obvious way — `value={form.title}
 * onChange={e => setForm({ ...form, title: e.target.value })}` — each
 * character typed sets state on that page component, so React re-runs the
 * whole thing: every closure rebuilt, every tab's JSX re-evaluated, every row
 * reconciled, before the letter can be painted. On a real register that is
 * hundreds of milliseconds per keystroke. The box does not look slow, it looks
 * broken: characters arrive late, out of order, or not at all, and people
 * retype, give up, and restart the application.
 *
 * `RegisterSearch` already solved this for the search box by holding the text
 * in a component of its own. This is the same answer for every other box.
 *
 *   · What is typed lives HERE. A keystroke re-renders one input, which is
 *     instant whatever the page holds.
 *   · The page is told once typing pauses, and immediately on blur, on Enter,
 *     and on Escape — so a value is never lost, and pressing Save straight
 *     after typing saves what is on screen. (A click on Save blurs the box
 *     first, which is what makes that true.)
 *   · A value arriving from outside still wins: a form cleared after saving,
 *     or a record loaded into an editor, replaces what is in the box even
 *     while the caret is in it. Only the page echoing back the value this box
 *     just reported is ignored, because that is not a change, it is agreement.
 *
 * `onValue` is called with the text, which is what almost every call site
 * wanted from `e.target.value` anyway.
 */

const FLUSH_MS = 120;

type Common = {
  /** The stored text. */
  value: string | null | undefined;
  /** The text the box now holds. Called on a pause, and at once on blur/Enter. */
  onValue: (value: string) => void;
  /** How long a pause counts as "stopped typing". */
  flushDelay?: number;
};

type Props =
  & Common
  & { as?: 'input' }
  & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;

type AreaProps =
  & Common
  & { as: 'textarea' }
  & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>;

export default function TextField(props: Props | AreaProps) {
  const { value, onValue, flushDelay = FLUSH_MS, as = 'input', ...rest } =
    props as Common & { as?: 'input' | 'textarea' } & Record<string, unknown>;

  const incoming = value ?? '';
  const [text, setText] = useState(incoming);
  /** The last text this box handed upward — used to tell an echo from a change. */
  const reported = useRef(incoming);
  const timer = useRef<number | undefined>(undefined);
  const notify = useRef(onValue);
  notify.current = onValue;

  // A value from outside replaces what is in the box; the page repeating what
  // this box just said does not.
  useEffect(() => {
    if (incoming === reported.current) return;
    reported.current = incoming;
    setText(incoming);
  }, [incoming]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flush = (next: string) => {
    window.clearTimeout(timer.current);
    if (next === reported.current) return;
    reported.current = next;
    notify.current(next);
  };

  const change = (next: string) => {
    setText(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => flush(next), flushDelay);
  };

  const shared = {
    value: text,
    onChange: (e: { target: { value: string } }) => change(e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      flush(e.target.value);
      (rest as unknown as { onBlur?: (e: unknown) => void }).onBlur?.(e);
    },
  };

  if (as === 'textarea') {
    const areaRest = rest as unknown as Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>;
    return (
      <textarea
        {...areaRest}
        {...shared}
        onKeyDown={e => {
          // Escape hands back what is typed before anything closes over it.
          if (e.key === 'Escape') flush(e.currentTarget.value);
          areaRest.onKeyDown?.(e);
        }}
      />
    );
  }

  const inputRest = rest as unknown as Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;
  return (
    <input
      {...inputRest}
      {...shared}
      onKeyDown={e => {
        // Enter usually submits the form this box is in, so the page has to
        // have the text before that happens.
        if (e.key === 'Enter' || e.key === 'Escape') flush(e.currentTarget.value);
        inputRest.onKeyDown?.(e);
      }}
    />
  );
}
