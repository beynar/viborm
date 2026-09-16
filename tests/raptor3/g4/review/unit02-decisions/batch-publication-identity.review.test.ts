/**
 * Independent review probe — G4-02 DECISIONS unit, R-D3.
 *
 * The decision: the bare `Error: Raptor 3 update expression publication
 * requires an integer field` becomes a registered `QueryEngineError` naming the
 * model, the field and the operation, with `meta { model, operation, field }`,
 * raised at the same point — before any statement is dispatched.
 *
 * The author's two cells measure ONE domain (`number`) and one operation
 * (`upsert`). This probe asks the questions they do not:
 *
 * - does the identity hold for the OTHER non-`int` key domains the message
 *   interpolates (`decimal`, `bigint`)?
 * - is the refusal really raised before any statement reaches the provider —
 *   measured, not argued?
 * - does the `int` arm still publish, on the same driver?
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

/** A D1-shaped ATOMIC BATCH profile: no interactive transaction, one batch. */
class BatchRecordingDriver extends SQLite3Driver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
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

const intKey = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g4r2d_p_int");
const bigKey = s
  .model({ id: s.bigInt().id(), label: s.string() })
  .map("g4r2d_p_big");
const decKey = s
  .model({ id: s.decimal({ precision: 8, scale: 2 }).id(), label: s.string() })
  .map("g4r2d_p_dec");
const numKey = s
  .model({ id: s.number().id(), label: s.string() })
  .map("g4r2d_p_num");
const schema = { intKey, bigKey, decKey, numKey };

const SEED = `
  INSERT INTO g4r2d_p_int (id,label) VALUES (6,'a');
  INSERT INTO g4r2d_p_big (id,label) VALUES (6,'a');
  INSERT INTO g4r2d_p_dec (id,label) VALUES ('600','a');
  INSERT INTO g4r2d_p_num (id,label) VALUES (6.0,'a');
`;

async function batchUpsert(
  engine: "shipped" | "candidate",
  model: keyof typeof schema,
  table: string,
  args: unknown
) {
  const database = new Database(":memory:");
  const driver = new BatchRecordingDriver({ client: database });
  const client = createClient({ schema, driver });
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called only from cells.
  assert.equal((await syncLiveSchema(client)).applied, true);
  database.exec(SEED);
  const candidate = createCommandEngine({ schema, driver });
  driver.reset();
  let answer: string;
  let raised: unknown;
  try {
    const value =
      engine === "shipped"
        ? await (
            client as unknown as Record<
              string,
              Record<string, (args: unknown) => Promise<unknown>>
            >
          )[model]!.upsert!(args)
        : await candidate.execute(model, "upsert", args);
    answer = `ok:${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
  } catch (error) {
    raised = error;
    answer = `${(error as Error).constructor.name}: ${(error as Error).message}`;
  }
  const writes = driver.statements.filter((sql) =>
    /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
  );
  const rows = database.prepare(`SELECT * FROM ${table}`).all();
  await client.$disconnect();
  database.close();
  return { answer, raised, rows, writes, statements: driver.statements.length };
}

describe("G4-02 decisions review — R-D3's identity across the non-int domains", () => {
  it("names every non-int domain with the same registered identity, and dispatches nothing", async () => {
    const cases = [
      [
        "decimal key",
        "decKey",
        "g4r2d_p_dec",
        {
          where: { id: "6.00" },
          create: { id: "6.00", label: "a" },
          update: { id: { increment: "1.00" } },
        },
        "decimal",
      ],
      [
        "bigint key",
        "bigKey",
        "g4r2d_p_big",
        {
          where: { id: 6n },
          create: { id: 6n, label: "a" },
          update: { id: { increment: 1n } },
        },
        "bigint",
      ],
      [
        "number key",
        "numKey",
        "g4r2d_p_num",
        {
          where: { id: 6 },
          create: { id: 6, label: "a" },
          update: { id: { increment: 1 } },
        },
        "number",
      ],
    ] as const;
    for (const [name, model, table, args, type] of cases) {
      const shipped = await batchUpsert("shipped", model, table, args);
      const candidate = await batchUpsert("candidate", model, table, args);
      // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
      console.log(
        `[${name}]\n  shipped   ${shipped.answer}\n            rows ${JSON.stringify(shipped.rows)}\n  candidate ${candidate.answer}\n            rows ${JSON.stringify(candidate.rows)}\n            writes dispatched ${JSON.stringify(candidate.writes)} (of ${candidate.statements} statements)\n            meta ${JSON.stringify((candidate.raised as QueryEngineError | undefined)?.meta ?? null)}`
      );
      assert.equal(
        candidate.answer,
        `QueryEngineError: Cannot publish the updated value of '${model}.id' for operation "upsert" inside an atomic batch: the batch scratch reads back as an integer, and 'id' is a ${type} field.`,
        name
      );
      assert.equal(candidate.raised instanceof QueryEngineError, true, name);
      assert.deepEqual(
        { ...(candidate.raised as QueryEngineError).meta },
        { field: "id", model, operation: "upsert" },
        name
      );
      // "Raised before any statement is dispatched", measured: no write ever
      // reached the provider, and the row is untouched.
      assert.deepEqual(candidate.writes, [], `${name}: writes dispatched`);
    }
  }, 180_000);

  it("still publishes an INT key expression on the same batch profile", async () => {
    const candidate = await batchUpsert("candidate", "intKey", "g4r2d_p_int", {
      where: { id: 6 },
      create: { id: 6, label: "a" },
      update: { id: { increment: 1 } },
    });
    // biome-ignore lint/suspicious/noConsole: the probe's output IS its receipt.
    console.log(
      `[int key control]\n  candidate ${candidate.answer}\n            rows ${JSON.stringify(candidate.rows)}`
    );
    assert.equal(candidate.answer, 'ok:{"id":7,"label":"a"}');
  }, 120_000);
});
