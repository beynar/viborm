import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NotFoundError, VibORMErrorCode } from "@errors";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import type { OperationStep } from "../../src/query-engine-v2/OperationFragment";
import { planningKey } from "../../src/query-engine-v2/Part";
import { constructRoutedOperation } from "../../src/query-engine-v2/routing";

/**
 * PHASE 3 — the delete fold (query-performance-plan).
 *
 * A delete by primary key used to send five round trips: BEGIN, a locate SELECT,
 * a snapshot SELECT, the DELETE, COMMIT. The snapshot SELECT re-read exactly what
 * the DELETE was already handing back — the statement always carried a RETURNING
 * clause whose rows were discarded. Phase 3 uses that clause: the mainstream
 * delete is now ONE `DELETE … WHERE <unique where> RETURNING <select>`, run
 * statement-atomically with no transaction envelope at all.
 *
 * These are the witnesses for the fold GATE. What the fold must not disturb —
 * the persisted effect, the extended-selector filter half, the driver matrix — is
 * covered by the delete cases already spread across `extended-where-unique-behavior.ts`,
 * `nested-write-behavior.ts` and the five driver legs. What is new, and what only a
 * test that can see the traffic can prove, is the COUNT, the ORDER, and that the
 * three excluded shapes kept their statements.
 */

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    label: s.string(),
    notes: s.oneToMany(() => note),
  })
  .map("p3_fold_accounts");
const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    accountId: s.int(),
    account: s
      .manyToOne(() => account)
      .fields("accountId")
      .references("id")
      .onDelete("cascade"),
  })
  .map("p3_fold_notes");

const schema = { account, note };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

/**
 * Records every statement the operation sends, in order. The hook is the PROTECTED
 * `execute`/`executeRaw` seam rather than `_execute`, because a transaction runs its
 * statements through a transaction-bound driver that delegates back to exactly these
 * two methods — so one hook sees both substrates.
 */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

class BatchOnlyRecordingDriver extends RecordingPGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

async function boot(driver: RecordingPGliteDriver) {
  const client = createClient({ schema, driver });
  await push(client, { force: true });
  for (const id of [1, 2, 3, 4, 5]) {
    await client.account.create({
      data: { id, email: `a${id}@x`, label: `L${id}` },
    });
  }
  // Only account 3 owns notes — the two include witnesses target it, so the
  // relation payload they read is non-empty and a lost read would be visible.
  await client.note.create({ data: { id: 30, body: "n30", accountId: 3 } });
  return client;
}

/** The captured statements, cleared so the next act starts from empty. */
function drain(driver: RecordingPGliteDriver): string[] {
  return driver.statements.splice(0, driver.statements.length);
}

