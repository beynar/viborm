/**
 * PostgreSQL DDL, control tables, and introspection, bound to one schema.
 *
 * Qualification is the containment mechanism: nothing sets `search_path`, so a
 * statement reaches this estate's objects only because it names the estate's
 * schema. Every control below is written against a DECOY — a `public` (or
 * sibling-schema) object of the same name — so a statement that lost its prefix
 * finds something and succeeds on the wrong object instead of failing loudly.
 *
 * The rendering half is provider-free; the convergence half runs on PGlite,
 * which is PostgreSQL, so `CREATE SCHEMA`, enum defaults, partial-index
 * deparsing and extension provenance all behave as the server does. The docker
 * `pg` legs live in `tests/providers/docker/pg.test.ts`.
 */

import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite/vector";
import { MigrationError, VibORMErrorCode } from "@errors";
import { getMigrationDriver } from "@migrations/drivers";
import { introspect as introspectClient } from "@migrations/push";
import { PG, s } from "@schema";
import { createControlTableSQL } from "@src/migrations/control";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import type { DiffOperation, SchemaSnapshot } from "@src/migrations/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";
import { ddlContext, pgEstateDriver, RecordingDriver } from "./_estate";

/** Refusal texts these controls pin, hoisted so no matcher builds one per call. */
const UNBOUND_ESTATE = /not bound to an estate/;
const EXTERNAL_SCHEMA_TYPE = /lives in another schema/;
const CROSS_SCHEMA_TOPOLOGY = /unsupported migration topology/;

// =============================================================================
// RENDERING — §4.1's position table
// =============================================================================

const billing = getMigrationDriver(pgEstateDriver("billing"));
const tenant = getMigrationDriver(pgEstateDriver("tenant_b"));

/**
 * An estate whose adapter declares the pgvector and PostGIS capabilities.
 *
 * The concrete drivers set these from their own options
 * (`src/drivers/pg/index.ts`), which is exactly what admits an extension type
 * during introspection — an installed extension a driver was not built for is
 * still a type VibORM cannot round-trip.
 */
function extensionCapableEstate(namespace: string) {
  const adapter = new PostgresAdapter(namespace);
  adapter.capabilities.supportsVector = true;
  adapter.capabilities.supportsGeospatial = true;
  return getMigrationDriver(new RecordingDriver("postgresql", "pg", adapter));
}

/** Renders one operation for the estate on `billing`, as a durable artifact. */
function artifact(op: DiffOperation, context: Partial<SchemaSnapshot> = {}) {
  return billing.generateDDL(op, {
    destination: "artifact",
    currentSchema: { tables: [], ...context },
  });
}

/** The same operation as an immediate live statement. */
function live(op: DiffOperation, context: Partial<SchemaSnapshot> = {}) {
  return billing.generateDDL(op, {
    destination: "live",
    currentSchema: { tables: [], ...context },
  });
}

const usersTable = {
  name: "users",
  columns: [
    { name: "id", type: "text", nullable: false },
    { name: "email", type: "text", nullable: false },
  ],
  primaryKey: { columns: ["id"], name: "users_pkey" },
  indexes: [{ name: "users_email_idx", columns: ["email"], unique: false }],
  foreignKeys: [],
  uniqueConstraints: [{ name: "users_email_key", columns: ["email"] }],
};

