import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { NotFoundError, VibORMErrorCode } from "@errors";

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { OperationStep } from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { fragmentAtom } from "@tests/fixtures/routed-fragment-atom";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

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
    notes: s.toMany(() => note),
  })
  .map("p3_fold_accounts");
const note = s
  .model({
    id: s.int().id(),
    body: s.string(),
    accountId: s.int(),
    account: s
      .toOne(() => account)
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
  await syncLiveSchema(client);
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

  // PIN UPDATED DELIBERATELY — PLAN Phase 6.2. This shape emitted FOUR
  // statements (planning locate, in-unit presence guard, shape-capturing read,
  // DELETE) because the fold gate required transaction mode: a folded step
  // carried an `affectedRows` postcondition, and the atomic batch has no
  // lowering for one.
  //
  // The batch fold drops the postcondition instead of lowering it. The premise
  // is the guard the unit ALREADY carried (ATOM §8.1 note (b)) — same selector,
  // same failure, same attribution — so the locate and the read are what go
  // away, not the presence pin: two statements, one round trip.
  test("batch mode folds behind its in-unit presence guard", async () => {
    const driver = new BatchOnlyRecordingDriver();
    const client = await boot(driver);

    driver.recording = true;
    const deleted = await client.account.delete({ where: { id: 4 } });
    const statements = drain(driver);
    driver.recording = false;

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("__viborm_assert__");
    expect(statements[1]).toContain("DELETE FROM");
    expect(statements[1]).toContain("RETURNING");

    expect(deleted).toEqual({ id: 4, email: "a4@x", label: "L4" });
    expect(await client.account.findUnique({ where: { id: 4 } })).toBeNull();
  });
});

describe("the delete fold — a projection answers what the read answers", () => {
  /**
   * THE ORACLE the `_count` defect got past. A delete's projection is asserted
   * against `findUnique`'s answer for the SAME projection on the SAME row — not
   * against a literal, and not only on the substrate that happens to fold.
   *
   * `_count` is a relation projection that is NOT a member of `relationSet`, so a
   * gate spelled `relationSet.has(field)` judged it scalar and folded. A relation
   * subquery inside a `RETURNING` list has no table alias to correlate against:
   * `DELETE` has no alias, so the outer reference was emitted BARE as `"id"`, and
   * inside a subquery whose FROM is the child table it bound to the CHILD's `id`.
   * The predicate silently became `note.id = note.accountId`. Measured on PGlite
   * and better-sqlite3 before the fix: the read said 3 and the folded delete said
   * 0 — one payload, two substrates, two different answers.
   *
   * Stated as read-equality rather than fold-equality on purpose: it is the
   * property that must hold whatever the gate decides, so it keeps biting if the
   * fold ever widens again.
   */
  const projections = [
    {
      name: "_count with an explicit relation",
      count: { select: { notes: true } },
    },
    { name: "_count shorthand (every relation)", count: true },
  ] as const;

  for (const projection of projections) {
    test(`a delete projecting ${projection.name} answers the read's count, on both substrates`, async () => {
      const truthDriver = new RecordingPGliteDriver();
      const truthClient = await boot(truthDriver);
      // Three notes, so a wrong answer cannot coincide with the right one and the
      // seeded single note of `boot` cannot be mistaken for a correct count.
      for (const id of [31, 32]) {
        await truthClient.note.create({
          data: { id, body: `n${id}`, accountId: 3 },
        });
      }
      const select = { id: true, _count: projection.count };

      // The control: the same projection through the read path, which builds the
      // correlation against an ALIASED outer SELECT.
      const truth = await truthClient.account.findUnique({
        where: { id: 3 },
        select,
      });
      expect(truth).toEqual({ id: 3, _count: { notes: 3 } });

      for (const driver of [
        new RecordingPGliteDriver(),
        new BatchOnlyRecordingDriver(),
      ]) {
        const client = await boot(driver);
        for (const id of [31, 32]) {
          await client.note.create({
            data: { id, body: `n${id}`, accountId: 3 },
          });
        }
        driver.recording = true;
        const deleted = await client.account.delete({
          where: { id: 3 },
          select,
        });
        const statements = drain(driver);
        driver.recording = false;

        expect(deleted).toEqual(truth);
        // ...and it got there by declining the fold: the count has to be read
        // through an aliased SELECT, which is a statement of its own.
        expect(statements.length).toBeGreaterThan(1);
        expect(statements.some((sql) => sql.startsWith("DELETE"))).toBe(true);
        expect(
          await client.account.findUnique({ where: { id: 3 } })
        ).toBeNull();
      }
    });
  }
});

