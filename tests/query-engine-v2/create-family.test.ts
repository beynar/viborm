import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import type { Model } from "@schema/model";
import { describe, expect, test } from "vitest";
import { compoundKeyBehaviorSchema } from "../fixtures/compound-key-behavior-schema";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { operationFragmentSchema } from "./create-nested-upsert-behavior";
import { createV2RoutedClient, type RouteRecord } from "./v2-client-proxy";

// A batch-only PGlite driver: forces the V2 atomic-batch substrate so every
// scenario is certified on BOTH V2 substrates (tx and batch), not only tx.
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

// A batch-only driver that runs a mutation on the same DB just before the atomic
// batch commits — the staleness injection (a concurrent writer moved committed
// state after V2 planned). Used to prove the create tree's non-elided pins fail
// the batch closed instead of writing against vanished state.
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

// A minimal 3-level one-to-many chain (org → team → member) for deep-recursion
// create (grandchildren+), all child-held FKs referencing the parent PK.
const deepSchema = (() => {
  const org = s
    .model({
      id: s.string().id(),
      name: s.string(),
      teams: s.oneToMany(() => team),
    })
    .map("create_family_orgs");
  const team = s
    .model({
      id: s.string().id(),
      orgId: s.string(),
      org: s
        .manyToOne(() => org)
        .fields("orgId")
        .references("id"),
      members: s.oneToMany(() => member),
    })
    .map("create_family_teams");
  const member = s
    .model({
      id: s.string().id(),
      teamId: s.string(),
      team: s
        .manyToOne(() => member2team())
        .fields("teamId")
        .references("id"),
    })
    .map("create_family_members");
  function member2team() {
    return team;
  }
  return { org, team, member };
})();

const CANNOT_CONNECT_PATTERN = /Cannot connect relation/;

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

function normalizeError(error: unknown): ErrorShape {
  if (!(error instanceof Error)) throw error;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  const stable =
    typeof code === "string" || typeof code === "number" ? code : undefined;
  return stable === undefined
    ? { name: error.name, message: error.message }
    : { name: error.name, code: stable, message: error.message };
}

// A loose client shape for the scenario closures — the oracle drives many
// schemas through one harness, so per-model typing is deliberately erased here.
type AnyClient = any;
type ArmKind = "v1" | "v2-tx" | "v2-batch";

interface Scenario {
  name: string;
  schema: Record<string, Model<any>>;
  seed: (client: AnyClient) => Promise<unknown>;
  act: (client: AnyClient) => Promise<unknown>;
  dump: (client: AnyClient) => Promise<unknown>;
  /** Extension class (P−1.2): V1 rejects at runtime, V2 adopts. `v1Rejects`
   *  is a substring of V1's typed message; V2 tx/batch must agree and succeed. */
  extension?: { v1Rejects: string };
}

