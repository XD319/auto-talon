export type SqliteBindValue = number | string | null;

export function buildWhereClause(
  clauses: Array<{ sql: string; value: SqliteBindValue; when: boolean }>
): { params: SqliteBindValue[]; whereSql: string } {
  const active = clauses.filter((clause) => clause.when);
  return {
    params: active.map((clause) => clause.value),
    whereSql: active.length === 0 ? "" : `WHERE ${active.map((clause) => clause.sql).join(" AND ")}`
  };
}

export function requirePersisted<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}
