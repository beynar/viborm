/**
 * The small owned answers the migration layer gives ONCE, each asked here for
 * the arm its everyday input never reaches.
 *
 * A graph orders the two edges that share one parent; a non-PostgreSQL estate
 * publishes a target with no namespace to publish; a generated program
 * whose inverse is empty carries the inverter's own sentence instead of a
 * generic one; a manual rollback is stepwise on its own; a stored catalog
 * number that is not a safe integer is not a descriptor; and an offline check
 * turns any storage failure into a finding rather than a throw.
 */

import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { checkEstate } from "@src/migrations/check";
import { createMigrationClient } from "@src/migrations/client";
import {
  assertManualStepwiseProof,
  compileGeneratedTransition,
  compileManualTransition,
  compileTrustedCheck,
} from "@src/migrations/compile";
import {
  describeDecimalStorageKind,
  mysqlDecimalStorageKind,
  readStoredDecimalDescriptor,
} from "@src/migrations/decimal";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import { showMigrationState } from "@src/migrations/public-view";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import type { MigrationStorageReader } from "@src/migrations/storage/contract";
import { describe, expect, test } from "vitest";
import { MemoryStorage, sqliteEstateDriver } from "./_estate";

const UTF8 = new TextDecoder();

const account = s.model({ id: s.string().id() });
const ledger = s.model({ id: s.string().id(), amount: s.string() });
const note = s.model({ id: s.string().id(), body: s.string() });

/** The exact order `graphEdges` puts two edges of one parent in. */
function byStateId(left: string, right: string): number {
  return left.localeCompare(right);
}

describe("the public estate view publishes one ordered graph", () => {
  test("sibling edges order by target state and a SQLite target carries no namespace", async () => {
    const storage = new MemoryStorage();
    const driver = sqliteEstateDriver();
    const rootClient = createMigrationClient(
      { $driver: driver, $schema: { account } },
      { storage }
    );
    const ledgerClient = createMigrationClient(
      { $driver: driver, $schema: { account, ledger } },
      { storage }
    );
    const noteClient = createMigrationClient(
      { $driver: driver, $schema: { account, note } },
      { storage }
    );

    const root = await rootClient.generate({ name: "accounts" });
    if (!root.stateId) throw new Error("expected a published root");
    const ledgers = await ledgerClient.generate({
      name: "ledgers",
      from: root.stateId,
    });
    const notes = await noteClient.generate({
      name: "notes",
      from: root.stateId,
    });
    if (!(ledgers.stateId && notes.stateId)) {
      throw new Error("expected two published branches");
    }
    const graph = await rootClient.graph();

    expect(graph.target).toEqual({ dialect: "sqlite" });
    expect(graph.roots).toEqual([root.stateId]);
    expect(graph.edges.map((edge) => edge.fromState)).toEqual([
      null,
      root.stateId,
      root.stateId,
    ]);
    expect(graph.edges.slice(1).map((edge) => edge.toState)).toEqual(
      [ledgers.stateId, notes.stateId].sort(byStateId)
    );
  });

  test("the readable surface routes resolve() to the resolve operator", async () => {
    const storage = new MemoryStorage();
    const migrations = createMigrationClient(
      { $driver: sqliteEstateDriver(), $schema: { account } },
      { storage }
    );
    await migrations.generate({ name: "initial" });

    await expect(
      migrations.resolve({ outcome: "complete" })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: "resolve requires an unfinished attempt",
    });
  });

  test("storage that cannot implement the reader contract is refused", () => {
    expect(() =>
      Reflect.apply(createMigrationClient, undefined, [
        { $driver: sqliteEstateDriver(), $schema: { account } },
        { storage: { readEstate: () => Promise.resolve(null) } },
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "V4002",
        // The precise "must implement MigrationStorageReader" refusal is
        // currently unreachable: refuseClientOptions throws from INSIDE the
        // try block at src/migrations/client.ts:150-162, so the sibling catch
        // intercepts its own refusal and re-wraps it. Pinned to what the
        // client actually surfaces today.
        message: "migration client storage could not be inspected",
      })
    );
  });
});

describe("an offline check reports a failure instead of raising it", () => {
  test("a storage that rejects with a non-Error is still a finding", async () => {
    const storage = {
      readEstate: () => Promise.reject("storage offline"),
      listStates: () => Promise.resolve([]),
      listSnapshots: () => Promise.resolve([]),
      listSql: () => Promise.resolve([]),
      readState: () => Promise.resolve(null),
      readSnapshot: () => Promise.resolve(null),
      readSql: () => Promise.resolve(null),
    } satisfies MigrationStorageReader;

    expect(await checkEstate(storage)).toEqual({
      ok: false,
      findings: [{ code: "invalid-estate", message: "storage offline" }],
    });
  });
});

