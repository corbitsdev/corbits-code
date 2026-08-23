/**
 * Process-local row store. Tables must be declared before use via
 * declareTable(); reads and writes to an undeclared table throw.
 */
const tables = new Map<string, Map<string, Record<string, unknown>>>();

export function declareTable(name: string): void {
  if (!tables.has(name)) tables.set(name, new Map());
}

function tableOf(name: string): Map<string, Record<string, unknown>> {
  const t = tables.get(name);
  if (t === undefined) throw new Error(`table not declared: ${name}`);
  return t;
}

export function put(table: string, id: string, row: Record<string, unknown>): void {
  tableOf(table).set(id, row);
}

export function get(table: string, id: string): Record<string, unknown> | undefined {
  return tableOf(table).get(id);
}

export function all(table: string): Record<string, unknown>[] {
  return [...tableOf(table).values()];
}

/** Clear all rows. Table declarations survive, as a real schema would. */
export function reset(): void {
  for (const t of tables.values()) t.clear();
}
