/** PostgreSQL's spelling of a judged write (`../../judged.ts`). */
import { sql } from "@sql";
import type { JudgedSpelling } from "../../judged";
import { rowValues } from "../../shared/standard-sql";

export const POSTGRES_JUDGED: JudgedSpelling = {
  // The refusal names its sentinel (22P02, `invalid input syntax for type
  // integer: "__viborm_refused__"`), which no caller's division by zero
  // does; the text is a sublink, which PostgreSQL does not fold while
  // planning, so it is evaluated only where it is reached.
  refused: "CAST((SELECT '__viborm_refused__') AS integer)",
  /**
   * The produced rows as a `VALUES` list: PostgreSQL parses each `UNION ALL`
   * arm one recursion deeper (`54001`, stack depth, at 8,000 rows on 16.14),
   * and a list is no deeper for its length. A `VALUES` column is typed by its
   * own rows, an unknown parameter as `text`, so the first row takes each
   * column's type from a NULL of the table's row type (`COALESCE`, the rule
   * a `UNION` arm met), beside the list, as a one-row FROM item. The NULL is
   * cast to the table's type, never read as `SELECT "qN" FROM table AS "qN"`:
   * there a column named `qN` would win over the whole-row reference (42809),
   * and the cast reads no relation at all.
   */
  typedRows: (a, typed, rows, alias) => {
    // Every adapter's `escape` is an arrow: it reads no `this`.
    const { escape: quoted } = a.identifiers;
    const name = quoted(typed.alias);
    const [first, ...rest] = rows;
    const typedFirst = first!.map(
      (value, index) =>
        sql`COALESCE(${value}, (${name}."row").${quoted(typed.columns[index]!)})`
    );
    return sql`(SELECT NULL::${typed.table} AS "row") AS ${name} CROSS JOIN LATERAL (VALUES ${sql.join(
      [typedFirst, ...rest].map(rowValues),
      ", "
    )}) AS ${quoted(alias)}(${sql.join(typed.columns.map(quoted), ", ")})`;
  },
};