describe("every RETURNING fold — the same projection gate, the same oracle", () => {
  /**
   * The gate `DeleteOperation` shares with its three siblings lives in ONE place
   * (`shared.selectProjectsRelation`), so the sibling folds are asserted against
   * the same oracle here rather than left to a separate filing: `create`'s
   * `foldStep`, `update`'s `directWrite` and `upsert`'s `canFoldUpdateArm` each
   * emit `… RETURNING <select>` and each answered `_count` from a bare, aliasless
   * correlation. Measured before the fix, an account with three notes:
   * `update`/`upsert` said 0 where the read said 3, and a pure-scalar `create` —
   * whose truth is necessarily 0, because nothing can reference a row that did not
   * exist — said 1 whenever some child row's own `id` equalled its foreign key.
   *
   * That last row is seeded here on purpose (`note 7` on `account 7`): it makes the
   * captured predicate `note.id = note.accountId` true for exactly one row, so the
   * wrong answer is a wrong NUMBER on every operation rather than an empty one that
   * could be mistaken for a cascade or a read-after-write.
   */
  test("create / update / upsert answer the read's `_count`, not the captured one", async () => {
    const driver = new RecordingPGliteDriver();
    const client = await boot(driver);
    for (const id of [31, 32]) {
      await client.note.create({ data: { id, body: `n${id}`, accountId: 3 } });
    }
    await client.account.create({
      data: { id: 7, email: "a7@x", label: "L7" },
    });
    await client.note.create({ data: { id: 7, body: "n7", accountId: 7 } });

    const select = { id: true, _count: { select: { notes: true } } } as const;
    expect(
      await client.account.findUnique({ where: { id: 3 }, select })
    ).toEqual({ id: 3, _count: { notes: 3 } });

    // `update` — a scalar SET with no nested relation work, the shape that folds.
    expect(
      await client.account.update({
        where: { id: 3 },
        data: { label: "L3-updated" },
        select,
      })
    ).toEqual({ id: 3, _count: { notes: 3 } });

    // `upsert` — its update arm is the same fold.
    expect(
      await client.account.upsert({
        where: { id: 3 },
        create: { id: 3, email: "a3@x", label: "L3" },
        update: { label: "L3-upserted" },
        select,
      })
    ).toEqual({ id: 3, _count: { notes: 3 } });

    // `create` — a pure scalar create, the shape that folds. A fresh row owns
    // nothing, so the only answer that is not the captured one is zero.
    expect(
      await client.account.create({
        data: { id: 8, email: "a8@x", label: "L8" },
        select,
      })
    ).toEqual({ id: 8, _count: { notes: 0 } });
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
    // Narrow rather than assert: AGENTS.md forbids type assertions, and the
    // assertion here also lied about the resolved case — when `act` RESOLVES,
    // `error` is `undefined`, and only the optional chaining kept the reads from
    // throwing. The `toEqual` against a full object below is what catches both a
    // resolution and a different error class.
    if (!(error instanceof NotFoundError)) {
      return { isNotFoundError: false };
    }
    return {
      isNotFoundError: true,
      name: error.name,
      message: error.message,
      code: error.code,
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
    const operation = fragmentAtom(
      constructRoutedOperation(
        engineFor(new PGliteDriver()),
        schema.account,
        "delete",
        {
          where: { id: 1 },
        }
      ),
      "delete"
    );

    // EMPTY planning is the whole point: the direct single-statement policy
    // takes an operation with no planning steps and exactly one non-guard step
    // and runs it directly on the base driver — no BEGIN, no COMMIT. A planning
    // step here would put the operation back inside a transaction envelope even
    // if the payload statements stayed at one.
    expect(operation.planning().steps).toEqual([]);
    const compiled = operation.compile({});
    expect(compiled.steps.map((step) => step.kind)).toEqual(["write"]);
    expect(sqlOf(compiled.steps[0]!)).toContain("DELETE");
    expect(sqlOf(compiled.steps[0]!)).toContain("RETURNING");
    expect(compiled.outputs.result).toMatchObject({
      step: compiled.steps[0]!.id,
      output: "result",
    });
  });

  /**
   * The two halves of "the projection names a relation", asserted against the
   * SAME two properties, so no fix can satisfy one spelling by breaking the other.
   *
   * DECLINING THE FOLD is what Phase 3 owns: both shapes keep their planning
   * locate, because the related rows must be read while they still exist.
   *
   * DROPPING `FOR UPDATE` on the shape-capturing read is the defect this closes.
   * That read used to gate the lock on `!include` — half the question — so a
   * relation nested in `select` slipped past and PostgreSQL rejected the locked
   * lateral join with 0A000. Both spellings, measured live on PGlite in
   * transaction mode before the fix:
   *
   *   select: { id, notes: { select: { body } } }
   *     -> "FOR UPDATE is not allowed with aggregate functions"
   *   select: { id, account: { select: { label } } }   (the to-one direction)
   *     -> "FOR UPDATE cannot be applied to the nullable side of an outer join"
   *
   * (This test previously recorded that crash as a known, separately-filed
   * defect and asserted only the fold verdict. It is fixed; the lock assertion
   * below is what keeps it fixed.)
   *
   * Nothing is lost by dropping the lock: the locate above is `FOR UPDATE` and
   * `OperationExecutor.runTransaction` wraps BOTH the planning fragment and the
   * compiled fragment in ONE `withTransaction` handle, so the row lock the locate
   * takes is still held when the DELETE runs.
   */
  test.each([
    ["select", { id: true, notes: { select: { body: true } } }, undefined],
    ["include", undefined, { notes: true }],
  ])("a relation named by `%s` declines the fold and reads UNLOCKED", (_spelling, select, include) => {
    const operation = fragmentAtom(
      constructRoutedOperation(
        engineFor(new PGliteDriver()),
        schema.account,
        "delete",
        {
          where: { id: 1 },
          ...(select ? { select } : {}),
          ...(include ? { include } : {}),
        }
      ),
      "delete"
    );

    // Declined: the locate survives.
    const planning = operation.planning();
    expect(planning.steps).toHaveLength(1);
    // ...and it is the lock-taking one.
    expect(sqlOf(planning.steps[0]!)).toContain("FOR UPDATE");

    // The shape-capturing read joins the relation and must NOT re-lock.
    const compiled = operation.compile({
      [planningKey(planning.steps[0]!.id, "rows")]: [{ id: 1 }],
    });
    expect(compiled.steps.map((step) => step.kind)).toEqual(["read", "write"]);
    const capture = sqlOf(compiled.steps[0]!);
    // The join is what makes the lock illegal — assert it is really there, so
    // the `not.toContain` below cannot pass on a read that lost its relation.
    expect(capture).toContain("JOIN");
    expect(capture).not.toContain("FOR UPDATE");
  });

  test("`_count` in `select` does not fold either, in either spelling", () => {
    // `_count` is a relation projection that is NOT a member of `relationSet`, so
    // the gate cannot key on that set alone — the first spelling did, judged
    // `_count` scalar, and folded into a `RETURNING` list where the correlation
    // loses its alias. Both Prisma spellings name the same projection.
    for (const count of [true, { select: { notes: true } }]) {
      const operation = fragmentAtom(
        constructRoutedOperation(
          engineFor(new PGliteDriver()),
          schema.account,
          "delete",
          {
            where: { id: 1 },
            select: { id: true, _count: count },
          }
        ),
        "delete"
      );

      expect(operation.planning().steps).toHaveLength(1);
    }
  });

  test("a NON-RETURNING driver keeps the locate, the read, and the delete", () => {
    // MySQL2Driver is transaction-capable and non-returning, so the ATOM §7
    // batch-only refusal does not pre-empt the plan. No connection is made:
    // planning and compile are pure.
    const operation = fragmentAtom(
      constructRoutedOperation(
        engineFor(new MySQL2Driver()),
        schema.account,
        "delete",
        {
          where: { id: 1 },
        }
      ),
      "delete"
    );

    const planning = operation.planning();
    expect(planning.steps).toHaveLength(1);
    expect(planning.steps[0]!.kind).toBe("read");
    expect(sqlOf(planning.steps[0]!)).toContain("FOR UPDATE");

    // Read BEFORE delete: without RETURNING the row cannot be recovered once it
    // is gone, so the capture has to precede the write.
    const compiled = operation.compile({
      [planningKey(planning.steps[0]!.id, "rows")]: [{ id: 1 }],
    });
    expect(compiled.steps.map((step) => step.kind)).toEqual(["read", "write"]);
    expect(compiled.outputs.result).toMatchObject({
      step: compiled.steps[0]!.id,
      output: "result",
    });

    // THE LOCK IS LOAD-BEARING. A SCALAR projection has no join to make
    // `FOR UPDATE` illegal, so the shape-capturing read still takes it — the drop
    // is scoped to relation projections, not widened to every unfolded read. This
    // is the ONLY reachable scalar-only shape-capturing read: on a RETURNING
    // driver the same payload folds to a single statement and never builds one.
    expect(sqlOf(compiled.steps[0]!)).toContain("FOR UPDATE");
  });
});
