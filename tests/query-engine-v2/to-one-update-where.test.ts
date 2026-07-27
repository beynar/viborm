import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";
import type {
  GuardStep,
  StatementStep,
} from "../../src/query-engine-v2/OperationFragment";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import {
  runToOneUpdateWhereBehavior,
  toOneUpdateWhereSchema,
} from "./to-one-update-where-behavior";

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

// The whole surface on PGlite, both substrates. The driver matrix legs run the
// same module from tests/drivers/*.test.ts.
runToOneUpdateWhereBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runToOneUpdateWhereBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// STRUCTURAL: where the filter lands, and where it deliberately does NOT.
//
// The behavior suite proves the semantics. This proves the MECHANISM: the
// wrapper's `where` is compiled into the planning LOCATE (and, in batch, into
// the presence guard) and NEVER into the write, which addresses the primary key
// the locate captured. That is what makes a relation filter portable here and
// what keeps the bare form's SQL byte-identical. The bare-form arm is the
// falsification: without it the "no filter in the write" assertion would pass
// for a plan that never carried a filter at all.
// ---------------------------------------------------------------------------

/** The two engine paths a to-one `update` filter has to ride, with the table each
 *  one's steps address. `profile` is PARENT-held (owner holds the FK — the
 *  `UpdateOperation.compileParentHeldUpdate` guard); `badge` is INVERSE-side (badge
 *  holds the FK — the `RelationWritePart` correlated probe). They build their guards
 *  from different code, so both are asserted. */
const DIRECTIONS = [
  { relation: "profile", table: "tou_profiles", scalar: { bio: "x" } },
  { relation: "badge", table: "tou_badges", scalar: { label: "x" } },
] as const;

function buildUpdate(
  relation: string,
  relationUpdate: Record<string, unknown>,
  batch: boolean
): {
  planning: StatementStep[];
  writes: StatementStep[];
  guards: GuardStep[];
} {
  const schemas = createSchemaRegistry(toOneUpdateWhereSchema);
  const engine = new QueryEngine(
    batch ? new BatchOnlyPGliteDriver() : new PGliteDriver(),
    createModelRegistry(toOneUpdateWhereSchema, schemas)
  );
  const operation = new UpdateOperation(engine, toOneUpdateWhereSchema.owner, {
    where: { id: 1 },
    data: { [relation]: { update: relationUpdate } },
    select: { id: true },
  });
  const plan = operation.planning();
  const planningSteps = plan.steps.filter(
    (step): step is StatementStep => step.kind === "read"
  );
  // The locate found owner 1 (holding profileId 1, the parent-held FK the
  // `profile` correlation reads); every target probe captured target 2.
  const known: Record<string, unknown> = {};
  for (const step of plan.steps) {
    const owner = step.id.includes("owner");
    known[`${step.id}.rows`] = [owner ? { id: 1, profileId: 1 } : { id: 2 }];
    known[`${step.id}.id`] = owner ? 1 : 2;
    if (owner) known[`${step.id}.profileId`] = 1;
  }
  const fragment = operation.compile(known);
  return {
    planning: planningSteps,
    writes: fragment.steps.filter(
      (step): step is StatementStep => step.kind === "write"
    ),
    guards: fragment.steps.filter(
      (step): step is GuardStep => step.kind === "guard"
    ),
  };
}

function sqlOf(steps: StatementStep[], table: string): string {
  return steps
    .filter((step) => step.statement.strings.join("?").includes(table))
    .map((step) => step.statement.strings.join("?"))
    .join("\n");
}

/** The SQL of each guard's PREMISE — the statement whose row the guard asserts
 *  still exists inside the atomic unit. This, not the guard count, is what makes
 *  the filter load-bearing in batch mode. */
function premiseSqlOf(guards: GuardStep[], table: string): string {
  return guards
    .map((guard) => guard.premise.statement.strings.join("?"))
    .filter((sql) => sql.includes(table))
    .join("\n");
}

