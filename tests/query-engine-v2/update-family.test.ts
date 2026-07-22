import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { isOperationValueReference } from "../../src/query-engine-v2/OperationFragment";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import {
  runUpdateFamilyBehavior,
  updateFamilySchema,
} from "./update-family-behavior";
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

// The whole update family on PGlite, both substrates (the driver-matrix legs
// live in tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runUpdateFamilyBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runUpdateFamilyBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// The dual-run oracle (PLAN standing rule): the SAME payload driven through the
// real V1 client and — via the V2-backed client proxy — through V2, on FRESH
// instances per arm, asserting byte-identical persisted state + result + error
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

function makeClient(db: PGlite) {
  return createClient({
    schema: updateFamilySchema,
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
        schema: updateFamilySchema,
        client: client as unknown as Record<string, RoutedModel>,
        driver,
      });
      routes = routed.routes;
      result = await scenario.act(routed.client);
    }
  } catch (thrown) {
    error = normalizeError(thrown);
  }
  // The proxy records the route before executing, so a thrown reject still
  // proves V2 handled the tree (routing is a pre-I/O, whole-tree decision).
  const routedToV2 = kind === "v1" || routes.every((r) => r.engine === "v2");
  const routed = routes.length > 0;
  const state = await dump(client);
  await client.$disconnect();
  return { result, error, state, routedToV2, routed };
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

describe("query-engine-v2 update family dual-run oracle (V1 vs V2)", () => {
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      // Routing proof: the whole tree was handled (a route was recorded) and
      // executed on V2 in both V2 arms — no silent V1 fallback.
      expect(tx.routed).toBe(true);
      expect(batch.routed).toBe(true);
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      // Error class + message parity across all three arms.
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

describe("query-engine-v2 technique #1 witness (correlated disconnect probe)", () => {
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
// V2 construction surface (was PLAN P2a per-tree routing). Pre-P6 a shape outside
// V2's family routed the whole tree to the V1 client; post-P6 there is no V1, so
// V2's construction-time decision IS the caller's outcome — a supported tree
// constructs, an unsupported tree declines with the typed refusal (an
// UnsupportedOperationError, a QueryEngineError subclass) before any I/O.
// ---------------------------------------------------------------------------

describe("query-engine-v2 update construction surface", () => {
  test("supported update constructs on V2; nested to-many create is the documented refusal", () => {
    const schemas = createSchemaRegistry(updateFamilySchema);
    const engine = new QueryEngine(
      new PGliteDriver(),
      createModelRegistry(updateFamilySchema, schemas)
    );
    const userModel = updateFamilySchema.user;

    // Supported: a scalar update is V2-native — it constructs for the whole tree.
    expect(
      new UpdateOperation(engine, userModel, {
        where: { email: "r@x" },
        data: { count: { increment: 1 } },
        select: { email: true },
      })
    ).toBeInstanceOf(UpdateOperation);

    // Outside V2's surface (a nested to-many `create` under `update`): V2 declines
    // at construction, before any I/O, with the typed refusal.
    expect(
      () =>
        new UpdateOperation(engine, userModel, {
          where: { email: "r@x" },
          data: { posts: { create: { id: 1, title: "t", slug: "sr" } } },
          select: { email: true, posts: { select: { id: true } } },
        })
    ).toThrow(UnsupportedOperationError);
  });
});
