// Generic chrome-budget reducer shared by every screen that must reserve
// space for fixed rows before handing the remainder to a scrollable region.
//
// The value is not the arithmetic — summing is trivial — it is that the
// budget can only be as complete as its explicit row list. A row that is
// mounted but never added to the list is a gap in that list, not a runtime
// guess that only shows up as garbled output on a short terminal.

/** One named fixed row (or block of rows) outside a screen's scrollable region. */
export type ChromeRow = {
  readonly id: string;
  readonly rows: number;
};

/** Space every listed row reserves, summed. */
export function chromeBudget(rows: readonly ChromeRow[]): number {
  return rows.reduce((total, row) => total + row.rows, 0);
}
