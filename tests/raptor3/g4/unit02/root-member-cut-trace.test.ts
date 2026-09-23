/**
 * G4-02 author check — the TAPE of a root conditional member, for the harness
 * reconciliation unit (`g4/briefs/harness-reconciliation.md`, plan §5.4).
 *
 * The CS-03 extension campaign reports
 * `Missing semantic cut choice:found|missing/root-member/0` on ten cells. That
 * cut is the observation point between a root member's LOCATE statement and the
 * statement that acts on what the locate found. The candidate no longer issues a
 * locate for a scalar-only root `update`/`delete`/`create`: the mutation itself
 * decides found from missing, by the number of rows it returns. So the cut is
 * ELIMINATED BY AN ATOMIC STRATEGY (one statement, no envelope), not moved to a
 * different boundary — there is no second statement for a choice to sit between.
 *
 * This file records that strategy as a tape a reader can check, and checks the
 * same semantic property at the cut's legal surrounding cuts:
 *
 *   BEFORE the atomic statement — nothing has been written and the premise is
 *   still open (a failing operation leaves the row set untouched);
 *   AFTER it — the found branch published the mutated row and the missing
 *   branch raised the shipped `NotFoundError` with `{model, operation}` and
 *   nothing else, having written nothing.
 *
 * Both branches are also compared against the shipped engine on the same
 * driver, which is what makes the elimination parity rather than a choice.
 * The multi-statement neighbours of the same cut (no RETURNING, relation
 * projection, relation-bearing create) keep their locate and are pinned in
 * `malformed-result-cuts.test.ts` and `root-delete.test.ts`.
 */

import assert from "node:assert/strict";
import { NotFoundError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

interface Tape {
  readonly statements: string[];
  readonly transactions: number;
  readonly outcome: string;
  readonly rows: number;
}

/** The leading verb of every statement the operation cost, in order. */
function verbs(statements: readonly { readonly sql: string }[]): string[] {
  return statements.map((statement) => statement.sql.split(/\s+/)[0] ?? "");
}

async function tape(
  current: World,
  engine: "candidate" | "shipped",
  run: (invoke: (model: string, operation: string, args: object) => Promise<unknown>) => Promise<unknown>
): Promise<Tape> {
  const commands = createCommandEngine({
    schema: worldSchema,
    driver: current.driver,
  });
  const client = current.client as unknown as Record<
    string,
    Record<string, (args: object) => Promise<unknown>>
  >;
  const invoke =
    engine === "candidate"
      ? (model: string, operation: string, args: object) =>
          commands.execute(model, operation as never, args)
      : (model: string, operation: string, args: object) =>
          client[model]![operation]!(args);
  current.driver.reset();
  let outcome = "";
  try {
    const value = await run(invoke);
    outcome = `published ${JSON.stringify(value)}`;
  } catch (failure) {
    assert.ok(failure instanceof Error);
    const meta = (failure as { meta?: unknown }).meta;
    outcome = `${failure.constructor.name}|${failure.message}|${JSON.stringify(meta)}`;
  }
  return {
    statements: verbs(current.driver.statements),
    transactions: current.driver.transactionCalls,
    outcome,
    rows: Number(
      current.database.prepare("SELECT COUNT(*) FROM g4u2_authors").pluck().get()
    ),
  };
}

describe("G4-02 §5.4 — the root conditional member's found/missing cut", () => {
  it("update: one statement decides found from missing, and both branches agree across the two seams", async () => {
    world = await createWorld();
    const found = await tape(world, "candidate", (invoke) =>
      invoke("author", "update", { where: { id: 1 }, data: { age: 37 } })
    );
    const foundShipped = await tape(world, "shipped", (invoke) =>
      invoke("author", "update", { where: { id: 1 }, data: { age: 38 } })
    );
    const missing = await tape(world, "candidate", (invoke) =>
      invoke("author", "update", { where: { id: 99 }, data: { age: 1 } })
    );
    const missingShipped = await tape(world, "shipped", (invoke) =>
      invoke("author", "update", { where: { id: 99 }, data: { age: 1 } })
    );
    // The strategy: ONE statement, no envelope, on both branches and on both
    // engines — so no cut exists between a locate and an act.
    for (const observed of [found, foundShipped, missing, missingShipped]) {
      assert.deepEqual(observed.statements, ["UPDATE"]);
      assert.equal(observed.transactions, 0);
    }
    // AFTER the atomic statement: the found branch publishes the mutated row.
    assert.equal(found.outcome, 'published {"id":1,"name":"Ada","age":37,"avatar":null}');
    assert.equal(
      foundShipped.outcome,
      'published {"id":1,"name":"Ada","age":38,"avatar":null}'
    );
    // AFTER it, missing branch: the shipped refusal, meta included.
    assert.equal(missing.outcome, missingShipped.outcome);
    assert.match(missing.outcome, /^NotFoundError\|/);
    assert.equal(
      missing.outcome,
      `NotFoundError|No author record found for update|{"model":"author","operation":"update"}`
    );
    // BEFORE it, seen from after: the missing branch wrote nothing.
    assert.equal(missing.rows, 2);
    assert.equal(missingShipped.rows, 2);
  });

  it("delete: the same strategy, and the row set agrees across the two seams on both branches", async () => {
    world = await createWorld();
    const missing = await tape(world, "candidate", (invoke) =>
      invoke("author", "delete", { where: { id: 99 } })
    );
    const missingShipped = await tape(world, "shipped", (invoke) =>
      invoke("author", "delete", { where: { id: 99 } })
    );
    assert.deepEqual(missing.statements, ["DELETE"]);
    assert.deepEqual(missingShipped.statements, ["DELETE"]);
    assert.equal(missing.outcome, missingShipped.outcome);
    assert.equal(
      missing.outcome,
      `NotFoundError|No author record found for delete|{"model":"author","operation":"delete"}`
    );
    assert.equal(missing.rows, 2);
    const found = await tape(world, "candidate", (invoke) =>
      invoke("author", "delete", { where: { id: 2 } })
    );
    assert.deepEqual(found.statements, ["DELETE"]);
    assert.equal(found.transactions, 0);
    assert.equal(found.rows, 1);
  });

  it("create: the root record is one INSERT … RETURNING, with no re-read to observe", async () => {
    world = await createWorld();
    const created = await tape(world, "candidate", (invoke) =>
      invoke("author", "create", { data: { id: 7, name: "Cy", age: 20 } })
    );
    const shipped = await tape(world, "shipped", (invoke) =>
      invoke("author", "create", { data: { id: 8, name: "Di", age: 21 } })
    );
    assert.deepEqual(created.statements, ["INSERT"]);
    assert.deepEqual(shipped.statements, ["INSERT"]);
    assert.equal(created.transactions, 0);
    assert.equal(shipped.transactions, 0);
    assert.equal(
      created.outcome,
      'published {"id":7,"name":"Cy","age":20,"avatar":null}'
    );
  });

  it("a relation-bearing root create keeps its statements, so its cuts are NOT eliminated", async () => {
    world = await createWorld();
    const nested = await tape(world, "candidate", (invoke) =>
      invoke("author", "create", {
        data: {
          id: 9,
          name: "Eve",
          age: 30,
          posts: { create: [{ id: 90, title: "P", rank: 1 }] },
        },
      })
    );
    assert.ok(
      nested.statements.length > 1,
      `a relation-bearing create is multi-statement, saw ${JSON.stringify(nested.statements)}`
    );
    assert.equal(nested.transactions, 1);
  });
});