describe("the delete fold — statement traffic", () => {
  test("a scalar delete is ONE statement, and it is the DELETE", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    const deleted = await client.account.delete({ where: { id: 1 } });
    const statements = drain(driver);
    driver.recording = false;

    // THE measurement: three payload statements became one. (Five round trips
    // became one: empty planning routes the operation through the executor's
    // statement-atomic path, which opens no transaction — the plan-shape
    // witnesses below pin that structurally.)
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("DELETE FROM");
    expect(statements[0]).toContain("RETURNING");

    // The fold returns the row's pre-delete shape, exactly as the snapshot
    // SELECT did, and the row is gone.
    expect(deleted).toEqual({ id: 1, email: "a1@x", label: "L1" });
    expect(await client.account.findUnique({ where: { id: 1 } })).toBeNull();
  });

  test("an ALTERNATE unique folds too, and addresses the row by that unique", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    const deleted = await client.account.delete({
      where: { email: "a2@x" },
      select: { label: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(1);
    // The multi-statement path located FOR UPDATE by `email` and then wrote
    // `WHERE id` (the captured primary key), because an alternate unique could be
    // rewritten between the two statements. There are no longer two statements to
    // race between: one DELETE matches, locks and removes one row, so the write
    // addresses the selector directly. Anything that re-introduced the locate
    // indirection would show up here as a second statement.
    expect(statements[0]).toContain("DELETE FROM");
    expect(statements[0]).toContain("email");
    expect(statements[0]).not.toContain("SELECT");

    // A narrower `select` narrows the RETURNING clause, and is what comes back.
    expect(deleted).toEqual({ label: "L2" });
    expect(
      await client.account.findUnique({ where: { email: "a2@x" } })
    ).toBeNull();
  });

  test("a delete with `include` still reads the relation BEFORE it deletes", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    const deleted = await client.account.delete({
      where: { id: 3 },
      include: { notes: true },
    });
    const statements = drain(driver);
    driver.recording = false;

    // Excluded from the fold and unchanged: locate, shape-capturing read, DELETE.
    // The related rows must be read while they still exist — the FK cascades, so
    // after the DELETE there is nothing left to read. A fold that swallowed this
    // shape would return `notes: []` for every delete with an include.
    expect(statements).toHaveLength(3);
    expect(statements.map((sql) => sql.slice(0, 6))).toEqual([
      "SELECT",
      "SELECT",
      "DELETE",
    ]);
    expect(statements[1]).toContain("p3_fold_notes");

    expect(deleted).toEqual({
      id: 3,
      email: "a3@x",
      label: "L3",
      notes: [{ id: 30, body: "n30", accountId: 3 }],
    });
    expect(await client.account.findUnique({ where: { id: 3 } })).toBeNull();
    expect(await client.note.findUnique({ where: { id: 30 } })).toBeNull();
  });

  test("batch mode keeps its in-unit presence guard and its read", async () => {
    const driver = new BatchOnlyRecordingDriver();
    const client = await boot(driver);

    driver.recording = true;
    const deleted = await client.account.delete({ where: { id: 4 } });
    const statements = drain(driver);
    driver.recording = false;

    // The folded step's `affectedRows` postcondition has no atomic-batch
    // lowering, and the batch substrate pins the row's presence INSIDE the
    // atomic unit (ATOM §8.1 note (b)) so a concurrent delete aborts it typed.
    // Both are reasons the gate requires transaction mode: planning locate,
    // in-unit presence guard, read, DELETE.
    expect(statements).toHaveLength(4);
    expect(statements[1]).toContain("__viborm_assert__");
    expect(statements[3]).toContain("DELETE FROM");

    expect(deleted).toEqual({ id: 4, email: "a4@x", label: "L4" });
    expect(await client.account.findUnique({ where: { id: 4 } })).toBeNull();
  });
});

describe("the delete fold — the NotFoundError is unchanged", () => {
  /**
   * The identity of the rejection a missing row produces — class, name, message
   * and code, as one comparable value so two paths can be asserted EQUAL rather
   * than each matched against a description.
   */
  async function rejection(act: PromiseLike<unknown>) {
    const error = await act.then(
      () => undefined,
      (caught: unknown) => caught
    );
    const notFound = error as NotFoundError;
    return {
      isNotFoundError: error instanceof NotFoundError,
      name: notFound?.name,
      message: notFound?.message,
      code: notFound?.code,
    };
  }

  test("the folded path and the multi-statement paths raise the SAME error", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    const batchDriver = new BatchOnlyRecordingDriver();
    const batchClient = await boot(batchDriver);

    // The folded path: the DELETE affects no row, and the `affectedRows(1,
    // notFound)` postcondition fires in JS after the single round-trip.
    const folded = await rejection(
      client.account.delete({ where: { id: 99 } })
    );

    // The multi-statement path: the locate read's `exactlyOneRow` postcondition
    // fires at PLANNING, before any write.
    const multiStatement = await rejection(
      client.account.delete({ where: { id: 99 }, include: { notes: true } })
    );

    // The batch path: the in-unit presence guard aborts the atomic unit.
    const batch = await rejection(
      batchClient.account.delete({ where: { id: 99 } })
    );

    // Byte-identical, all three: `failureError` builds the public error from the
    // execution context, not from the step that failed, so moving the assertion
    // from a locate read to a write postcondition cannot change what the caller
    // sees.
    expect(folded).toEqual({
      isNotFoundError: true,
      name: "NotFoundError",
      message: "No account record found for delete",
      code: VibORMErrorCode.RECORD_NOT_FOUND,
    });
    expect(multiStatement).toEqual(folded);
    expect(batch).toEqual(folded);
  });

  test("an EXCLUDING extended selector folds and is still a NOT-FOUND", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);

    driver.recording = true;
    // The filter half rides INTO the folded DELETE's WHERE (no locate to carry
    // it any more), so an excluding filter has to make the statement affect zero
    // rows rather than silently widening to the bare unique.
    const excluded = await rejection(
      client.account.delete({ where: { id: 5, label: "wrong" } })
    );
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(1);
    expect(excluded).toEqual({
      isNotFoundError: true,
      name: "NotFoundError",
      message: "No account record found for delete",
      code: VibORMErrorCode.RECORD_NOT_FOUND,
    });
    // And the row the filter excluded is still there — a widened selector would
    // have deleted it.
    expect(
      await client.account.findUnique({
        where: { id: 5 },
        select: { id: true },
      })
    ).toEqual({ id: 5 });

    // The matching filter deletes the same row through the same one statement.
    expect(
      await client.account.delete({ where: { id: 5, label: "L5" } })
    ).toEqual({ id: 5, email: "a5@x", label: "L5" });
  });
});

