/**
 * G4-02 — the borrowed-transaction half of the envelope rule (brief item 11,
 * divergence D-1) and the trusted-context threading (item 9, blocker B-4).
 *
 * These checks construct the binding the CORRECTED route will pass — the
 * caller's own transaction driver plus a `memberRollback` grant, with no region
 * opened by the caller — because `src/query-engine/raptor3/route/client-route.ts`
 * is the G4-03 author's file and still wraps every write itself (note §11.3).
 * They therefore pin the candidate's own behavior, side by side with the shipped
 * engine's, for both outcomes the divergence record names.
 */

import assert from "node:assert/strict";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import {
  createExecutionContext,
  getExecutionExtensionChain,
} from "@drivers/execution-context";
import type { ResolvedExtensionChain } from "@extensions/chain";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

function engineOf(current: World) {
  return createCommandEngine({ schema: worldSchema, driver: current.driver });
}

/** Exactly what the corrected route hands the candidate for a borrowed scope. */
function borrowed(scoped: AnyDriver) {
  return {
    kind: "borrowed-transaction",
    driver: scoped,
    memberRollback: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => scoped.withTransaction(execute, undefined, context),
  } as const;
}

describe("G4-02 borrowed transaction envelope", () => {
  it("runs a single-statement write directly on the borrowed driver", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    await driver.withTransaction(async (scoped) => {
      driver.reset();
      const value = await engine.execute(
        "author",
        "update",
        { where: { id: 1 }, data: { age: { increment: 1 } } },
        borrowed(scoped as AnyDriver)
      );
      assert.deepEqual(value, { id: 1, name: "Ada", age: 37, avatar: null });
      // One statement, and NO region of its own: the caller's transaction is
      // the unit, exactly as the shipped `runStatementAtomic` leaves it.
      assert.equal(driver.statements.length, 1);
      assert.deepEqual(
        driver.control.filter((statement) => /^SAVEPOINT/i.test(statement)),
        []
      );
    });
  });

  it("opens no region of its own for a multi-statement borrowed write", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    await driver.withTransaction(async (scoped) => {
      driver.reset();
      await engine.execute(
        "author",
        "update",
        {
          where: { id: 1 },
          data: {
            name: "Ada II",
            posts: { update: { where: { id: 10 }, data: { title: "renamed" } } },
          },
        },
        borrowed(scoped as AnyDriver)
      );
      // The caller's scope is the unit. `memberRollback` is MEMBER isolation,
      // not an operation-region grant: `g3-suppression-retry` pins one savepoint
      // per suppressed member and none for the operation, and opening a second
      // scope on the caller's driver is refused outright by the native
      // `g3-scope-composition-*` contract. The operation-level region for a
      // multi-statement borrowed write needs a binding grant that does not exist
      // yet (g4/unit02/note.md §8.4).
      const savepoints = driver.control.filter((statement) =>
        /^SAVEPOINT/i.test(statement)
      );
      assert.deepEqual(savepoints, []);
      assert.ok(driver.statements.length > 1);
    });
  });

  it("a failing single-statement write poisons the caller's transaction on both seams", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    const name = (error: unknown) => (error as Error).constructor.name;

    // A duplicate identity: `update` moving author 1 onto author 2's key.
    const shipped = { inner: "", after: "", outer: "" };
    try {
      await world.client.$transaction(async (tx) => {
        try {
          await tx.author.update({ where: { id: 1 }, data: { id: 2 } });
          shipped.inner = "ok";
        } catch (error) {
          shipped.inner = name(error);
        }
        try {
          await tx.author.update({
            where: { id: 1 },
            data: { age: { increment: 1 } },
          });
          shipped.after = "ok";
        } catch (error) {
          shipped.after = name(error);
        }
      });
      shipped.outer = "resolved";
    } catch (error) {
      shipped.outer = name(error);
    }

    const candidate = { inner: "", after: "", outer: "" };
    try {
      await driver.withTransaction(async (scoped) => {
        const binding = borrowed(scoped as AnyDriver);
        try {
          await engine.execute(
            "author",
            "update",
            { where: { id: 1 }, data: { id: 2 } },
            binding
          );
          candidate.inner = "ok";
        } catch (error) {
          candidate.inner = name(error);
        }
        try {
          await engine.execute(
            "author",
            "update",
            { where: { id: 1 }, data: { age: { increment: 1 } } },
            binding
          );
          candidate.after = "ok";
        } catch (error) {
          candidate.after = name(error);
        }
      });
      candidate.outer = "resolved";
    } catch (error) {
      candidate.outer = name(error);
    }

    assert.deepEqual(
      candidate,
      shipped,
      `candidate ${JSON.stringify(candidate)} vs shipped ${JSON.stringify(shipped)}`
    );
  });
});

