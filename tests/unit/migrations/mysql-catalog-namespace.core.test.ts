/**
 * MySQL catalog targeting and dependency containment (plan §5.2).
 *
 * Two invariants live here. Every catalog read filters on the ONE configured
 * database, bound as data — `DATABASE()` (the connection's ambient default) is
 * gone, and a missing database refuses instead of publishing an empty estate.
 * And every foreign key with an endpoint outside that database is refused
 * before a snapshot exists, in either direction.
 */

import { getMigrationDriver } from "@migrations/drivers";
import { postgresMigrationDriver } from "@migrations/drivers/postgres";
import { readsCommandNamespace } from "@migrations/target";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { describe, expect, it } from "vitest";
import { mysqlEstateDriver } from "./_estate";

const BILLING = getMigrationDriver(
  mysqlEstateDriver({ namespace: "billing", attested: true })
);
const CASED = getMigrationDriver(
  mysqlEstateDriver({ namespace: "Billing", attested: true })
);
const UNBOUND = mysqlMigrationDriver;

interface Call {
  sql: string;
  params: unknown[];
}

/** A catalog server that records what it was asked and with which binds. */
function catalogReader(answer: (sql: string) => unknown[]): {
  read: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    read<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params: params ?? [] });
      const rows: T[] = [];
      for (const row of answer(sql)) {
        rows.push(Object.assign(Object.create(null), row));
      }
      return Promise.resolve({ rows });
    },
  };
}

const schemata = (...names: string[]) =>
  names.map((SCHEMA_NAME) => ({ SCHEMA_NAME }));

/** Answers the existence proof and nothing else — an existing, empty database. */
const emptyDatabase = (...names: string[]) =>
  catalogReader((sql) =>
    sql.includes("information_schema.SCHEMATA") ? schemata(...names) : []
  );

/**
 * The refusal MESSAGES. Every fact they name — the configured database, the
 * candidate spellings, and both ends of a cross-database foreign key — also
 * rides its own key in safe metadata, asserted beside each message below.
 */
const MISSING_DATABASE = /The MySQL database "billing" does not exist/;
const AMBIGUOUS_CANDIDATES =
  /matches 2 existing databases that differ only by case \(billing, BILLING\)/;
const OUTBOUND_ENDPOINTS =
  /`billing`\.`users` references `analytics`\.`orgs`, and this client manages only "billing"/;
const INBOUND_ENDPOINTS = /`analytics`\.`users` references `billing`\.`orgs`/;

