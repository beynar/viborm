// S12 (decision 4): the shipped SQLite repair expression reads SQLite's own
// zone-less text 'YYYY-MM-DD HH:MM:SS[.fff]' as UTC and converts it to canonical
// 'YYYY-MM-DDTHH:mm:ss.sssZ' instead of aborting; zoned ISO text keeps
// converting (control) and garbage still aborts. Runs the published
// expression directly in better-sqlite3 over 10k values.
import Database from "better-sqlite3";
import { sqliteCanonicalDateTimeExpression } from "viborm/migrations";

export const meta = {
  id: "S12-repair",
  title: "SQLite repair expression accepts zone-less text as UTC",
  plan: "phase-1/lane-L/S12",
  needs: [],
  source:
    "docs/architecture/migrations-durable-objects-review-2026-10-09 FI-07; completion-plan-2026-10/code-check-probes/migrations-sqlite/probes/predicate-size.mjs; src/adapters/databases/sqlite/storage/datetime.ts (ISO_TIMESTAMP_SHAPES); plan decision 4",
};

const ROWS = 10_000;

const cases = [
  ["2026-10-10 12:34:56", "2026-10-10T12:34:56.000Z"],
  ["2026-10-10 12:34:56.7", "2026-10-10T12:34:56.700Z"],
  ["2026-10-10 12:34:56.789", "2026-10-10T12:34:56.789Z"],
  // Control: already-admitted zoned spellings.
  ["2026-10-10T12:34:56Z", "2026-10-10T12:34:56.000Z"],
  ["2026-10-10T12:34:56.5+02:00", "2026-10-10T10:34:56.500Z"],
];

export default async function probe() {
  const db = new Database(":memory:");
  const failures = [];
  const lines = [];
  try {
    const convert = db.prepare(
      `SELECT ${sqliteCanonicalDateTimeExpression("at")} AS out FROM (SELECT ? AS "at")`
    );
    for (const [input, expected] of cases) {
      let out;
      try {
        out = convert.get(input).out;
      } catch (error) {
        out = `aborted (${error.message})`;
      }
      lines.push(`'${input}' -> ${out}`);
      if (out !== expected)
        failures.push(`'${input}' -> ${out}, expected ${expected}`);
    }
    let garbage;
    try {
      garbage = `converted to ${convert.get("next tuesday").out}`;
    } catch {
      garbage = "aborted";
    }
    lines.push(`'next tuesday' -> ${garbage}`);
    if (garbage !== "aborted") failures.push(`garbage ${garbage}`);

    // At scale: datetime('now', ...) text written by SQLite itself, rewritten in one UPDATE.
    db.exec(`CREATE TABLE "ev" ("id" INTEGER PRIMARY KEY, "at" TEXT NOT NULL)`);
    db.prepare(
      `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < ?)
       INSERT INTO "ev" ("at") SELECT datetime('2026-01-01', '+' || value || ' minutes') FROM n`
    ).run(ROWS);
    try {
      db.exec(
        `UPDATE "ev" SET "at" = ${sqliteCanonicalDateTimeExpression("at")}`
      );
      const sample = db
        .prepare(`SELECT "at" FROM "ev" WHERE "id" = 1`)
        .get().at;
      lines.push(`${ROWS} datetime() rows rewritten; row 1 '${sample}'`);
      if (sample !== "2026-01-01T00:01:00.000Z") {
        failures.push(`bulk rewrite gave '${sample}'`);
      }
    } catch (error) {
      lines.push(`${ROWS} datetime() rows: UPDATE aborted (${error.message})`);
      failures.push(`bulk rewrite of ${ROWS} zone-less rows aborted`);
    }
  } finally {
    db.close();
  }
  return failures.length === 0
    ? {
        status: "pass",
        evidence: `zone-less text converts as UTC\n${lines.join("\n")}`,
      }
    : {
        status: "fail",
        evidence: `${failures.join("; ")}\n${lines.join("\n")}`,
      };
}
