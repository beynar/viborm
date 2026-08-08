import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  createDepthSliceExecutor,
  depthSliceSchema,
  depthUpsertArgs,
} from "@tests/contracts/engine/write/update-depth-upsert-behavior";

// ---------------------------------------------------------------------------
// The depth gate (PLAN P1): `update > upsert > upsert` with actual planning
// reads. The middle upsert (posts) is located by its PK; its UPDATE arm carries
// a deeper correlated upsert (comments). Recursion adds list entries and one
// parent-id value, never a Part method, a step kind, or a parent reference.
// ---------------------------------------------------------------------------

function planningEngine() {
  const schemas = createSchemaRegistry(depthSliceSchema);
  return new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(depthSliceSchema, schemas)
  );
}

function batchPlanningEngine() {
  const schemas = createSchemaRegistry(depthSliceSchema);
  return new QueryEngine(
    new BatchOnlyPGliteDriver(),
    createModelRegistry(depthSliceSchema, schemas)
  );
}

const gateArgs = () =>
  depthUpsertArgs({
    email: "z@x",
    postId: 5,
    postSlug: "s5",
    commentId: 9,
    commentTag: "t9",
    commentBody: "deep",
  });

describe("write engine depth gate: update > upsert > upsert composition", () => {
  test("planning contributes one read per level (locate + two probes)", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      depthSliceSchema.user,
      gateArgs()
    );
    const planning = operation.planning();
    expect(planning.steps.map((step) => step.id)).toEqual([
      "user.locate",
      "post.find",
      "comment.find",
    ]);
    expect(planning.steps.every((step) => step.kind === "read")).toBe(true);
  });

  test("post found + comment found → deep update fragment (tx: no guards)", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      depthSliceSchema.user,
      gateArgs()
    );
    const fragment = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 5, userId: 42 }],
      "comment.find.rows": [{ id: 9, postId: 5 }],
    });
    expect(fragment.steps.map((step) => step.id)).toEqual([
      "user.update",
      "post.update",
      "comment.update",
      "user.select",
    ]);
    expect(fragment.steps.every((step) => step.kind !== "guard")).toBe(true);
  });

  test("post found + comment absent → deep create-comment fragment", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      depthSliceSchema.user,
      gateArgs()
    );
    const fragment = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 5, userId: 42 }],
      "comment.find.rows": [],
    });
    const ids = fragment.steps.map((step) => step.id);
    expect(ids).toEqual([
      "user.update",
      "post.update",
      "comment.create",
      "user.select",
    ]);
    // The deep create carries the racePin (its unique constraint enforces the
    // missing premise); it never carries a guard.
    const commentCreate = fragment.steps[2];
    expect(
      commentCreate?.kind === "write" && commentCreate.racePin?.fields
    ).toEqual(["id"]);
  });

  test("batch mode hoists a guard per found level ahead of every write", () => {
    const operation = new UpdateOperation(
      batchPlanningEngine(),
      depthSliceSchema.user,
      gateArgs()
    );
    const fragment = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 5, userId: 42 }],
      "comment.find.rows": [{ id: 9, postId: 5 }],
    });
    // The root-presence guard (ATOM §8.1 note (b), P2a) leads: batch mode pins
    // the located root inside the atomic unit, then each found child level.
    expect(fragment.steps.map((step) => step.id)).toEqual([
      "user.guard.exists",
      "post.guard.exists",
      "comment.guard.exists",
      "user.update",
      "post.update",
      "comment.update",
      "user.select",
    ]);
    const guards = fragment.steps.filter((step) => step.kind === "guard");
    expect(guards).toHaveLength(3);
    // All are existing-row premises: pinned raceable: false (Pin Rule).
    expect(
      guards.every(
        (step) =>
          step.kind === "guard" &&
          step.premise.kind === "exists" &&
          step.failure.raceable === false
      )
    ).toBe(true);
  });

  test("found-uncorrelated comment under a correlated post → typed V7001 at compile", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      depthSliceSchema.user,
      gateArgs()
    );
    // Post 5 belongs to the located user, but comment 9 belongs to a foreign
    // post (postId 99 != this post's PK 5) — adopting it would steal it.
    expect(() =>
      operation.compile({
        "user.locate.rows": [{ id: 42 }],
        "post.find.rows": [{ id: 5, userId: 42 }],
        "comment.find.rows": [{ id: 9, postId: 99 }],
      })
    ).toThrow(
      "Cannot upsert relation 'comments': target record was not found for this parent."
    );
  });

  test("create-arm nested relations compose (fresh-parent adopt, ATOM §8.1's P2b deferral)", () => {
    // A nested relation mutation inside the post's CREATE payload runs under a
    // FRESH child (ATOM §4's elision): correlation is statically empty, so it
    // adopts globally. Depth composes on the create arm now — the P1 rejection is
    // replaced by the composed shape.
    const operation = new UpdateOperation(
      planningEngine(),
      depthSliceSchema.user,
      createArmDepthArgs()
    );
    // The create-arm comment probe is planned unconditionally (widened superset).
    const planning = operation.planning();
    expect(planning.steps.map((step) => step.id)).toEqual([
      "user.locate",
      "post.find",
      "comment.find",
    ]);
    // Post absent → create the post, then its create-arm comment (absent → create,
    // its unique constraint enforces the missing premise via racePin).
    const absent = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [],
      "comment.find.rows": [],
    });
    expect(absent.steps.map((step) => step.id)).toEqual([
      "user.update",
      "post.create",
      "comment.create",
      "user.select",
    ]);
    const commentCreate = absent.steps[2];
    expect(
      commentCreate?.kind === "write" && commentCreate.racePin?.fields
    ).toEqual(["id"]);
    // A globally-existing comment is ADOPTED under the fresh post — no V7001
    // (correlation is meaningless under a parent that cannot have children yet).
    const adopt = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [],
      "comment.find.rows": [{ id: 9, postId: 999 }],
    });
    expect(adopt.steps.map((step) => step.id)).toEqual([
      "user.update",
      "post.create",
      "comment.update",
      "user.select",
    ]);
    // Post found → update arm; the create-arm comment does NOT run.
    const found = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 5, userId: 42 }],
      "comment.find.rows": [],
    });
    expect(found.steps.map((step) => step.id)).toEqual([
      "user.update",
      "post.update",
      "user.select",
    ]);
  });
});

