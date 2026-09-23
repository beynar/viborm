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
 * Repair-2 review (findings C and D). No provider in this environment has a
 * distance or vector tier, so the evidence is the two lowerings — and the two
 * refusal messages — on one PostgreSQL adapter, exactly as the author and the
 * previous review evidenced them. These probes go past the shapes the repair
 * was aimed at: mixed orders, a second distance term, both directions, a
 * cursor, a nested window, every usage label, and the refusal ORDER.
 */

const spot = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point().nullable(),
    here: s.point(),
    rank: s.int().nullable(),
    embedding: s.vector().dimension(3),
    maybeEmbedding: s.vector().dimension(3).nullable(),
    freeVector: s.vector(),
  })
  .map("g4_r2rev_spots");

const spotSchema = { spot };
const paris = { longitude: 2.3522, latitude: 48.8566 };
const lyon = { longitude: 4.8357, latitude: 45.764 };

class LoweringDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `g4-r2rev-${dialect}`);
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // Lowering only; no provider resource is held.
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
  const registry = createModelRegistry(
    spotSchema,
    createSchemaRegistry(spotSchema)
  );
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

function outcome(
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
    shipped: run(() => shipped(args, postgis, pgvector)),
    candidate: run(() => candidate(args, postgis, pgvector)),
  };
}

function refusalMessages(
  args: Record<string, unknown>,
  postgis = true,
  pgvector = false
): { shipped: string; candidate: string } {
  const seen = outcome(args, postgis, pgvector);
  return {
    shipped: seen.shipped.replace(/^error:/, ""),
    candidate: seen.candidate.replace(/^error:/, ""),
  };
}

/** Every `ASC`/`DESC` with its placement, in statement order. */
function placements(statement: string): string[] {
  const index = statement.indexOf("ORDER BY");
  if (index < 0) return [];
  return [
    ...statement
      .slice(index)
      .matchAll(/(?:ASC|DESC)(?:\s+NULLS\s+(?:FIRST|LAST))?/g),
  ].map((match) => match[0].replace(/\s+/g, " "));
}

describe("G4-01 repair 2 review — distance placement under a reversed window (finding C)", () => {
  it("agrees on a distance term mixed with a scalar key, reversed and not", () => {
    for (const sort of ["asc", "desc"] as const)
      for (const take of [undefined, 3, -3])
        for (const second of [
          { id: "asc" },
          { id: "desc" },
          { rank: { sort: "asc", nulls: "first" } },
          { rank: { sort: "desc", nulls: "last" } },
        ]) {
          const args = {
            select: { id: true },
            orderBy: [{ at: { _distance: { to: paris, sort } } }, second],
            ...(take === undefined ? {} : { take }),
          };
          const seen = outcome(args);
          assert.equal(
            seen.candidate.startsWith("error:"),
            seen.shipped.startsWith("error:"),
            `sort ${sort} take ${take}: candidate ${seen.candidate}\nshipped ${seen.shipped}`
          );
          assert.deepEqual(
            placements(seen.candidate),
            placements(seen.shipped),
            `sort ${sort} take ${take} second ${JSON.stringify(second)}`
          );
        }
  });

  it("agrees on two distance terms in one order, reversed and not", () => {
    for (const take of [undefined, -2, 2]) {
      const args = {
        select: { id: true },
        orderBy: [
          { at: { _distance: { to: paris, sort: "asc" } } },
          { here: { _distance: { to: lyon, sort: "desc" } } },
        ],
        ...(take === undefined ? {} : { take }),
      };
      const seen = outcome(args);
      assert.deepEqual(
        placements(seen.candidate),
        placements(seen.shipped),
        `take ${take}`
      );
    }
  });

  it("agrees on a NON-nullable point column's distance placement", () => {
    for (const take of [undefined, -2]) {
      const args = {
        select: { id: true },
        orderBy: { here: { _distance: { to: paris, sort: "asc" } } },
        ...(take === undefined ? {} : { take }),
      };
      const seen = outcome(args);
      assert.deepEqual(placements(seen.candidate), placements(seen.shipped), `take ${take}`);
    }
  });

  it("agrees on a vector distance order, reversed and not", () => {
    for (const sort of ["asc", "desc"] as const)
      for (const take of [undefined, 2, -2]) {
        const args = {
          select: { id: true },
          orderBy: {
            embedding: { _distance: { to: [1, 2, 3], metric: "l2", sort } },
          },
          ...(take === undefined ? {} : { take }),
        };
        const seen = outcome(args, true, true);
        assert.deepEqual(
          placements(seen.candidate),
          placements(seen.shipped),
          `sort ${sort} take ${take}`
        );
      }
  });

  it("agrees on a skip-only distance order (no window, no placement invented)", () => {
    const args = {
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
      skip: 2,
    };
    const seen = outcome(args);
    assert.deepEqual(placements(seen.candidate), placements(seen.shipped));
  });

  it("agrees on what a cursor beside a distance order does", () => {
    const seen = outcome({
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
      take: 2,
      cursor: { id: 1 },
    });
    // Both must refuse, or both must lower the same order.
    assert.equal(
      seen.candidate.startsWith("error:"),
      seen.shipped.startsWith("error:"),
      `candidate ${seen.candidate}\nshipped ${seen.shipped}`
    );
    if (!seen.candidate.startsWith("error:"))
      assert.deepEqual(placements(seen.candidate), placements(seen.shipped));
  });
});