describe("PostgreSQL DDL qualifies every persistent object position", () => {
  it("creates a table, its index and its constraints in the bound schema", () => {
    const ddl = artifact({ type: "createTable", table: usersTable });

    expect(ddl).toContain('CREATE TABLE "billing"."users" (');
    // Constraint names are ONE identifier — they live in the table's schema.
    expect(ddl).toContain('CONSTRAINT "users_pkey" PRIMARY KEY ("id")');
    expect(ddl).toContain('CONSTRAINT "users_email_key" UNIQUE ("email")');
    // CREATE INDEX: bare index name, qualified target table.
    expect(ddl).toContain(
      'CREATE INDEX "users_email_idx" ON "billing"."users" ("email")'
    );
  });

  it("drops and renames a table, leaving the RENAME target bare", () => {
    expect(artifact({ type: "dropTable", tableName: "users" })).toBe(
      'DROP TABLE "billing"."users"'
    );
    // `RENAME TO` takes one identifier: PostgreSQL renames inside the schema,
    // and a qualified new name is a syntax error rather than a move.
    expect(artifact({ type: "renameTable", from: "users", to: "people" })).toBe(
      'ALTER TABLE "billing"."users" RENAME TO "people"'
    );
  });

  it("qualifies every ALTER TABLE subject and no column name", () => {
    expect(
      artifact({
        type: "addColumn",
        tableName: "users",
        column: { name: "age", type: "integer", nullable: true },
      })
    ).toBe('ALTER TABLE "billing"."users" ADD COLUMN "age" integer');

    expect(
      artifact({ type: "dropColumn", tableName: "users", columnName: "age" })
    ).toBe('ALTER TABLE "billing"."users" DROP COLUMN "age"');

    expect(
      artifact({
        type: "renameColumn",
        tableName: "users",
        from: "age",
        to: "years",
      })
    ).toBe('ALTER TABLE "billing"."users" RENAME COLUMN "age" TO "years"');

    expect(
      artifact({
        type: "alterColumn",
        tableName: "users",
        columnName: "age",
        from: { name: "age", type: "integer", nullable: true },
        to: { name: "age", type: "integer", nullable: false },
      })
    ).toBe('ALTER TABLE "billing"."users" ALTER COLUMN "age" SET NOT NULL');
  });

  it("qualifies a CREATE INDEX target and a DROP INDEX name", () => {
    expect(
      artifact({
        type: "createIndex",
        tableName: "users",
        index: { name: "users_email_idx", columns: ["email"], unique: true },
      })
    ).toBe(
      'CREATE UNIQUE INDEX "users_email_idx" ON "billing"."users" ("email")'
    );

    // DROP INDEX names the index object itself, which lives in a schema.
    expect(
      artifact({
        type: "dropIndex",
        tableName: "users",
        indexName: "users_email_idx",
      })
    ).toBe('DROP INDEX "billing"."users_email_idx"');
  });

  it("qualifies both sides of a foreign key and neither constraint name", () => {
    expect(
      artifact({
        type: "addForeignKey",
        tableName: "posts",
        fk: {
          name: "posts_author_fk",
          columns: ["author_id"],
          referencedTable: "users",
          referencedColumns: ["id"],
          onDelete: "cascade",
        },
      })
    ).toBe(
      'ALTER TABLE "billing"."posts" ADD CONSTRAINT "posts_author_fk" FOREIGN KEY ("author_id") REFERENCES "billing"."users" ("id") ON DELETE CASCADE'
    );

    expect(
      artifact({
        type: "dropForeignKey",
        tableName: "posts",
        fkName: "posts_author_fk",
      })
    ).toBe('ALTER TABLE "billing"."posts" DROP CONSTRAINT "posts_author_fk"');
  });

  it("qualifies unique and primary-key constraint subjects", () => {
    expect(
      artifact({
        type: "addUniqueConstraint",
        tableName: "users",
        constraint: { name: "users_email_key", columns: ["email"] },
      })
    ).toBe(
      'ALTER TABLE "billing"."users" ADD CONSTRAINT "users_email_key" UNIQUE ("email")'
    );
    expect(
      artifact({
        type: "dropUniqueConstraint",
        tableName: "users",
        constraintName: "users_email_key",
      })
    ).toBe('ALTER TABLE "billing"."users" DROP CONSTRAINT "users_email_key"');
    expect(
      artifact({
        type: "addPrimaryKey",
        tableName: "users",
        primaryKey: { columns: ["id"] },
      })
    ).toBe(
      'ALTER TABLE "billing"."users" ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id")'
    );
    expect(
      artifact({
        type: "dropPrimaryKey",
        tableName: "users",
        constraintName: "users_pkey",
      })
    ).toBe('ALTER TABLE "billing"."users" DROP CONSTRAINT "users_pkey"');
  });

  it("qualifies enum creation, addition, recreation and drop", () => {
    expect(
      artifact({
        type: "createEnum",
        enumDef: { name: "state", values: ["active", "archived"] },
      })
    ).toBe(`CREATE TYPE "billing"."state" AS ENUM ('active', 'archived')`);

    expect(artifact({ type: "dropEnum", enumName: "state" })).toBe(
      'DROP TYPE "billing"."state"'
    );

    expect(
      artifact({
        type: "alterEnum",
        enumName: "state",
        addValues: ["pending"],
      })
    ).toBe(`ALTER TYPE "billing"."state" ADD VALUE 'pending'`);

    const recreation = artifact({
      type: "alterEnum",
      enumName: "state",
      removeValues: ["archived"],
      newValues: ["active"],
      dependentColumns: [{ tableName: "users", columnName: "state" }],
      defaultReplacement: "active",
    });
    // Every step of the recreation names this estate: the text cast, the data
    // migration, the type replacement and the cast back.
    expect(recreation).toContain(
      'ALTER TABLE "billing"."users" ALTER COLUMN "state" TYPE text'
    );
    expect(recreation).toContain(
      `UPDATE "billing"."users" SET "state" = 'active' WHERE "state" = 'archived'`
    );
    expect(recreation).toContain('DROP TYPE "billing"."state"');
    expect(recreation).toContain(
      `CREATE TYPE "billing"."state" AS ENUM ('active')`
    );
    expect(recreation).toContain(
      'ALTER TABLE "billing"."users" ALTER COLUMN "state" TYPE "billing"."state" USING "state"::"billing"."state"'
    );
  });

  it("renders one estate's schema, not another's, from one singleton", () => {
    const op: DiffOperation = { type: "dropTable", tableName: "users" };
    expect(artifact(op)).toBe('DROP TABLE "billing"."users"');
    expect(tenant.generateDDL(op, { destination: "artifact" })).toBe(
      'DROP TABLE "tenant_b"."users"'
    );
    // The registered singleton is never mutated by binding.
    expect(Object.getPrototypeOf(billing)).toBe(postgresMigrationDriver);
    expect(Object.getPrototypeOf(tenant)).toBe(postgresMigrationDriver);
  });

  it("spells an artifact exactly like a live statement", () => {
    // The dialect difference from MySQL: generated PostgreSQL SQL is bound to
    // the configured schema (§3.4), so `destination` changes nothing here.
    for (const op of [
      { type: "dropTable", tableName: "users" },
      { type: "createTable", table: usersTable },
      { type: "createEnum", enumDef: { name: "state", values: ["a"] } },
    ] satisfies DiffOperation[]) {
      expect(live(op)).toBe(artifact(op));
    }
  });
});

