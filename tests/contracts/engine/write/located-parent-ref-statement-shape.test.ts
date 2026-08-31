import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import {
  makeClient,
  seed,
} from "@tests/contracts/engine/write/located-parent-ref-fixtures";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

/**
 * The two STATEMENT-SHAPE pins of the located-parent Ref: what the transaction plan
 * emits compared with the pinned `where: { id }` spelling, and what the atomic batch
 * addresses statement by statement. Both record SQL rather than state, both need one
 * fresh database per arm, and neither can be expressed by the behavior matrix — which
 * is why they sit together here, apart from the oracle and the staleness harness.
 *
 * Records every statement the operation sends, in order. The hook is the PROTECTED
 * `execute`/`executeRaw` seam rather than `_execute`, because a transaction runs its
 * statements through a transaction-bound driver that delegates back to exactly these two
 * methods — so one hook sees both substrates.
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

describe("located-parent Ref compiles the same plan as the pinned spelling", () => {
  for (const kind of ["create", "createMany"] as const) {
    test(
      `${kind}: the where:{email} spelling issues the same statement count and the same write SQL as where:{id}`,
      { timeout: 30_000 },
      async () => {
        const db = openBorrowedPGlite();
        const driver = new RecordingPGliteDriver({ client: db });
        const client = makeClient(driver);
        await syncLiveSchema(client);
        await seed(client);

        const payload = (noteId: number) =>
          kind === "create"
            ? { notes: { create: { id: noteId, body: "b" } } }
            : {
                notes: {
                  createMany: {
                    data: [
                      { id: noteId, body: "b" },
                      { id: noteId + 1, body: "c" },
                    ],
                  },
                },
              };

        driver.recording = true;
        await client.account.update({
          where: { id: 2 },
          data: payload(100),
        });
        const pinned = driver.statements.splice(0, driver.statements.length);
        await client.account.update({
          where: { email: "target@x" },
          data: payload(200),
        });
        const reffed = driver.statements.splice(0, driver.statements.length);
        driver.recording = false;

        // Same number of round-trips: the Ref adds no statement. The locate differs in
        // its WHERE (that IS the spelling) and in selecting the referenced column when
        // the discriminator is not it; every other statement is byte-identical modulo
        // the literal note ids the payloads chose.
        expect(reffed.length).toBe(pinned.length);
        const writes = (statements: string[]) =>
          statements.filter((sql) => sql.startsWith("INSERT"));
        expect(writes(reffed).map((sql) => sql.replace(/2\d\d/g, "#"))).toEqual(
          writes(pinned).map((sql) => sql.replace(/1\d\d/g, "#"))
        );
        expect(writes(reffed).length).toBeGreaterThan(0);

        await expect(
          client.note.findMany({ orderBy: { id: "asc" } })
        ).resolves.toEqual(
          [100, 200]
            .flatMap((base) => (kind === "create" ? [base] : [base, base + 1]))
            .map((id) => ({
              id,
              body: id % 100 === 0 ? "b" : "c",
              accountId: 2,
            }))
        );
        await client.$disconnect();
      }
    );
  }
});

/**
 * The BATCH root address, spelled out statement by statement.
 *
 * On an atomic batch the located-parent update carries two statements that used to
 * re-consult the caller's `where` — the root-presence guard and the root UPDATE —
 * while every child edge addressed the CAPTURED row. A discriminator the `where`
 * does not fix to the primary key is reassignable, so those two could name a
 * different row than the children did.
 *
 * The two statements did NOT end up with the same rule, and the difference is what
 * this describe pins:
 * - the root UPDATE always addresses the captured PK, whatever the `where` named.
 * - the guard conjoins the captured PK only when the `where` does NOT name it; a
 *   selector that pins the PK already answers the guard's question, and a second
 *   copy would be a duplicate conjunct (AGENTS.md: one guard per invariant).
 *
 * So the `where: { id }` arm is a genuine byte-compare — its five statements are
 * asserted verbatim and are identical to the pre-change plan — but for the UPDATE
 * that is a CONSEQUENCE, not an exemption: `buildPrimaryKeyWhereUnique` reproduces a
 * PK-only selector exactly (flat for a single PK, nested under the constraint name for
 * a compound one), so "address the capture" and "keep the `where`" emit the same
 * string. The `where: { email }` arm asserts the two statements that DO move, and only
 * those two. The compound-PK spelling of the same shape is certified behaviorally, on
 * both substrates and every driver leg, in `located-parent-ref-behavior.ts`
 * ("compound primary-key reference: both members come from the located row").
 *
 * Note what this describe therefore CANNOT witness: an `if` at the write site that left
 * a PK-only `where` alone would keep every assertion here green. One existed and was
 * deleted for exactly that reason — a branch nothing can tell apart from its own
 * fall-through. What the address rule IS falsified by lives in
 * `staleness-injection.test.ts` ("batch root address"), where re-consulting the
 * selector mid-batch changes the row that gets written.
 */
