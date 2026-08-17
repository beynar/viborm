import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchTransactionOptions } from "@drivers/shared/transaction-options";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError } from "@errors";
import type { Sql } from "@sql";
import { updateFamilySchema } from "@tests/contracts/engine/write/update-family-behavior";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { TransportCensusRecorder } from "@tests/fixtures/transport-census";
import { describe, expect, test } from "vitest";

const getFamily = usePGliteSchemaFamily(updateFamilySchema);

/** The folded write's shape: it must project through its own RETURNING clause,
 *  because a folded plan has no terminal read left to answer from. */
const FOLDED_UPDATE = /^UPDATE .* RETURNING /;
const FOLDED_DELETE = /^DELETE FROM .* RETURNING /;
const SELECT_STATEMENT = /^SELECT /;
const WRITE_STATEMENT = /^\s*(?:INSERT|UPDATE|DELETE)\b/i;

// ---------------------------------------------------------------------------
// The measured starting line for relation-bearing bulk transport on a
// batch-only substrate.
//
// This PGlite stand-in can measure SQL statements, single-statement driver body
// calls, and the transaction envelope used to emulate an atomic batch. It
// cannot observe a remote protocol boundary and it has no provider-native batch
// API. Those two facts are recorded explicitly rather than inferred from
// `_executeBatch` entry calls.
//
// Execution units remain available to pin grouping and exact SQL shape. They
// are not provider-request measurements.
// ---------------------------------------------------------------------------

interface ExecutionUnit {
  readonly kind: "execute" | "batch";
  readonly statements: readonly string[];
}

class TransportCensusPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly transport = new TransportCensusRecorder({
    providerRequests: "not-measured",
    atomicity: "operation",
  });
  readonly executionUnits: ExecutionUnit[] = [];

  private emulatedBatchDepth = 0;

  override _execute<T>(
    statement: Sql,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.executionUnits.push({
      kind: "execute",
      statements: [statement.strings.join("?")],
    });
    return super._execute<T>(statement, context);
  }

  override _executeBatch<T>(
    queries: BatchQuery[],
    options?: BatchTransactionOptions,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>[]> {
    this.executionUnits.push({
      kind: "batch",
      statements: queries.map((query) => query.sql),
    });
    return super._executeBatch<T>(queries, options, context);
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.transport.recordExecuteCall();
    const queryResult = await super.execute<T>(client, sql, params, context);
    if (this.emulatedBatchDepth === 0 && WRITE_STATEMENT.test(sql)) {
      this.transport.recordCommittedWriteSegment();
    }
    return queryResult;
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.transport.recordExecuteCall();
    const queryResult = await super.executeRaw<T>(client, sql, params, context);
    if (this.emulatedBatchDepth === 0 && WRITE_STATEMENT.test(sql)) {
      this.transport.recordCommittedWriteSegment();
    }
    return queryResult;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const containsWrite = queries.some((query) =>
      WRITE_STATEMENT.test(query.sql)
    );
    this.transport.recordBegin();
    this.emulatedBatchDepth += 1;
    try {
      const queryResults = await this.transaction(client, async (tx) => {
        const results: QueryResult<T>[] = [];
        for (const query of queries) {
          results.push(await this.executeRaw<T>(tx, query.sql, query.params));
        }
        return results;
      });
      this.transport.recordCommit();
      if (containsWrite) this.transport.recordCommittedWriteSegment();
      return queryResults;
    } catch (error) {
      this.transport.recordRollback();
      throw error;
    } finally {
      this.emulatedBatchDepth -= 1;
    }
  }

  resetTransport(): void {
    this.executionUnits.length = 0;
    this.transport.reset();
  }
}

async function seeded(postIds: number[] = []): Promise<{
  driver: TransportCensusPGliteDriver;
  client: any;
}> {
  const family = getFamily();
  await family.reset();
  const db = family.database;
  const driver = new TransportCensusPGliteDriver({ client: db });
  const client = createClient({ schema: updateFamilySchema, driver });
  await client.user.create({ data: { id: 1, email: "root@x", count: 1 } });
  for (const id of postIds) {
    await client.post.create({
      data: { id, title: `t${id}`, slug: `s${id}`, userId: 1 },
    });
  }
  driver.resetTransport();
  return { driver, client };
}

