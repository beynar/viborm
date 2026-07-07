import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { FeatureNotSupportedError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { type Sql, sql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(
    adapter: DatabaseAdapter,
    dialect: Dialect = "postgresql",
    driverName = `mock-${dialect}`
  ) {
    super(dialect, driverName);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {}

  protected async execute<T>(
    _client: null,
    _statement: string,
    _params: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    _client: null,
    _statement: string,
    _params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (tx: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const vectorOrderModels = (() => {
  const collection = s
    .model({
      id: s.string().id(),
      name: s.string(),
      centroid: s.vector().dimension(3),
      docs: s.oneToMany(() => doc),
    })
    .map("vector_order_collections");

  const doc = s
    .model({
      id: s.string().id(),
      title: s.string(),
      collectionId: s.string(),
      collection: s
        .manyToOne(() => collection)
        .fields("collectionId")
        .references("id"),
      embedding: s.vector().dimension(3),
      secondaryEmbedding: s.vector().dimension(3),
    })
    .map("vector_order_docs");

  return { collection, doc };
})();

const vectorOrderSchema = vectorOrderModels;

hydrateSchemaNames(vectorOrderSchema);

function createEngine(adapter: DatabaseAdapter, dialect: Dialect = "postgresql") {
  const schemaRegistry = createSchemaRegistry(vectorOrderSchema);
  const registry = createModelRegistry(vectorOrderSchema, schemaRegistry);
  return new QueryEngine(new MockDriver(adapter, dialect), registry);
}

describe("Vector distance orderBy SQL generation", () => {
  test("delegates l2 distance SQL to the adapter vector namespace", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    let literalValues: number[] | undefined;
    let l2Column: Sql | undefined;
    let l2Vector: Sql | undefined;
    adapter.vector = {
      literal: (values) => {
        literalValues = values;
        return sql.raw`VECTOR_LITERAL`;
      },
      l2: (column, vector) => {
        l2Column = column;
        l2Vector = vector;
        return sql.raw`VECTOR_DISTANCE`;
      },
      cosine: () => sql.raw`UNUSED_COSINE_DISTANCE`,
    };

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      orderBy: {
        embedding: {
          _distance: {
            to: [1, 2, 3],
            metric: "l2",
          },
        },
      },
    });

    expect(query.toStatement("$n")).toContain(
      "ORDER BY VECTOR_DISTANCE ASC"
    );
    expect(literalValues).toEqual([1, 2, 3]);
    expect(l2Column?.toStatement("$n")).toBe('"t0"."embedding"');
    expect(l2Vector?.toStatement("$n")).toBe("VECTOR_LITERAL");
  });

  test("uses the cosine adapter method for cosine distance order", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;
    let cosineCalled = false;
    adapter.vector = {
      literal: () => sql.raw`VECTOR_LITERAL`,
      l2: () => sql.raw`UNUSED_L2_DISTANCE`,
      cosine: () => {
        cosineCalled = true;
        return sql.raw`COSINE_DISTANCE`;
      },
    };

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      orderBy: {
        embedding: {
          _distance: {
            to: [1, 2, 3],
            metric: "cosine",
          },
        },
      },
    });

    expect(query.toStatement("$n")).toContain("ORDER BY COSINE_DISTANCE ASC");
    expect(cosineCalled).toBe(true);
  });

  test("parameterizes Postgres vector literals", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      orderBy: {
        embedding: {
          _distance: {
            to: [1, 2, 3],
            metric: "cosine",
          },
        },
      },
    });

    expect(query.toStatement("$n")).toContain(
      'ORDER BY "t0"."embedding" <=> $1::vector ASC'
    );
    expect(query.values).toEqual(["[1,2,3]"]);
  });

  test("delegates l2 distance select SQL to the adapter vector namespace", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    let literalValues: number[] | undefined;
    let l2Column: Sql | undefined;
    let l2Vector: Sql | undefined;
    adapter.vector = {
      literal: (values) => {
        literalValues = values;
        return sql.raw`VECTOR_LITERAL`;
      },
      l2: (column, vector) => {
        l2Column = column;
        l2Vector = vector;
        return sql.raw`VECTOR_DISTANCE`;
      },
      cosine: () => sql.raw`UNUSED_COSINE_DISTANCE`,
    };

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      select: {
        embedding: {
          _distance: {
            to: [1, 2, 3],
            metric: "l2",
          },
        },
      },
    });

    expect(query.toStatement("$n")).toContain(
      'SELECT VECTOR_DISTANCE AS "_distance"'
    );
    expect(literalValues).toEqual([1, 2, 3]);
    expect(l2Column?.toStatement("$n")).toBe('"t0"."embedding"');
    expect(l2Vector?.toStatement("$n")).toBe("VECTOR_LITERAL");
  });

  test("parameterizes Postgres vector literals in distance select", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      select: {
        id: true,
        embedding: {
          _distance: {
            to: [1, 2, 3],
            metric: "cosine",
          },
        },
      },
    });

    expect(query.toStatement("$n")).toContain(
      '"t0"."embedding" <=> $1::vector AS "_distance"'
    );
    expect(query.values).toEqual(["[1,2,3]"]);
  });

  test("throws FeatureNotSupportedError when distance select lacks vector support", () => {
    const adapter = new SQLiteAdapter();

    expect(() =>
      createEngine(adapter, "sqlite").build(vectorOrderSchema.doc, "findMany", {
        select: {
          embedding: {
            _distance: {
              to: [1, 2, 3],
              metric: "l2",
            },
          },
        },
      })
    ).toThrow(FeatureNotSupportedError);
    expect(() =>
      createEngine(adapter, "sqlite").build(vectorOrderSchema.doc, "findMany", {
        select: {
          embedding: {
            _distance: {
              to: [1, 2, 3],
              metric: "l2",
            },
          },
        },
      })
    ).toThrow("vector distance select requires a pgvector-enabled PostgreSQL driver");
  });

  test("throws a clear error when selected query vector dimension does not match", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    expect(() =>
      createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
        select: {
          embedding: {
            _distance: {
              to: [1, 2],
              metric: "l2",
            },
          },
        },
      })
    ).toThrow(
      "Vector distance select dimension mismatch for 'embedding': expected 3 values, received 2."
    );
  });

  test("rejects multiple distance selects in one result scope", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    expect(() =>
      createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
        select: {
          embedding: {
            _distance: {
              to: [1, 0, 0],
              metric: "l2",
            },
          },
          secondaryEmbedding: {
            _distance: {
              to: [0, 1, 0],
              metric: "cosine",
            },
          },
        },
      })
    ).toThrow(
      "Vector distance select supports only one _distance field per select."
    );
  });

  test("combines distance orderBy with selected distance score", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      select: {
        id: true,
        embedding: {
          _distance: {
            to: [1, 0, 0],
            metric: "l2",
          },
        },
      },
      orderBy: {
        embedding: {
          _distance: {
            to: [1, 0, 0],
            metric: "l2",
          },
        },
      },
    });

    const statement = query.toStatement("$n");
    expect(statement).toContain(
      '"t0"."embedding" <-> $1::vector AS "_distance"'
    );
    expect(statement).toContain(
      'ORDER BY "t0"."embedding" <-> $2::vector ASC'
    );
    expect(query.values).toEqual(["[1,0,0]", "[1,0,0]"]);
  });

  test("throws FeatureNotSupportedError when the adapter lacks vector support", () => {
    const adapter = new SQLiteAdapter();

    expect(() =>
      createEngine(adapter, "sqlite").build(vectorOrderSchema.doc, "findMany", {
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 2, 3],
              metric: "l2",
            },
          },
        },
      })
    ).toThrow(FeatureNotSupportedError);
    expect(() =>
      createEngine(adapter, "sqlite").build(vectorOrderSchema.doc, "findMany", {
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 2, 3],
              metric: "l2",
            },
          },
        },
      })
    ).toThrow("vector ordering requires a pgvector-enabled PostgreSQL driver");
  });

  test("throws a clear error when the query vector dimension does not match the column", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    expect(() =>
      createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
        orderBy: {
          embedding: {
            _distance: {
              to: [1, 2],
              metric: "l2",
            },
          },
        },
      })
    ).toThrow(
      "Vector distance orderBy dimension mismatch for 'embedding': expected 3 values, received 2."
    );
  });

  test("routes vector distance orderBy through lateral to-many include with take", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    const query = createEngine(adapter).build(
      vectorOrderSchema.collection,
      "findMany",
      {
        include: {
          docs: {
            select: { id: true },
            orderBy: {
              embedding: {
                _distance: {
                  to: [1, 2, 3],
                  metric: "l2",
                },
              },
            },
            take: 2,
          },
        },
      }
    );

    const statement = query.toStatement("$n");
    expect(statement).toContain("LEFT JOIN LATERAL");
    expect(statement).toContain(
      'ORDER BY "t1"."embedding" <-> $2::vector ASC'
    );
    expect(statement).toContain("LIMIT $3");
    expect(query.values).toEqual(["id", "[1,2,3]", 2]);
  });

  test("routes vector distance orderBy through subquery to-many include with take", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;
    adapter.capabilities.supportsLateralJoins = false;

    const query = createEngine(adapter).build(
      vectorOrderSchema.collection,
      "findMany",
      {
        include: {
          docs: {
            select: { id: true },
            orderBy: {
              embedding: {
                _distance: {
                  to: [1, 2, 3],
                  metric: "cosine",
                },
              },
            },
            take: 2,
          },
        },
      }
    );

    const statement = query.toStatement("$n");
    expect(statement).not.toContain("LEFT JOIN LATERAL");
    expect(statement).toContain(
      'ORDER BY "t1"."embedding" <=> $2::vector ASC'
    );
    expect(statement).toContain("LIMIT $3");
    expect(query.values).toEqual(["id", "[1,2,3]", 2]);
  });

  test("applies the vector capability gate inside to-many include orderBy", () => {
    const adapter = new SQLiteAdapter();

    expect(() =>
      createEngine(adapter, "sqlite").build(
        vectorOrderSchema.collection,
        "findMany",
        {
          include: {
            docs: {
              orderBy: {
                embedding: {
                  _distance: {
                    to: [1, 2, 3],
                    metric: "l2",
                  },
                },
              },
              take: 2,
            },
          },
        }
      )
    ).toThrow(FeatureNotSupportedError);
  });

  test("passes vector scalar metadata through to-one relation orderBy", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    const query = createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
      orderBy: {
        collection: {
          centroid: {
            _distance: {
              to: [1, 2, 3],
              metric: "l2",
            },
          },
        },
      },
    });

    const statement = query.toStatement("$n");
    expect(statement).toContain(
      'LEFT JOIN "vector_order_collections" AS "t1" ON "t0"."collectionId" = "t1"."id"'
    );
    expect(statement).toContain(
      'ORDER BY "t1"."centroid" <-> $1::vector ASC'
    );
    expect(query.values).toEqual(["[1,2,3]"]);
  });

  test("applies the vector dimension gate through to-one relation orderBy", () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.supportsVector = true;

    expect(() =>
      createEngine(adapter).build(vectorOrderSchema.doc, "findMany", {
        orderBy: {
          collection: {
            centroid: {
              _distance: {
                to: [1, 2],
                metric: "l2",
              },
            },
          },
        },
      })
    ).toThrow(
      "Vector distance orderBy dimension mismatch for 'collection.centroid': expected 3 values, received 2."
    );
  });
});
