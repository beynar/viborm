import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import {
  nestedMutationSchema,
  runNestedMutationBehavior,
} from "./nested-mutation-behavior";
import { createV2RoutedClient } from "./v2-client-proxy";

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

// The whole nested-mutation family on PGlite, both substrates.
runNestedMutationBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runNestedMutationBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN P2c gate): the FULL FK conformance scenario set for
// nested update/updateMany/delete/deleteMany/set — the SAME payload through the
// real V1 client and, via the V2-routed proxy, through V2 (tx and forced batch),
// FRESH instances per arm, asserting byte-identical state + result + error class
// AND message. This is the parity evidence.
// ---------------------------------------------------------------------------

type State = {
  users: unknown[];
  posts: unknown[];
  profiles: unknown[];
  tags: unknown[];
  postTags: unknown[];
};

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

interface Scenario {
  name: string;
  seed: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
}

function makeClient(db: PGlite) {
  return createClient({
    schema: nestedMutationSchema,
    driver: new PGliteDriver({ client: db }),
  });
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

async function dump(client: ReturnType<typeof makeClient>): Promise<State> {
  const [users, posts, profiles, tags, postTags] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
    client.profile.findMany({ orderBy: { id: "asc" } }),
    client.tag.findMany({ orderBy: { id: "asc" } }),
    client.postTag.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts, profiles, tags, postTags };
}

type ArmKind = "v1" | "v2-tx" | "v2-batch";

async function runArm(kind: ArmKind, scenario: Scenario) {
  const db = new PGlite();
  const client = makeClient(db);
  await push(client, { force: true });
  await scenario.seed(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let routes: { engine: "v1" | "v2" }[] = [];
  try {
    if (kind === "v1") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const routed = createV2RoutedClient({
        schema: nestedMutationSchema,
        client: client as unknown as Record<string, RoutedModel>,
        driver,
      });
      routes = routed.routes;
      result = await scenario.act(routed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToV2 = kind === "v1" || routes.every((r) => r.engine === "v2");
  const routed = routes.length > 0;
  const state = await dump(client);
  await client.$disconnect();
  return { result, error, state, routedToV2, routed };
}

const scenarios: Scenario[] = [
  {
    name: "delete and deleteMany keep child mutations parent-correlated",
    seed: async (c) => {
      await c.user.create({
        data: {
          id: "u1",
          name: "Hana",
          posts: {
            create: [
              { id: "po1", title: "Remove one" },
              { id: "po2", title: "Remove many" },
            ],
          },
        },
      });
      await c.user.create({
        data: {
          id: "u2",
          name: "Ivan",
          posts: { create: { id: "po3", title: "Remove many" } },
        },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { id: "u1" },
        data: {
          posts: {
            delete: { id: "po1" },
            deleteMany: { title: "Remove many" },
          },
        },
      }),
  },
  {
    name: "delete of another parent's child rejects",
    expectReject: true,
    seed: async (c) => {
      await c.user.create({
        data: {
          id: "u1",
          name: "Owner",
          posts: { create: { id: "po1", title: "Owner post" } },
        },
      });
      await c.user.create({
        data: {
          id: "u2",
          name: "Other",
          posts: { create: { id: "po2", title: "Other post" } },
        },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { id: "u1" },
        data: { posts: { delete: { id: "po2" } } },
      }),
  },
  {
    name: "update child and updateMany stay parent-correlated",
    seed: async (c) => {
      await c.user.create({
        data: {
          id: "u1",
          name: "Faye",
          posts: {
            create: [
              { id: "po1", title: "Draft" },
              { id: "po2", title: "Queued" },
            ],
          },
        },
      });
      await c.user.create({
        data: {
          id: "u2",
          name: "Gus",
          posts: { create: { id: "po3", title: "Queued" } },
        },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { id: "u1" },
        data: {
          posts: {
            update: { where: { id: "po1" }, data: { title: "Updated one" } },
            updateMany: {
              where: { title: "Queued" },
              data: { title: "Updated many" },
            },
          },
        },
      }),
  },
  {
    name: "update to another parent's child rejects",
    expectReject: true,
    seed: async (c) => {
      await c.user.create({
        data: {
          id: "u1",
          name: "Lina",
          posts: { create: { id: "po1", title: "Owner" } },
        },
      });
      await c.user.create({
        data: {
          id: "u2",
          name: "Milo",
          posts: { create: { id: "po2", title: "Other" } },
        },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { id: "u1" },
        data: {
          name: "Changed",
          posts: {
            update: { where: { id: "po2" }, data: { title: "Stolen" } },
          },
        },
      }),
  },
  {
    name: "set (nullable FK) disconnects departing and connects added children",
    seed: async (c) => {
      await c.user.create({
        data: {
          id: "u1",
          name: "Nia",
          posts: {
            create: [
              { id: "po-kept", title: "Kept" },
              { id: "po-dropped", title: "Dropped" },
            ],
          },
        },
      });
      await c.post.create({
        data: { id: "po-added", title: "Added", userId: null },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { id: "u1" },
        data: { posts: { set: [{ id: "po-kept" }, { id: "po-added" }] } },
      }),
  },
  {
    name: "set keeping the only required-FK child is a no-op and succeeds",
    seed: async (c) => {
      await c.tag.create({ data: { id: "t1", name: "keep" } });
      await c.post.create({
        data: {
          id: "po1",
          title: "Set no-op",
          userId: null,
          postTags: { create: { id: "j1", tag: { connect: { id: "t1" } } } },
        },
      });
    },
    act: (c) =>
      c.post!.update!({
        where: { id: "po1" },
        data: { postTags: { set: [{ id: "j1" }] } },
      }),
  },
  {
    name: "set orphaning a required-FK child rejects, state unchanged",
    expectReject: true,
    seed: async (c) => {
      await c.tag.create({ data: { id: "t1", name: "keep" } });
      await c.tag.create({ data: { id: "t2", name: "orphan" } });
      await c.post.create({
        data: {
          id: "po1",
          title: "Set orphan",
          userId: null,
          postTags: {
            create: [
              { id: "j-keep", tag: { connect: { id: "t1" } } },
              { id: "j-orphan", tag: { connect: { id: "t2" } } },
            ],
          },
        },
      });
    },
    act: (c) =>
      c.post!.update!({
        where: { id: "po1" },
        data: { title: "Changed", postTags: { set: [{ id: "j-keep" }] } },
      }),
  },
  {
    name: "disconnect a required-FK child rejects, state unchanged",
    expectReject: true,
    seed: async (c) => {
      await c.tag.create({ data: { id: "t1", name: "required" } });
      await c.post.create({
        data: {
          id: "po1",
          title: "Required join",
          userId: null,
          postTags: { create: { id: "j1", tag: { connect: { id: "t1" } } } },
        },
      });
    },
    act: (c) =>
      c.post!.update!({
        where: { id: "po1" },
        data: { title: "Changed", postTags: { disconnect: { id: "j1" } } },
      }),
  },
];

describe("query-engine-v2 nested-mutation dual-run oracle (V1 vs V2)", () => {
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      // Routing proof: the whole tree ran on V2 in both V2 arms.
      expect(tx.routed).toBe(true);
      expect(batch.routed).toBe(true);
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      // Error class + message parity.
      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);
      expect(Boolean(v1.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }

      // The load-bearing assertion: byte-identical persisted state.
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
    });
  }
});