for (const { relation, table, scalar } of DIRECTIONS) {
  const wrappedUpdate = { where: { active: true }, data: scalar };

  test(`${relation}: the wrapper filter is compiled into the locate, never into the write`, () => {
    const wrapped = buildUpdate(relation, wrappedUpdate, false);
    const bare = buildUpdate(relation, scalar, false);

    // The target probe carries the filter column…
    expect(sqlOf(wrapped.planning, table)).toContain("active");
    // …and the target UPDATE does not (it is addressed by the captured PK).
    expect(sqlOf(wrapped.writes, table)).not.toContain("active");

    // Falsification: the bare form's probe carries no filter at all, so the
    // assertion above cannot be passing on a plan that never had one.
    expect(sqlOf(bare.planning, table)).not.toContain("active");
    expect(sqlOf(bare.writes, table)).toBe(sqlOf(wrapped.writes, table));
  });

  test(`${relation}: in batch mode the filter is re-asserted by the presence guard`, () => {
    const wrapped = buildUpdate(relation, wrappedUpdate, true);
    const bare = buildUpdate(relation, scalar, true);

    // Same guard COUNT in both spellings — the filter rides the existing
    // split-witness guard rather than adding a step to the vocabulary.
    expect(wrapped.guards.length).toBe(bare.guards.length);
    expect(wrapped.guards.length).toBeGreaterThan(0);

    // THE claim of this test: the filter is part of the guard's PREMISE, so the
    // atomic unit re-asserts it. A guard that merely re-asserts the correlation
    // would satisfy the count assertions above and fail this one.
    expect(premiseSqlOf(wrapped.guards, table)).toContain("active");
    // Falsification: the bare spelling's premise names no filter column, so the
    // assertion above cannot be reading a premise that always carries one.
    expect(premiseSqlOf(bare.guards, table)).not.toContain("active");

    expect(sqlOf(wrapped.writes, table)).not.toContain("active");
  });
}

// ---------------------------------------------------------------------------
// STALENESS INJECTION (PLAN P2a instrument 3) — the guard premise is LOAD-BEARING.
//
// The structural assertions above prove the filter is in the premise; this proves
// what that buys. A deterministic before-batch hook makes the connected record stop
// matching the wrapper `where` AFTER the unlocked planning probe decided it did and
// BEFORE the atomic batch runs. The batch must abort with the family's typed
// not-found failure and leave the whole tree untouched — a filter that only rode
// planning would fall through to an UPDATE addressed by the captured PK, silently
// writing a row that no longer satisfies the user's `where`.
//
// Batch mode (MySQL, D1) has no transaction to hold a locked probe, so this is the
// only thing standing between a concurrent write and a wrong row on those drivers.
// ---------------------------------------------------------------------------

class BeforeBatchPGliteDriver extends BatchOnlyPGliteDriver {
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(
    beforeBatch: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    this.beforeBatch = undefined;
    if (hook) await hook();
    return super.executeBatch<T>(client, queries);
  }
}

for (const { relation } of DIRECTIONS) {
  test(`${relation}: a concurrent write that voids the wrapper filter aborts the batch typed`, async () => {
    const db = new PGlite();
    const seed = createClient({
      schema: toOneUpdateWhereSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await push(seed, { force: true });
    await seed.profile.create({
      data: { id: 1, bio: "bio-0", active: true },
    });
    await seed.owner.create({ data: { id: 1, name: "name-0", profileId: 1 } });
    await seed.badge.create({
      data: { id: 2, label: "label-0", active: true, ownerId: 1 },
    });

    // Planning sees `active = true`; the hook flips it before the batch commits.
    const injector = createClient({
      schema: toOneUpdateWhereSchema,
      driver: new PGliteDriver({ client: db }),
    });
    const stale = createClient({
      schema: toOneUpdateWhereSchema,
      driver: new BeforeBatchPGliteDriver(
        async () => {
          await (relation === "profile"
            ? injector.profile.update({
                where: { id: 1 },
                data: { active: false },
              })
            : injector.badge.update({
                where: { id: 2 },
                data: { active: false },
              }));
        },
        { client: db }
      ),
    });

    const rejected = await stale.owner
      .update({
        where: { id: 1 },
        data: {
          name: "name-1",
          [relation]: {
            update: {
              where: { active: true },
              data: relation === "profile" ? { bio: "bio-1" } : { label: "l" },
            },
          },
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(rejected).toBeInstanceOf(NestedWriteError);

    // The batch aborted whole: the target's scalar and the root SET both stand
    // where the injector left them.
    expect(await seed.owner.findUnique({ where: { id: 1 } })).toMatchObject({
      name: "name-0",
    });
    expect(await seed.profile.findUnique({ where: { id: 1 } })).toMatchObject({
      bio: "bio-0",
    });
    expect(await seed.badge.findUnique({ where: { id: 2 } })).toMatchObject({
      label: "label-0",
    });
    await seed.$disconnect();
  }, 30_000);
}
