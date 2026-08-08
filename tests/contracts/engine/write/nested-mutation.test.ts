import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe, expect, test } from "vitest";
import {
  nestedMutationSchema,
  runNestedMutationBehavior,
} from "@tests/contracts/engine/write/nested-mutation-behavior";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";

// The whole nested-mutation family on PGlite, both substrates.
runNestedMutationBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runNestedMutationBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN P2c gate): the FULL FK conformance scenario set for
// nested update/updateMany/delete/deleteMany/set — the SAME payload through the
// real Direct client and, via the Observed-observed proxy, through Observed (tx and forced batch),
// reset state per arm, asserting byte-identical state + result + error class
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

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof nestedMutationSchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database);
  await scenario.seed(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  let operations: { boundary: "direct" | "production" }[] = [];
  try {
    if (kind === "direct") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: family.database })
          : new BatchOnlyPGliteDriver({ client: family.database });
      const observed = observeClientOperations({
        schema: nestedMutationSchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const routedToObserved =
    kind === "direct" || operations.every((r) => r.boundary === "production");
  const observed = operations.length > 0;
  const state = await dump(client);
  return { result, error, state, routedToObserved, observed };
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

describe("write boundary nested-mutation dual-run oracle (Direct vs Observed)", () => {
  const getFamily = usePGliteSchemaFamily(nestedMutationSchema);
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      // Routing proof: the whole tree ran on Observed in both Observed arms.
      expect(tx.observed).toBe(true);
      expect(batch.observed).toBe(true);
      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      // Error class + message parity.
      expect(tx.error).toEqual(direct.error);
      expect(batch.error).toEqual(direct.error);
      expect(Boolean(direct.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(direct.result);
        expect(batch.result).toEqual(direct.result);
      }

      // The load-bearing assertion: byte-identical persisted state.
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
    });
  }
});
