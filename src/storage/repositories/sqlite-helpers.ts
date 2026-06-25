export type SqliteBindValue = number | string | null;

export type SqliteWhereClause =
  | { sql: string; value: SqliteBindValue; when: boolean }
  | { sql: string; values: SqliteBindValue[]; when: boolean }
  | { sql: string; when: boolean };

export function buildWhereClause(
  clauses: SqliteWhereClause[]
): { params: SqliteBindValue[]; whereSql: string } {
  const active = clauses.filter((clause) => clause.when);
  return {
    params: active.flatMap((clause) => {
      if ("values" in clause) {
        return clause.values;
      }
      if ("value" in clause) {
        return [clause.value];
      }
      return [];
    }),
    whereSql: active.length === 0 ? "" : `WHERE ${active.map((clause) => clause.sql).join(" AND ")}`
  };
}

export function appendLimitClause(
  params: SqliteBindValue[],
  limit: number | undefined
): { limitSql: string; params: SqliteBindValue[] } {
  if (limit === undefined) {
    return { limitSql: "", params };
  }
  return {
    limitSql: " LIMIT ?",
    params: [...params, limit]
  };
}

export function requirePersisted<T>(value: T | null, message: string): T {
  if (value === null) {
    throw new Error(message);
  }
  return value;
}
