import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

/**
 * The search box on a register, which has to stay typeable.
 *
 * Every register in SECH_LIMS is one enormous page component holding a dozen
 * tabs. When the search text lived in that component's state, each keystroke
 * re-ran the whole thing — every closure rebuilt, every tab's JSX re-evaluated,
 * every row of the table reconciled — before the character could be painted.
 * On a register of a couple of thousand rows that was over half a second per
 * letter, which is not slow typing; it is a box that has stopped responding.
 * People retyped, gave up, and restarted the application.
 *
 * So the text lives HERE, in a component that renders one input. Typing
 * re-renders only this, which is instant whatever the register holds. The page
 * is told what to filter on once the typing pauses, and that render is the
 * cheap one to be late.
 *
 * `onQuery` is read through a ref, so a callback written inline at the call
 * site — which is every call site — does not restart the timer on every render
 * of the page and strand the pending keystroke.
 */
export default function RegisterSearch({
  onQuery, placeholder = 'Search…', delay = 150, autoFocus = false, className, style,
}: {
  /** Called with the text to filter on, once typing pauses. */
  onQuery: (query: string) => void;
  placeholder?: string;
  /** How long a pause counts as "stopped typing". */
  delay?: number;
  autoFocus?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const notify = useRef(onQuery);
  notify.current = onQuery;

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (value: string) => {
    setText(value);
    window.clearTimeout(timer.current);
    // Clearing the box is not typing — the reader wants the whole register
    // back at once, not after a pause staring at a filtered list.
    if (value === '') { notify.current(''); return; }
    timer.current = window.setTimeout(() => notify.current(value), delay);
  };

  return (
    <label className={`reg-search ${className ?? ''}`} style={style}>
      <Search size={15} />
      <input
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={e => change(e.target.value)}
        // Enter should search now rather than wait out the pause.
        onKeyDown={e => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          window.clearTimeout(timer.current);
          notify.current(text);
        }}
      />
    </label>
  );
}
