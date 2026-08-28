import { sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "@src/errors";
import {
  classifyStoredAtomicity,
  compileManualTransition,
  encodeParameter,
} from "@src/migrations/compile";
import { invertOperations } from "@src/migrations/invert";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import { describe, expect, test } from "vitest";
import Decimal from "decimal.js";

const NO_DATA_PRESERVED = /No data is preserved/;

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
});
