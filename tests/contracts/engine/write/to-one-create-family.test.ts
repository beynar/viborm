import { createClient } from "@client/client";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";

import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import {
  constructRoutedOperation,
  executeRoutedOperation,
} from "@src/query-engine/write-engine/routing";
import { operationFragmentSchema } from "@tests/contracts/engine/write/create-nested-upsert-behavior";
import {
  type OperationRecord,
  observeClientOperations,
} from "@tests/contracts/engine/write/operation-observer";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// Two parent-held to-one relations on one record, BOTH referencing `account` —
// the crossRelationTargetSchema of nested-write-conformance, the sibling-coupling
// witness the incident lives in.
const crossSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.toMany(() => record).name("primary"),
      secondaryRecords: s.toMany(() => record).name("secondary"),
    })
    .map("t1_cross_accounts");
  const record = s
    .model({
      id: s.int().id(),
      primaryId: s.int().nullable(),
      secondaryId: s.int().nullable(),
      primary: s
        .toOne(() => account)
        .fields("primaryId")
        .references("id")
        .name("primary"),
      secondary: s
        .toOne(() => account)
        .fields("secondaryId")
        .references("id")
        .name("secondary"),
    })
    .map("t1_cross_records");
  return { account, record };
})();

// A self-referential parent-held FK: `parent` is a manyToOne to the same model,
// so a nested `parent: { create }` INSERTs a same-model row BEFORE the record.
const selfRefSchema = (() => {
  const category = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => category)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => category),
    })
    .map("t1_selfref_categories");
  return { category };
})();

const opf = operationFragmentSchema;
const nb = nestedWriteBehaviorSchema;

interface ErrorShape {
  name: string;
  message: string;
}
function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  return { name: error.name, message: error.message };
}

type AnyClient = any;
type ArmKind = "direct" | "observed-tx" | "observed-batch";

interface Scenario {
  name: string;
  schema: Record<string, Model<any>>;
  seed: (client: AnyClient) => Promise<unknown>;
  act: (client: AnyClient) => Promise<unknown>;
  dump: (client: AnyClient) => Promise<unknown>;
}