// =============================================================================
// MANAGED ENUM COLUMN TYPES — §4.1, N17
// =============================================================================

function columnTypeOf(
  type: string,
  context: { currentSchema?: SchemaSnapshot; preceding?: DiffOperation[] } = {}
): string {
  const ddl = billing.generateDDL(
    {
      type: "addColumn",
      tableName: "users",
      column: { name: "state", type, nullable: true },
    },
    {
      destination: "artifact",
      currentSchema: context.currentSchema,
      precedingOperations: context.preceding,
    }
  );
  return ddl.replace('ALTER TABLE "billing"."users" ADD COLUMN "state" ', "");
}

const enumSchema: SchemaSnapshot = {
  tables: [],
  enums: [{ name: "state", values: ["active"] }],
};

describe("a column type is qualified only when it names a managed enum", () => {
  it("qualifies an enum proven by the current schema, whatever it is called", () => {
    expect(columnTypeOf("state", { currentSchema: enumSchema })).toBe(
      '"billing"."state"'
    );
  });

  it("qualifies an enum this batch just created", () => {
    expect(
      columnTypeOf("users_state_enum", {
        preceding: [
          {
            type: "createEnum",
            enumDef: { name: "users_state_enum", values: ["active"] },
          },
        ],
      })
    ).toBe('"billing"."users_state_enum"');
  });

  it("qualifies the array form of a managed enum (N17)", () => {
    expect(columnTypeOf("state[]", { currentSchema: enumSchema })).toBe(
      '"billing"."state"[]'
    );
  });

  it("leaves a type nothing proves to be a managed enum alone", () => {
    // The `_enum` SUFFIX GUESS is gone: a token is qualified because the batch
    // proves it names an enum, never because of how it is spelled.
    expect(columnTypeOf("users_state_enum")).toBe("users_state_enum");
    expect(columnTypeOf("text", { currentSchema: enumSchema })).toBe("text");
    expect(columnTypeOf("vector(3)", { currentSchema: enumSchema })).toBe(
      "vector(3)"
    );
    expect(
      columnTypeOf("geometry(Point,4326)", { currentSchema: enumSchema })
    ).toBe("geometry(Point,4326)");
  });

  it("qualifies the enum an ALTER COLUMN changes a column to, in both positions", () => {
    expect(
      billing.generateDDL(
        {
          type: "alterColumn",
          tableName: "users",
          columnName: "state",
          from: { name: "state", type: "text", nullable: false },
          to: { name: "state", type: "state", nullable: false },
        },
        { destination: "live", currentSchema: enumSchema }
      )
    ).toBe(
      'ALTER TABLE "billing"."users" ALTER COLUMN "state" TYPE "billing"."state" USING "state"::"billing"."state"'
    );
  });
});

// =============================================================================
// TRACKING AND INVENTORY
// =============================================================================

describe("control and inventory statements name the estate", () => {
  it("qualifies every control-table statement", () => {
    const sql = createControlTableSQL(billing, "_viborm_migration");
    expect(sql.state).toContain(
      'CREATE TABLE IF NOT EXISTS "billing"."_viborm_migration_state"'
    );
    expect(sql.log).toContain(
      'CREATE TABLE IF NOT EXISTS "billing"."_viborm_migration_log"'
    );
    expect(billing.generateClearMigrations("_viborm_migration_state")).toBe(
      'DELETE FROM "billing"."_viborm_migration_state"'
    );
  });

  it("binds the estate's schema into both inventories, with no public fallback", () => {
    const tables = billing.generateInventoryTables();
    expect(tables.sql).toContain("schemaname = $1");
    expect(tables.sql).not.toContain("'billing'");
    expect(tables.params).toEqual(["billing"]);

    const enums = billing.generateInventoryEnums();
    expect(enums?.sql).toContain("nspname = $1");
    expect(enums?.sql).not.toContain("'billing'");
    expect(enums?.params).toEqual(["billing"]);
  });

  it("drops through the estate's schema and emits no CASCADE (section 6.1)", () => {
    // CASCADE dropped dependants in OTHER schemas even though the enumeration
    // that produced this name only ever selected one, which made the namespace
    // a filter instead of a boundary. RESTRICT is PostgreSQL's default and is
    // now what aborts on an unrepresented dependency.
    expect(billing.generateDropTableSQL("users")).toBe(
      'DROP TABLE IF EXISTS "billing"."users"'
    );
    expect(billing.generateDropEnumSQL("state")).toBe(
      'DROP TYPE IF EXISTS "billing"."state"'
    );
    expect(
      billing.generateDDL(
        { type: "dropTable", tableName: "users" },
        ddlContext("live")
      )
    ).toBe('DROP TABLE "billing"."users"');
  });

  it("refuses a catalog statement from the unbound singleton, and only that", () => {
    // A DDL statement off the singleton is the dialect's SQL with no estate
    // behind it, which is a coherent answer; a catalog PREDICATE has none — no
    // schema operand means every schema, and any default means a schema nothing
    // proved. `getMigrationDriver` is what binds one.
    expect(
      postgresMigrationDriver.generateDDL(
        { type: "dropTable", tableName: "users" },
        ddlContext("artifact")
      )
    ).toBe('DROP TABLE "users"');

    for (const build of [
      () => postgresMigrationDriver.generateInventoryTables(),
      () => postgresMigrationDriver.generateInventoryEnums(),
    ]) {
      expect(build).toThrow(MigrationError);
      expect(build).toThrow(UNBOUND_ESTATE);
    }
  });
});

