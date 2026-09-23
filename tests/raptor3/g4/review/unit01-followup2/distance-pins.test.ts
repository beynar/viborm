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

/**
 * Non-vacuity guard for the distance parity probes: an agreement assertion
 * passes trivially if BOTH engines refuse at admission, so these pin the
 * absolute placement and the absolute refusal sentence.
 */
const spot = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point().nullable(),
    embedding: s.vector().dimension(3),
  })
  .map("g4_r2rev_pins");

const spotSchema = { spot };
const paris = { longitude: 2.3522, latitude: 48.8566 };

class PinDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `g4-r2rev-pin-${dialect}`);
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // Lowering only.
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

function both(
  args: Record<string, unknown>,
  postgis = true,
  pgvector = false
): { shipped: string; candidate: string } {
  const run = (build: () => string): string => {
    try {
      return `ok:${build()}`;
    } catch (error) {
      return `error:${(error as Error).message}`;
    }
  };
  return {
    shipped: run(() => {
      const registry = createModelRegistry(
        spotSchema,
        createSchemaRegistry(spotSchema)
      );
      return new QueryEngine(
        new PinDriver(postgres(postgis, pgvector), "postgresql"),
        registry
      )
        .build(spot, "findMany", args)
        .toStatement("$n");
    }),
    candidate: run(() =>
      new Queries(new EngineSchema(spotSchema), postgres(postgis, pgvector))
        .select(spot, args as never)
        .sql.toStatement("$n")
    ),
  };
}

function placements(statement: string): string[] {
  const index = statement.indexOf("ORDER BY");
  if (index < 0) return [];
  return [
    ...statement
      .slice(index)
      .matchAll(/(?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?/g),
  ].map((match) => match[0].replace(/\s+/g, " "));
}

describe("G4-01 repair 2 review — absolute distance pins", () => {
  it("pins a reversed mixed order: the expression keeps NULLS LAST, the scalar flips bare", () => {
    const seen = both({
      select: { id: true },
      orderBy: [{ at: { _distance: { to: paris, sort: "asc" } } }, { id: "asc" }],
      take: -3,
    });
    assert.ok(seen.shipped.startsWith("ok:"), seen.shipped);
    assert.ok(seen.candidate.startsWith("ok:"), seen.candidate);
    assert.deepEqual(placements(seen.shipped), ["DESC NULLS LAST", "DESC"]);
    assert.deepEqual(placements(seen.candidate), ["DESC NULLS LAST", "DESC"]);
  });

  it("pins the unreversed mixed order", () => {
    const seen = both({
      select: { id: true },
      orderBy: [{ at: { _distance: { to: paris, sort: "asc" } } }, { id: "asc" }],
      take: 3,
    });
    assert.deepEqual(placements(seen.shipped), ["ASC NULLS LAST", "ASC"]);
    assert.deepEqual(placements(seen.candidate), ["ASC NULLS LAST", "ASC"]);
  });

  it("pins the no-point-tier sentence for every usage that reaches it", () => {
    const sentence =
      "GeoPoint requires a provider with its physical point tier enabled.";
    const cases: [string, Record<string, unknown>][] = [
      [
        "orderBy",
        {
          select: { id: true },
          orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
        },
      ],
      ["select", { select: { id: true, at: { _distance: { to: paris } } } }],
      ["equals", { select: { id: true }, where: { at: { equals: paris } } }],
      [
        "within",
        {
          select: { id: true },
          where: {
            at: { within: { bounds: { south: 45, west: 2, north: 49, east: 5 } } },
          },
        },
      ],
      ["projection", { select: { id: true, at: true } }],
      [
        "filter distance",
        {
          select: { id: true },
          where: { at: { distance: { to: paris, lt: 1000 } } },
        },
      ],
    ];
    for (const [label, args] of cases) {
      const seen = both(args, false);
      assert.ok(seen.shipped.includes(sentence), `${label} shipped ${seen.shipped}`);
      assert.ok(
        seen.candidate.includes(sentence),
        `${label} candidate ${seen.candidate}`
      );
    }
  });

  it("pins the two pgvector sentences", () => {
    const order = both({
      select: { id: true },
      orderBy: {
        embedding: { _distance: { to: [1, 2, 3], metric: "l2", sort: "asc" } },
      },
    });
    assert.ok(
      order.shipped.includes(
        "vector ordering requires a pgvector-enabled PostgreSQL driver"
      ),
      order.shipped
    );
    assert.equal(order.candidate, order.shipped);

    const select = both({
      select: { id: true, embedding: { _distance: { to: [1, 2, 3], metric: "l2" } } },
    });
    assert.ok(
      select.shipped.includes(
        "vector distance select requires a pgvector-enabled PostgreSQL driver"
      ),
      select.shipped
    );
    assert.equal(select.candidate, select.shipped);
  });
});
