/**
 * Bound views (Permissions plan K6, §4.6 as amended by spike F5 in §11.2) on
 * in-memory SQLite: the witnesses W-AS1..W-AS7 of
 * `extension-bound-views-behavior.ts`, which PGlite and D1 run beside
 * (`tests/providers/local/pglite-bound-views.test.ts`,
 * `tests/providers/workers/d1-bound-views.test.ts`), and plan §8's cost of
 * `$as` against one `$extends` of a 50-model chain, which reads no database.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { arg, bound, createClient, parts, s } from "@src/index";
import { v } from "@src/validation";
import { runBoundViewsBehavior } from "@tests/contracts/public-client/extension-bound-views-behavior";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

runBoundViewsBehavior({
  name: "SQLite3",
  createDriver: createInMemorySQLite3Driver,
  prepare: async (client) => {
    await syncLiveSchema(client);
  },
});

/** `$as`, declared apart: inline, the factory's contextual type makes `Self` void. */
type RequestMethods = {
  $as<Self>(this: Self, name: string): Self;
};

describe("bound views: cost", () => {
  test("plan §8: $as costs at most a quarter of one $extends of the same 50-model chain, factories lazy", () => {
    let factoryRuns = 0;
    // Plan §8's chain: 50 models, each with a row predicate reading the
    // bound actor and a model factory, beside the `$as` client factory.
    const models = Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `m${index}`,
        s.model({ id: s.string().id(), ownerId: s.string() }),
      ])
    );
    const wide = createClient({
      schema: models,
      driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
    });
    const owned = { ownerId: arg("actor") };
    const typed = parts<typeof wide>();
    const definition = typed.extension(
      "wide",
      typed.args({ actor: bound(v.string()).required() }),
      // The 50 entries are computed: a rule read from the schema.
      typed.rule(() =>
        Object.fromEntries(
          Object.keys(models).map((name) => [
            name,
            { root: owned, related: owned },
          ])
        )
      ),
      typed.methods((scope) => {
        factoryRuns += 1;
        const methods: RequestMethods = {
          $as: (actor) => scope.$bind({ actor }) as never,
        };
        return {
          ...methods,
          ...Object.fromEntries(
            Object.keys(models).map((name, index) => [
              name,
              () => {
                factoryRuns += 1;
                return { touch: () => index };
              },
            ])
          ),
        };
      })
    );
    const extendOnce = () =>
      Reflect.apply(Reflect.get(wide, "$extends"), wide, [definition]) as {
        $as(actor: string): object;
      };
    const median = (run: () => unknown) => {
      const rounds: number[] = [];
      for (let round = 0; round < 7; round++) {
        const start = performance.now();
        for (let i = 0; i < 200; i++) run();
        rounds.push((performance.now() - start) / 200);
      }
      return rounds.sort((a, b) => a - b)[3]!;
    };
    const chained = extendOnce();
    factoryRuns = 0;
    chained.$as("u1");
    expect(factoryRuns).toBe(0);
    const extendCost = median(extendOnce);
    const asCost = median(() => chained.$as("u1"));
    expect(asCost).toBeLessThanOrEqual(extendCost / 4);
  });
});