// =============================================================================
// NAMESPACE EXISTENCE PROOF — §3.3
// =============================================================================

interface RecordedStatement {
  readonly sql: string;
  readonly params: unknown[] | undefined;
}

function recordingExecutor(answer: (sql: string) => unknown[]) {
  const statements: RecordedStatement[] = [];
  const execute = <T>(sql: string, params?: unknown[]) => {
    statements.push({ sql, params });
    return Promise.resolve({ rows: answer(sql) as T[] });
  };
  return { execute, statements };
}

describe("the configured schema is proven to exist", () => {
  it("asks pg_namespace one bound question", async () => {
    const executor = recordingExecutor(() => [{ present: 1 }]);
    await billing.proveNamespaceExists(executor.execute);

    expect(executor.statements).toHaveLength(1);
    const [proof] = executor.statements;
    expect(proof?.sql).toContain("pg_catalog.pg_namespace");
    expect(proof?.sql).toContain("nspname = $1");
    // Bound, never interpolated: a catalog predicate carries no schema text.
    expect(proof?.sql).not.toContain("billing");
    expect(proof?.params).toEqual(["billing"]);
  });

  it("refuses an absent schema with MIGRATION_INVALID_STATE", async () => {
    const executor = recordingExecutor(() => []);
    const failure = await billing.proveNamespaceExists(executor.execute).then(
      () => undefined,
      (error: unknown) => error
    );

    // The schema is named in the message AND survives the error-metadata
    // allowlist (`src/errors/diagnostics.ts`) on its `namespace` key, so a
    // caller can read which estate was missing without parsing prose.
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      meta: { dialect: "postgresql", namespace: "billing" },
    });
    expect(failure).toBeInstanceOf(MigrationError);
    expect(String(failure)).toContain('"billing"');
  });

  it("runs before the applied-state SELECT can fail, never after it", async () => {
    // PostgreSQL reports a missing schema and a missing relation alike as
    // 42P01, so a translation consulted first would report an absent estate as
    // "zero migrations applied". Order is the whole guarantee.
    const executor = recordingExecutor((sql) =>
      sql.includes("pg_namespace") ? [] : [{ name: "x", checksum: "y" }]
    );
    await expect(billing.introspect(executor.execute)).rejects.toThrow(
      MigrationError
    );
    expect(executor.statements).toHaveLength(1);
    expect(executor.statements[0]?.sql).toContain("pg_namespace");
  });
});

// =============================================================================
// INTROSPECTION — §4.2
// =============================================================================

type CatalogQuery =
  | "proof"
  | "tables"
  | "columns"
  | "primaryKeys"
  | "indexes"
  | "foreignKeys"
  | "crossSchemaForeignKeys"
  | "uniques"
  | "enums"
  | "unknown";

/** Which catalog question a statement is, by a fragment unique to it. */
function classifyCatalogQuery(sql: string): CatalogQuery {
  if (sql.includes("SELECT 1 AS present")) return "proof";
  if (sql.includes("format_type")) return "columns";
  if (sql.includes("(owner_ns.nspname = $1) <> (referenced_ns.nspname = $1)")) {
    return "crossSchemaForeignKeys";
  }
  if (sql.includes("FROM pg_index ix")) return "indexes";
  if (sql.includes("JOIN pg_enum e")) return "enums";
  if (sql.includes("'PRIMARY KEY'")) return "primaryKeys";
  if (sql.includes("con.contype = 'f'")) return "foreignKeys";
  if (sql.includes("'UNIQUE'")) return "uniques";
  if (sql.includes("information_schema.tables")) return "tables";
  return "unknown";
}

function catalogExecutor(answers: Partial<Record<CatalogQuery, unknown[]>>) {
  const asked = new Map<CatalogQuery, RecordedStatement>();
  const execute = <T>(sql: string, params?: unknown[]) => {
    const query = classifyCatalogQuery(sql);
    asked.set(query, { sql, params });
    const rows = query === "proof" ? [{ present: 1 }] : (answers[query] ?? []);
    return Promise.resolve({ rows: rows as T[] });
  };
  return { execute, asked };
}

