import { sql } from "@sql";
import { MigrationError, VibORMErrorCode } from "@src/errors";
import { compileManualTransition } from "@src/migrations/compile";
import { SqlAssembly } from "@src/migrations/sql-assembly";
import {
  composeSqlBlob,
  encodeSqlText,
  refuseMysqlDelimiter,
  sliceDispatch,
  validateSqlRanges,
} from "@src/migrations/sql-blob";
import {
  encodeDispatchIdentity,
  encodeSqlBlob,
  parseDispatch,
} from "@src/migrations/v1-parse";
import type {
  MigrationDispatchV1,
  MigrationParameterV1,
} from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

function dispatchAt(
  blob: ReturnType<typeof composeSqlBlob>,
  index: number,
  parameters: readonly MigrationParameterV1[] = []
): MigrationDispatchV1 {
  const range = blob.ranges[index];
  if (!range) throw new Error(`Missing SQL range ${index}`);
  return {
    dispatchId: encodeDispatchIdentity(
      blob.sqlHash,
      range.offset,
      range.length,
      parameters
    ),
    sqlHash: blob.sqlHash,
    offset: range.offset,
    length: range.length,
    parameters,
  };
}

describe("migration v1 SQL framing", () => {
  test("generated fragments are joined by exactly two LF bytes", () => {
    const blob = composeSqlBlob(["SELECT 1", "SELECT 2"]);
    expect(blob.bytes).toEqual(
      new TextEncoder().encode("SELECT 1\n\nSELECT 2")
    );
    expect(blob.ranges[1]!.offset).toBe("SELECT 1\n\n".length);
    validateSqlRanges(blob.bytes, [dispatchAt(blob, 0), dispatchAt(blob, 1)]);
  });

  test("a PostgreSQL dollar-quoted body stays one opaque fragment", () => {
    const fragment = [
      "CREATE FUNCTION f() RETURNS void AS $tag$",
      "BEGIN",
      "  -- a semicolon; inside a comment is not a statement",
      "  PERFORM $inner$ ; $inner$;",
      "END",
      "$tag$ LANGUAGE plpgsql",
    ].join("\n");
    const blob = composeSqlBlob([fragment]);
    expect(blob.ranges).toHaveLength(1);
    expect(sliceDispatch(blob.bytes, dispatchAt(blob, 0))).toBe(fragment);
    validateSqlRanges(blob.bytes, [dispatchAt(blob, 0)]);
  });

  test("a MySQL procedure body with internal semicolons stays one fragment", () => {
    const fragment =
      "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND";
    const blob = composeSqlBlob([fragment]);
    expect(blob.ranges).toHaveLength(1);
    validateSqlRanges(blob.bytes, [dispatchAt(blob, 0)]);
  });

  test("an SQLite trigger body with quoted semicolons stays one fragment", () => {
    const fragment =
      'CREATE TRIGGER t AFTER INSERT ON users BEGIN\n  INSERT INTO log(msg) VALUES ("done;");\nEND';
    const blob = composeSqlBlob([fragment]);
    expect(blob.ranges).toHaveLength(1);
    validateSqlRanges(blob.bytes, [dispatchAt(blob, 0)]);
  });

  test("manual CRLF and BOM are refused before composition", () => {
    expect(() => encodeSqlText("SELECT 1\r\n")).toThrow(MigrationError);
    expect(() => encodeSqlText("\uFEFFSELECT 1")).toThrow(MigrationError);
  });

  test("MySQL DELIMITER is a client command and is refused", () => {
    expect(() => refuseMysqlDelimiter("DELIMITER //")).toThrow(MigrationError);
    expect(() => refuseMysqlDelimiter("  delimiter  ;;")).toThrow(
      MigrationError
    );
    expect(() => refuseMysqlDelimiter("SELECT 1")).not.toThrow();
    const assembly = new SqlAssembly();
    expect(() =>
      assembly.add("CREATE PROCEDURE p() BEGIN SELECT 1; END;\nDELIMITER //")
    ).toThrow(MigrationError);
    try {
      refuseMysqlDelimiter("DELIMITER //");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_INVALID_ESTATE
      );
    }
  });

  test("ranges are UTF-8 byte offsets, not code-unit indexes", () => {
    const cafe = "SELECT 'café'";
    const emoji = "SELECT '😀'";
    const blob = composeSqlBlob([cafe, emoji]);
    const cafeBytes = new TextEncoder().encode(cafe);
    const emojiBytes = new TextEncoder().encode(emoji);
    expect(cafeBytes.length).toBeGreaterThan(cafe.length);
    expect(blob.ranges[0]).toMatchObject({
      offset: 0,
      length: cafeBytes.length,
    });
    expect(blob.ranges[1]!.offset).toBe(cafeBytes.length + 2);
    expect(blob.ranges[1]!.length).toBe(emojiBytes.length);
    expect(sliceDispatch(blob.bytes, dispatchAt(blob, 0))).toBe(cafe);
    expect(sliceDispatch(blob.bytes, dispatchAt(blob, 1))).toBe(emoji);
    expect(new TextDecoder().decode(blob.bytes).includes("\r")).toBe(false);
  });

  test("one manual Sql with multiple provider statements is one opaque dispatch", () => {
    const assembly = new SqlAssembly();
    const compiled = compileManualTransition(
      [sql`SELECT 1; SELECT 2; SELECT 3`],
      { kind: "irreversible", reason: "manual multi-statement" },
      "sqlite",
      "stepwise",
      undefined,
      assembly
    );
    expect(compiled.operations).toHaveLength(1);
    expect(compiled.operations[0]!.steps).toHaveLength(1);
    expect(compiled.operations[0]!.steps[0]!.retry).toBe("opaque");
    expect(compiled.operations[0]!.origin).toBe("manual");
    const sealed = assembly.seal();
    expect(sealed.dispatches).toHaveLength(1);
    expect(new TextDecoder().decode(sealed.bytes)).toBe(
      "SELECT 1; SELECT 2; SELECT 3"
    );
  });

  test("overlapping ranges and unclaimed gaps refuse", () => {
    const blob = composeSqlBlob(["SELECT 1", "SELECT 2"]);
    const first = dispatchAt(blob, 0);
    const second = dispatchAt(blob, 1);
    expect(() =>
      validateSqlRanges(blob.bytes, [
        first,
        { ...second, offset: first.offset },
      ])
    ).toThrow(MigrationError);
    expect(() =>
      validateSqlRanges(blob.bytes, [
        first,
        { ...second, offset: second.offset + 1 },
      ])
    ).toThrow(MigrationError);
  });

  test("a trailing single LF after the last range is allowed; other trailing bytes are not", () => {
    const blob = composeSqlBlob(["SELECT 1"]);
    const dispatch = dispatchAt(blob, 0);
    const withLf = new Uint8Array(blob.bytes.length + 1);
    withLf.set(blob.bytes);
    withLf[blob.bytes.length] = 0x0a;
    const sqlHash = encodeSqlBlob(withLf);
    validateSqlRanges(withLf, [
      {
        ...dispatch,
        sqlHash,
        dispatchId: encodeDispatchIdentity(
          sqlHash,
          dispatch.offset,
          dispatch.length,
          []
        ),
      },
    ]);
    const junk = new Uint8Array(blob.bytes.length + 1);
    junk.set(blob.bytes);
    junk[blob.bytes.length] = 0x20;
    expect(() => validateSqlRanges(junk, [dispatch])).toThrow(MigrationError);
  });

  test("an altered sqlHash is blob corruption; an altered dispatchId fails parse", () => {
    const blob = composeSqlBlob(["SELECT 1"]);
    const dispatch = dispatchAt(blob, 0);
    try {
      validateSqlRanges(blob.bytes, [{ ...dispatch, sqlHash: "1".repeat(64) }]);
      throw new Error("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect((error as MigrationError).code).toBe(
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    expect(() =>
      parseDispatch({ ...dispatch, dispatchId: "1".repeat(64) }, "dispatch")
    ).toThrow(MigrationError);
  });
});
