/**
 * G4 performance pass, item 3 — a statement's aliases are a fact of that
 * statement, not of the engine's history.
 *
 * `Queries` used to mint table aliases from an instance-lifetime counter, and
 * `commands/index.ts` keeps ONE engine-lifetime `Queries` for the prepared
 * read, so the same `findUnique` published `q0`, then `q1`, … `q10000`: its
 * statement TEXT was unique per call. The cutover protocol recorded that as a
 * measurement obstacle (`g4/cutover/protocol.md` §7.2,
 * `receipts-stage2/prepared-sql-alias-drift.json`), and any transport that
 * caches by statement text — PostgreSQL named prepared statements, `mysql2`'s
 * prepare cache, D1/PlanetScale/Neon — would miss every time while growing a
 * per-connection cache keyed on a counter that never repeats.
 *
 * `Queries.rootAlias` is the fix: the six owners that assemble a COMPLETE
 * statement open its alias scope, and nothing else does. These cells pin both
 * halves of that rule — the same query always emits the same text, and the
 * subqueries INSIDE one statement keep sharing its scope, which is what makes
 * the aliases unique where it matters.
 *
 * Not registered in `scripts/raptor3-manifest.mjs` by this unit (the pass edits
 * no manifest); the count is reported to the integrator for `g4-unit02-author`.
 */

import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterEach, describe, it } from "vitest";
import { createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

/** The statement texts one prepared operation publishes, in order. */
async function preparedSql(
  engine: ReturnType<typeof createCommandEngine>,
  model: string,
  operation: string,
  args: unknown
): Promise<string[]> {
  const prepared = await engine.prepareBatch(
    model,
    operation as Parameters<typeof engine.prepareBatch>[1],
    args
  );
  assert.ok(prepared, `${model}.${operation} did not package statically`);
  return prepared.queries.map((query) => query.sql);
}

describe("G4 perf item 3 — statement-scoped SQL aliases", () => {
  it("publishes byte-identical SQL for two successive identical findUnique calls", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    const args = { where: { id: 1 }, select: { id: true, name: true } };
    const first = await preparedSql(engine, "author", "findUnique", args);
    const second = await preparedSql(engine, "author", "findUnique", args);
    assert.deepEqual(second, first);
    assert.equal(first.length, 1);
    // Every statement starts at `q0`, so the text is a function of the query.
    assert.match(first[0]!, /"q0"/);
    assert.doesNotMatch(first[0]!, /"q1"/);

    // …and it stays that text after twenty more of the same call, and after
    // OTHER operations have minted aliases on the same engine in between.
    for (let index = 0; index < 20; index++) {
      assert.deepEqual(
        await preparedSql(engine, "author", "findUnique", args),
        first
      );
      assert.deepEqual(
        await preparedSql(engine, "post", "findMany", {
          where: { rank: { gt: 0 } },
          select: { id: true },
        }),
        await preparedSql(engine, "post", "findMany", {
          where: { rank: { gt: 0 } },
          select: { id: true },
        })
      );
    }
    assert.deepEqual(
      await preparedSql(engine, "author", "findUnique", args),
      first
    );
  });

  it("keeps one statement's nested scopes inside that statement's alias scope", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    // A nested to-many projection is a correlated subquery of the SAME
    // statement: it must continue the statement's counter, never restart it,
    // or the subquery would address the root's own alias.
    const [nested] = await preparedSql(engine, "author", "findMany", {
      select: { id: true, posts: { select: { id: true, title: true } } },
    });
    assert.ok(nested);
    const declared = [...nested.matchAll(/AS "(q\d+)"/g)].map(
      (match) => match[1]!
    );
    assert.deepEqual(
      [...new Set(declared)].length,
      declared.length,
      `one statement declared an alias twice: ${nested}`
    );
    assert(
      declared.length > 1,
      "the nested projection declared no second alias"
    );
    // One contiguous run from `q0`: the subquery continued the statement's own
    // scope instead of opening a second one that would collide with the root.
    const used = [...new Set([...nested.matchAll(/"(q\d+)"/g)].map((m) => m[1]!))]
      .map((alias) => Number(alias.slice(1)))
      .sort((left, right) => left - right);
    assert.deepEqual(
      used,
      used.map((_, index) => index),
      `one statement's aliases are not one run from q0: ${nested}`
    );

    // The same statement, again: still byte-identical.
    const [again] = await preparedSql(engine, "author", "findMany", {
      select: { id: true, posts: { select: { id: true, title: true } } },
    });
    assert.equal(again, nested);
  });

  it("gives every statement of one multi-statement operation its own scope", async () => {
    world = await createWorld();
    const engine = createCommandEngine({
      schema: worldSchema,
      driver: world.driver,
    });
    // A bulk delete with a limit is one mutation statement whose predicate
    // carries a capped subquery: the fragment and the mutation share ONE scope,
    // so the capped select's alias is the statement's own first alias.
    const [capped] = await preparedSql(engine, "post", "deleteMany", {
      where: { rank: { gt: 0 } },
      limit: 1,
    });
    assert.ok(capped);
    assert.match(capped, /"q0"/);
    const repeated = await preparedSql(engine, "post", "deleteMany", {
      where: { rank: { gt: 0 } },
      limit: 1,
    });
    assert.equal(repeated[0], capped);
  });
});