const BUILT_IN_COLUMN = {
  table_name: "users",
  column_name: "id",
  data_type: "integer",
  udt_schema: "pg_catalog",
  udt_name: "int4",
  is_nullable: "NO",
  column_default: "nextval('billing.users_id_seq'::regclass)",
  character_maximum_length: null,
  numeric_precision: 32,
  numeric_scale: 0,
  formatted_type: "integer",
  type_extension: null,
  type_extension_schema: null,
};

describe("introspection is relative to the estate's schema", () => {
  it("binds the schema into every catalog query and spells no default", async () => {
    const executor = catalogExecutor({});
    await billing.introspect(executor.execute);

    // Every question this introspection asks, and no unclassified one.
    expect([...executor.asked.keys()].sort()).toEqual([
      "columns",
      "crossSchemaForeignKeys",
      "enums",
      "foreignKeys",
      "indexes",
      "primaryKeys",
      "proof",
      "tables",
      "uniques",
    ]);
    for (const [query, statement] of executor.asked) {
      expect({ query, params: statement.params }).toEqual({
        query,
        params: ["billing"],
      });
      expect(statement.sql).not.toContain("'public'");
      expect(statement.sql).not.toContain("'billing'");
    }
  });

  it("keeps the built-in type reading every existing snapshot holds", async () => {
    const executor = catalogExecutor({
      tables: [{ table_name: "users" }],
      columns: [
        BUILT_IN_COLUMN,
        {
          ...BUILT_IN_COLUMN,
          column_name: "email",
          data_type: "character varying",
          udt_name: "varchar",
          character_maximum_length: 255,
          numeric_precision: null,
          numeric_scale: null,
          column_default: "'none'::character varying",
          formatted_type: "character varying(255)",
        },
      ],
    });
    const snapshot = await billing.introspect(executor.execute);

    // `format_type` would answer `integer` / `character varying(255)`; the
    // udt_name path answers `int4` / `varchar(255)`, and that is what is
    // pinned — reading the formatted spelling for a built-in would rewrite
    // every column of every existing snapshot.
    //
    // The default is pinned for the same reason: the generic terminal-cast
    // strip is UNCHANGED, including its blind spot for a multi-word type name,
    // so `'none'::character varying` reads back exactly as it does today. The
    // enum strip is additive beside it, never a replacement for it.
    expect(snapshot.tables[0]?.columns).toEqual([
      {
        name: "id",
        type: "int4",
        nullable: false,
        default: undefined,
        autoIncrement: true,
      },
      {
        name: "email",
        type: "varchar(255)",
        nullable: false,
        default: "'none'::character varying",
        autoIncrement: false,
      },
    ]);
  });

  it.each([
    ["scalar negative scale", "numeric", "numeric", 4, -1, "numeric(4,-1)"],
    [
      "scalar scale above precision",
      "numeric",
      "numeric",
      2,
      5,
      "numeric(2,5)",
    ],
    [
      "array negative scale",
      "ARRAY",
      "_numeric",
      null,
      null,
      "numeric(4,-1)[]",
    ],
    [
      "array scale above precision",
      "ARRAY",
      "_numeric",
      null,
      null,
      "numeric(2,5)[]",
    ],
  ])("refuses a PostgreSQL %s instead of publishing an invalid decimal descriptor", async (_case, dataType, udtName, numericPrecision, numericScale, formattedType) => {
    const executor = catalogExecutor({
      tables: [{ table_name: "ledger" }],
      columns: [
        {
          ...BUILT_IN_COLUMN,
          table_name: "ledger",
          column_name: "amount",
          data_type: dataType,
          udt_name: udtName,
          column_default: null,
          numeric_precision: numericPrecision,
          numeric_scale: numericScale,
          formatted_type: formattedType,
        },
      ],
    });

    await expect(billing.introspect(executor.execute)).rejects.toMatchObject({
      code: "V11009",
      meta: {
        dialect: "postgresql",
        table: "ledger",
        column: "amount",
        type: "invalid-catalog-decimal-domain",
      },
    });
  });

  it("preserves an admitted extension type's modifiers and array structure", async () => {
    const executor = catalogExecutor({
      tables: [{ table_name: "points" }],
      columns: [
        {
          ...BUILT_IN_COLUMN,
          table_name: "points",
          column_name: "embedding",
          data_type: "USER-DEFINED",
          udt_schema: "public",
          udt_name: "vector",
          column_default: null,
          numeric_precision: null,
          numeric_scale: 0,
          formatted_type: "public.vector(3)",
          type_extension: "vector",
          type_extension_schema: "public",
        },
        {
          ...BUILT_IN_COLUMN,
          table_name: "points",
          column_name: "shape",
          data_type: "USER-DEFINED",
          udt_schema: "extensions",
          udt_name: "geometry",
          column_default: null,
          numeric_precision: null,
          numeric_scale: 0,
          formatted_type: '"extensions".geometry(Point,4326)',
          type_extension: "postgis",
          type_extension_schema: "extensions",
        },
      ],
    });
    const snapshot = await extensionCapableEstate("billing").introspect(
      executor.execute
    );

    // Only the PROVEN extension schema is removed — the modifiers the
    // `udt_name` path drops (and that made every push churn) survive.
    expect(snapshot.tables[0]?.columns.map((column) => column.type)).toEqual([
      "vector(3)",
      "geometry(Point,4326)",
    ]);
  });

  it("reads an unadmitted extension type through the udt_name path", async () => {
    const executor = catalogExecutor({
      tables: [{ table_name: "users" }],
      columns: [
        {
          ...BUILT_IN_COLUMN,
          column_name: "email",
          data_type: "USER-DEFINED",
          udt_schema: "public",
          udt_name: "citext",
          column_default: null,
          numeric_precision: null,
          numeric_scale: null,
          formatted_type: "public.citext",
          type_extension: "citext",
          type_extension_schema: "public",
        },
        {
          ...BUILT_IN_COLUMN,
          column_name: "aliases",
          data_type: "ARRAY",
          udt_schema: "public",
          udt_name: "_citext",
          column_default: null,
          numeric_precision: null,
          numeric_scale: null,
          formatted_type: "public.citext[]",
          type_extension: "citext",
          type_extension_schema: "public",
        },
        {
          ...BUILT_IN_COLUMN,
          column_name: "embedding",
          data_type: "USER-DEFINED",
          udt_schema: "public",
          udt_name: "vector",
          column_default: null,
          numeric_precision: null,
          numeric_scale: null,
          formatted_type: "public.vector(3)",
          type_extension: "vector",
          type_extension_schema: "public",
        },
      ],
    });
    const snapshot = await billing.introspect(executor.execute);

    // The capability set decides ONE thing — whether `format_type`'s
    // modifier-carrying spelling is read — and never whether a type is
    // representable. `citext` is one of VibORM's own PostgreSQL native types
    // (`src/schema/scalars/native-types.ts`) with no capability that could
    // admit it, and `mapScalarType` emits it verbatim on the desired side, so
    // refusing it here would brick `introspect`/`push` for an estate using a
    // shipped type. Read through `udt_name` all three are byte-identical to
    // what the driver's own renderer spells, which is what converges.
    //
    // `vector` is the admitted case above minus the capability: it reads back
    // exactly as it did before `format_type` was ever consulted.
    expect(snapshot.tables[0]?.columns.map((column) => column.type)).toEqual([
      "citext",
      "citext[]",
      "vector",
    ]);
  });

  it("refuses an unknown external UDT instead of claiming the schema owns it", async () => {
    const executor = catalogExecutor({
      tables: [{ table_name: "users" }],
      columns: [
        {
          ...BUILT_IN_COLUMN,
          column_name: "mood",
          data_type: "USER-DEFINED",
          udt_schema: "other",
          udt_name: "mood",
          column_default: null,
          formatted_type: "other.mood",
        },
      ],
    });

    // The ONE refusal left, and §4.2's whole unrepresentable class: a type no
    // extension owns, living outside the estate and outside `pg_catalog` —
    // an enum, domain, composite or UDT of another schema. Its two clauses are
    // pinned in opposite directions: no-extension-owner by this test, and
    // outside-the-estate by the built-in and estate-enum readings above.
    // The citext control is the other half of the first clause: an
    // extension-owned type from another schema reaches the `udt_name` path
    // instead of this refusal.
    await expect(billing.introspect(executor.execute)).rejects.toThrow(
      EXTERNAL_SCHEMA_TYPE
    );
  });

  it("strips the cast that names this column's own managed enum", async () => {
    const executor = catalogExecutor({
      tables: [{ table_name: "users" }],
      enums: [
        { enum_name: "state", enum_value: "active", sort_order: 1 },
        { enum_name: "state", enum_value: "archived", sort_order: 2 },
      ],
      columns: [
        // Qualified spelling — what a session whose `search_path` excludes the
        // estate's schema reads back, and what the generic strip cannot match.
        {
          ...BUILT_IN_COLUMN,
          column_name: "state",
          data_type: "USER-DEFINED",
          udt_schema: "billing",
          udt_name: "state",
          column_default: "'active'::billing.state",
          formatted_type: "billing.state",
        },
        // Array form.
        {
          ...BUILT_IN_COLUMN,
          column_name: "states",
          data_type: "ARRAY",
          udt_schema: "billing",
          udt_name: "_state",
          column_default: "'{active}'::billing.state[]",
          formatted_type: "billing.state[]",
        },
        // Quoted spelling — the same type, spelled the way a name needing
        // quotes is spelled.
        {
          ...BUILT_IN_COLUMN,
          column_name: "quoted",
          data_type: "USER-DEFINED",
          udt_schema: "billing",
          udt_name: "state",
          column_default: `'active'::"billing"."state"`,
          formatted_type: "billing.state",
        },
        // An unrelated cast: untouched by the enum strip, then handled by the
        // generic terminal strip exactly as before.
        {
          ...BUILT_IN_COLUMN,
          column_name: "label",
          data_type: "text",
          udt_schema: "pg_catalog",
          udt_name: "text",
          column_default: "'none'::text",
          formatted_type: "text",
        },
      ],
    });
    const snapshot = await billing.introspect(executor.execute);

    expect(snapshot.tables[0]?.columns.map((column) => column.default)).toEqual(
      ["'active'", "'{active}'", "'active'", "'none'"]
    );
  });

  it("refuses a foreign key that crosses the estate boundary, either way", async () => {
    for (const crossing of [
      {
        constraint_name: "acct_parent_fkey",
        owning_schema: "billing",
        owning_table: "acct",
        referenced_schema: "other",
        referenced_table: "parent",
      },
      {
        constraint_name: "inbound_acct_fkey",
        owning_schema: "other",
        owning_table: "inbound",
        referenced_schema: "billing",
        referenced_table: "acct",
      },
    ]) {
      const executor = catalogExecutor({
        tables: [{ table_name: "acct" }],
        crossSchemaForeignKeys: [crossing],
      });
      const failure = await billing.introspect(executor.execute).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(MigrationError);
      // Both schemas are named, so the refusal says which boundary was crossed.
      expect(String(failure)).toContain("billing");
      expect(String(failure)).toContain("other");
      expect(failure).toMatchObject({
        meta: { constraint: crossing.constraint_name },
      });
    }
  });
});