async function runArm(
  family: { readonly database: PGlite; readonly reset: () => Promise<void> },
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const db = family.database;
  const base = createClient({
    schema: scenario.schema,
    driver: new PGliteDriver({ client: db }),
  });
  await scenario.seed(base);

  let result: unknown;
  let error: ErrorShape | undefined;
  let operations: OperationRecord[] = [];
  try {
    if (kind === "direct") {
      const direct = createClient({
        schema: scenario.schema,
        driver: new PGliteDriver({ client: db }),
      });
      result = await scenario.act(direct);
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const observed = observeClientOperations({
        schema: scenario.schema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const state = await scenario.dump(base);
  const routedToObserved =
    kind === "direct" || operations.every((r) => r.boundary === "production");
  return {
    result,
    error,
    state,
    routedToObserved,
    observed: operations.length > 0,
  };
}

const scenarios: Scenario[] = [
  {
    name: "parent-held to-one create (generated target id)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.post.create({
        data: {
          id: 6,
          title: "t",
          slug: "s6",
          author: { create: { name: "x" } },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "parent-held to-one create (provided target id, string PK)",
    schema: nb,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.profile.create({
        data: {
          id: "pr1",
          bio: "b",
          user: { create: { id: "u1", name: "alice" } },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "parent-held to-one create whose target has its own child-held children (depth)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.post.create({
        data: {
          id: 7,
          title: "t",
          slug: "s7",
          author: {
            create: {
              name: "auth",
              posts: { create: [{ id: 70, title: "c", slug: "sc" }] },
            },
          },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "parent-held to-one connectOrCreate FOUND (adopts existing)",
    schema: opf,
    seed: (c) => c.user.create({ data: { name: "owner" } }),
    act: (c) =>
      c.post.create({
        data: {
          id: 8,
          title: "t",
          slug: "s8",
          author: {
            connectOrCreate: { where: { id: 1 }, create: { name: "new" } },
          },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "parent-held to-one connectOrCreate MISSING (creates target)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.post.create({
        data: {
          id: 9,
          title: "t",
          slug: "s9",
          author: {
            connectOrCreate: { where: { id: 50 }, create: { name: "fresh" } },
          },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) =>
      Promise.all([
        c.user.findMany({ orderBy: { id: "asc" } }),
        c.post.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    // THE NAMED REGRESSION WITNESS (P6-prereq-2 kill-signal incident). A sibling
    // `connect` observes the before-parent `create` of the same target — the
    // construction-time coverage ledger resolves it with no probe. Absorbing
    // parent-held create standalone broke exactly this; it now runs on Observed.
    name: "INCIDENT: sibling create then connect observes the earlier insert (create root)",
    schema: crossSchema,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.record.create({
        data: {
          id: 1,
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 2 } },
        },
      }),
    dump: (c) =>
      Promise.all([
        c.record.findMany({ orderBy: { id: "asc" } }),
        c.account.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "INCIDENT reversed: sibling connect then create observes the insert (order-insensitive)",
    schema: crossSchema,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.record.create({
        data: {
          id: 1,
          secondary: { connect: { id: 2 } },
          primary: { create: { id: 2, label: "created" } },
        },
      }),
    dump: (c) =>
      Promise.all([
        c.record.findMany({ orderBy: { id: "asc" } }),
        c.account.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "sibling create + create across distinct to-one relations",
    schema: crossSchema,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.record.create({
        data: {
          id: 1,
          primary: { create: { id: 2, label: "a" } },
          secondary: { create: { id: 3, label: "b" } },
        },
      }),
    dump: (c) =>
      Promise.all([
        c.record.findMany({ orderBy: { id: "asc" } }),
        c.account.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "sibling create + disjoint connect (pre-seeded target)",
    schema: crossSchema,
    seed: (c) => c.account.create({ data: { id: 1, label: "existing" } }),
    act: (c) =>
      c.record.create({
        data: {
          id: 1,
          primary: { create: { id: 2, label: "created" } },
          secondary: { connect: { id: 1 } },
        },
      }),
    dump: (c) =>
      Promise.all([
        c.record.findMany({ orderBy: { id: "asc" } }),
        c.account.findMany({ orderBy: { id: "asc" } }),
      ]),
  },
  {
    name: "self-referential parent-held create (parent category before child)",
    schema: selfRefSchema,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.category.create({
        data: {
          id: "c-child",
          name: "child",
          parent: { create: { id: "c-parent", name: "parent" } },
        },
        select: { id: true, parentId: true },
      }),
    dump: (c) => c.category.findMany({ orderBy: { id: "asc" } }),
  },
  {
    // Reject parity: a parent-held connect to the record's own future id — no
    // sibling create covers it, so the global probe finds nothing and Direct's typed
    // "target record was not found" fires on both engines (conformance witness).
    name: "REJECT parity: before-parent self connect is not covered by the future insert",
    schema: selfRefSchema,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.category.create({
        data: {
          id: "self",
          name: "root",
          parent: { connect: { id: "self" } },
        },
      }),
    dump: (c) => c.category.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "child-held inverse-side to-one connect (adopt orphan profile)",
    schema: nb,
    seed: (c) =>
      c.profile.create({ data: { id: "orphan", bio: "b", userId: null } }),
    act: (c) =>
      c.user.create({
        data: {
          id: "u9",
          name: "adopter",
          profile: { connect: { id: "orphan" } },
        },
        select: { id: true, profile: { select: { id: true, userId: true } } },
      }),
    dump: (c) => c.profile.findMany({ orderBy: { id: "asc" } }),
  },
];

describe("write boundary to-one create family oracle (Direct vs Observed tx vs Observed batch)", () => {
  const getOperationFragmentFamily = usePGliteSchemaFamily(opf);
  const getNestedWriteFamily = usePGliteSchemaFamily(nb);
  const getCrossFamily = usePGliteSchemaFamily(crossSchema);
  const getSelfReferenceFamily = usePGliteSchemaFamily(selfRefSchema);
  const familyFor = (schema: Scenario["schema"]) => {
    if (schema === opf) return getOperationFragmentFamily();
    if (schema === nb) return getNestedWriteFamily();
    if (schema === crossSchema) return getCrossFamily();
    return getSelfReferenceFamily();
  };

  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 45_000 }, async () => {
      const family = familyFor(scenario.schema);
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      // Observed actually owned the whole tree (no silent Direct fallback).
      expect(tx.observed).toBe(true);
      expect(batch.observed).toBe(true);
      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      // Byte-identical error class + message, result, and persisted state.
      expect(tx.error).toEqual(direct.error);
      if (!direct.error) {
        expect(tx.result).toEqual(direct.result);
      }
      expect(tx.state).toEqual(direct.state);
      expect(batch.error).toEqual(direct.error);
      if (!direct.error) expect(batch.result).toEqual(direct.result);
      expect(batch.state).toEqual(direct.state);
    });
  }
});

// A batch-only driver that runs a mutation on the same DB just before the atomic
// batch commits — the staleness / concurrent-writer injection.
class BeforeBatchDriver extends BatchOnlyPGliteDriver {
  private hook: (() => Promise<void>) | undefined;
  constructor(
    hook: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.hook = hook;
  }
  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.hook;
    // Fire once (the retry runs clean), before the operation's compiled ATOMIC
    // UNIT — planning reads ride a batch too once grouped by level (PLAN
    // Phase 6.1).
    if (hook && batchIsAtomicUnit(queries)) {
      this.hook = undefined;
      await hook();
    }
    return super.executeBatch<T>(client, queries);
  }
}

// ---------------------------------------------------------------------------
// Falsifications for the T1 pins (ATOM, branch pins). The covered-connect
// ledger is falsified by the decline-surface-gate incident test (fallback OFF —
// disabling the ledger makes the connect probe fail). Here: the connectOrCreate
// FOUND-arm presence guard (raceable:false) and MISSING-arm racePin (raceable:true).
// ---------------------------------------------------------------------------
describe("write boundary to-one create family: T1 pin falsifications", () => {
  test("connectOrCreate FOUND-arm presence guard: target deleted before batch fails closed", async () => {
    const db = openBorrowedPGlite();
    const base = createClient({
      schema: opf,
      driver: new PGliteDriver({ client: db }),
    });
    await syncLiveSchema(base as never);
    await (base as any).user.create({ data: { name: "owner" } }); // id=1

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer removes the found target after Observed planned.
        await (base as any).user.deleteMany({ where: { id: 1 } });
      },
      { client: db }
    );
    const observed = observeClientOperations({
      schema: opf,
      driver,
    });

    // The found-arm connects to user id=1; if it vanishes before commit the batch
    // must surface Direct's replacement-race failure, never write a dangling post.
    await expect(
      (observed.client as any).post.create({
        data: {
          id: 40,
          title: "t",
          slug: "s40",
          author: {
            connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
          },
        },
      })
    ).rejects.toThrow(
      "Record was replaced by another transaction during nested connectOrCreate"
    );
    const posts = await (base as any).post.findMany({ where: { id: 40 } });
    expect(posts).toHaveLength(0);
    await (base as any).$disconnect();
    await closeTestPGlite(db);
  }, 45_000);

  test("connectOrCreate MISSING-arm racePin: a concurrent create converges by retry-and-adopt", async () => {
    // A provided-PK target (nb.user.id is a string PK) so a concurrent create can
    // collide on the SAME key. The missing-arm INSERT's unique violation is the
    // raceable signal; the observed retry re-plans, finds the row, and adopts it.
    const db = openBorrowedPGlite();
    const base = createClient({
      schema: nb,
      driver: new PGliteDriver({ client: db }),
    });
    await syncLiveSchema(base as never);

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer creates the very target the missing arm was about to.
        await (base as any).user.create({ data: { id: "u1", name: "winner" } });
      },
      { client: db }
    );
    const schemas = createSchemaRegistry(nb);
    const boundary = new QueryEngine(
      driver as AnyDriver,
      createModelRegistry(nb, schemas)
    );
    const executor = new OperationExecutor(boundary);

    const op = constructRoutedOperation(boundary, nb.profile, "create", {
      data: {
        id: "pr1",
        bio: "b",
        user: {
          connectOrCreate: {
            where: { id: "u1" },
            create: { id: "u1", name: "loser" },
          },
        },
      },
      select: { id: true, userId: true },
    });
    const context = createOperationExecutionContext(
      "profile",
      "create",
      boundary.instrumentation
    );
    const result = await executeRoutedOperation<any>(executor, op!, context);

    // Converged: the profile links to the concurrently-created user, not a second one.
    expect(result).toEqual({ id: "pr1", userId: "u1" });
    const users = await (base as any).user.findMany();
    expect(users).toEqual([{ id: "u1", name: "winner" }]); // no duplicate insert
    await (base as any).$disconnect();
    await closeTestPGlite(db);
  }, 45_000);
});