describe("the MySQL namespace proof is one bound SCHEMATA read", () => {
  it("binds the configured name and never splices it into the statement", async () => {
    const server = emptyDatabase("billing");
    await BILLING.proveNamespaceExists(server.read);

    expect(server.calls).toHaveLength(1);
    const [proof] = server.calls;
    expect(proof?.sql).toContain("information_schema.SCHEMATA");
    expect(proof?.params).toEqual(["billing"]);
    expect(proof?.sql).not.toContain("DATABASE()");
    expect(proof?.sql).not.toContain("billing");
  });

  it("refuses a database the server does not report", async () => {
    const server = emptyDatabase();
    await expect(
      BILLING.proveNamespaceExists(server.read)
    ).rejects.toMatchObject({
      code: "V11009",
      message: MISSING_DATABASE,
      meta: {
        dialect: "mysql",
        type: "missing-database",
        namespace: "billing",
      },
    });
  });

  it("refuses an unbound driver before any provider call", async () => {
    const server = emptyDatabase("billing");
    await expect(
      UNBOUND.proveNamespaceExists(server.read)
    ).rejects.toMatchObject({ code: "V11009" });
    expect(server.calls).toEqual([]);
  });

  it("prefers the byte-exact spelling when the server reports case variants", async () => {
    const server = emptyDatabase("BILLING", "billing");
    await expect(
      BILLING.proveNamespaceExists(server.read)
    ).resolves.toBeUndefined();
  });

  it("accepts one case-folded server match", async () => {
    const server = emptyDatabase("billing");
    await expect(
      CASED.proveNamespaceExists(server.read)
    ).resolves.toBeUndefined();
  });

  it("ANSWERS with the server's spelling, which the command then renders", async () => {
    // The capability is structural, like the pinned-session hook: MySQL is the
    // only dialect whose configured spelling and the server's can differ, so it
    // is the only one that declares this.
    expect(readsCommandNamespace(postgresMigrationDriver)).toBe(false);
    if (!readsCommandNamespace(CASED)) {
      throw new Error(
        "the MySQL migration driver must resolve a command-local namespace"
      );
    }

    // The proof and the resolution are ONE read: accepting a case-folded match
    // without keeping the answer is what let `Billing` pass its proof and then
    // fail `USE` — while the reset inventory bound a database the server does
    // not have.
    await expect(
      CASED.resolveCommandNamespace(emptyDatabase("billing").read)
    ).resolves.toBe("billing");
    // A byte-exact match answers with itself.
    if (!readsCommandNamespace(BILLING)) {
      throw new Error("bound MySQL drivers share one implementation");
    }
    await expect(
      BILLING.resolveCommandNamespace(emptyDatabase("billing").read)
    ).resolves.toBe("billing");
  });

  it("refuses an ambiguous case-only pair", async () => {
    const server = emptyDatabase("billing", "BILLING");
    await expect(CASED.proveNamespaceExists(server.read)).rejects.toMatchObject(
      {
        code: "V11009",
        message: AMBIGUOUS_CANDIDATES,
        meta: {
          type: "ambiguous-database",
          namespace: "Billing",
          candidates: ["billing", "BILLING"],
        },
      }
    );
  });

  it.each([
    { label: "null", SCHEMA_NAME: null },
    { label: "a number", SCHEMA_NAME: 1 },
  ])("refuses a row whose SCHEMA_NAME is $label instead of resolving it", async ({
    SCHEMA_NAME,
  }) => {
    // Catalog rows are untrusted transport data. MySQL declares
    // `SCHEMATA.SCHEMA_NAME` NOT NULL so a conforming mysql2 server cannot
    // answer this, but a serverless/HTTP MySQL transport or a custom
    // `_executeRaw` can. A present-but-non-string name proves nothing — the
    // same doctrine `src/migrations/target.ts` applies to the adapter's own
    // namespace — so it is dropped and the missing-database refusal owns the
    // outcome. Resolving it instead would bind a non-string into all five
    // catalog filters, match nothing, and publish an ABSENT database as an
    // empty one, which is exactly what §5.2 forbids.
    const server = catalogReader((sql) =>
      sql.includes("information_schema.SCHEMATA") ? [{ SCHEMA_NAME }] : []
    );
    await expect(BILLING.introspect(server.read)).rejects.toMatchObject({
      code: "V11009",
      message: MISSING_DATABASE,
      meta: { type: "missing-database", namespace: "billing" },
    });
    // It refuses AT the proof: no filter is ever bound with the bad value.
    expect(server.calls).toHaveLength(1);
  });
});