// =============================================================================
// CONVERGENCE ON A REAL SERVER (PGlite)
// =============================================================================

const tenantSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      state: s.enum(["active", "archived"]).name("account_state"),
      published: s.boolean(),
    })
    .map("ns_accounts")
    .index(["email"], { where: "published = true" });
  return { account };
})();

let database: PGlite;

async function pushInto(namespace: string) {
  const client = createClient({
    schema: tenantSchema,
    driver: new PGliteDriver({ client: database, namespace }),
  });
  return await syncLiveSchema(client);
}

describe("a custom schema converges on PostgreSQL", () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE SCHEMA "billing"');
    // Decoys in `public`, identically named: an unqualified statement finds
    // them and succeeds on the wrong object instead of failing.
    await database.exec(
      'CREATE TABLE "ns_accounts" ("id" TEXT PRIMARY KEY, "decoy" TEXT)'
    );
    await database.exec(`CREATE TYPE "account_state" AS ENUM ('decoy')`);
  });

  afterAll(async () => {
    await database?.close();
  });

  it("creates only its own objects, then plans nothing", async () => {
    const first = await pushInto("billing");
    expect(first.operations.length).toBeGreaterThan(0);

    // The public decoys are untouched: same names, different schema.
    const decoyColumns = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ns_accounts'"
    );
    expect(decoyColumns.rows.map((row) => row.column_name).sort()).toEqual([
      "decoy",
      "id",
    ]);
    const decoyEnum = await database.query<{ enumlabel: string }>(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'account_state'"
    );
    expect(decoyEnum.rows.map((row) => row.enumlabel)).toEqual(["decoy"]);

    // The estate's own objects exist where they were asked for.
    const created = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'billing'"
    );
    expect(created.rows.map((row) => row.table_name)).toEqual(["ns_accounts"]);

    // Second push is empty: the enum default and the partial-index predicate
    // both canonicalize against the estate's schema, not the decoy's.
    const second = await pushInto("billing");
    expect(second.operations).toEqual([]);
  });

  it("reads its own schema back and nothing else's", async () => {
    const client = createClient({
      schema: tenantSchema,
      driver: new PGliteDriver({ client: database, namespace: "billing" }),
    });
    const snapshot = await introspectClient(client);

    expect(snapshot.tables.map((table) => table.name)).toEqual(["ns_accounts"]);
    // Namespace-RELATIVE in the other direction: the snapshot carries bare
    // names, so it is the schema the DDL renderer qualifies with, not the
    // snapshot, that binds an estate.
    expect(snapshot.enums?.map((definition) => definition.name)).toEqual([
      "account_state",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("billing");
  });

  it("refuses a schema that does not exist, before any DDL", async () => {
    const failure = await pushInto("absent_tenant").then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    // A missing schema is not an empty database: nothing was created for it.
    const leaked = await database.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname = 'absent_tenant'"
    );
    expect(leaked.rows).toEqual([]);
  });

  it("refuses an inbound foreign key from outside the estate", async () => {
    await database.exec(
      'CREATE TABLE "public"."ns_watchers" ("id" TEXT PRIMARY KEY, "account_id" TEXT REFERENCES "billing"."ns_accounts"("id"))'
    );
    try {
      await expect(pushInto("billing")).rejects.toThrow(CROSS_SCHEMA_TOPOLOGY);
    } finally {
      await database.exec('DROP TABLE "public"."ns_watchers"');
    }
  });
});

