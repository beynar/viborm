import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { isOperationValueReference } from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import {
  runUpdateFamilyBehavior,
  updateFamilySchema,
} from "@tests/contracts/engine/write/update-family-behavior";
import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

// The whole update family on PGlite, both substrates (the driver-matrix legs
// live in tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runUpdateFamilyBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runUpdateFamilyBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN standing rule): the SAME payload driven through the
// real Direct client and — via the Observed-backed client proxy — through Observed, with
// reset state per arm, asserting byte-identical persisted state + result + error
// class AND message. This is the parity evidence; the fixed-expectation
// behavior suite above is not.
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
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
}

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

function makeClient(db: PGlite, namespace: string) {
  return createClient({
    schema: updateFamilySchema,
    driver: new PGliteDriver({ client: db, namespace }),
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

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof updateFamilySchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database, family.namespace);
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
          ? new PGliteDriver({
              client: family.database,
              namespace: family.namespace,
            })
          : new BatchOnlyPGliteDriver({
              client: family.database,
              namespace: family.namespace,
            });
      const observed = observeClientOperations({
        schema: updateFamilySchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  // The proxy records the route before executing, so a thrown reject still
  // proves Observed handled the tree (routing is a pre-I/O, whole-tree decision).
  const routedToObserved =
    kind === "direct" || operations.every((r) => r.boundary === "production");
  const observed = operations.length > 0;
  const state = await dump(client);
  return { result, error, state, routedToObserved, observed };
}

const scenarios: Scenario[] = [
  {
    name: "root scalar update by non-PK unique",
    seed: (c) => c.user.create({ data: { email: "s@x", count: 10 } }),
    act: (c) =>
      c.user!.update!({
        where: { email: "s@x" },
        data: { count: { increment: 5 } },
        select: { email: true, count: true },
      }),
  },
  {
    name: "to-many connect reparents child",
    seed: async (c) => {
      await c.user.create({ data: { email: "o@x", count: 0 } });
      await c.post.create({
        data: { id: 7, title: "orphan", slug: "s7", userId: null },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { email: "o@x" },
        data: { posts: { connect: { id: 7 } } },
        select: { email: true, posts: { select: { id: true, userId: true } } },
      }),
  },
  {
    name: "to-many disconnect nulls correlated child (technique #1 path)",
    seed: (c) =>
      c.user.create({
        data: {
          email: "d@x",
          count: 0,
          posts: { create: { id: 8, title: "mine", slug: "s8" } },
        },
      }),
    act: (c) =>
      c.user!.update!({
        where: { email: "d@x" },
        data: { posts: { disconnect: { id: 8 } } },
        select: { email: true, posts: { select: { id: true } } },
      }),
  },
  {
    name: "to-one connect sets parent-held FK",
    seed: async (c) => {
      await c.user.create({ data: { email: "u@x", count: 0 } });
      await c.post.create({
        data: { id: 11, title: "p", slug: "s11", userId: null },
      });
    },
    act: (c) =>
      c.post!.update!({
        where: { id: 11 },
        data: { author: { connect: { id: 1 } } },
        select: { id: true, userId: true },
      }),
  },
  {
    name: "to-one disconnect nulls parent-held FK",
    seed: async (c) => {
      await c.user.create({ data: { email: "u@x", count: 0 } });
      await c.post.create({
        data: { id: 12, title: "p", slug: "s12", userId: 1 },
      });
    },
    act: (c) =>
      c.post!.update!({
        where: { id: 12 },
        data: { author: { disconnect: true } },
        select: { id: true, userId: true },
      }),
  },
  {
    name: "root delete returns the removed row",
    seed: (c) => c.user.create({ data: { email: "del@x", count: 3 } }),
    act: (c) =>
      c.user!.delete!({
        where: { email: "del@x" },
        select: { email: true, count: true },
      }),
  },
  {
    name: "connect a missing target → typed error",
    expectReject: true,
    seed: (c) => c.user.create({ data: { email: "c@x", count: 0 } }),
    act: (c) =>
      c.user!.update!({
        where: { email: "c@x" },
        data: { posts: { connect: { id: 404 } } },
        select: { email: true },
      }),
  },
  {
    name: "disconnect an uncorrelated child → typed error",
    expectReject: true,
    seed: async (c) => {
      await c.user.create({ data: { email: "a@x", count: 0 } });
      await c.user.create({ data: { email: "b@x", count: 0 } });
      await c.post.create({
        data: { id: 9, title: "b's", slug: "s9", userId: 2 },
      });
    },
    act: (c) =>
      c.user!.update!({
        where: { email: "a@x" },
        data: { posts: { disconnect: { id: 9 } } },
        select: { email: true },
      }),
  },
  {
    name: "missing root update → typed notFound",
    expectReject: true,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user!.update!({
        where: { email: "ghost@x" },
        data: { count: { increment: 1 } },
        select: { email: true },
      }),
  },
  {
    name: "missing root delete → typed notFound",
    expectReject: true,
    seed: () => Promise.resolve(),
    act: (c) =>
      c.user!.delete!({ where: { email: "ghost@x" }, select: { email: true } }),
  },
];

describe("write boundary update family dual-run oracle (Direct vs Observed)", () => {
  const getFamily = usePGliteSchemaFamily(updateFamilySchema);
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      // Routing proof: the whole tree was handled (a route was recorded) and
      // executed on Observed in both Observed arms — no silent Direct fallback.
      expect(tx.observed).toBe(true);
      expect(batch.observed).toBe(true);
      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      // Error class + message parity across all three arms.
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

// ---------------------------------------------------------------------------
// Technique #1's positive witness (PLAN P2a gate; ATOM §8.1 note (a) comes due):
// a correlated nested read whose PROBE SQL literally carries a `Ref` to an
// earlier planning step's output. Proven by INSPECTING the emitted planning
// fragment — not by the validator merely accepting the shape.
// ---------------------------------------------------------------------------

function planningEngine() {
  const schemas = createSchemaRegistry(updateFamilySchema);
  return new QueryEngine(
    new PGliteDriver(),
    createModelRegistry(updateFamilySchema, schemas)
  );
}

describe("write boundary technique #1 witness (correlated disconnect probe)", () => {
  test("the disconnect probe SQL contains a Ref to the locate planning step", () => {
    const operation = new UpdateOperation(
      planningEngine(),
      updateFamilySchema.user,
      {
        where: { email: "z@x" },
        data: { posts: { disconnect: { id: 5 } } },
        select: { email: true },
      }
    );
    const planning = operation.planning();
    // The planning fragment is locate + the correlated disconnect probe.
    expect(planning.steps.map((step) => step.id)).toEqual([
      "user.locate",
      "post.find",
    ]);
    const probe = planning.steps.find((step) => step.id === "post.find");
    if (!(probe && probe.kind === "read")) {
      throw new Error("expected the disconnect probe read");
    }
    const refs = probe.statement.values.filter(isOperationValueReference);
    // The probe correlates by `userId = Ref(user.locate.id)` — the SQL-level
    // planning→planning reference (technique #1), not a compile-time literal.
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ step: "user.locate", output: "id" });
    // The referenced output is a declared output of the locate read (backward,
    // fragment-local): the fragment validator accepts it.
    const locate = planning.steps.find((step) => step.id === "user.locate");
    if (!(locate && locate.kind === "read")) {
      throw new Error("expected the locate read");
    }
    expect(Object.keys(locate.outputs)).toContain("id");
  });
});

// ---------------------------------------------------------------------------
// Observed construction surface (was PLAN P2a per-tree routing). Pre-P6 a shape outside
// Observed's family observed the whole tree to the Direct client; post-P6 there is no Direct, so
// Observed's construction-time decision IS the caller's outcome — a supported tree
// constructs, an unsupported tree declines with the typed refusal (an
// UnsupportedOperationError, a QueryEngineError subclass) before any I/O.
// ---------------------------------------------------------------------------

describe("write boundary update construction surface", () => {
  // DELIBERATE RETARGET (N1-U1). The second case used to be the file's decline
  // example: a nested to-many `create` under an update located by a NON-PK unique
  // had no compile-time literal for the child's foreign key and refused at
  // construction. N1 threads that value from the locate read instead, so the same
  // tree now constructs — and `located-parent-ref-behavior.ts` proves on every
  // driver and both substrates that it also EXECUTES, persisting what the
  // `where: { id }` spelling persists.
  test("both a scalar update and a nested to-many create by a non-PK unique construct on Observed", () => {
    const boundary = planningEngine();
    const userModel = updateFamilySchema.user;

    // A scalar update is Observed-native — it constructs for the whole tree.
    expect(
      new UpdateOperation(boundary, userModel, {
        where: { email: "r@x" },
        data: { count: { increment: 1 } },
        select: { email: true },
      })
    ).toBeInstanceOf(UpdateOperation);

    expect(
      new UpdateOperation(boundary, userModel, {
        where: { email: "r@x" },
        data: { posts: { create: { id: 1, title: "t", slug: "sr" } } },
        select: { email: true, posts: { select: { id: true } } },
      })
    ).toBeInstanceOf(UpdateOperation);
  });
});