describe("MySQL introspection binds the resolved database", () => {
  it("binds it in every catalog read and emits no DATABASE()", async () => {
    const server = emptyDatabase("billing");
    await BILLING.introspect(server.read);

    expect(server.calls).toHaveLength(6);
    for (const call of server.calls) {
      expect(call.sql).not.toContain("DATABASE()");
      expect(call.sql).not.toContain("'billing'");
      expect(call.params.every((param) => param === "billing")).toBe(true);
      expect(call.params.length).toBeGreaterThan(0);
    }
  });

  it("proves existence FIRST and reads no catalog for a missing database", async () => {
    const server = emptyDatabase();
    await expect(BILLING.introspect(server.read)).rejects.toMatchObject({
      code: "V11009",
    });
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.sql).toContain("information_schema.SCHEMATA");
  });

  it("filters on the server's own spelling under a case-folded match", async () => {
    const server = emptyDatabase("billing");
    await CASED.introspect(server.read);

    const proof = server.calls[0];
    expect(proof?.params).toEqual(["Billing"]);
    for (const call of server.calls.slice(1)) {
      expect(call.params.every((param) => param === "billing")).toBe(true);
    }
  });

  it("refuses an unbound driver before any provider call", async () => {
    const server = emptyDatabase("billing");
    await expect(UNBOUND.introspect(server.read)).rejects.toMatchObject({
      code: "V11009",
    });
    expect(server.calls).toEqual([]);
  });

  it("admits either endpoint as a foreign-key filter candidate", async () => {
    const server = emptyDatabase("billing");
    await BILLING.introspect(server.read);

    const fkQuery = server.calls.find((call) =>
      call.sql.includes("'FOREIGN KEY'")
    );
    expect(fkQuery?.sql).toContain("tc.TABLE_SCHEMA");
    expect(fkQuery?.sql).toContain("kcu.REFERENCED_TABLE_SCHEMA");
    expect(fkQuery?.sql).toContain(
      "(tc.TABLE_SCHEMA = ? OR kcu.REFERENCED_TABLE_SCHEMA = ?)"
    );
    expect(fkQuery?.params).toEqual(["billing", "billing"]);
  });
});

// =============================================================================
// CROSS-DATABASE FOREIGN KEYS
// =============================================================================

const usersRow = { TABLE_NAME: "users" };
const orgIdColumn = {
  TABLE_NAME: "users",
  COLUMN_NAME: "org_id",
  DATA_TYPE: "int",
  COLUMN_TYPE: "int",
  IS_NULLABLE: "NO",
  COLUMN_DEFAULT: null,
  CHARACTER_MAXIMUM_LENGTH: null,
  NUMERIC_PRECISION: 10,
  NUMERIC_SCALE: 0,
  EXTRA: "",
};

const foreignKeyRow = (from: string, to: string) => ({
  TABLE_SCHEMA: from,
  TABLE_NAME: "users",
  CONSTRAINT_NAME: "users_org_fk",
  COLUMN_NAME: "org_id",
  REFERENCED_TABLE_SCHEMA: to,
  REFERENCED_TABLE_NAME: "orgs",
  REFERENCED_COLUMN_NAME: "id",
  DELETE_RULE: "CASCADE",
  UPDATE_RULE: "NO ACTION",
  ORDINAL_POSITION: 1,
});

/** MySQL auto-creates an index named after each FK constraint. */
const fkBackingIndexRow = {
  TABLE_NAME: "users",
  INDEX_NAME: "users_org_fk",
  COLUMN_NAME: "org_id",
  NON_UNIQUE: 1,
  INDEX_TYPE: "BTREE",
  SEQ_IN_INDEX: 1,
};

/** What the TARGET database itself owns, as its three catalog reads answer. */
interface CatalogEstate {
  readonly tables: Record<string, unknown>[];
  readonly columns: Record<string, unknown>[];
  readonly indexes: Record<string, unknown>[];
}

const POPULATED: CatalogEstate = {
  tables: [usersRow],
  columns: [orgIdColumn],
  indexes: [fkBackingIndexRow],
};

it("refuses a MySQL catalog DECIMAL outside the complete operation domain", async () => {
  const decimalColumn = {
    ...orgIdColumn,
    COLUMN_NAME: "amount",
    DATA_TYPE: "decimal",
    COLUMN_TYPE: "decimal(65,30)",
    NUMERIC_PRECISION: 65,
    NUMERIC_SCALE: 30,
    COLUMN_COMMENT: "",
  };
  const server = catalogReader((sql) => {
    if (sql.includes("information_schema.SCHEMATA")) {
      return schemata("billing");
    }
    if (sql.includes("information_schema.TABLES")) return [usersRow];
    if (sql.includes("information_schema.COLUMNS")) return [decimalColumn];
    return [];
  });

  await expect(BILLING.introspect(server.read)).rejects.toMatchObject({
    code: "V11009",
    meta: {
      dialect: "mysql",
      table: "users",
      column: "amount",
      type: "invalid-catalog-decimal-domain",
    },
  });
});

