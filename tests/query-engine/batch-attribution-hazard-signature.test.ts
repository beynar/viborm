import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { NestedWriteAssertionError } from "@errors";
import { attributeOperationBatchError } from "@query-engine/batch-error-attribution";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { PreparedBatchGuard } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * The dialect table that decides whether a native batch's assertion failure may
 * be blamed on a guard (`src/query-engine/batch-error-attribution.ts`),
 * measured against the SQL this ORM actually emits.
 *
 * A native batch is normalized against the JOINED SQL, so one assertion
 * statement arms the assertion detector for every statement in the batch. An
 * ORDINARY statement that can raise the executing dialect's assertion signature
 * therefore makes the failure un-attributable — blaming a guard would report
 * `NotFoundError` / P2025 for a row that is present. The table encodes which
 * shapes those are, per dialect. It is only as good as its agreement with the
 * adapters: the first version knew SQLite's assertion trick (`json_extract`)
 * but not SQLite's ordinary JSON access (the `->` / `->>` operators), and so
 * read a live path filter as harmless.
 *
 * Each case below builds BOTH hazard shapes through the engine on its own
 * adapter and pins the spelling, then drives the real attribution entry point:
 * the dialect's own trick must block attribution, the other dialect's must not
 * (MySQL's `x / 0` yields NULL or errno 1365, Postgres reports bad JSON as
 * 22P02 — neither is that dialect's assertion signature).
 *
 * Execution-backed proof that the SQLite row matters lives in
 * {@link file://../client/batch-transaction.test.ts} ("attribution on the
 * SQLite dialect"), on a batch-only SQLite driver.
 */

class SqlOnlyDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `hazard-signature-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // No external client is allocated by this SQL-only driver.
  }

  /** A guard re-probe finds its row: every probe here comes back CLEAN. */
  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [{ found: 1 } as T], rowCount: 1 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [{ found: 1 } as T], rowCount: 1 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const Doc = s
  .model({
    id: s.string().id(),
    label: s.string(),
    n: s.int(),
    payload: s.json().nullable(),
  })
  .map("hazard_signature_docs");

const schema = { Doc };

beforeAll(() => hydrateSchemaNames(schema));

type DialectCase = {
  name: string;
  dialect: Dialect;
  createAdapter: () => DatabaseAdapter;
  /** Which ordinary shape can counterfeit THIS dialect's assertion trick. */
  hazard: "json" | "division";
  /** Spellings the signature owes its coverage to, as the adapter emits them. */
  jsonSpelling: string;
  divisionSpelling: string;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    createAdapter: () => new PostgresAdapter(),
    hazard: "division",
    // `#>` path access: no `/`, no `%` — invisible to the division signature.
    jsonSpelling: '"payload"#>',
    divisionSpelling: '"n" / ',
  },
  {
    name: "MySQL",
    dialect: "mysql",
    createAdapter: () => new MySQLAdapter(),
    hazard: "json",
    jsonSpelling: "JSON_EXTRACT(",
    // TRUNCATE(n / ?, 0) does contain a `/` — which is Postgres's trick, not
    // MySQL's, and must not block attribution here.
    divisionSpelling: " / ",
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    createAdapter: () => new SQLiteAdapter(),
    hazard: "json",
    // THE BLIND SPOT: an ordinary path filter chains bound `->` legs and never
    // spells "json" at all. If this pin ever fails because the adapter moved to
    // json_extract, re-derive FOREIGN_ASSERTION_SIGNATURE from the new SQL.
    jsonSpelling: " -> ",
    divisionSpelling: '"n" / ',
  },
];

function createEngine(dialectCase: DialectCase): {
  engine: QueryEngine;
  driver: Driver<null, null>;
  adapter: DatabaseAdapter;
} {
  const adapter = dialectCase.createAdapter();
  const driver = new SqlOnlyDriver(adapter, dialectCase.dialect);
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return { engine: new QueryEngine(driver, registry), driver, adapter };
}

function statementOf(
  engine: QueryEngine,
  args: Record<string, unknown>
): string {
  return engine
    .build(Doc, "updateMany" as never, args as never)
    .toStatement("?");
}

/** One guard whose premise HOLDS on re-probe — the post-rollback shape. */
const cleanGuard = (): PreparedBatchGuard => ({
  queryIndex: 0,
  premise: "exists",
  probe: sql`SELECT 1`,
  failure: {
    kind: "notFound",
    message: "No Doc record found for update",
    raceable: false,
  },
  model: "Doc",
  operation: "update",
});

describe.each(dialectCases)(
  "$name batch attribution hazard signature",
  (dialectCase) => {
    const build = () => {
      const { engine, driver, adapter } = createEngine(dialectCase);
      return {
        driver,
        assertion: adapter.assertions
          .exists(sql.raw`SELECT 1`)
          .toStatement("?"),
        json: statementOf(engine, {
          where: { payload: { path: ["a"], equals: 1 } },
          data: { label: "y" },
        }),
        division: statementOf(engine, {
          where: { id: "b" },
          data: { n: { divide: 0 } },
        }),
      };
    };

    test("the adapter spells both hazard shapes the way the table expects", () => {
      const { json, division } = build();
      expect(json).toContain(dialectCase.jsonSpelling);
      expect(division).toContain(dialectCase.divisionSpelling);
    });

    test("an ordinary statement carrying this dialect's trick blocks attribution", async () => {
      const { driver, assertion, json, division } = build();
      const ordinary = dialectCase.hazard === "json" ? json : division;
      const error = new NestedWriteAssertionError("assertion failed");

      const attributed = await attributeOperationBatchError(
        error,
        [cleanGuard()],
        driver,
        [{ sql: assertion }, { sql: ordinary }]
      );

      // The raw error stands: no P2025 about a row nobody showed is missing.
      expect(attributed).toBe(error);
    });

    test("the other dialect's trick is not this dialect's, so attribution stands", async () => {
      const { driver, assertion, json, division } = build();
      const foreign = dialectCase.hazard === "json" ? division : json;
      const error = new NestedWriteAssertionError("assertion failed");

      const attributed = await attributeOperationBatchError(
        error,
        [cleanGuard()],
        driver,
        [{ sql: assertion }, { sql: foreign }]
      );

      expect((attributed as Error).name).toBe("NotFoundError");
    });

    test("a batch of nothing but its own assertion attributes", async () => {
      const { driver, assertion } = build();
      const error = new NestedWriteAssertionError("assertion failed");

      const attributed = await attributeOperationBatchError(
        error,
        [cleanGuard()],
        driver,
        [{ sql: assertion }]
      );

      expect((attributed as Error).name).toBe("NotFoundError");
    });
  }
);