// =============================================================================
// EXTENSION TYPES ON A REAL SERVER (PGlite + pgvector)
// =============================================================================

const embeddingSchema = (() => {
  const point = s
    .model({
      id: s.string().id(),
      embedding: s.vector().dimension(3),
    })
    .map("ns_points");
  return { point };
})();

describe("an extension type converges inside a custom schema", () => {
  let vectorDatabase: PGlite;

  beforeAll(async () => {
    vectorDatabase = new PGlite({ extensions: { vector } });
    // The extension lives in `public`; the estate lives elsewhere. This is the
    // shape §4.2 describes — a provider object owned by another schema, which
    // the estate uses without managing.
    await vectorDatabase.exec("CREATE EXTENSION IF NOT EXISTS vector");
    await vectorDatabase.exec('CREATE SCHEMA "tenant_v"');
  });

  afterAll(async () => {
    await vectorDatabase?.close();
  });

  it("keeps vector(3) through a first push, a read-back and a second push", async () => {
    const client = createClient({
      schema: embeddingSchema,
      driver: new PGliteDriver({
        client: vectorDatabase,
        namespace: "tenant_v",
        pgvector: true,
      }),
    });

    const first = await syncLiveSchema(client);
    expect(first.operations.length).toBeGreaterThan(0);

    // The typmod survives the catalog round-trip. Reduced to `udt_name` it
    // reads back as a bare `vector`, and every later push re-alters the column.
    const snapshot = await introspectClient(client);
    expect(snapshot.tables[0]?.columns.map((column) => column.type)).toContain(
      "vector(3)"
    );

    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });

  it("reads the same column through udt_name when the driver declares no vector support", async () => {
    const unaware = createClient({
      schema: embeddingSchema,
      driver: new PGliteDriver({
        client: vectorDatabase,
        namespace: "tenant_v",
      }),
    });

    const snapshot = await introspectClient(unaware);
    const types = snapshot.tables
      .find((table) => table.name === "ns_points")
      ?.columns.map((column) => column.type);

    // Not a refusal — the column is still representable, and this is the
    // reading every snapshot written before `format_type` was consulted holds.
    // What the missing capability costs is the typmod: `vector`, not
    // `vector(3)`, which is the churn N4 fixed for a driver that DOES declare
    // the extension.
    expect(types).toContain("vector");
    expect(types).not.toContain("vector(3)");
  });
});