describe("the batch root address, statement by statement", () => {
  class RecordingBatchOnlyPGliteDriver extends BatchOnlyPGliteDriver {
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

  // `ACCOUNTS` is the CORRELATION name and stays bare beside a qualified target;
  // `ACCOUNTS_TABLE` is the persistent identifier, which PostgreSQL always
  // qualifies. One constant cannot serve both positions.
  const ACCOUNTS = '"n1_ref_accounts"';
  const ACCOUNTS_TABLE = `"public".${ACCOUNTS}`;
  const PK_LOCATE = `SELECT "t0"."id" AS "id" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE "t0"."id" = $1 LIMIT 1`;
  const TERMINAL = `SELECT "t0"."id" AS "id", "t0"."email" AS "email", "t0"."code" AS "code", "t0"."label" AS "label" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE "t0"."id" = $1 LIMIT 1`;
  const NOTE_INSERT = `INSERT INTO "public"."n1_ref_notes" ("id", "body", "accountId") VALUES ($1, $2, CAST($3 AS INTEGER))`;

  test("where:{id} issues the pre-change batch, statement for statement", async () => {
    const db = openBorrowedPGlite();
    const driver = new RecordingBatchOnlyPGliteDriver({ client: db });
    const client = makeClient(driver);
    try {
      await syncLiveSchema(client);
      await seed(client);

      driver.recording = true;
      await client.account.update({
        where: { id: 2 },
        data: { label: "pinned", notes: { create: { id: 300, body: "b" } } },
      });
      driver.recording = false;

      expect(driver.statements).toEqual([
        // The locate, unchanged.
        PK_LOCATE,
        // The presence guard: still `findUnique(where)`. The captured PK would be the
        // same column with the same literal, and a duplicated conjunct is a second
        // guard on one invariant.
        `SELECT 1 / CASE WHEN EXISTS (${PK_LOCATE}) THEN 1 ELSE 0 END AS "__viborm_assert__"`,
        // The root UPDATE addresses the captured PK, as it always does. The statement is
        // unchanged because here the captured PK and the `where` are the same conjunct
        // with the same literal — which is also why the write site carries no branch for
        // this shape: there would be nothing to tell the two arms apart.
        `UPDATE ${ACCOUNTS_TABLE} SET "label" = $1 WHERE ${ACCOUNTS}."id" = $2 RETURNING "id" AS "id"`,
        NOTE_INSERT,
        TERMINAL,
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  test("where:{email} moves exactly the guard and the root UPDATE onto the captured PK", async () => {
    const db = openBorrowedPGlite();
    const driver = new RecordingBatchOnlyPGliteDriver({ client: db });
    const client = makeClient(driver);
    try {
      await syncLiveSchema(client);
      await seed(client);

      driver.recording = true;
      await client.account.update({
        where: { email: "target@x" },
        data: { label: "reffed", notes: { create: { id: 400, body: "b" } } },
      });
      driver.recording = false;

      expect(driver.statements).toEqual([
        // The locate still asks the question the caller asked.
        `SELECT "t0"."id" AS "id" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE "t0"."email" = $1 LIMIT 1`,
        // The guard is now the split-witness: the selector AND the row it located.
        // The tie-breaker carries no null placement (query-performance plan
        // Unit 5.1): `id` is NOT NULL, so `NULLS LAST` named nothing and cost
        // the index. The guard's meaning is unchanged.
        `SELECT 1 / CASE WHEN EXISTS (SELECT "t0"."id" AS "id" FROM ${ACCOUNTS_TABLE} AS "t0" WHERE ("t0"."email" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3) THEN 1 ELSE 0 END AS "__viborm_assert__"`,
        // The root UPDATE addresses the captured PK — the same row the note INSERT
        // below and the terminal read already address.
        `UPDATE ${ACCOUNTS_TABLE} SET "label" = $1 WHERE ${ACCOUNTS}."id" = $2 RETURNING "id" AS "id"`,
        NOTE_INSERT,
        TERMINAL,
      ]);
    } finally {
      await client.$disconnect();
    }
  });
});
