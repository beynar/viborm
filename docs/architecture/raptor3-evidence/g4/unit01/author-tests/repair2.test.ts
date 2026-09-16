import assert from "node:assert/strict";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, it } from "vitest";
import { differential, seedPost, type World } from "./world";

/**
 * Repair-2 witnesses (review follow-up findings B, C and D). Every observable
 * choice is pinned DIFFERENTIALLY against the shipped engine: over the same
 * SQLite data where a provider can answer, and — where no provider here has
 * the tier — between the two lowerings on one PostgreSQL adapter.
 */

function seedCategories(world: World): void {
  for (const [id, category] of [
    [1, "alpha"],
    [2, "beta"],
    [3, "alpha"],
  ] as [number, string][])
    seedPost(world, { id, category, rank: id });
}

describe("G4-01 repair 2 — the empty logical arm (finding B, Q-W01)", () => {
  // The six admitted inputs the follow-up review answered differently, plus
  // the six it found already at parity, which must stay there.
  const FORMS: [string, Record<string, unknown>][] = [
    ["NOT object empty", { NOT: {} }],
    ["NOT array with one empty arm", { NOT: [{}] }],
    ["NOT empty arm beside a real arm", { NOT: [{}, { category: "beta" }] }],
    ["NOT real arm beside an empty arm", { NOT: [{ category: "beta" }, {}] }],
    ["OR with an empty arm", { OR: [{}, { category: "beta" }] }],
    ["OR of nothing but an empty arm", { OR: [{}] }],
    ["NOT array empty", { NOT: [] }],
    ["AND array empty", { AND: [] }],
    ["OR array empty", { OR: [] }],
    ["AND with an empty arm", { AND: [{}, { category: "beta" }] }],
    ["NOT around an empty NOT", { NOT: [{ NOT: [{}] }] }],
    ["NOT around an empty AND", { NOT: [{ AND: [{}] }] }],
    ["empty where", {}],
  ];

  for (const [label, where] of FORMS)
    it(`answers ${label} the way the shipped engine does`, async () => {
      const { shipped, candidate } = await differential(
        seedCategories,
        "post",
        "findMany",
        { where, orderBy: { id: "asc" }, select: { id: true } }
      );
      assert.deepEqual(candidate, shipped, JSON.stringify(where));
    });

  it("reads an empty arm the same way in where and in having", async () => {
    for (const having of [
      { NOT: {} },
      { NOT: [{}] },
      { NOT: [{}, { category: { equals: "alpha" } }] },
      { AND: [{}] },
      { OR: [{}, { category: { equals: "beta" } }] },
    ]) {
      const { shipped, candidate } = await differential(
        seedCategories,
        "post",
        "groupBy",
        {
          by: ["category"],
          having,
          orderBy: { category: "asc" },
          _count: { _all: true },
        }
      );
      assert.deepEqual(candidate, shipped, JSON.stringify(having));
    }
  });

  it("keeps a non-empty arm's meaning, so the rule removes nothing real", async () => {
    for (const where of [
      { NOT: [{ category: "alpha" }, { id: 2 }] },
      { OR: [{ category: "alpha" }, { id: 2 }] },
      { AND: [{ category: "alpha" }, { id: 3 }] },
      { NOT: { category: "alpha" } },
    ]) {
      const { shipped, candidate } = await differential(
        seedCategories,
        "post",
        "findMany",
        { where, orderBy: { id: "asc" }, select: { id: true } }
      );
      assert.deepEqual(candidate, shipped, JSON.stringify(where));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Distance lowering: no provider here has a distance or vector tier, so the   */
/* evidence is the two lowerings on one adapter.                              */
/* -------------------------------------------------------------------------- */

const spot = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point().nullable(),
    rank: s.int().nullable(),
    embedding: s.vector().dimension(3),
    maybeEmbedding: s.vector().dimension(3).nullable(),
  })
  .map("g4_r2_spots");
const spotSchema = { spot };
const paris = { longitude: 2.3522, latitude: 48.8566 };

class LoweringDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `g4-r2-${dialect}`);
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // A lowering-only comparison holds no provider resource.
  }
  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  protected async transaction<T>(
    _client: null,
    fn: (client: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

function postgres(postgis: boolean, pgvector = false): PostgresAdapter {
  const adapter = new PostgresAdapter("public", postgis);
  adapter.capabilities.supportsVector = pgvector;
  return adapter;
}

function shipped(
  args: Record<string, unknown>,
  postgis = true,
  pgvector = false
): string {
  const registry = createModelRegistry(spotSchema, createSchemaRegistry(spotSchema));
  const engine = new QueryEngine(
    new LoweringDriver(postgres(postgis, pgvector), "postgresql"),
    registry
  );
  return engine.build(spot, "findMany", args).toStatement("$n");
}

function candidate(
  args: Record<string, unknown>,
  postgis = true,
  pgvector = false
): string {
  const queries = new Queries(
    new EngineSchema(spotSchema),
    postgres(postgis, pgvector)
  );
  return queries.select(spot, args as never).sql.toStatement("$n");
}

function refusals(
  args: Record<string, unknown>,
  postgis = true,
  pgvector = false
): { shipped: string; candidate: string } {
  const catch_ = (run: () => string): string => {
    try {
      run();
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  return {
    shipped: catch_(() => shipped(args, postgis, pgvector)),
    candidate: catch_(() => candidate(args, postgis, pgvector)),
  };
}

/** Every `ASC`/`DESC` with its placement, in the order the statement sorts. */
function placements(statement: string): string[] {
  const tail = statement.slice(statement.indexOf("ORDER BY"));
  return [...tail.matchAll(/(?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?/g)].map(
    (match) => match[0].replace(/\s+/g, " ")
  );
}

describe("G4-01 repair 2 — a reversed window and the distance placement (finding C, Q-O02, Q-P01)", () => {
  it("keeps a point distance NULLS LAST when a negative take reverses the window", () => {
    const args = {
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
      take: -2,
    };
    assert.deepEqual(placements(candidate(args)), ["DESC NULLS LAST"]);
    assert.deepEqual(placements(candidate(args)), placements(shipped(args)));
  });

  it("keeps the same placement in both directions, reversed or not", () => {
    for (const sort of ["asc", "desc"] as const)
      for (const take of [undefined, 2, -2])
        for (const skip of [undefined, 1]) {
          const args = {
            select: { id: true },
            orderBy: { at: { _distance: { to: paris, sort } } },
            ...(take === undefined ? {} : { take }),
            ...(skip === undefined ? {} : { skip }),
          };
          assert.deepEqual(
            placements(candidate(args)),
            placements(shipped(args)),
            `sort ${sort} take ${take} skip ${skip}`
          );
        }
  });

  it("still reverses a placement the caller spelled", () => {
    // The falsifier for the fix above: an expression's own placement is fixed,
    // a caller's is not. If `expressionNulls` leaked onto a scalar key this
    // pair would stop matching the shipped reversal.
    for (const nulls of ["first", "last"] as const) {
      const args = {
        select: { id: true },
        orderBy: { rank: { sort: "asc", nulls } },
        take: -2,
      };
      assert.deepEqual(
        placements(candidate(args)),
        placements(shipped(args)),
        `nulls ${nulls}`
      );
      assert.equal(
        placements(candidate(args))[0],
        nulls === "first" ? "DESC NULLS LAST" : "DESC NULLS FIRST"
      );
    }
  });
});

describe("G4-01 repair 2 — the registered distance refusals (finding D, Q-W07, RF)", () => {
  it("refuses a nullable vector distance selection before consulting the provider", () => {
    const args = {
      select: {
        id: true,
        maybeEmbedding: { _distance: { to: [1, 2, 3], metric: "cosine" } },
      },
    };
    // Refused on a provider WITH pgvector and on one without: it is a property
    // of the field, not of the tier.
    for (const pgvector of [false, true]) {
      const seen = refusals(args, true, pgvector);
      assert.match(
        seen.shipped,
        /Vector distance select does not support nullable vector field 'maybeEmbedding'\./
      );
      assert.equal(seen.candidate, seen.shipped, `pgvector ${pgvector}`);
    }
  });

  it("names pgvector in the vector select and vector ordering refusals", () => {
    const select = refusals({
      select: {
        id: true,
        embedding: { _distance: { to: [1, 2, 3], metric: "cosine" } },
      },
    });
    assert.match(
      select.shipped,
      /vector distance select requires a pgvector-enabled PostgreSQL driver/
    );
    assert.equal(select.candidate, select.shipped);

    const order = refusals({
      select: { id: true },
      orderBy: {
        embedding: { _distance: { to: [1, 2, 3], metric: "cosine", sort: "asc" } },
      },
    });
    assert.match(
      order.shipped,
      /vector ordering requires a pgvector-enabled PostgreSQL driver/
    );
    assert.equal(order.candidate, order.shipped);
  });

  it("refuses a vector distance whose operand is not the declared dimension", () => {
    for (const usage of ["select", "orderBy"] as const) {
      const distance = { to: [1, 2], metric: "cosine" };
      const args =
        usage === "select"
          ? { select: { id: true, embedding: { _distance: distance } } }
          : {
              select: { id: true },
              orderBy: { embedding: { _distance: { ...distance, sort: "asc" } } },
            };
      const seen = refusals(args, true, true);
      assert.match(
        seen.shipped,
        /dimension mismatch for 'embedding': expected 3 values, received 2\./
      );
      assert.equal(seen.candidate, seen.shipped, usage);
    }
  });

  it("names the physical point tier when the provider has none", () => {
    const order = refusals(
      {
        select: { id: true },
        orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
      },
      false
    );
    assert.match(
      order.shipped,
      /GeoPoint requires a provider with its physical point tier enabled\./
    );
    assert.equal(order.candidate, order.shipped);

    const equality = refusals(
      { select: { id: true }, where: { at: { equals: paris } } },
      false
    );
    assert.match(
      equality.shipped,
      /GeoPoint requires a provider with its physical point tier enabled\./
    );
    assert.equal(equality.candidate, equality.shipped);
  });
});
