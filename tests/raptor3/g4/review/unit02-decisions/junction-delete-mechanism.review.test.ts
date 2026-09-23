/**
 * Independent review probe — G4-02 DECISIONS unit, R-B5.
 *
 * The note (§D.3) names the mechanism: before the repair the junction `delete`
 * arm placed the TARGET's `DELETE` **with no link-row statement at all**, so a
 * provider that enforces the link's foreign key refused the write; the repair
 * places the link removal FIRST, in the same region, and only for a junction
 * `delete`.
 *
 * "The mechanism named in the note is the real one" is a claim about the
 * STATEMENTS, not about the answer. This probe records the actual SQL the
 * candidate issues for the three placements the repair distinguishes, and
 * checks the count and the order rather than the row set. It also compares the
 * shipped engine's statement shape for the same request, because the repair's
 * contract is "the shipped order".
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const OWNERS = "g4r2d_owners";
const NOTES = "g4r2d_notes";
const TAGS = "g4r2d_tags";
const LINKS = "g4r2d_links";

const owner = s
  .model({
    id: s.string().id(),
    name: s.string(),
    notes: s.toMany(() => note),
    tags: s.toMany(() => tag).through(LINKS).source("ownerId").target("tagId"),
  })
  .map(OWNERS);
const note = s
  .model({
    id: s.string().id(),
    ownerId: s.string().nullable(),
    owner: s
      .toOne(() => owner)
      .fields("ownerId")
      .references("id"),
  })
  .map(NOTES);
const tag = s
  .model({
    id: s.string().id(),
    label: s.string(),
    owners: s.toMany(() => owner),
  })
  .map(TAGS);
const schema = { owner, note, tag };

class RecordingDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  reset(): void {
    this.statements.length = 0;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries, context);
  }
}

async function world() {
  const database = new Database(":memory:");
  const driver = new RecordingDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("world did not apply");
  // Plain foreign keys: the project's migration emits ON DELETE CASCADE on the
  // junction, which makes the statement ORDER unobservable.
  database.exec(
    `DROP TABLE "${LINKS}";
     CREATE TABLE "${LINKS}" (
       "ownerId" TEXT NOT NULL,
       "tagId" TEXT NOT NULL,
       PRIMARY KEY ("ownerId","tagId"),
       FOREIGN KEY ("ownerId") REFERENCES "${OWNERS}" ("id"),
       FOREIGN KEY ("tagId") REFERENCES "${TAGS}" ("id")
     );
     INSERT INTO ${OWNERS} (id,name) VALUES ('o1','winner');
     INSERT INTO ${NOTES} (id,ownerId) VALUES ('n1','o1');
     INSERT INTO ${TAGS} (id,label) VALUES ('t1','tag');
     INSERT INTO ${LINKS} (ownerId,tagId) VALUES ('o1','t1');`
  );
  return { client, database, driver };
}

/** The write statements, in issue order, reduced to verb + table. */
const writesOf = (statements: readonly string[]) =>
  statements
    .map((sql) => sql.replaceAll("\n", " ").replace(/\s+/g, " ").trim())
    .filter((sql) => /^(DELETE|INSERT|UPDATE)\b/i.test(sql))
    .map((sql) => {
      const match =
        /^(DELETE FROM|INSERT INTO|UPDATE)\s+"?([A-Za-z0-9_]+)"?/i.exec(sql);
      return match ? `${match[1]!.toUpperCase()} ${match[2]}` : sql.slice(0, 40);
    });

async function trace(
  engine: "shipped" | "candidate",
  args: unknown
): Promise<{ answer: string; writes: string[]; all: number }> {
  const w = await world();
  const candidate = createCommandEngine({ schema, driver: w.driver });
  w.driver.reset();
  let answer: string;
  try {
    const value =
      engine === "shipped"
        ? await (
            w.client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          ).owner!.update!(args)
        : await candidate.execute("owner", "update", args);
    answer = `ok:${JSON.stringify(value)}`;
  } catch (error) {
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const writes = writesOf(w.driver.statements);
  const all = w.driver.statements.length;
  await w.client.$disconnect();
  w.database.close();
  return { answer, writes, all };
}

describe("G4-02 decisions review — R-B5's mechanism, in statements", () => {
  it("places the junction link removal BEFORE the target deletion, and only there", async () => {
    const cases = [
      [
        "junction delete",
        { where: { id: "o1" }, data: { tags: { delete: [{ id: "t1" }] } } },
      ],
      [
        "junction disconnect",
        { where: { id: "o1" }, data: { tags: { disconnect: [{ id: "t1" }] } } },
      ],
      [
        "reference-held delete",
        { where: { id: "o1" }, data: { notes: { delete: [{ id: "n1" }] } } },
      ],
      [
        "junction set to empty",
        { where: { id: "o1" }, data: { tags: { set: [] } } },
      ],
    ] as const;
    const report: string[] = [];
    for (const [name, args] of cases) {
      const shipped = await trace("shipped", args);
      const candidate = await trace("candidate", args);
      report.push(
        `[${name}]\n  shipped   ${shipped.answer}\n            writes ${JSON.stringify(shipped.writes)} (of ${shipped.all} statements)\n  candidate ${candidate.answer}\n            writes ${JSON.stringify(candidate.writes)} (of ${candidate.all} statements)`
      );
      // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
      console.log(report.at(-1));
      if (name === "junction delete") {
        assert.deepEqual(
          candidate.writes,
          [`DELETE FROM ${LINKS}`, `DELETE FROM ${TAGS}`],
          "the junction delete issues the link removal, then the target deletion"
        );
        assert.deepEqual(
          shipped.writes,
          [`DELETE FROM ${LINKS}`, `DELETE FROM ${TAGS}`],
          "the shipped order this repair adopts"
        );
      }
      if (name === "junction disconnect")
        assert.deepEqual(
          candidate.writes,
          [`DELETE FROM ${LINKS}`],
          "a disconnect places the removal ALONE"
        );
      if (name === "reference-held delete")
        assert.deepEqual(
          candidate.writes,
          [`DELETE FROM ${NOTES}`],
          "a reference-held target places its deletion ALONE"
        );
    }
  }, 180_000);
});