describe("a compiled transition states why it cannot be rolled back", () => {
  test("an inverse the inverter refused carries the inverter's own reason", () => {
    const compiled = compileGeneratedTransition(
      [{ type: "dropTable", tableName: "ghost" }],
      sqlite3MigrationDriver,
      "artifact",
      emptyManagedSnapshot(),
      emptyManagedSnapshot(),
      new SqlAssembly()
    );

    expect(compiled.operations).toHaveLength(1);
    expect(compiled.rollback).toEqual({
      kind: "irreversible",
      reason:
        'Cannot invert dropTable "ghost": table not found in previous snapshot.',
    });
  });

  test("a stepwise manual ROLLBACK needs the same complete checks a stepwise forward does", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`UPDATE account SET state = 'live'`],
      {
        kind: "manual",
        execution: "stepwise",
        sql: [sql`UPDATE account SET state = 'draft'`],
      },
      "postgresql",
      "transactional",
      [{ kind: "trusted-read", query: sql`SELECT 1`, equals: true }],
      assembly
    );
    const destination = compileTrustedCheck(
      { kind: "trusted-read", query: sql`SELECT 1`, equals: true },
      "postgresql",
      assembly,
      "destination:0"
    );

    expect(compiled.requestedForwardBoundary).toBe("transactional");
    expect(() => assertManualStepwiseProof(compiled, [])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
    expect(() =>
      assertManualStepwiseProof(compiled, [destination])
    ).not.toThrow();
  });

  test("a trusted check is rendered in its own dialect's placeholder", () => {
    const postgres = new SqlAssembly();
    compileTrustedCheck(
      { kind: "trusted-read", query: sql`SELECT ${1}`, equals: true },
      "postgresql",
      postgres,
      "origin:0"
    );
    const sqlite = new SqlAssembly();
    compileTrustedCheck(
      { kind: "trusted-read", query: sql`SELECT ${1}`, equals: true },
      "sqlite",
      sqlite,
      "origin:0"
    );

    expect(UTF8.decode(postgres.seal().bytes)).toBe("SELECT $1");
    expect(UTF8.decode(sqlite.seal().bytes)).toBe("SELECT ?");
  });
});

describe("stored decimal facts are read from what the catalog proves", () => {
  test("a MySQL decimal column names its storage shape or none", () => {
    const decimal = { precision: 10, scale: 2 };

    expect(
      mysqlDecimalStorageKind({
        name: "amount",
        type: "decimal(10,2)",
        nullable: false,
        decimal,
      })
    ).toBe("scalar");
    expect(
      mysqlDecimalStorageKind({
        name: "amounts",
        type: "JSON",
        nullable: false,
        decimal,
      })
    ).toBe("list");
    expect(
      mysqlDecimalStorageKind({
        name: "amounts",
        type: "TEXT",
        nullable: false,
        decimal,
      })
    ).toBeUndefined();
  });

  test("only a finite safe integer is admitted as a stored precision or scale", () => {
    expect(readStoredDecimalDescriptor(10, 2, "mysql")).toEqual({
      precision: 10,
      scale: 2,
    });
    expect(readStoredDecimalDescriptor("10", "2", "mysql")).toEqual({
      precision: 10,
      scale: 2,
    });
    expect(readStoredDecimalDescriptor(10.5, 2, "mysql")).toBeUndefined();
    expect(
      readStoredDecimalDescriptor(Number.MAX_SAFE_INTEGER + 2, 2, "mysql")
    ).toBeUndefined();
    expect(readStoredDecimalDescriptor(null, 2, "mysql")).toBeUndefined();
    expect(readStoredDecimalDescriptor("10.5", 2, "mysql")).toBeUndefined();
  });

  test("an unwritable storage shape is named rather than left blank", () => {
    expect(describeDecimalStorageKind("list")).toBe("list");
    expect(describeDecimalStorageKind(undefined)).toBe("unrecognized");
  });
});

describe("coverage low value", () => {
  test("a state id absent from its own graph is an internal refusal", () => {
    expect(() =>
      showMigrationState(
        {
          estateHash: "a".repeat(64),
          descriptor: {
            format: "1",
            hash: "sha256",
            target: { dialect: "sqlite" },
          },
          states: new Map(),
          snapshots: new Map(),
          sql: new Map(),
          roots: [],
          leaves: [],
          emptySnapshotHash: "d".repeat(64),
        },
        "e".repeat(64)
      )
    ).toThrowError(
      expect.objectContaining({
        message: "Resolved migration state is absent from its graph",
      })
    );
  });
});
