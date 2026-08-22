import { useMemo } from 'react';

/**
 * How many rows a register draws before it stops.
 *
 * Nobody reads the two-thousandth row of a table, but the browser still pays
 * to build it, and it pays again on every re-render. A register of a couple of
 * thousand rows cost over half a second of blocked UI per keystroke in the
 * search box — which is not slow typing, it is a box that has stopped
 * responding. Registers now draw up to this many and say what they are holding
 * back, which bounds the cost of a render however large the laboratory's
 * register grows.
 *
 * This is a drawing limit, not a filter: the search still runs over every row,
 * so narrowing the search always reaches the record being looked for.
 */
export const MAX_REGISTER_ROWS = 250;

/** The rows to draw, and how many were held back. */
export function useCappedRows<T>(rows: T[], limit = MAX_REGISTER_ROWS) {
  return useMemo(() => ({
    shown: rows.length > limit ? rows.slice(0, limit) : rows,
    hidden: Math.max(0, rows.length - limit),
    total: rows.length,
  }), [rows, limit]);
}
