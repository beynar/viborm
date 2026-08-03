import { createClient } from "@client/client";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import {
  constructRoutedOperation,
  executeRoutedOperation,
} from "../../src/query-engine-v2/routing";
import { batchIsAtomicUnit } from "../fixtures/atomic-unit-batch";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";
import { operationFragmentSchema } from "./create-nested-upsert-behavior";
import { createV2RoutedClient, type RouteRecord } from "./v2-client-proxy";

// The T1 to-one-under-create oracle (TO-ONE.md). Every parent-held to-one arm and
// every sibling combination is certified V1 == V2-tx == V2-batch byte-identical
// (state + result + error + message), and the P6-prereq-2 create-then-connect
// kill-signal incident is a NAMED regression witness executing on V2.

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

// Two parent-held to-one relations on one record, BOTH referencing `account` —
// the crossRelationTargetSchema of nested-write-conformance, the sibling-coupling
// witness the incident lives in.
const crossSchema = (() => {
  const account = s
    .model({
      id: s.int().id(),
      label: s.string(),
      primaryRecords: s.oneToMany(() => record).name("primary"),
      secondaryRecords: s.oneToMany(() => record).name("secondary"),
    })
    .map("t1_cross_accounts");
  const record = s
    .model({
      id: s.int().id(),
      primaryId: s.int().nullable(),
      secondaryId: s.int().nullable(),
      primary: s
        .manyToOne(() => account)
        .fields("primaryId")
        .references("id")
        .name("primary")
        .optional(),
      secondary: s
        .manyToOne(() => account)
        .fields("secondaryId")
        .references("id")
        .name("secondary")
        .optional(),
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
        .manyToOne(() => category)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => category),
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
type ArmKind = "v1" | "v2-tx" | "v2-batch";

interface Scenario {
  name: string;
  schema: Record<string, Model<any>>;
  seed: (client: AnyClient) => Promise<unknown>;
  act: (client: AnyClient) => Promise<unknown>;
  dump: (client: AnyClient) => Promise<unknown>;
}

async function runArm(kind: ArmKind, scenario: Scenario) {
  const db = new PGlite();
  const base = createClient({
    schema: scenario.schema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(base, { force: true });
  await scenario.seed(base);

  let result: unknown;
  let error: ErrorShape | undefined;
  let routes: RouteRecord[] = [];
  try {
    if (kind === "v1") {
      const v1 = createClient({
        schema: scenario.schema,
        driver: new PGliteDriver({ client: db }),
      });
      result = await scenario.act(v1);
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const routed = createV2RoutedClient({
        schema: scenario.schema,
        client: base as unknown as Record<string, never>,
        driver,
      });
      routes = routed.routes;
      result = await scenario.act(routed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const state = await scenario.dump(base);
  await base.$disconnect();
  const routedToV2 = kind === "v1" || routes.every((r) => r.engine === "v2");
  return { result, error, state, routedToV2, routed: routes.length > 0 };
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
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
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
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
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
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
  },
  {
    // THE NAMED REGRESSION WITNESS (P6-prereq-2 kill-signal incident). A sibling
    // `connect` observes the before-parent `create` of the same target — the
    // construction-time coverage ledger resolves it with no probe. Absorbing
    // parent-held create standalone broke exactly this; it now runs on V2.
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
    // sibling create covers it, so the global probe finds nothing and V1's typed
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

describe("query-engine-v2 to-one create family oracle (V1 vs V2 tx vs V2 batch)", () => {
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 45_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      // V2 actually owned the whole tree (no silent V1 fallback).
      expect(tx.routed).toBe(true);
      expect(batch.routed).toBe(true);
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      // Byte-identical error class + message, result, and persisted state.
      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);
      if (!v1.error) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
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
// Falsifications for the T1 pins (ATOM §2, TO-ONE.md §3). The covered-connect
// ledger is falsified by the decline-surface-gate incident test (fallback OFF —
// disabling the ledger makes the connect probe fail). Here: the connectOrCreate
// FOUND-arm presence guard (raceable:false) and MISSING-arm racePin (raceable:true).
// ---------------------------------------------------------------------------
describe("query-engine-v2 to-one create family: T1 pin falsifications", () => {
  test("connectOrCreate FOUND-arm presence guard: target deleted before batch fails closed", async () => {
    const db = new PGlite();
    const base = createClient({
      schema: opf,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).user.create({ data: { name: "owner" } }); // id=1

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer removes the found target after V2 planned.
        await (base as any).user.deleteMany({ where: { id: 1 } });
      },
      { client: db }
    );
    const routed = createV2RoutedClient({
      schema: opf,
      client: base as never,
      driver,
    });

    // The found-arm connects to user id=1; if it vanishes before commit the batch
    // must fail closed (FK backstop / presence guard), never write a dangling post.
    await expect(
      (routed.client as any).post.create({
        data: {
          id: 40,
          title: "t",
          slug: "s40",
          author: {
            connectOrCreate: { where: { id: 1 }, create: { name: "x" } },
          },
        },
      })
    ).rejects.toThrow();
    const posts = await (base as any).post.findMany({ where: { id: 40 } });
    expect(posts).toHaveLength(0);
    await (base as any).$disconnect();
  }, 45_000);

  test("connectOrCreate MISSING-arm racePin: a concurrent create converges by retry-and-adopt", async () => {
    // A provided-PK target (nb.user.id is a string PK) so a concurrent create can
    // collide on the SAME key. The missing-arm INSERT's unique violation is the
    // raceable signal; the routed retry re-plans, finds the row, and adopts it.
    const db = new PGlite();
    const base = createClient({
      schema: nb,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);

    const driver = new BeforeBatchDriver(
      async () => {
        // A concurrent writer creates the very target the missing arm was about to.
        await (base as any).user.create({ data: { id: "u1", name: "winner" } });
      },
      { client: db }
    );
    const schemas = createSchemaRegistry(nb);
    const engine = new QueryEngine(
      driver as AnyDriver,
      createModelRegistry(nb, schemas)
    );
    const executor = new OperationExecutor(engine);

    const op = constructRoutedOperation(engine, nb.profile, "create", {
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
      engine.instrumentation
    );
    const result = await executeRoutedOperation<any>(executor, op!, context);

    // Converged: the profile links to the concurrently-created user, not a second one.
    expect(result).toEqual({ id: "pr1", userId: "u1" });
    const users = await (base as any).user.findMany();
    expect(users).toEqual([{ id: "u1", name: "winner" }]); // no duplicate insert
    await (base as any).$disconnect();
  }, 45_000);
});
