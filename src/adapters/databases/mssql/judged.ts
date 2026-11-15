/** SQL Server's spelling of a judged write (`../../judged.ts`). */
import { sql } from "@sql";
import { afterHead, type JudgedSpelling } from "../../judged";

export const MSSQL_JUDGED: JudgedSpelling = {
  // The refusal is a conversion error naming its sentinel (Msg 245); `CASE`
  // evaluates the arm only for a refused row, and T-SQL defers a constant's
  // conversion error to execution.
  refused: "CAST('__viborm_refused__' AS INT)",
  /**
   * One `UNION ALL SELECT` arm per row after the typed head, each typed
   * against the arms before it: the 2,098 parameters of a request are
   * reached first.
   */
  typedRows: (a, typed, rows, alias) =>
    afterHead(
      a,
      typed,
      sql.join(
        rows.map((row) => sql`SELECT ${sql.join(row, ", ")}`),
        " UNION ALL "
      ),
      alias
    ),
  // T-SQL aggregates no subquery (Msg 130), so a judged update cannot keep
  // `MIN(guard) = 1` per key. One scalar `CASE` judges a row its filter
  // keeps and answers true for any other: a plan that reads the guard
  // before the filter still refuses no row the update does not write. A
  // condition of one member is the dialect's predicate (`and`), never a
  // `BIT` value.
  keptWhere: (a, kept, condition) =>
    sql`CASE WHEN ${a.operators.and(kept)} THEN CASE WHEN ${a.operators.and(condition)} THEN 1 ELSE 0 END ELSE 1 END = 1`,
};
