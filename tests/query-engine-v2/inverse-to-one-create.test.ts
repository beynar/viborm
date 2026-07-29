import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError } from "@errors";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import {
  inverseToOneCreateSchema,
  runInverseToOneCreateBehavior,
} from "./inverse-to-one-create-behavior";

/**
 * N2 — the inverse-side to-one family, on the substrate that can see the traffic, plus
 * the two MEASUREMENTS the wave owed (U2 and U3) pinned as tests rather than asserted in
 * prose.
 *
 * The shared behavior suite (`inverse-to-one-create-behavior.ts`, run here and by every
 * driver leg) proves the STATE. This file proves the claims that only the statement
 * stream can show:
 *
 *  · the occupied slot is decided by the CONSTRAINT — there is no pre-check SELECT on the
 *    child (the one-guard-per-invariant rule made observable), and the conflict is NOT
 *    re-run as a race (exactly one INSERT reaches the database);
 *  · the parse boundary is the whole inverse-to-one surface, and it is EXACTLY Prisma's.
 */

class BatchOnlyPGliteDriver extends PGliteDriver {
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

/**
 * Records every statement, in order. The hook is the PROTECTED `execute`/`executeRaw`
 * seam rather than `_execute`, because a transaction runs its statements through a
 * transaction-bound driver that delegates back to exactly these two methods.
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

// The whole family on PGlite, both substrates (the driver-matrix legs live in
// tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runInverseToOneCreateBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runInverseToOneCreateBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: inverseToOneCreateSchema, driver });
}

/**
 * THE OCCUPIED-SLOT RACE STORY, made observable.
 *
 * The comment at the `create` case claims two things a state assertion cannot see: that
 * the UNIQUE constraint is the ONLY guard (no pre-check SELECT — a second guard on one
 * invariant, and a racy one), and that the resulting violation is attributed as a genuine
 * conflict rather than a lost race (no `racePin` on this leaf → `race-retry.ts` does not
 * mark it retryable → the routed lifecycle above the executor does not re-run it).
 *
 * Both are one measurement: run the conflicting update through the ROUTED client (the
 * layer that owns the retry), and count what reached the database.
 */
test("an occupied slot is decided by the constraint alone, and is not retried", async () => {
  const driver = new RecordingPGliteDriver();
  const client = makeClient(driver);
  try {
    await push(client, { force: true });
    await client.account.create({
      data: { id: 1, email: "a@x", code: "A", label: "l" },
    });
    await client.account.update({
      where: { id: 1 },
      data: { profile: { create: { id: 10, bio: "first" } } },
    });

    driver.recording = true;
    await expect(
      client.account.update({
        where: { id: 1 },
        data: { profile: { create: { id: 11, bio: "second" } } },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    driver.recording = false;

    const profileStatements = driver.statements.filter((sql) =>
      sql.includes("n2_ito_profiles")
    );
    // Exactly one INSERT: the conflict was NOT re-run. A racePin-attributed error would
    // make the routed lifecycle retry once and this would be 2.
    expect(
      profileStatements.filter((sql) => sql.startsWith("INSERT")).length
    ).toBe(1);
    // And nothing read the child first: the constraint is the guard, not a probe.
    expect(
      profileStatements.filter((sql) => sql.startsWith("SELECT")).length
    ).toBe(0);
  } finally {
    await client.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// N2-U2 / N2-U3 — the parse-boundary surface, MEASURED against Prisma 7.9.1.
//
// Measurement method (reproducible): `prisma generate` on a schema with
// `User.profile: Profile?` (inverse side) alongside `User.posts: Post[]`, Prisma 7.9.1,
// `prisma-client` generator. The two generated nested-update inputs:
//
//   ProfileUpdateOneWithoutUserNestedInput = {
//     create?, connectOrCreate?, upsert?, connect?, update?,
//     disconnect?: ProfileWhereInput | boolean,
//     delete?:     ProfileWhereInput | boolean,
//   }
//   PostUpdateManyWithoutAuthorNestedInput = {
//     create?, connectOrCreate?, upsert?, createMany?, set?, disconnect?, delete?,
//     connect?, update?, updateMany?, deleteMany?,
//   }
//
// So `createMany` / `deleteMany` / `updateMany` / `set` are to-MANY-only in Prisma, and
// viborm's `toOneUpdateFactory` does not offer them either. N2-U2's engine arm was
// therefore never owed: there is no shape to absorb, and no validation key to remove —
// the surface already matches. What the unit produces instead is this pin, so a future
// wave cannot quietly add a to-many key to the to-one surface (or lose a to-one one).
// ---------------------------------------------------------------------------

function construct(args: Record<string, unknown>): void {
  const schemas = createSchemaRegistry(inverseToOneCreateSchema);
  const engine = new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(inverseToOneCreateSchema, schemas)
  );
  new UpdateOperation(
    engine,
    inverseToOneCreateSchema.account as unknown as Model<any>,
    args
  );
}

/** Prisma 7.9.1 `ProfileUpdateOneWithoutUserNestedInput` — the whole key set. */
const PRISMA_TO_ONE_KEYS = [
  "create",
  "connectOrCreate",
  "upsert",
  "disconnect",
  "delete",
  "connect",
  "update",
] as const;

/** Present on Prisma's to-MANY nested update input, absent from its to-one one. */
const PRISMA_TO_MANY_ONLY_KEYS = [
  "createMany",
  "deleteMany",
  "updateMany",
  "set",
] as const;

test("the inverse to-one update surface offers exactly Prisma 7.9.1's key set", () => {
  const schemas = createSchemaRegistry(inverseToOneCreateSchema);
  const relations = schemas.proxy.account.relations as Record<
    string,
    { update: { entries?: Record<string, unknown> } } | undefined
  >;
  const offered = Object.keys(relations.profile?.update.entries ?? {}).sort();
  expect(offered).toEqual([...PRISMA_TO_ONE_KEYS].sort());
});

test.each(
  PRISMA_TO_MANY_ONLY_KEYS
)("a to-many-only key '%s' is refused by the parse boundary on an inverse to-one, as Prisma refuses it", (key) => {
  expect(() =>
    construct({ where: { id: 1 }, data: { profile: { [key]: {} } } })
  ).toThrow();
  // Bidirectional: the SAME key is accepted where Prisma accepts it (to-many), so
  // this test cannot pass by the schema simply rejecting everything.
  expect(() =>
    construct({
      where: { id: 1 },
      data: { profile: { create: { id: 1, bio: "b" } } },
    })
  ).not.toThrow();
});

/**
 * N2-U3 — the residual inverse-side declines, RE-AUDITED, and the audit's premise
 * FALSIFIED.
 *
 * The plan carried these as "believed Prisma-parity (booleans only on to-one)". The
 * generated types above say otherwise: Prisma 7.9.1 types both as
 * `ProfileWhereInput | boolean` — a FILTER form that narrows which connected record is
 * disconnected/deleted, the to-one analogue of W4-U3's `update: { where, data }` wrapper
 * (which viborm already has). So the object form is NOT a Prisma-parity refusal; it is a
 * genuine viborm surface gap.
 *
 * It is also not where the engine's two `UnsupportedOperationError`s fire. viborm's
 * schema types both keys `v.boolean()`, so the object form never reaches the engine — it
 * is refused at the PARSE boundary — and the engine throws are reachable only for the
 * literal `false`. This test pins both halves of that corrected picture so the census
 * entry cannot drift back to the old, wrong justification.
 *
 * Owner: absorbing the filter form is a validation-surface widening (`disconnect` /
 * `delete` become `boolean | where`) plus a filtered disconnect write, not a re-audit —
 * recorded in the census as a NAMED gap rather than smuggled in here.
 */
/** A parse-boundary rejection, not an engine route: the schema's own vocabulary. */
const PARSE_BOUNDARY_REJECTION = /valid|expected|boolean/i;

test("the object form of disconnect/delete is refused at the PARSE boundary, not by the engine", () => {
  for (const key of ["disconnect", "delete"] as const) {
    expect(() =>
      construct({
        where: { id: 1 },
        data: { profile: { [key]: { bio: "x" } } },
      })
    ).toThrow(PARSE_BOUNDARY_REJECTION);
  }
});

test("the engine's boolean-only refusal is reachable exactly for `false`", () => {
  for (const key of ["disconnect", "delete"] as const) {
    expect(() =>
      construct({ where: { id: 1 }, data: { profile: { [key]: false } } })
    ).toThrow(new RegExp(`supports only '${key}: true'`));
    expect(() =>
      construct({ where: { id: 1 }, data: { profile: { [key]: true } } })
    ).not.toThrow();
  }
});
