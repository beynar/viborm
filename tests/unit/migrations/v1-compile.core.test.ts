import { sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "@src/errors";
import {
  assertManualStepwiseProof,
  assertTransactionalBoundaryHonored,
  classifyGeneratedAtomicity,
  classifyStoredAtomicity,
  compileManualTransition,
  decodeParameter,
  encodeParameter,
  groupContiguousAtomicity,
  hashParent,
  rebindChecks,
  rebindDispatches,
  rebindRollback,
  sealParent,
} from "@src/migrations/compile";
import { getMigrationDriver } from "@src/migrations/drivers";
import { invertOperations } from "@src/migrations/invert";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  sqliteEstateDriver,
} from "./_estate";

const NO_DATA_PRESERVED = /No data is preserved/;
const SHA_256 = /^[a-f0-9]{64}$/;

describe("migration v1 compiler", () => {
  test("parameter codec refuses NaN and functions", () => {
    expect(() => encodeParameter(Number.NaN)).toThrow(MigrationError);
    expect(() => encodeParameter(() => 1)).toThrow(MigrationError);
    expect(encodeParameter(null)).toEqual({ kind: "null" });
    expect(encodeParameter(2n)).toEqual({ kind: "bigint", value: "2" });
    expect(encodeParameter(new Decimal("12.3400"))).toEqual({
      kind: "decimal",
      value: "12.34",
    });
  });

  test("byte parameters round-trip without a Buffer global", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    Reflect.deleteProperty(globalThis, "Buffer");
    let encoded: ReturnType<typeof encodeParameter> | undefined;
    let decoded: unknown;
    try {
      encoded = encodeParameter(Uint8Array.of(0, 1, 254, 255));
      decoded = decodeParameter(encoded);
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "Buffer", descriptor);
      }
    }
    expect(encoded).toEqual({ kind: "bytes", value: "AAH+/w==" });
    expect(decoded).toEqual(Uint8Array.of(0, 1, 254, 255));
  });

  test("manual Sql is one opaque dispatch and never splits", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1; SELECT 2`],
      { kind: "irreversible", reason: "demo" },
      "sqlite",
      "stepwise",
      undefined,
      assembly
    );
    expect(compiled.operations).toHaveLength(1);
    expect(compiled.operations[0]!.steps).toHaveLength(1);
    expect(compiled.operations[0]!.steps[0]!.retry).toBe("opaque");
    const sealed = assembly.seal();
    expect(sealed.dispatches).toHaveLength(1);
  });

  test("MySQL refuses a transactional manual boundary", () => {
    try {
      classifyStoredAtomicity(
        { dialect: "mysql", target: { dialect: "mysql" } } as never,
        "transactional",
        []
      );
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
      );
    }
  });

  test("empty generated program inverts to an empty schema rollback", () => {
    const inverted = invertOperations([], { tables: [], enums: [] });
    expect(inverted.operations).toEqual([]);
  });

  test("createTable inverts to dropTable and warns about data loss", () => {
    const inverted = invertOperations(
      [
        {
          type: "createTable",
          table: {
            name: "user",
            columns: [],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        },
      ],
      { tables: [], enums: [] }
    );
    expect(inverted.operations).toEqual([
      { type: "dropTable", tableName: "user" },
    ]);
    expect(inverted.warnings[0]).toMatch(NO_DATA_PRESERVED);
  });

  test("parameter codec round-trips every persisted scalar arm", () => {
    const instant = new Date("2026-08-31T10:15:30.123Z");
    const json = { nested: [1, true, null] };
    const values = [
      undefined,
      true,
      "text",
      12.5,
      7n,
      instant,
      Uint8Array.of(1, 2, 3),
      new Decimal("4.50"),
      json,
    ];
    const encoded = values.map(encodeParameter);

    expect(encoded.map((parameter) => parameter.kind)).toEqual([
      "null",
      "boolean",
      "string",
      "number",
      "bigint",
      "date-time",
      "bytes",
      "decimal",
      "json",
    ]);
    expect(encoded.map((parameter) => decodeParameter(parameter))).toEqual([
      null,
      true,
      "text",
      12.5,
      7n,
      instant,
      Uint8Array.of(1, 2, 3),
      "4.5",
      json,
    ]);
    expect(() => encodeParameter(Number.POSITIVE_INFINITY)).toThrow(
      MigrationError
    );
    expect(() => encodeParameter(Symbol("nope"))).toThrow(MigrationError);
  });

  test("target namespaces and canonical byte parameters fail closed", () => {
    expect(decodeParameter({ kind: "target-namespace" }, "tenant")).toBe(
      "tenant"
    );
    expect(() => decodeParameter({ kind: "target-namespace" })).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
    expect(() =>
      decodeParameter({ kind: "bytes", value: "not base64" })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
  });

  test("manual programs reject empty and whitespace-only dispatch lists", () => {
    expect(() =>
      compileManualTransition(
        [],
        { kind: "irreversible", reason: "test" },
        "sqlite",
        "stepwise",
        undefined,
        new SqlAssembly()
      )
    ).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("forward") })
    );
    expect(() =>
      compileManualTransition(
        [sql.raw("   ")],
        { kind: "irreversible", reason: "test" },
        "sqlite",
        "stepwise",
        undefined,
        new SqlAssembly()
      )
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("whitespace"),
      })
    );
    expect(() =>
      compileManualTransition(
        [sql`SELECT 1`],
        { kind: "manual", execution: "stepwise", sql: [] },
        "sqlite",
        "transactional",
        undefined,
        new SqlAssembly()
      )
    ).toThrowError(
      expect.objectContaining({ message: expect.stringContaining("rollback") })
    );
  });

  test("compiled placeholders rebind across checks, proven steps, and rollback", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT ${2}`],
      { kind: "manual", execution: "transactional", sql: [sql`SELECT ${3}`] },
      "sqlite",
      "transactional",
      [{ kind: "trusted-read", query: sql`SELECT ${1}`, equals: true }],
      assembly
    );
    const sealed = assembly.seal();
    const operations = rebindDispatches(compiled.operations, sealed.dispatches);
    const checks = rebindChecks(compiled.originChecks, sealed.dispatches);
    const rollback = rebindRollback(compiled.rollback, sealed.dispatches);
    const parent = sealParent(null, {
      ...compiled,
      operations,
      originChecks: checks,
      rollback,
    });

    expect(operations[0]?.steps[0]?.execute.sqlHash).toBe(sealed.sqlHash);
    expect(checks[0]?.query.sqlHash).toBe(sealed.sqlHash);
    expect(rollback.kind).toBe("manual");
    expect(hashParent(parent).transitionHash).toMatch(SHA_256);
    expect(
      rebindRollback(
        { kind: "irreversible", reason: "none" },
        sealed.dispatches
      )
    ).toEqual({ kind: "irreversible", reason: "none" });
  });

  test("atomicity grouping preserves boundaries and provider capabilities", () => {
    expect(
      groupContiguousAtomicity([
        { boundary: "transactional", id: 1 },
        { boundary: "transactional", id: 2 },
        { boundary: "stepwise", id: 3 },
      ])
    ).toEqual([
      {
        boundary: "transactional",
        items: [
          { boundary: "transactional", id: 1 },
          { boundary: "transactional", id: 2 },
        ],
      },
      { boundary: "stepwise", items: [{ boundary: "stepwise", id: 3 }] },
    ]);
    expect(groupContiguousAtomicity([])).toEqual([]);

    const sqlite = getMigrationDriver(sqliteEstateDriver());
    const postgres = getMigrationDriver(pgEstateDriver("public"));
    const mysql = getMigrationDriver(
      mysqlEstateDriver({ namespace: "tenant", attested: true })
    );
    expect(classifyGeneratedAtomicity(mysql, [])).toBe("stepwise");
    expect(classifyGeneratedAtomicity(sqlite, [])).toBe("transactional");
    expect(
      classifyGeneratedAtomicity(postgres, [
        {
          type: "alterEnum",
          enumName: "status",
          addValues: ["ready"],
          removeValues: [],
        },
      ])
    ).toBe("stepwise");
    expect(classifyStoredAtomicity(sqlite, "stepwise", [])).toBe("stepwise");
    for (const statement of [
      "CREATE INDEX CONCURRENTLY ix_user_email ON user (email)",
      "ALTER TYPE status ADD VALUE 'ready'",
    ]) {
      const assembly = new SqlAssembly();
      const compiled = compileManualTransition(
        [sql.raw(statement)],
        { kind: "irreversible", reason: "test" },
        "postgresql",
        "transactional",
        undefined,
        assembly
      );
      const sealed = assembly.seal();
      expect(
        classifyStoredAtomicity(
          postgres,
          null,
          rebindDispatches(compiled.operations, sealed.dispatches),
          sealed.bytes
        )
      ).toBe("stepwise");
    }
    expect(() =>
      assertTransactionalBoundaryHonored(false, "transactional")
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      })
    );
    expect(() =>
      assertTransactionalBoundaryHonored(false, "stepwise")
    ).not.toThrow();
  });

  test("stepwise manual proof requires both origin and destination checks", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      { kind: "irreversible", reason: "test" },
      "sqlite",
      "stepwise",
      undefined,
      assembly
    );
    expect(() => assertManualStepwiseProof(compiled, [])).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
    const transactional = {
      ...compiled,
      requestedForwardBoundary: "transactional" as const,
    };
    expect(() => assertManualStepwiseProof(transactional, [])).not.toThrow();
  });
});

describe("coverage low value", () => {
  test("unknown persisted parameter kinds retain an exhaustive runtime refusal", () => {
    expect(() =>
      Reflect.apply(decodeParameter, undefined, [{ kind: "future" }])
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      })
    );
  });

  test("a missing assembly slot is an internal compiler error", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1`],
      { kind: "irreversible", reason: "test" },
      "sqlite",
      "transactional",
      undefined,
      assembly
    );
    expect(() => rebindDispatches(compiled.operations, [])).toThrowError(
      expect.objectContaining({ code: VibORMErrorCode.INTERNAL_ERROR })
    );
  });
});
