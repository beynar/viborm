import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { buildScalarSqlValue } from "@query-engine/builders/values-builder";
import { createQueryScope } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { referenceSql } from "@src/query-engine/write-engine/fragment-builders";
import type {
  OperationStep,
  StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import {
  destinationCastSchema,
  FOUND_AT,
  OLD_AT,
  registerDestinationCastBehavior,
} from "@tests/contracts/engine/write/destination-cast-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const substrates = [
  {
    name: "transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerDestinationCastBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: destinationCastSchema,
        driver: substrate.make(),
      }) as any;
      await push(shared, { force: true });
    }
    return shared;
  });
}

function writeSteps(steps: readonly OperationStep[]): readonly StatementStep[] {
  return steps.filter((step): step is StatementStep => step.kind === "write");
}

function sqlOf(step: { statement: { strings: readonly string[] } }): string {
  return step.statement.strings.join("?");
}

function compiledFor(
  model: any,
  data: Record<string, unknown>,
  known: Record<string, unknown>
) {
  const schemas = createSchemaRegistry(destinationCastSchema);
  const engine = new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(destinationCastSchema, schemas)
  );
  return new CreateOperation(engine, model, { data }).compile(known);
}

const ENTRY_UPDATE = /UPDATE (?:"[^"]+"\.)?"e60_entries"/;
const ENTRY_INSERT = /INSERT INTO (?:"[^"]+"\.)?"e60_entries"/;
const TICK_UPDATE = /UPDATE (?:"[^"]+"\.)?"e60_ticks"/;
const FILE_UPDATE = /UPDATE (?:"[^"]+"\.)?"e60_files"/;

describe("U-E6.0 the emitted relation-key expression", () => {
  test("the dateTime reparent SET wears NO cast", () => {
    // The defect, at the exact byte: `SET "atRef" = CAST(? AS TEXT)` is what
    // PostgreSQL answered 42804 to. A temporal column's domain is its own type, and an
    // uncast bind takes that type from the assignment target.
    const compiled = compiledFor(
      destinationCastSchema.slot,
      {
        at: FOUND_AT,
        label: "fresh",
        entries: {
          upsert: {
            where: { id: "e-1" },
            create: { id: "e-1", body: "never" },
            update: {},
          },
        },
      },
      { "entry.find.rows": [{ id: "e-1", atRef: OLD_AT }] }
    );
    const arm = writeSteps(compiled.steps).find((step) =>
      ENTRY_UPDATE.test(sqlOf(step))
    );
    expect(arm).toBeDefined();
    expect(sqlOf(arm as StatementStep)).toContain('SET "atRef" = ?');
    expect(sqlOf(arm as StatementStep)).not.toContain("CAST");
  });

  test("the dateTime create arm's INSERT wears no cast either", () => {
    const compiled = compiledFor(
      destinationCastSchema.slot,
      {
        at: FOUND_AT,
        label: "fresh",
        entries: {
          upsert: {
            where: { id: "e-new" },
            create: { id: "e-new", body: "made" },
            update: {},
          },
        },
      },
      { "entry.find.rows": [] }
    );
    const insert = writeSteps(compiled.steps).find((step) =>
      ENTRY_INSERT.test(sqlOf(step))
    );
    expect(insert).toBeDefined();
    expect(sqlOf(insert as StatementStep)).not.toContain("CAST");
  });

  test("CONTROL: an int relation key still wears CAST(? AS INTEGER)", () => {
    const compiled = compiledFor(
      destinationCastSchema.counter,
      {
        seq: 2,
        label: "fresh",
        ticks: {
          upsert: {
            where: { id: "t-1" },
            create: { id: "t-1", body: "never" },
            update: {},
          },
        },
      },
      { "tick.find.rows": [{ id: "t-1", seqRef: 1 }] }
    );
    const arm = writeSteps(compiled.steps).find((step) =>
      TICK_UPDATE.test(sqlOf(step))
    );
    expect(sqlOf(arm as StatementStep)).toContain(
      'SET "seqRef" = CAST(? AS INTEGER)'
    );
  });

  test("CONTROL: a string relation key still wears CAST(? AS TEXT)", () => {
    const compiled = compiledFor(
      destinationCastSchema.folder,
      {
        name: "fresh",
        label: "fresh",
        files: {
          upsert: {
            where: { id: "f-1" },
            create: { id: "f-1", body: "never" },
            update: {},
          },
        },
      },
      { "file.find.rows": [{ id: "f-1", nameRef: "old" }] }
    );
    const arm = writeSteps(compiled.steps).find((step) =>
      FILE_UPDATE.test(sqlOf(step))
    );
    expect(sqlOf(arm as StatementStep)).toContain(
      'SET "nameRef" = CAST(? AS TEXT)'
    );
  });
});

/** SQL-only: the lowering is a pure function of the adapter, and the three dialects
 *  disagree about the spelling, not about the plan. Same shape as the decimal FK
 *  harness in `tests/contracts/engine/query/decimal-relation-key-write.test.ts`. */
class SqlOnlyDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `e60-destination-cast-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // SQL-only driver: no external client is allocated.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const dialects = [
  {
    name: "PostgreSQL",
    dialect: "postgresql" as Dialect,
    adapter: () => new PostgresAdapter(),
    // The 42804 spelling. Never again, on this dialect above all.
    bound: "2020-01-01T00:00:00.000Z",
  },
  {
    name: "MySQL",
    dialect: "mysql" as Dialect,
    adapter: () => new MySQLAdapter(),
    // `DATETIME` rejects ISO-8601's `Z` — ER_TRUNCATED_WRONG_VALUE on 8.4.10.
    bound: "2020-01-01 00:00:00.000",
  },
  {
    name: "SQLite",
    dialect: "sqlite" as Dialect,
    adapter: () => new SQLiteAdapter(),
    bound: "2020-01-01T00:00:00.000Z",
  },
];

const ISO = "2020-01-01T00:00:00.000Z";

const rendered = (fragment: ReturnType<typeof referenceSql>) => ({
  statement: fragment.toStatement("$n"),
  values: fragment.values,
});

describe.each(
  dialects
)("U-E6.0 $name dateTime relation-key lowering", (dialectCase) => {
  const engineFor = () => {
    const adapter = dialectCase.adapter();
    return new QueryEngine(
      new SqlOnlyDriver(adapter, dialectCase.dialect),
      createModelRegistry(
        destinationCastSchema,
        createSchemaRegistry(destinationCastSchema)
      )
    );
  };

  test("the relation key wears no cast and the dialect's own spelling", () => {
    const fk = rendered(
      referenceSql(engineFor(), destinationCastSchema.entry, "atRef", ISO)
    );
    expect(fk.statement).not.toContain("CAST");
    expect(fk.values).toEqual([dialectCase.bound]);
  });

  test("the FK lowering EQUALS the referenced column's own write lowering", () => {
    // The whole rule in one assertion, and the reason both halves of the defect are
    // one fix: whatever the child's foreign key is written as, a plain write of the
    // parent's own key column is written the same. This is the decimal note's
    // invariant (W6), now enforced for the second type.
    const engine = engineFor();
    const scope = createQueryScope(engine, destinationCastSchema.slot);
    expect(
      rendered(referenceSql(engine, destinationCastSchema.entry, "atRef", ISO))
    ).toEqual(
      rendered(
        buildScalarSqlValue(scope, destinationCastSchema.slot, "at", ISO)
      )
    );
  });
});
