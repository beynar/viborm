/**
 * A pending history shaped like the one PlanetScale's Neki refused in 1.2.1
 * (synthetic names): a data migration that adds the columns it fills, a
 * schema state, a data-only cleanup after it, a schema state that changes
 * nothing a planner reads, and a data state after that one. Applied in one
 * `apply()` on standard PostgreSQL, on PGlite made to refuse what Neki
 * refuses, and on Neki itself.
 */

import type { WritableMigrations } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";

export const REPORT_ROWS = 2000;

/** The schema at `stage` (0 to 3) of the history. */
export function reportSchema(stage: number) {
  const fields = {
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
  };
  const withTeam = { ...fields, teamId: s.string().nullable() };
  return {
    ...(stage >= 2
      ? {
          team: s.model({ id: s.string().id(), name: s.string() }).map("teams"),
        }
      : {}),
    person: s
      .model({
        id: s.string().id(),
        name: s.string(),
        email: s.string(),
        ...(stage >= 1
          ? {
              firstName: s.string().nullable(),
              lastName: s.string().nullable(),
            }
          : {}),
      })
      .map("people"),
    note: (stage >= 3
      ? s.model(withTeam).index(["authorId"], { name: "notes_author" })
      : s.model(stage >= 2 ? withTeam : fields)
    ).map("notes"),
  };
}

/** `REPORT_ROWS` people and notes, one note in ten by an author who is gone. */
export const seedReportRows = (namespace: string): string =>
  `INSERT INTO "${namespace}"."people" ("id", "name", "email") SELECT 'p' || g, 'First' || g || ' Last' || g, 'p' || g || '@example.com' FROM generate_series(1, ${REPORT_ROWS}) g;
   INSERT INTO "${namespace}"."notes" ("id", "title", "authorId") SELECT 'n' || g, 'Note ' || g, CASE WHEN g % 10 = 0 THEN 'gone' || g ELSE 'p' || g END FROM generate_series(1, ${REPORT_ROWS}) g`;

/** Its dispatches, as the states' manual transitions run them. */
export const reportSql = (namespace: string) => {
  const table = (name: string) => `"${namespace}"."${name}"`;
  return {
    names: [
      `ALTER TABLE ${table("people")} ADD COLUMN "firstName" text`,
      `ALTER TABLE ${table("people")} ADD COLUMN "lastName" text`,
      `UPDATE ${table("people")} SET "firstName" = split_part("name", ' ', 1), "lastName" = split_part("name", ' ', 2)`,
    ],
    namesCheck: `SELECT NOT EXISTS (SELECT 1 FROM ${table("people")} WHERE "firstName" IS NULL) AS ok`,
    dangling: [
      `DELETE FROM ${table("notes")} WHERE "authorId" IS NOT NULL AND "authorId" NOT IN (SELECT "id" FROM ${table("people")})`,
      `UPDATE ${table("notes")} SET "teamId" = NULL WHERE "teamId" IS NOT NULL`,
    ],
    agrees: [
      `UPDATE ${table("people")} SET "name" = "firstName" || ' ' || "lastName" WHERE "name" <> "firstName" || ' ' || "lastName"`,
    ],
    agreesCheck: `SELECT NOT EXISTS (SELECT 1 FROM ${table("people")} WHERE "name" <> "firstName" || ' ' || "lastName") AS ok`,
  };
};

/**
 * Generates the history past `origin` with `at(stage)`, the migration client
 * for that stage's schema, and returns its states in apply order.
 */
export async function generateReportStates(
  at: (stage: number) => WritableMigrations,
  namespace: string,
  origin: string
): Promise<readonly string[]> {
  const text = reportSql(namespace);
  const manual = async (
    stage: number,
    name: string,
    from: string,
    up: readonly string[],
    check?: string
  ) =>
    (
      await at(stage).generate({
        name,
        manualMigration: {
          transitions: [
            {
              from,
              execution: "transactional",
              up: up.map((statement) => sql.raw(statement)),
              rollback: { kind: "irreversible", reason: "test" },
            },
          ],
          ...(check
            ? {
                destinationChecks: [
                  { kind: "trusted-read", query: sql.raw(check), equals: true },
                ],
              }
            : {}),
        },
      })
    ).stateId!;
  const names = await manual(
    1,
    "person-first-last-name",
    origin,
    text.names,
    text.namesCheck
  );
  const teams = (await at(2).generate({ name: "note-teams" })).stateId!;
  const dangling = await manual(2, "dangling-authors", teams, text.dangling);
  const index = (await at(3).generate({ name: "notes-author-index" })).stateId!;
  const agrees = await manual(
    3,
    "person-name-agrees",
    index,
    text.agrees,
    text.agreesCheck
  );
  return [names, teams, dangling, index, agrees];
}
