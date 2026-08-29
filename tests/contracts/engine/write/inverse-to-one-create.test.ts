import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError, ValidationError } from "@errors";

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  inverseToOneCreateSchema,
  runInverseToOneCreateBehavior,
} from "@tests/contracts/engine/write/inverse-to-one-create-behavior";

import { syncLiveSchema } from "@tests/fixtures/sync-schema";
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
  pgliteMode: "transaction",
});
runInverseToOneCreateBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
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
    await syncLiveSchema(client);
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

/**
 * ONE engine for every construction witness below, because the thing under test is the
 * `UpdateOperation` CONSTRUCTOR: it reads the registries and never executes a statement.
 *
 * The measured cost of the per-call form this replaces was the fourteen schema and model
 * registries, NOT fourteen databases — `PGliteDriver`'s constructor stores its options
 * and defers `initClient` to the first query, so a driver that is never queried never
 * opens one. There is nothing here to dispose, which is why nothing does.
 */
const constructEngine = new QueryEngine(
  new PGliteDriver(),
  createModelRegistry(
    inverseToOneCreateSchema,
    createSchemaRegistry(inverseToOneCreateSchema)
  )
);

function construct(args: Record<string, unknown>): void {
  new UpdateOperation(
    constructEngine,
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
  // The control that keeps the line above from passing by blanket rejection: a key
  // Prisma DOES offer on this to-one surface still constructs. It is deliberately NOT
  // the same key — `inverseToOneCreateSchema.account` holds two to-one relations and no
  // to-many one, so "the same key on a to-many" is not expressible here (and the one
  // to-many in the fixture, `profile.tags`, sits behind `profile.update`, which the
  // engine refuses wholesale for an unrelated reason — measured, so the rejection would
  // say nothing about the key). The claim this control is standing in for — that the
  // offered set is EXACTLY Prisma's, no key missing and none extra — is carried by the
  // key-set test above, which reads the surface directly instead of probing it.
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
/**
 * The parse boundary's own error CLASS, which is the claim this test makes. The
 * matcher used to be `/valid|expected|boolean/i` — a message regex broad enough that
 * an ENGINE refusal mentioning `boolean` satisfied it, so the day the surface widens
 * (`disconnect` / `delete` become `boolean | where`, the named gap above) the object
 * form would start reaching the engine and this test would go on passing while
 * testing the opposite of its name. `ValidationError` is raised by `parseValidated`
 * and by nothing in the engine, so it separates the two the way the message cannot.
 */
const PARSE_BOUNDARY_REJECTION = ValidationError;

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

/**
 * RETARGETED by N7-U-B, deliberately, and the reason is the point of the change.
 *
 * N2-U3 wrote this test to pin the refusal in both directions — *"`false` throws,
 * `true` does not"* — so the message could not outlive its cause. The cause did not
 * survive: N7-U-B measured Prisma 7.9.1 live and `false` is Prisma's NO-OP arm, not a
 * shape Prisma refuses. N2-U3's own record says it *"recorded no reason to refuse
 * `false`"*, and there was none. The refusal is gone; what stays pinned is that `false`
 * reaches the engine at all (it is not a parse-boundary rejection like the object form
 * above) and that it now CONSTRUCTS, exactly as `true` does.
 *
 * The semantics — that `false` moves no row while `true` does — are witnessed on live
 * data, on both substrates, in `boolean-noop-arm-behavior.ts`. This test keeps only the
 * construction-level half, which is what this file is about.
 */
test("the boolean arm constructs for `false` and for `true` alike", () => {
  for (const key of ["disconnect", "delete"] as const) {
    expect(() =>
      construct({ where: { id: 1 }, data: { profile: { [key]: false } } })
    ).not.toThrow();
    expect(() =>
      construct({ where: { id: 1 }, data: { profile: { [key]: true } } })
    ).not.toThrow();
  }
});