/**
 * `update > upsert post > (CREATE-arm) connectOrCreate comment` — the fresh-parent
 * path. connectOrCreate is the create-arm's supported adopt member (global lookup,
 * found → connect/reparent, absent → create); V1's runtime rejects a nested
 * `upsert` under a create payload, so the create arm takes connectOrCreate.
 */
function createArmDepthArgs(): Record<string, unknown> {
  return {
    where: { email: "z@x" },
    data: {
      count: { increment: 1 },
      posts: {
        upsert: {
          where: { id: 5 },
          create: {
            id: 5,
            title: "created-post",
            slug: "s5",
            comments: {
              connectOrCreate: {
                where: { id: 9 },
                create: { id: 9, body: "deep", tag: "t9" },
              },
            },
          },
          update: { title: "updated-post" },
        },
      },
    },
    select: {
      email: true,
      count: true,
      posts: {
        select: {
          id: true,
          title: true,
          comments: { select: { id: true, body: true, postId: true } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Behavior on both substrates + the dual-run oracle (V1 vs V2 tx vs V2 batch).
// ---------------------------------------------------------------------------

type State = { users: unknown[]; posts: unknown[]; comments: unknown[] };

interface ErrorShape {
  name: string;
  code?: string | number;
  message: string;
}

interface Scenario {
  name: string;
  seed: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  args: Record<string, unknown>;
  expectReject?: boolean;
}

function makeClient(db: PGlite) {
  return createClient({
    schema: depthSliceSchema,
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
  const [users, posts, comments] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
    client.comment.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts, comments };
}

type ArmKind = "v1" | "v2-tx" | "v2-batch";

async function runArm(
  family: { readonly database: PGlite; readonly reset: () => Promise<void> },
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const db = family.database;
  const client = makeClient(db);
  await scenario.seed(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  try {
    if (kind === "v1") {
      result = await client.user.update(scenario.args as never);
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      result = await createDepthSliceExecutor(driver).executeUpdate(
        depthSliceSchema.user,
        scenario.args
      );
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const state = await dump(client);
  return { result, error, state };
}

const seedUserPostComment = (
  client: ReturnType<typeof makeClient>,
  options: { commentPostId?: number } = {}
) =>
  client.user.create({
    data: {
      email: "z@x",
      count: 0,
      posts: {
        create: {
          id: 5,
          title: "old-post",
          slug: "s5",
          comments: {
            create: {
              id: 9,
              body: "old-comment",
              tag: "t9",
              // Optionally reparent to a foreign post to force uncorrelated.
              ...(options.commentPostId !== undefined
                ? { postId: options.commentPostId }
                : {}),
            },
          },
        },
      },
    },
  });

const dualRunScenarios: Scenario[] = [
  {
    name: "post found + comment found → deep nested update",
    seed: (client) => seedUserPostComment(client),
    args: depthUpsertArgs({
      email: "z@x",
      postId: 5,
      postSlug: "s5",
      commentId: 9,
      commentTag: "t9",
      commentBody: "fresh-comment",
      increment: 2,
    }),
  },
  {
    name: "post found + comment absent → deep nested create",
    seed: (client) =>
      client.user.create({
        data: {
          email: "z@x",
          count: 1,
          posts: { create: { id: 5, title: "old-post", slug: "s5" } },
        },
      }),
    args: depthUpsertArgs({
      email: "z@x",
      postId: 5,
      postSlug: "s5",
      commentId: 10,
      commentTag: "t10",
      commentBody: "brand-new",
      increment: 3,
    }),
  },
  {
    name: "post absent → create post, no comment (create-arm has none)",
    seed: (client) => client.user.create({ data: { email: "z@x", count: 5 } }),
    args: depthUpsertArgs({
      email: "z@x",
      postId: 5,
      postSlug: "s5",
      commentId: 9,
      commentTag: "t9",
      commentBody: "unused",
      increment: 1,
    }),
  },
  {
    name: "post absent → create post AND its create-arm comment (fresh-parent, P2b)",
    seed: (client) => client.user.create({ data: { email: "z@x", count: 5 } }),
    args: createArmDepthArgs(),
  },
  {
    name: "create-arm comment adopts a globally-existing orphan comment (P2b)",
    seed: async (client) => {
      await client.user.create({ data: { email: "z@x", count: 5 } });
      // Comment 9 exists globally, unattached (postId null); the create arm's
      // global-adopt reparents it under the freshly-created post 5.
      await client.comment.create({
        data: { id: 9, body: "orphan", tag: "t9", postId: null },
      });
    },
    args: createArmDepthArgs(),
  },
  {
    name: "found-uncorrelated deep comment → typed V7001",
    expectReject: true,
    seed: async (client) => {
      // Two posts under the user; the comment belongs to post 6, not post 5.
      await client.user.create({
        data: {
          email: "z@x",
          count: 0,
          posts: {
            create: [
              { id: 5, title: "p5", slug: "s5" },
              {
                id: 6,
                title: "p6",
                slug: "s6",
                comments: { create: { id: 9, body: "owned", tag: "t9" } },
              },
            ],
          },
        },
      });
    },
    args: depthUpsertArgs({
      email: "z@x",
      postId: 5,
      postSlug: "s5",
      commentId: 9,
      commentTag: "t9",
      commentBody: "stolen",
    }),
  },
];

describe("write engine depth gate dual-run oracle (direct client vs production engine)", () => {
  const getFamily = usePGliteSchemaFamily(depthSliceSchema);

  for (const scenario of dualRunScenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const v1 = await runArm(family, "v1", scenario);
      const tx = await runArm(family, "v2-tx", scenario);
      const batch = await runArm(family, "v2-batch", scenario);

      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);
      expect(Boolean(v1.error)).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }

      // The load-bearing assertion: byte-identical persisted state at depth 3.
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
    });
  }
});

describe("write engine depth gate: no partial mutation on the uncorrelated arm", () => {
  const getFamily = usePGliteSchemaFamily(depthSliceSchema);

  test("V7001 leaves users, posts, and comments untouched (both substrates)", async () => {
    for (const kind of ["v2-tx", "v2-batch"] as const) {
      const family = getFamily();
      await family.reset();
      const db = family.database;
      const client = makeClient(db);
      await client.user.create({
        data: {
          email: "z@x",
          count: 0,
          posts: {
            create: [
              { id: 5, title: "p5", slug: "s5" },
              {
                id: 6,
                title: "p6",
                slug: "s6",
                comments: { create: { id: 9, body: "owned", tag: "t9" } },
              },
            ],
          },
        },
      });
      const before = await dump(client);
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      await expect(
        createDepthSliceExecutor(driver).executeUpdate(
          depthSliceSchema.user,
          depthUpsertArgs({
            email: "z@x",
            postId: 5,
            postSlug: "s5",
            commentId: 9,
            commentTag: "t9",
            commentBody: "stolen",
          })
        )
      ).rejects.toBeInstanceOf(NestedWriteError);
      const after = await dump(client);
      expect(after).toEqual(before);
    }
  });
});
