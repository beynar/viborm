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
 * comparison is between the SHIPPED lowering and the CANDIDATE lowering on the
 * same PostgreSQL adapter: which columns each projects, and under what names.
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

function shippedStatement(
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

describe("G4-01 follow-up — distance projection against the shipped lowering", () => {
  it("projects the distance and NOT the point column, exactly as the shipped engine does", () => {
    const args = {
      select: { id: true, at: { _distance: { to: paris } } },
    };
    const shipped = shippedStatement(args);
    const mine = candidate(args);
    // The shipped engine hides the distance behind a private alias and never
    // projects the point column beside it.
    assert.match(shipped, /AS "0viborm_distance"/);
    assert.doesNotMatch(shipped, /AS "at"/);
    assert.match(mine.statement, /AS "_distance"/);
    assert.doesNotMatch(mine.statement, /AS "at"/);
    assert.deepEqual(mine.fields, ["id", "_distance"]);
  });

  it("keeps the point column when it is selected in its own right", () => {
    const args = {
      select: { id: true, at: true, fixed: { _distance: { to: paris } } },
    };
    const shipped = shippedStatement(args);
    const mine = candidate(args);
    assert.match(shipped, /AS "at"/);
    assert.match(shipped, /AS "0viborm_distance"/);
    assert.match(mine.statement, /AS "at"/);
    assert.match(mine.statement, /AS "_distance"/);
    assert.deepEqual(mine.fields, ["id", "at", "_distance"]);
  });

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

  it("refuses a vector distance selection with the shipped refusal", () => {
    const args = {
      select: {
        id: true,
        embedding: { _distance: { to: [1, 2, 3], metric: "cosine" } },
      },
    };
    let shippedMessage = "";
    let candidateMessage = "";
    try {
      shippedStatement(args);
    } catch (error) {
      shippedMessage = (error as Error).message;
    }
    try {
      candidate(args);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.notEqual(shippedMessage, "", "the shipped engine must refuse");
    assert.equal(
      candidateMessage,
      shippedMessage,
      `vector select refusal\n  candidate ${candidateMessage}\n  shipped   ${shippedMessage}`
    );
  });

  it("refuses a vector distance ORDER with the shipped refusal", () => {
    const args = {
      select: { id: true },
      orderBy: {
        embedding: { _distance: { to: [1, 2, 3], metric: "cosine", sort: "asc" } },
      },
    };
    let shippedMessage = "";
    let candidateMessage = "";
    try {
      shippedStatement(args);
    } catch (error) {
      shippedMessage = (error as Error).message;
    }
    try {
      candidate(args);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.notEqual(shippedMessage, "", "the shipped engine must refuse");
    assert.equal(
      candidateMessage,
      shippedMessage,
      `vector orderBy refusal\n  candidate ${candidateMessage}\n  shipped   ${shippedMessage}`
    );
  });

  it("keeps the shipped refusal for a nullable vector distance selection", () => {
    const args = {
      select: {
        id: true,
        maybeEmbedding: { _distance: { to: [1, 2, 3], metric: "cosine" } },
      },
    };
    let shippedMessage = "";
    let candidateMessage = "";
    try {
      shippedStatement(args);
    } catch (error) {
      shippedMessage = (error as Error).message;
    }
    try {
      candidate(args);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.match(
      shippedMessage,
      /Vector distance select does not support nullable vector field/
    );
    assert.equal(
      candidateMessage,
      shippedMessage,
      `nullable vector refusal\n  candidate ${candidateMessage}\n  shipped   ${shippedMessage}`
    );
  });

  it("refuses a point distance ORDER on a provider with no distance tier, as the shipped engine words it", () => {
    const args = {
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
    };
    let shippedMessage = "";
    let candidateMessage = "";
    try {
      shippedStatement(args, false);
    } catch (error) {
      shippedMessage = (error as Error).message;
    }
    try {
      candidate(args, false);
    } catch (error) {
      candidateMessage = (error as Error).message;
    }
    assert.notEqual(shippedMessage, "", "the shipped engine must refuse");
    assert.equal(
      candidateMessage,
      shippedMessage,
      `point orderBy refusal\n  candidate ${candidateMessage}\n  shipped   ${shippedMessage}`
    );
  });

  it("reverses a point distance ORDER the way the shipped engine reverses it", () => {
    const args = {
      select: { id: true },
      orderBy: { at: { _distance: { to: paris, sort: "asc" } } },
      take: -2,
    };
    const shipped = shippedStatement(args);
    const mine = candidate(args);
    const placement = (statement: string) =>
      /(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?/g.exec(
        statement.slice(statement.indexOf("ORDER BY"))
      )?.[0];
    assert.equal(
      placement(mine.statement),
      placement(shipped),
      `reversed distance order\n  candidate ${placement(mine.statement)}\n  shipped   ${placement(shipped)}`
    );
  });
});
