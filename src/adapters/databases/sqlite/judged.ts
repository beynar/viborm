/** SQLite's spelling of a judged write (`../../judged.ts`). */
import { sql } from "@sql";
import { afterHead, type JudgedSpelling } from "../../judged";
import { rowValues } from "../../shared/standard-sql";

export const SQLITE_JUDGED: JudgedSpelling = {
  // The refusal names its sentinel (`bad JSON path: '__viborm_refused__'`).
  refused: "json_extract('{}', '__viborm_refused__')",
  /**
   * A multi-row `VALUES` is the one compound SQLite does not count against
   * `SQLITE_MAX_COMPOUND_SELECT` (500 terms; measured on 3.53.2: 500 `UNION
   * ALL SELECT` arms refused, 10,922 `VALUES` rows read), so the produced
   * rows follow their typed head as one: the head's columns still type every
   * row, as an arm's did (affinity and collation measured equal).
   */
  typedRows: (a, typed, rows, alias) =>
    afterHead(
      a,
      typed,
      sql`VALUES ${sql.join(rows.map(rowValues), ", ")}`,
      alias
    ),
};