describe("G4-02 execution context threading", () => {
  it("every candidate statement carries the caller's own trusted context, attributed to the model it addresses", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    const chain = {
      extensions: [],
      hasCache: false,
      hasRequestHandlers: false,
      hasQueryHandlers: false,
      hasResultConsumers: false,
      request: {},
      query: {},
      statement: [],
      observe: [],
    } as unknown as ResolvedExtensionChain;
    const caller: QueryExecutionContext = createExecutionContext(
      { model: "author", operation: "update", correlationId: "g4u2-caller" },
      undefined,
      () => "g4u2-caller",
      chain
    );
    driver.reset();
    await engine.execute(
      "author",
      "update",
      {
        where: { id: 1 },
        data: {
          name: "Ada II",
          posts: { update: { where: { id: 10 }, data: { title: "renamed" } } },
        },
      },
      undefined,
      caller
    );
    assert.ok(driver.statements.length > 1);
    const candidateModels = driver.statements.map(
      (statement) => statement.context?.model
    );
    for (const statement of driver.statements) {
      // The driver snapshots a trusted context by value, carrying the resolved
      // chain forward; what must NOT survive is a candidate-minted attribution,
      // which carries no chain at all (g4/unit03/note.md B-4).
      assert.equal(
        getExecutionExtensionChain(statement.context),
        chain,
        `a candidate statement lost the caller's resolved extension chain`
      );
      assert.equal(statement.context?.correlationId, "g4u2-caller");
      assert.equal(statement.context?.operation, "update");
    }

    // Model PARITY with the shipped engine, not "everything is the root model":
    // `statementExecutionContext` re-attributes a statement compiled for a
    // nested record to that record's model, and the candidate's
    // `statementContext` does the same through the same public derivation
    // (`deriveStatementExecutionContext`), which is what keeps the chain.
    const shippedWorld = await createWorld();
    try {
      shippedWorld.driver.reset();
      await shippedWorld.client.author.update({
        where: { id: 1 },
        data: {
          name: "Ada II",
          posts: {
            update: { where: { id: 10 }, data: { title: "renamed" } },
          },
        },
      });
      const tally = (models: (string | undefined)[]) => {
        const counts: Record<string, number> = {};
        for (const model of models) counts[model ?? "?"] = (counts[model ?? "?"] ?? 0) + 1;
        return counts;
      };
      assert.deepEqual(
        tally(candidateModels),
        tally(
          shippedWorld.driver.statements.map(
            (statement) => statement.context?.model
          )
        ),
        `candidate statement models ${JSON.stringify(candidateModels)} do not match the shipped engine's`
      );
    } finally {
      await shippedWorld.close();
    }
  });

  it("without a caller context the candidate keeps its own attribution", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    driver.reset();
    await engine.execute("author", "findUnique", { where: { id: 1 } });
    const context = driver.statements[0]?.context;
    assert.equal(context?.model, "author");
    assert.equal(context?.operation, "findUnique");
    assert.equal(typeof context?.correlationId, "string");
  });
});
