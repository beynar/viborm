/** MySQL's spelling of a judged write (`../../judged.ts`). */
import { sql } from "@sql";
import { afterHead, type JudgedSpelling } from "../../judged";

export const MYSQL_JUDGED: JudgedSpelling = {
  // The refusal is an invalid path (3143), never the invalid text (3141)
  // a premise fails with.
  refused: "JSON_EXTRACT('{}', '__viborm_refused__')",
  /**
   * One `UNION ALL SELECT` arm per row after the typed head, each typed
   * against the arms before it: 65,535 arms measured, so the bind budget is
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
};
