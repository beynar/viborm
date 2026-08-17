import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  correlatedUpsertArgs,
  createUpdateSliceExecutor,
  runUpdateNestedUpsertBehavior,
  updateSliceSchema,
} from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

runUpdateNestedUpsertBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});

runUpdateNestedUpsertBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN standing rule): the SAME payload through the real
// V1 client and through the V2 operation runner, with reset state per arm,
// asserting byte-identical persisted state + result + error class. This is the
// parity evidence the fixed-expectation behavior tests above are not.
// ---------------------------------------------------------------------------

type State = { users: unknown[]; posts: unknown[] };

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
    schema: updateSliceSchema,
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
  const [users, posts] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts };
}

type ArmKind = "v1" | "v2-tx" | "v2-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof updateSliceSchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database);
  await scenario.seed(client);

  let result: unknown;
  let error: ErrorShape | undefined;
  try {
    if (kind === "v1") {
      result = await client.user.update(scenario.args as never);
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: family.database })
          : new BatchOnlyPGliteDriver({ client: family.database });
      result = await createUpdateSliceExecutor(driver).executeUpdate(
        updateSliceSchema.user,
        scenario.args
      );
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  const state = await dump(client);
  return { result, error, state };
}

const dualRunScenarios: Scenario[] = [
  {
    name: "absent child → create arm + increment",
    seed: (client) => client.user.create({ data: { email: "a@x", count: 10 } }),
    args: correlatedUpsertArgs({
      email: "a@x",
      childId: 1,
      title: "made",
      slug: "made",
      increment: 3,
    }),
  },
  {
    name: "correlated child → update arm",
    seed: (client) =>
      client.user.create({
        data: {
          email: "b@x",
          count: 0,
          posts: { create: { id: 5, title: "old", slug: "s5" } },
        },
      }),
    args: correlatedUpsertArgs({
      email: "b@x",
      childId: 5,
      title: "fresh",
      slug: "s5",
      increment: 2,
    }),
  },
  {
    name: "found-uncorrelated child → typed V7001",
    expectReject: true,
    seed: async (client) => {
      await client.user.create({ data: { email: "owner@x", count: 0 } });
      await client.user.create({ data: { email: "thief@x", count: 0 } });
      await client.post.create({
        data: { id: 7, title: "owned", slug: "s7", userId: 1 },
      });
    },
    args: correlatedUpsertArgs({
      email: "thief@x",
      childId: 7,
      title: "stolen",
      slug: "s7",
    }),
  },
  {
    name: "missing root → typed notFound",
    expectReject: true,
    seed: () => Promise.resolve(),
    args: correlatedUpsertArgs({
      email: "ghost@x",
      childId: 9,
      title: "n",
      slug: "s9",
    }),
  },
];

describe("write engine update slice dual-run oracle (direct client vs production engine)", () => {
  const getFamily = usePGliteSchemaFamily(updateSliceSchema);
  for (const scenario of dualRunScenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const v1 = await runArm(family, "v1", scenario);
      const tx = await runArm(family, "v2-tx", scenario);
      const batch = await runArm(family, "v2-batch", scenario);

      // Error class + message parity across all three arms.
      expect(tx.error).toEqual(v1.error);
      expect(batch.error).toEqual(v1.error);
      expect(Boolean(v1.error)).toBe(scenario.expectReject === true);

      // Result parity on the success arms.
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

// ---------------------------------------------------------------------------
// Composition gates: preflight rejection, O(N) shared steps, id allocator.
// ---------------------------------------------------------------------------

function planningEngine() {
  const schemas = createSchemaRegistry(updateSliceSchema);
  return new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(updateSliceSchema, schemas)
  );
}

function batchPlanningEngine() {
  const schemas = createSchemaRegistry(updateSliceSchema);
  return new QueryEngine(
    new BatchOnlyPGliteDriver(),
    createModelRegistry(updateSliceSchema, schemas)
  );
}

function multiUpsertArgs(items: { id: number; slug: string }[]) {
  return {
    where: { email: "z@x" },
    data: {
      count: { increment: 1 },
      posts: {
        upsert: items.map((item) => ({
          where: { id: item.id },
          create: { id: item.id, title: `t${item.id}`, slug: item.slug },
          update: { title: `t${item.id}` },
        })),
      },
    },
    select: { email: true, posts: { select: { id: true } } },
  };
}

describe("write engine update slice composition gates", () => {
  test("preflight rejects two upserts on the same child unique (typed, both substrates)", () => {
    const samePair = () =>
      multiUpsertArgs([
        { id: 1, slug: "s1" },
        { id: 1, slug: "s1b" },
      ]);
    // The preflight runs before planning, so the rejection is substrate-
    // independent — proven here on both the transaction and batch engines.
    expect(
      () =>
        new UpdateOperation(
          planningEngine(),
          updateSliceSchema.user,
          samePair()
        )
    ).toThrow("depends on an earlier 'upsert'");
    expect(
      () =>
        new UpdateOperation(
          batchPlanningEngine(),
          updateSliceSchema.user,
          samePair()
        )
    ).toThrow("depends on an earlier 'upsert'");
  });

  test("two same-model children: the scope disambiguates their step ids", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      updateSliceSchema.user,
      multiUpsertArgs([
        { id: 1, slug: "s1" },
        { id: 2, slug: "s2" },
      ])
    );
    const planning = operation.planning();
    expect(planning.steps.map((step) => step.id)).toEqual([
      "user.locate",
      "post.find",
      "post.find#1",
    ]);
  });

  test("upsert: [a, b] plan emits shared root+terminal once (O(N) proof)", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      updateSliceSchema.user,
      multiUpsertArgs([
        { id: 1, slug: "s1" },
        { id: 2, slug: "s2" },
      ])
    );
    // Both children absent → both create arms; the shared root update and the
    // deep terminal read appear exactly once regardless of decision count.
    const fragment = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [],
      "post.find#1.rows": [],
    });
    const ids = fragment.steps.map((step) => step.id);
    expect(ids).toMatchInlineSnapshot(`
      [
        "user.update",
        "post.create",
        "post.create#1",
        "user.select",
      ]
    `);
    expect(ids.filter((id) => id === "user.update")).toHaveLength(1);
    expect(ids.filter((id) => id === "user.select")).toHaveLength(1);
  });

  test("mixed decisions still share root+terminal once", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      updateSliceSchema.user,
      multiUpsertArgs([
        { id: 1, slug: "s1" },
        { id: 2, slug: "s2" },
      ])
    );
    // First child correlated (found under parent 42) → update arm; second
    // absent → create arm. One update root, one terminal, two child arms.
    const fragment = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 1, userId: 42 }],
      "post.find#1.rows": [],
    });
    const ids = fragment.steps.map((step) => step.id);
    expect(ids).toEqual([
      "user.update",
      "post.update",
      "post.create#1",
      "user.select",
    ]);
  });
});