describe("the delete fold — the plan shape, without a database", () => {
  function engineFor(driver: MySQL2Driver | PGliteDriver): QueryEngine {
    return new QueryEngine(
      driver,
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
  }

  function sqlOf(step: OperationStep): string {
    if (!("statement" in step)) throw new Error("expected a statement step");
    return step.statement.strings.join("");
  }

  test("a RETURNING driver plans nothing and compiles to one write", () => {
    const operation = constructRoutedOperation(
      engineFor(new PGliteDriver()),
      schema.account,
      "delete",
      { where: { id: 1 } }
    );

    // EMPTY planning is the whole point: `OperationExecutor.statementAtomicPlan`
    // takes an operation with no planning steps and exactly one non-guard step
    // and runs it directly on the base driver — no BEGIN, no COMMIT. A planning
    // step here would put the operation back inside a transaction envelope even
    // if the payload statements stayed at one.
    expect(operation?.planning().steps).toEqual([]);
    const compiled = operation!.compile({});
    expect(compiled.steps.map((step) => step.kind)).toEqual(["write"]);
    expect(sqlOf(compiled.steps[0]!)).toContain("DELETE");
    expect(sqlOf(compiled.steps[0]!)).toContain("RETURNING");
    expect(compiled.outputs.result).toMatchObject({
      step: compiled.steps[0]!.id,
      output: "result",
    });
  });

  test("a relation nested in `select` does not fold either", () => {
    // `include` is not the only relation projection: `select: { notes: … }`
    // produces the same lateral join, and the same reason applies — the related
    // rows have to be read while they still exist. The gate keys on the
    // PROJECTION, not on which of the two keys spelled it, so this shape keeps
    // its planning read.
    //
    // Pinned at the plan rather than against a database because this path has a
    // pre-existing PostgreSQL defect unrelated to the fold: the shape-capturing
    // read asks for `FOR UPDATE` over the lateral join and PostgreSQL answers
    // 0A000. Reproduced on the PR tip with this phase reverted; filed separately.
    // What THIS phase owns is the verdict below — that the shape is declined.
    const operation = constructRoutedOperation(
      engineFor(new PGliteDriver()),
      schema.account,
      "delete",
      {
        where: { id: 1 },
        select: { id: true, notes: { select: { body: true } } },
      }
    );

    expect(operation!.planning().steps).toHaveLength(1);
  });

  test("a NON-RETURNING driver keeps the locate, the read, and the delete", () => {
    // MySQL2Driver is transaction-capable and non-returning, so the ATOM §7
    // batch-only refusal does not pre-empt the plan. No connection is made:
    // planning and compile are pure.
    const operation = constructRoutedOperation(
      engineFor(new MySQL2Driver()),
      schema.account,
      "delete",
      { where: { id: 1 } }
    );

    const planning = operation!.planning();
    expect(planning.steps).toHaveLength(1);
    expect(planning.steps[0]!.kind).toBe("read");
    expect(sqlOf(planning.steps[0]!)).toContain("FOR UPDATE");

    // Read BEFORE delete: without RETURNING the row cannot be recovered once it
    // is gone, so the capture has to precede the write.
    const compiled = operation!.compile({
      [planningKey(planning.steps[0]!.id, "rows")]: [{ id: 1 }],
    });
    expect(compiled.steps.map((step) => step.kind)).toEqual(["read", "write"]);
    expect(compiled.outputs.result).toMatchObject({
      step: compiled.steps[0]!.id,
      output: "result",
    });
  });
});