/**
 * The same target owning NOTHING.
 *
 * An inbound constraint is declared on a stranger's table, so the managed
 * database can legitimately hold no objects of its own — §10's "including when
 * the target side owns no other objects". The refusal must still fire, because
 * it is decided from the constraint rows alone.
 */
const OWNS_NOTHING: CatalogEstate = { tables: [], columns: [], indexes: [] };

function serverWithForeignKey(
  row: Record<string, unknown>,
  estate: CatalogEstate = POPULATED
) {
  return catalogReader((sql) => {
    if (sql.includes("information_schema.SCHEMATA")) return schemata("billing");
    if (sql.includes("'FOREIGN KEY'")) return [row];
    if (sql.includes("information_schema.TABLES")) return estate.tables;
    if (sql.includes("information_schema.COLUMNS")) return estate.columns;
    if (sql.includes("information_schema.STATISTICS")) return estate.indexes;
    return [];
  });
}

describe("cross-database foreign keys refuse before a snapshot exists", () => {
  it("refuses an OUTBOUND reference and names both endpoints", async () => {
    const server = serverWithForeignKey(foreignKeyRow("billing", "analytics"));
    await expect(BILLING.introspect(server.read)).rejects.toMatchObject({
      code: "V11009",
      message: OUTBOUND_ENDPOINTS,
      meta: {
        dialect: "mysql",
        type: "cross-database-foreign-key",
        constraint: "users_org_fk",
        namespace: "billing",
        table: "billing.users",
        referencedTable: "analytics.orgs",
      },
    });
  });

  it("refuses an INBOUND reference from a database owning nothing else", async () => {
    const server = serverWithForeignKey(
      foreignKeyRow("analytics", "billing"),
      OWNS_NOTHING
    );
    await expect(BILLING.introspect(server.read)).rejects.toMatchObject({
      code: "V11009",
      message: INBOUND_ENDPOINTS,
      meta: { table: "analytics.users", referencedTable: "billing.orgs" },
    });

    // The fixture really does own nothing, so the refusal above came from the
    // constraint row and not from a table the target still held: the SAME empty
    // estate carrying a CONTAINED constraint publishes an empty snapshot.
    const contained = serverWithForeignKey(
      foreignKeyRow("billing", "billing"),
      OWNS_NOTHING
    );
    const snapshot = await BILLING.introspect(contained.read);
    expect(snapshot.tables).toEqual([]);
  });

  it("publishes a contained estate and hides the auto FK index", async () => {
    const server = serverWithForeignKey(foreignKeyRow("billing", "billing"));
    const snapshot = await BILLING.introspect(server.read);

    expect(snapshot.tables).toHaveLength(1);
    expect(snapshot.tables[0]?.foreignKeys).toEqual([
      {
        name: "users_org_fk",
        columns: ["org_id"],
        referencedTable: "orgs",
        referencedColumns: ["id"],
        onDelete: "cascade",
        onUpdate: "noAction",
      },
    ]);
    // The suppression set is built from the ADMITTED rows, so it is still
    // complete after the containment refusal runs.
    expect(snapshot.tables[0]?.indexes).toEqual([]);
  });

  it("keeps the published snapshot database-relative", async () => {
    const server = serverWithForeignKey(foreignKeyRow("billing", "billing"));
    const snapshot = await BILLING.introspect(server.read);
    expect(JSON.stringify(snapshot)).not.toContain("billing");
  });
});