// =============================================================================
// AN EXTENSION TYPE NO CAPABILITY ADMITS (PGlite + citext)
// =============================================================================

const contactSchema = (() => {
  const contact = s
    .model({
      id: s.string().id(),
      // A shipped VibORM native type whose extension no driver capability
      // declares. Before the fall-through this pair of pushes could not be
      // written: the first push succeeded and every later read refused.
      email: s.string(PG.STRING.CITEXT),
    })
    .map("ns_contacts");
  return { contact };
})();

describe("an extension type no capability admits converges in a custom schema", () => {
  let citextDatabase: PGlite;

  beforeAll(async () => {
    citextDatabase = new PGlite({ extensions: { citext } });
    // The extension lives in `public` — where `CREATE EXTENSION` puts it and
    // where the estate's own unqualified `citext` type token resolves it — and
    // the estate lives elsewhere, so the type is external in exactly the way
    // §4.2 means.
    await citextDatabase.exec("CREATE EXTENSION IF NOT EXISTS citext");
    await citextDatabase.exec('CREATE SCHEMA "tenant_c"');
  });

  afterAll(async () => {
    await citextDatabase?.close();
  });

  it("keeps citext through a first push, a read-back and a second push", async () => {
    const client = createClient({
      schema: contactSchema,
      driver: new PGliteDriver({
        client: citextDatabase,
        namespace: "tenant_c",
      }),
    });

    const first = await syncLiveSchema(client);
    expect(first.operations.length).toBeGreaterThan(0);

    const snapshot = await introspectClient(client);
    expect(snapshot.tables[0]?.columns.map((column) => column.type)).toContain(
      "citext"
    );

    // The whole point: the read-back spelling equals the desired spelling, so
    // the estate converges instead of refusing forever after its first push.
    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });
});

describe("a unique-index foreign-key target stays visible", () => {
  const host = s
    .model({
      id: s.int().id(),
      code: s.string(),
      pets: s.toMany(() => pet),
    })
    .map("ns_hosts")
    .index(["code"], { unique: true });
  const pet = s
    .model({
      id: s.int().id(),
      hostCode: s.string(),
      host: s
        .toOne(() => host)
        .fields("hostCode")
        .references("code")
        .onUpdate("cascade"),
    })
    .map("ns_pets");
  const schema = { host, pet };
  let uniqueIndexDatabase: PGlite;

  beforeAll(async () => {
    uniqueIndexDatabase = new PGlite();
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: uniqueIndexDatabase }),
    });
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await uniqueIndexDatabase?.close();
  });

  it("reads the unique index and the foreign key that targets it", async () => {
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: uniqueIndexDatabase }),
    });
    const snapshot = await introspectClient(client);
    const hosts = snapshot.tables.find((table) => table.name === "ns_hosts");
    const pets = snapshot.tables.find((table) => table.name === "ns_pets");

    expect(hosts?.indexes).toEqual([
      expect.objectContaining({
        name: "ns_hosts_code_idx",
        columns: ["code"],
        unique: true,
      }),
    ]);
    expect(hosts?.uniqueConstraints).toEqual([]);
    expect(pets?.foreignKeys).toEqual([
      expect.objectContaining({
        name: "ns_pets_hostCode_fkey",
        columns: ["hostCode"],
        referencedTable: "ns_hosts",
        referencedColumns: ["code"],
        onUpdate: "cascade",
      }),
    ]);

    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });
});