describe("G4-01 repair 2 review — the registered distance refusals (finding D)", () => {
  it("refuses a nullable vector select before the capability, in BOTH provider tiers", () => {
    for (const pgvector of [false, true]) {
      const seen = refusalMessages(
        {
          select: {
            id: true,
            maybeEmbedding: { _distance: { to: [1, 2, 3], metric: "l2" } },
          },
        },
        true,
        pgvector
      );
      assert.equal(seen.candidate, seen.shipped, `pgvector ${pgvector}`);
      assert.match(
        seen.candidate,
        /Vector distance select does not support nullable vector field 'maybeEmbedding'\./
      );
    }
  });

  it("refuses a nullable vector select BEFORE the dimension mismatch", () => {
    // Both faults at once: the order of the checks is itself observable.
    const seen = refusalMessages(
      {
        select: {
          id: true,
          maybeEmbedding: { _distance: { to: [1, 2], metric: "l2" } },
        },
      },
      true,
      true
    );
    assert.equal(seen.candidate, seen.shipped);
    assert.match(seen.candidate, /does not support nullable vector field/);
  });

  it("does NOT refuse a nullable vector in orderBy, on either engine", () => {
    for (const pgvector of [false, true]) {
      const seen = outcome(
        {
          select: { id: true },
          orderBy: {
            maybeEmbedding: {
              _distance: { to: [1, 2, 3], metric: "l2", sort: "asc" },
            },
          },
        },
        true,
        pgvector
      );
      assert.equal(
        seen.candidate.startsWith("error:"),
        seen.shipped.startsWith("error:"),
        `pgvector ${pgvector}: candidate ${seen.candidate}\nshipped ${seen.shipped}`
      );
      if (seen.candidate.startsWith("error:"))
        assert.equal(seen.candidate, seen.shipped, `pgvector ${pgvector}`);
    }
  });

  it("agrees on an undeclared-dimension vector (no mismatch to raise)", () => {
    for (const to of [[1, 2], [1, 2, 3, 4]]) {
      const seen = outcome(
        { select: { id: true, freeVector: { _distance: { to, metric: "l2" } } } },
        true,
        true
      );
      assert.equal(
        seen.candidate.startsWith("error:"),
        seen.shipped.startsWith("error:"),
        `to ${JSON.stringify(to)}: candidate ${seen.candidate}\nshipped ${seen.shipped}`
      );
      if (seen.candidate.startsWith("error:"))
        assert.equal(seen.candidate, seen.shipped, JSON.stringify(to));
    }
  });

  it("agrees on the dimension refusal in every usage that reaches it", () => {
    const seen = refusalMessages(
      {
        select: { id: true },
        orderBy: {
          embedding: { _distance: { to: [1], metric: "cosine", sort: "desc" } },
        },
      },
      true,
      true
    );
    assert.equal(seen.candidate, seen.shipped);
    assert.match(
      seen.candidate,
      /Vector distance orderBy dimension mismatch for 'embedding': expected 3 values, received 1\./
    );
  });

  it("names the point tier identically for orderBy, select, equals and within", () => {
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
            at: {
              within: { bounds: { south: 45, west: 2, north: 49, east: 5 } },
            },
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
      const seen = outcome(args, false);
      assert.equal(
        seen.candidate.startsWith("error:"),
        seen.shipped.startsWith("error:"),
        `${label}: candidate ${seen.candidate}\nshipped ${seen.shipped}`
      );
      if (seen.candidate.startsWith("error:"))
        assert.equal(seen.candidate, seen.shipped, label);
    }
  });

  it("agrees on the distance-tier refusal when the point tier exists but distance does not", () => {
    // PostGIS present: the distance tier exists, so this must NOT refuse.
    const seen = outcome({
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
    });
    assert.equal(
      seen.candidate.startsWith("error:"),
      seen.shipped.startsWith("error:"),
      `candidate ${seen.candidate}\nshipped ${seen.shipped}`
    );
  });
});
