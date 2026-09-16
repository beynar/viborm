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
 * Finding 3 follow-up. No distance-tier provider can execute here, so the
 * comparison is between the two seams that reach the engine on the same
 * PostgreSQL adapter: `QueryEngine.build` through the route it provisions
 * ({@link routedStatement}, the shipped lowering before C-01) and this
 * engine's query layer directly ({@link candidate}) — which columns each
 * projects, and under what names.
 */
const spot = s
  .model({
    id: s.int().id(),
    name: s.string(),
    at: s.point().nullable(),
    fixed: s.point(),
    embedding: s.vector().dimension(3),
    maybeEmbedding: s.vector().dimension(3).nullable(),
  })
  .map("fu_spots");
const models = { spot };

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `fu-${dialect}`);
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // No provider resource is held by a lowering-only comparison.
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

function routedStatement(
  args: Record<string, unknown>,
  postgis = true
): string {
  const registry = createModelRegistry(models, createSchemaRegistry(models));
  const engine = new QueryEngine(
    new MockDriver(new PostgresAdapter("public", postgis), "postgresql"),
    registry
  );
  return engine.build(spot, "findMany", args).toStatement("$n");
}

function candidate(args: Record<string, unknown>, postgis = true) {
  const queries = new Queries(
    new EngineSchema(models),
    new PostgresAdapter("public", postgis)
  );
  const query = queries.select(spot, args as never);
  return {
    statement: query.sql.toStatement("$n"),
    fields: Object.keys(
      (query.shape as { fields: Record<string, unknown> }).fields
    ),
    query,
    queries,
  };
}

const paris = { longitude: 2.3522, latitude: 48.8566 };

describe("G4-01 follow-up — distance projection across the routed seam and the query layer", () => {
  it("decodes a NOT NULL point distance as required and a nullable one as optional", () => {
    const required = candidate({
      select: { id: true, fixed: { _distance: { to: paris } } },
    });
    assert.deepEqual(
      required.queries.decodeQuery(required.query, [
        { id: 1, _distance: 12.5 },
      ]),
      [{ id: 1, _distance: 12.5 }]
    );
    assert.throws(() =>
      required.queries.decodeQuery(required.query, [{ id: 1, _distance: null }])
    );
    const optional = candidate({
      select: { id: true, at: { _distance: { to: paris } } },
    });
    assert.deepEqual(
      optional.queries.decodeQuery(optional.query, [{ id: 1, _distance: null }]),
      [{ id: 1, _distance: null }]
    );
  });

  it("refuses a second distance selection and accepts a distance beside a relation count", () => {
    assert.throws(
      () =>
        candidate({
          select: {
            at: { _distance: { to: paris } },
            fixed: { _distance: { to: paris } },
          },
        }),
      /Distance select supports only one _distance field per select\./
    );
  });

  it("refuses a vector distance selection with one refusal on both seams", () => {
    const args = {
      select: {
        id: true,
        embedding: { _distance: { to: [1, 2, 3], metric: "cosine" } },
      },
    };
    let routedMessage = "";
    let candidateMessage = "";
    try {
      routedStatement(args);
    } catch (error) {
      routedMessage = (error as Error).message;
    }
    try {
      candidate(args);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.notEqual(routedMessage, "", "the routed seam must refuse");
    assert.equal(
      candidateMessage,
      routedMessage,
      `vector select refusal\n  candidate ${candidateMessage}\n  routed    ${routedMessage}`
    );
  });

  it("refuses a vector distance ORDER with one refusal on both seams", () => {
    const args = {
      select: { id: true },
      orderBy: {
        embedding: { _distance: { to: [1, 2, 3], metric: "cosine", sort: "asc" } },
      },
    };
    let routedMessage = "";
    let candidateMessage = "";
    try {
      routedStatement(args);
    } catch (error) {
      routedMessage = (error as Error).message;
    }
    try {
      candidate(args);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.notEqual(routedMessage, "", "the routed seam must refuse");
    assert.equal(
      candidateMessage,
      routedMessage,
      `vector orderBy refusal\n  candidate ${candidateMessage}\n  routed    ${routedMessage}`
    );
  });

  it("keeps one refusal on both seams for a nullable vector distance selection", () => {
    const args = {
      select: {
        id: true,
        maybeEmbedding: { _distance: { to: [1, 2, 3], metric: "cosine" } },
      },
    };
    let routedMessage = "";
    let candidateMessage = "";
    try {
      routedStatement(args);
    } catch (error) {
      routedMessage = (error as Error).message;
    }
    try {
      candidate(args);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.match(
      routedMessage,
      /Vector distance select does not support nullable vector field/
    );
    assert.equal(
      candidateMessage,
      routedMessage,
      `nullable vector refusal\n  candidate ${candidateMessage}\n  routed    ${routedMessage}`
    );
  });

  it("refuses a point distance ORDER on a provider with no distance tier, worded identically on both seams", () => {
    const args = {
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
    };
    let routedMessage = "";
    let candidateMessage = "";
    try {
      routedStatement(args, false);
    } catch (error) {
      routedMessage = (error as Error).message;
    }
    try {
      candidate(args, false);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.notEqual(routedMessage, "", "the routed seam must refuse");
    assert.equal(
      candidateMessage,
      routedMessage,
      `point orderBy refusal\n  candidate ${candidateMessage}\n  routed    ${routedMessage}`
    );
  });

  it("reverses a point distance ORDER identically on both seams", () => {
    const args = {
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
      take: -2,
    };
    const routed = routedStatement(args);
    const mine = candidate(args);
    const placement = (statement: string) =>
      /(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?/g.exec(
        statement.slice(statement.indexOf("ORDER BY"))
      )?.[0];
    assert.equal(
      placement(mine.statement),
      placement(routed),
      `reversed distance order\n  candidate ${placement(mine.statement)}\n  routed    ${placement(routed)}`
    );
  });
});