/** Every planning read the operation sent before its one atomic write batch. */
function planningCalls(driver: TransportCensusPGliteDriver) {
  return driver.executionUnits.slice(0, -1);
}

describe("relation bulk transport census on an embedded batch stand-in", () => {
  test("the census separates execute, native batch, and provider calls", () => {
    const transport = new TransportCensusRecorder({
      providerRequests: 0,
      atomicity: "segment",
    });

    transport.recordExecuteCall();
    transport.recordNativeBatchCall(3);
    transport.recordProviderRequest();
    transport.recordBegin();
    transport.recordCommit();
    transport.recordSavepoint();
    transport.recordCommittedWriteSegment();

    expect(transport.snapshot()).toEqual({
      sqlStatements: 4,
      executeCalls: 1,
      nativeBatchCalls: 1,
      providerRequests: 1,
      atomicity: "segment",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 1,
        commit: 1,
        rollback: 0,
        savepoints: 1,
      },
    });
  });

  test("an embedded census refuses to invent provider-request counts", () => {
    const transport = new TransportCensusRecorder({
      providerRequests: "not-measured",
      atomicity: "operation",
    });

    expect(() => transport.recordProviderRequest()).toThrow(
      "Provider requests are not measured by this census."
    );
    expect(transport.snapshot().providerRequests).toBe("not-measured");
  });

  test("a scalar update is one batch unit with two executed statements", async () => {
    const { driver, client } = await seeded();

    await client.user.update({
      where: { email: "root@x" },
      data: { count: 2 },
    });

    expect(driver.executionUnits).toHaveLength(1);
    const [unit] = driver.executionUnits;
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(2);
    expect(unit?.statements[0]).toContain("__viborm_assert__");
    expect(unit?.statements[1]).toMatch(FOLDED_UPDATE);
    expect(driver.transport.snapshot()).toEqual({
      sqlStatements: 2,
      executeCalls: 2,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 1,
        commit: 1,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  test("a scalar delete is one batch unit with two executed statements", async () => {
    const { driver, client } = await seeded();
    await client.user.delete({ where: { email: "root@x" } });

    expect(driver.executionUnits).toHaveLength(1);
    const [unit] = driver.executionUnits;
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(2);
    expect(unit?.statements[0]).toContain("__viborm_assert__");
    expect(unit?.statements[1]).toMatch(FOLDED_DELETE);
    expect(driver.transport.snapshot()).toEqual({
      sqlStatements: 2,
      executeCalls: 2,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 1,
        commit: 1,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  test("a folded scalar upsert is one statement without an envelope", async () => {
    const { driver, client } = await seeded();
    await client.user.upsert({
      where: { email: "root@x" },
      create: { email: "root@x", count: 9 },
      update: { count: 7 },
    });
    expect(driver.executionUnits).toHaveLength(1);
    expect(driver.executionUnits[0]?.kind).toBe("execute");
    expect(driver.transport.snapshot()).toEqual({
      sqlStatements: 1,
      executeCalls: 1,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 0,
        commit: 0,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  // WHY PHASE 6.2 DOES NOT EXTEND HERE — measured, not asserted. The upsert's
  // update arm ALREADY compiles to the shape 6.2 builds for update and delete:
  // `[presence guard, UPDATE … RETURNING]`, no postcondition (`enforceAffected`
  // is a transaction-mode-only conjunct). There is nothing to fold.
  //
  // Its remaining planning call decides create-versus-update; an upsert with no
  // locate has no arm.
  // Decision 7.1's `INSERT … ON CONFLICT DO UPDATE` door is the mechanism that
  // removes it, and this payload is the one the door excludes (conjunct 6 —
  // PostgreSQL calls the bare column reference ambiguous inside `DO UPDATE SET`).
  test("an excluded upsert keeps one locate and one two-statement batch", async () => {
    const { driver, client } = await seeded();
    await client.user.upsert({
      where: { email: "root@x" },
      create: { email: "root@x", count: 9 },
      update: { count: { increment: 7 } },
    });
    expect(driver.executionUnits).toHaveLength(2);
    expect(driver.executionUnits[0]?.kind).toBe("execute");
    // The atomic unit is already the folded pair — the arm's terminal refetch is
    // gone and the presence premise rides inside the batch.
    const unit = driver.executionUnits[1];
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(2);
    expect(unit?.statements[0]).toContain("__viborm_assert__");
    expect(unit?.statements[1]).toMatch(FOLDED_UPDATE);
    expect(driver.transport.snapshot()).toEqual({
      sqlStatements: 3,
      executeCalls: 3,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 1,
        commit: 1,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  test("a conditional skip keeps two batch units and commits no write", async () => {
    const { driver, client } = await seeded();

    const result = await client.user.upsert({
      where: { email: "root@x" },
      targetWhere: { count: 999 },
      create: { email: "root@x", count: 9 },
      update: { count: 7 },
      select: { email: true, count: true },
    });

    expect(result).toEqual({ email: "root@x", count: 1 });
    expect(driver.executionUnits).toHaveLength(2);
    expect(driver.executionUnits[0]?.kind).toBe("batch");
    expect(driver.executionUnits[0]?.statements).toHaveLength(2);
    const unit = driver.executionUnits[1];
    expect(unit?.kind).toBe("batch");
    expect(unit?.statements).toHaveLength(3);
    expect(unit?.statements[0]).toContain("CASE WHEN EXISTS");
    expect(unit?.statements[1]).toContain("CASE WHEN NOT EXISTS");
    expect(unit?.statements[2]).toMatch(SELECT_STATEMENT);
    expect(driver.transport.snapshot()).toEqual({
      sqlStatements: 5,
      executeCalls: 5,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 0,
      transactionEnvelope: {
        begin: 2,
        commit: 2,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  test("a failed emulated batch records rollback and no committed segment", async () => {
    const { driver, client } = await seeded();

    await expect(
      driver._executeBatch([
        {
          sql: 'INSERT INTO "update_family_users" ("id", "email", "count") VALUES ($1, $2, $3)',
          params: [2, "rolled-back@x", 2],
        },
        {
          sql: 'INSERT INTO "update_family_users" ("id", "email", "count") VALUES ($1, $2, $3)',
          params: [3, "root@x", 3],
        },
      ])
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    expect(driver.executionUnits).toHaveLength(1);
    expect(driver.executionUnits[0]?.statements).toHaveLength(2);
    expect(driver.transport.snapshot()).toEqual({
      sqlStatements: 2,
      executeCalls: 2,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 0,
      transactionEnvelope: {
        begin: 1,
        commit: 0,
        rollback: 1,
        savepoints: 0,
      },
    });
    await expect(
      client.user.findUnique({ where: { email: "rolled-back@x" } })
    ).resolves.toBeNull();
  });

  // A scalar create has no planning read and the PostgreSQL producer's own
  // RETURNING answers the selection in that same statement. The exact fold uses
  // the direct statement path; no synthetic one-entry batch envelope is needed.
  test("a scalar create uses one direct execution unit without claiming a request", async () => {
    const { driver, client } = await seeded();
    await client.user.create({
      data: { id: 2, email: "fresh@x", count: 4 },
    });
    expect(driver.executionUnits).toHaveLength(1);
    expect(driver.executionUnits[0]?.kind).toBe("execute");
    const statementCount = driver.executionUnits[0]?.statements.length;
    expect(driver.transport.snapshot()).toMatchObject({
      sqlStatements: statementCount,
      executeCalls: statementCount,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 0,
        commit: 0,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  // A root locate travels through one single-statement entry call. The two
  // independent probes share one batch entry call, followed by the write unit.
  test("independent sibling probes share one planning batch call", async () => {
    // The two sibling probes below reference nothing but their own unique keys
    // and the located parent, so nothing orders them against EACH OTHER — only
    // a technique-#1 reference orders planning steps, and both of theirs point
    // at the same locate. They therefore occupy one dependency level.
    const { driver, client } = await seeded([20, 21]);

    await client.user.update({
      where: { email: "root@x" },
      data: {
        count: 5,
        posts: {
          update: [
            { where: { id: 20 }, data: { title: "a2" } },
            { where: { id: 21 }, data: { title: "b2" } },
          ],
        },
      },
    });

    expect(driver.executionUnits).toHaveLength(3);
    const planning = planningCalls(driver);
    expect(planning).toHaveLength(2);
    // Level 0 — the root locate, alone, on the per-statement path.
    expect(planning[0]?.kind).toBe("execute");
    expect(planning[0]?.statements).toHaveLength(1);
    // Level 1 — both correlated probes in ONE batch.
    expect(planning[1]?.kind).toBe("batch");
    expect(planning[1]?.statements).toHaveLength(2);
    // ...and one atomic batch carrying every write.
    expect(driver.executionUnits.at(-1)?.kind).toBe("batch");
    const measuredStatementCount = driver.executionUnits.reduce(
      (count, unit) => count + unit.statements.length,
      0
    );
    expect(driver.transport.snapshot()).toMatchObject({
      sqlStatements: measuredStatementCount,
      executeCalls: measuredStatementCount,
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      atomicity: "operation",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 2,
        commit: 2,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  // Adding siblings adds statements to one dependency level, not entry calls.
  test("the planning cost no longer grows with the fan-out", async () => {
    const { driver, client } = await seeded([30, 31, 32, 33]);

    await client.user.update({
      where: { email: "root@x" },
      data: {
        posts: {
          update: [30, 31, 32, 33].map((id) => ({
            where: { id },
            data: { title: `w${id}` },
          })),
        },
      },
    });

    expect(driver.executionUnits).toHaveLength(3);
    const planning = planningCalls(driver);
    expect(planning).toHaveLength(2);
    expect(planning[0]?.statements).toHaveLength(1);
    // Four probes, one batch — this is the entry that would grow again if the
    // grouping were lost.
    expect(planning[1]?.statements).toHaveLength(4);
    expect(driver.transport.snapshot()).toMatchObject({
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 2,
        commit: 2,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  // These reads share a level: the nested upsert probe uses the caller's literal
  // id and references nothing produced by the root locate.
  test("planning reads that reference nothing of each other's share a level", async () => {
    const { driver, client } = await seeded([40]);

    await client.user.update({
      where: { email: "root@x" },
      data: {
        posts: {
          upsert: [
            {
              where: { id: 40 },
              create: { id: 40, title: "c", slug: "sc" },
              update: { title: "u" },
            },
          ],
        },
      },
    });

    expect(driver.executionUnits).toHaveLength(2);
    const planning = planningCalls(driver);
    expect(planning).toHaveLength(1);
    expect(planning[0]?.kind).toBe("batch");
    expect(planning[0]?.statements).toHaveLength(2);
    expect(driver.transport.snapshot()).toMatchObject({
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 2,
        commit: 2,
        rollback: 0,
        savepoints: 0,
      },
    });
  });

  // BASELINE UPDATED DELIBERATELY — PLAN Phase 6.2. This is the seam that
  // falsified the plan's own correction: fold to a step carrying a JS
  // postcondition and `compileToEntries` refuses it here, because this path
  // merges several operations into ONE driver batch and a check that runs after
  // the batch returns cannot un-commit the siblings. A working payload would
  // have become a typed refusal, so the count stayed at two.
  //
  // The shipped fold carries no postcondition — its premise is a guard INSIDE
  // the unit — so nothing is deferred past the merge, the seam keeps working,
  // and its planning read is gone: two execution units became one. The RESULT is
  // asserted first and unchanged; that is the half of this test that says the
  // seam still works rather than merely still being cheap.
  test("$transaction([...]) folds the update into the merged batch", async () => {
    const { driver, client } = await seeded();

    const out = await client.$transaction([
      client.user.update({ where: { email: "root@x" }, data: { count: 3 } }),
    ]);

    expect(out).toEqual([{ id: 1, email: "root@x", count: 3 }]);
    expect(driver.executionUnits).toHaveLength(1);
    expect(driver.executionUnits[0]?.kind).toBe("batch");
    expect(driver.transport.snapshot()).toMatchObject({
      nativeBatchCalls: 0,
      providerRequests: "not-measured",
      committedWriteSegments: 1,
      transactionEnvelope: {
        begin: 1,
        commit: 1,
        rollback: 0,
        savepoints: 0,
      },
    });
  });
});
