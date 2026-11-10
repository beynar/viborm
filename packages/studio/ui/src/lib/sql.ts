// SQL laid out to be read: a clause per line, what it lists indented under it, a subquery indented inside its
// parentheses, in the database's own dialect. A statement the formatter cannot read stays as it came.
import { formatDialect, mysql, postgresql, sqlite } from "sql-formatter";

const DIALECTS = { postgresql, mysql, sqlite };

/** The dialect a studio says it speaks, as the formatter reads it. */
function dialectOf(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("postgres")) return DIALECTS.postgresql;
  if (lower.includes("mysql") || lower.includes("maria")) return DIALECTS.mysql;
  return DIALECTS.sqlite;
}

export function prettySql(sql: string, dialect: string): string {
  try {
    return formatDialect(sql, {
      dialect: dialectOf(dialect),
      keywordCase: "upper",
      tabWidth: 2,
      expressionWidth: 60,
    });
  } catch {
    return sql;
  }
}