async function runArm(kind: ArmKind, scenario: Scenario) {
  const db = new PGlite();
  // The seed/dump client is a plain default client on the same DB. State is
  // state; which engine reads/seeds does not change the persisted rows.
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
        queryEngine: "v1",
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

// ---------------------------------------------------------------------------
// PARITY scenarios: V1 and V2 (tx + batch) must agree byte-for-byte on the
// persisted state, the returned result, and any error class + message.
// ---------------------------------------------------------------------------

const opf = operationFragmentSchema;
const m2m = manyToManySchema;
const compound = compoundKeyBehaviorSchema;

const parityScenarios: Scenario[] = [
  {
    name: "root scalar create with generated PK + select subset",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({ data: { name: "a" }, select: { id: true, name: true } }),
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "root scalar create default projection (no select)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) => c.user.create({ data: { name: "b" } }),
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "root create with include (relation terminal)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({
        data: {
          name: "c",
          posts: { create: [{ id: 1, title: "t1", slug: "s1" }] },
        },
        include: { posts: true },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "nested create to-many array",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({
        data: {
          name: "d",
          posts: {
            create: [
              { id: 2, title: "t2", slug: "s2" },
              { id: 3, title: "t3", slug: "s3" },
            ],
          },
        },
        select: { name: true, posts: { select: { id: true, userId: true } } },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "nested createMany under create",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({
        data: {
          name: "e",
          posts: {
            createMany: {
              data: [
                { id: 4, title: "t4", slug: "s4" },
                { id: 5, title: "t5", slug: "s5" },
              ],
            },
          },
        },
        select: { name: true, posts: { select: { id: true } } },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "child-held connect existing orphan",
    schema: opf,
    seed: async (c) => {
      await c.post.create({
        data: { id: 6, title: "orphan", slug: "s6", userId: null },
      });
    },
    act: (c) =>
      c.user.create({
        data: { name: "f", posts: { connect: { id: 6 } } },
        select: { name: true, posts: { select: { id: true, userId: true } } },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "child-held connect missing target (reject parity)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({
        data: { name: "g", posts: { connect: { id: 999 } } },
        select: { name: true, posts: true },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "child-held connectOrCreate creates missing",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({
        data: {
          name: "h",
          posts: {
            connectOrCreate: {
              where: { id: 7 },
              create: { id: 7, title: "t7", slug: "s7" },
            },
          },
        },
        select: { name: true, posts: { select: { id: true, userId: true } } },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "child-held connectOrCreate connects existing",
    schema: opf,
    seed: async (c) => {
      await c.post.create({
        data: { id: 8, title: "e8", slug: "s8", userId: null },
      });
    },
    act: (c) =>
      c.user.create({
        data: {
          name: "i",
          posts: {
            connectOrCreate: {
              where: { id: 8 },
              create: { id: 8, title: "new", slug: "s8" },
            },
          },
        },
        select: {
          name: true,
          posts: { select: { id: true, title: true, userId: true } },
        },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "parent-held to-one connect existing (author)",
    schema: opf,
    seed: async (c) => {
      await c.user.create({ data: { name: "owner" } });
    },
    act: (c) =>
      c.post.create({
        data: {
          id: 9,
          title: "t9",
          slug: "s9",
          author: { connect: { id: 1 } },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "parent-held to-one connect missing (reject parity)",
    schema: opf,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.post.create({
        data: {
          id: 10,
          title: "t10",
          slug: "s10",
          author: { connect: { id: 999 } },
        },
        select: { id: true, userId: true },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "deep recursion (org → team → member, grandchildren)",
    schema: deepSchema,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.org.create({
        data: {
          id: "o1",
          name: "acme",
          teams: {
            create: [
              {
                id: "tm1",
                members: { create: [{ id: "mb1" }, { id: "mb2" }] },
              },
              { id: "tm2", members: { create: { id: "mb3" } } },
            ],
          },
        },
        select: {
          id: true,
          teams: {
            select: {
              id: true,
              members: { select: { id: true, teamId: true } },
            },
          },
        },
      }),
    dump: (c) => c.member.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "M2M create-through-junction",
    schema: m2m,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.post.create({
        data: {
          id: "p1",
          title: "t",
          tags: { create: { id: "t1", name: "x" } },
        },
        select: { id: true, tags: { select: { id: true } } },
      }),
    dump: (c) => c.tag.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "M2M connect existing tag",
    schema: m2m,
    seed: async (c) => {
      await c.tag.create({ data: { id: "t2", name: "y" } });
    },
    act: (c) =>
      c.post.create({
        data: { id: "p2", title: "t", tags: { connect: { id: "t2" } } },
        select: { id: true, tags: { select: { id: true } } },
      }),
    dump: (c) => c.tag.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "M2M connectOrCreate missing tag",
    schema: m2m,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.post.create({
        data: {
          id: "p3",
          title: "t",
          tags: {
            connectOrCreate: {
              where: { id: "t3" },
              create: { id: "t3", name: "z" },
            },
          },
        },
        select: { id: true, tags: { select: { id: true } } },
      }),
    dump: (c) => c.tag.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "self-M2M connect (user follows user)",
    schema: m2m,
    seed: async (c) => {
      await c.user.create({ data: { id: "u2", name: "b" } });
    },
    act: (c) =>
      c.user.create({
        data: { id: "u1", name: "a", follows: { connect: { id: "u2" } } },
        select: { id: true, follows: { select: { id: true } } },
      }),
    dump: (c) => c.user.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "compound-FK child create under compound-PK parent",
    schema: compound,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.author.create({
        data: {
          tenantId: "t1",
          id: "a1",
          name: "alice",
          posts: { create: { id: "p1", title: "hello" } },
        },
        select: {
          id: true,
          posts: { select: { id: true, tenantId: true, authorId: true } },
        },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
];

// ---------------------------------------------------------------------------
// EXTENSION class (PLAN P−1.2): one-to-many `upsert` under `create` is a
// DELIBERATE Prisma superset. V1 rejects it at runtime with a typed
// NestedWriteError; V2 accepts it (global lookup, adopt-and-update). The oracle
// certifies: V1 arm asserts the typed rejection (state unchanged); V2 tx and
// batch agree byte-for-byte on the pinned successful state.
// ---------------------------------------------------------------------------

const extensionScenarios: Scenario[] = [
  {
    name: "upsert-under-create adopts a foreign-owned target (V1 rejects, V2 adopts)",
    schema: opf,
    extension: { v1Rejects: "is not supported in parent create" },
    seed: async (c) => {
      await c.user.create({ data: { name: "owner" } });
      await c.post.create({
        data: {
          id: 1,
          title: "orig",
          slug: "s1",
          author: { connect: { id: 1 } },
        },
      });
    },
    act: (c) =>
      c.user.create({
        data: {
          name: "adopter",
          posts: {
            upsert: {
              where: { id: 1 },
              create: { id: 1, title: "created", slug: "s1" },
              update: { title: "adopted" },
            },
          },
        },
        select: {
          name: true,
          posts: { select: { id: true, title: true, userId: true } },
        },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
  {
    name: "upsert-under-create creates a missing target (V1 rejects, V2 creates)",
    schema: opf,
    extension: { v1Rejects: "is not supported in parent create" },
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user.create({
        data: {
          name: "creator",
          posts: {
            upsert: {
              where: { id: 20 },
              create: { id: 20, title: "fresh", slug: "s20" },
              update: { title: "u" },
            },
          },
        },
        select: {
          name: true,
          posts: { select: { id: true, title: true, userId: true } },
        },
      }),
    dump: (c) => c.post.findMany({ orderBy: { id: "asc" } }),
  },
];

describe("query-engine-v2 create family dual-run oracle (V1 vs V2 tx vs V2 batch)", () => {
  for (const scenario of parityScenarios) {
    test(scenario.name, { timeout: 45_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      // V2 actually executed the create tree (not a silent V1 fallback).
      expect(tx.routed).toBe(true);
      expect(batch.routed).toBe(true);
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      // Byte-identical error class + message.
      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);

      // Byte-identical result (when no error) and persisted state.
      if (!v1.error) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
    });
  }
});

describe("query-engine-v2 create family extension class (P−1.2 superset; V1 rejects, V2 adopts)", () => {
  for (const scenario of extensionScenarios) {
    test(scenario.name, { timeout: 45_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      // V1 arm: typed rejection; the seeded/empty state is unchanged.
      expect(v1.error).toBeDefined();
      expect(v1.error?.message).toContain(scenario.extension!.v1Rejects);

      // V2 arms: both succeed, and tx and batch agree byte-for-byte on the
      // pinned result and persisted state (V2 substrate parity is the certifier
      // here — there is no V1 success to compare against).
      expect(tx.error).toBeUndefined();
      expect(batch.error).toBeUndefined();
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);
      expect(tx.result).toEqual(batch.result);
      expect(tx.state).toEqual(batch.state);

      // V2 mutated where V1 refused: the persisted state differs from V1's.
      expect(tx.state).not.toEqual(v1.state);
    });
  }
});

// ---------------------------------------------------------------------------
// Staleness injection for the create tree's NON-ELIDED pins (ATOM §2/§4). A
// fresh parent elides its own children's correlation, but the connect targets a
// create tree adopts are PRE-EXISTING committed rows — those pins do NOT elide.
// A concurrent delete of the connect target between planning and the atomic
// batch commit must fail the batch CLOSED (raceable: false), never write a
// dangling FK. (tx mode locks the target at the FOR UPDATE probe; batch mode
// pins it with the exists guard these tests exercise.)
// ---------------------------------------------------------------------------

describe("query-engine-v2 create family staleness (batch non-elided connect pins)", () => {
  test("parent-held to-one connect: target deleted before batch fails closed", async () => {
    const db = new PGlite();
    const base = createClient({
      schema: opf,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).user.create({ data: { name: "owner" } });

    const driver = new BeforeBatchPGliteDriver(
      async () => {
        // A concurrent writer removes the connect target after V2 planned.
        await (base as any).post.deleteMany({});
        await (base as any).user.deleteMany({ where: { id: 1 } });
      },
      { client: db }
    );
    const routed = createV2RoutedClient({
      schema: opf,
      client: base as never,
      driver,
    });

    // The presence guard (raceable: false) pins the connect target and yields
    // V1's exact `Cannot connect relation … target record was not found` message
    // — the FK constraint is a fail-closed backstop, but only the guard produces
    // the V1-parity wording (disabling the guard yields a raw FK error instead;
    // falsified in the report). Asserting the message makes the guard load-bearing.
    await expect(
      (routed.client as any).post.create({
        data: {
          id: 30,
          title: "t",
          slug: "s30",
          author: { connect: { id: 1 } },
        },
        select: { id: true, userId: true },
      })
    ).rejects.toThrow(CANNOT_CONNECT_PATTERN);
    // Fail-closed: no dangling post was written.
    const posts = await (base as any).post.findMany({ where: { id: 30 } });
    expect(posts).toHaveLength(0);
    await (base as any).$disconnect();
  }, 45_000);

  test("child-held connect: target deleted before batch fails closed", async () => {
    const db = new PGlite();
    const base = createClient({
      schema: opf,
      driver: new PGliteDriver({ client: db }),
    });
    await push(base as never, { force: true } as never);
    await (base as any).post.create({
      data: { id: 31, title: "orphan", slug: "s31", userId: null },
    });

    const driver = new BeforeBatchPGliteDriver(
      async () => {
        await (base as any).post.deleteMany({ where: { id: 31 } });
      },
      { client: db }
    );
    const routed = createV2RoutedClient({
      schema: opf,
      client: base as never,
      driver,
    });

    await expect(
      (routed.client as any).user.create({
        data: { name: "adopter", posts: { connect: { id: 31 } } },
        select: { name: true, posts: true },
      })
    ).rejects.toThrow();
    // Fail-closed: the adopter user was not created (whole batch rolled back).
    const users = await (base as any).user.findMany({
      where: { name: "adopter" },
    });
    expect(users).toHaveLength(0);
    await (base as any).$disconnect();
  }, 45_000);
});
