import { MigrationError, VibORMErrorCode } from "@src/errors";
import {
  canonicalizeJson,
  canonicalizeJsonText,
} from "@src/migrations/canonical-json";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { emptyManagedSnapshot } from "@src/migrations/empty-snapshot";
import {
  domainHash,
  HASH_DOMAIN,
  isSha256,
  parseSha256,
  sha256Hex,
  utf8Bytes,
} from "@src/migrations/identity";
import { fingerprintSnapshot } from "@src/migrations/push-fingerprint";
import {
  composeSqlBlob,
  refuseMysqlDelimiter,
  validateSqlRanges,
} from "@src/migrations/sql-blob";
import type { SchemaSnapshot } from "@src/migrations/types";
import {
  encodeDispatchIdentity,
  encodeEstateDescriptor,
  encodeSnapshot,
  encodeSqlBlob,
} from "@src/migrations/v1-parse";
import type { MigrationDispatchV1 } from "@src/migrations/v1-types";
import { describe, expect, test } from "vitest";

function uniqueEmailSnapshot(constraintName: string): SchemaSnapshot {
  return {
    tables: [
      {
        name: "user",
        columns: [{ name: "email", type: "TEXT", nullable: false }],
        indexes: [],
        foreignKeys: [],
        uniqueConstraints: [{ name: constraintName, columns: ["email"] }],
      },
    ],
    enums: [],
  };
}

function dispatch(
  bytes: Uint8Array,
  offset: number,
  length: number
): MigrationDispatchV1 {
  const sqlHash = encodeSqlBlob(bytes);
  const parameters: MigrationDispatchV1["parameters"] = [];
  return {
    dispatchId: encodeDispatchIdentity(sqlHash, offset, length, parameters),
    sqlHash,
    offset,
    length,
    parameters,
  };
}

describe("migration v1 identity", () => {
  test("canonical JSON sorts keys and rejects NaN", () => {
    expect(canonicalizeJsonText({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(() => canonicalizeJson({ x: Number.NaN })).toThrow(MigrationError);
  });

  test("same inputs produce the same estate and snapshot hashes", () => {
    const left = encodeEstateDescriptor({ dialect: "sqlite" });
    const right = encodeEstateDescriptor({ dialect: "sqlite" });
    expect(left.estateHash).toBe(right.estateHash);
    expect(isSha256(left.estateHash)).toBe(true);
    const snap = encodeSnapshot(emptyManagedSnapshot());
    expect(emptyManagedSnapshot()).toEqual({ tables: [], enums: [] });
    expect(snap.snapshotHash).toBe(
      encodeSnapshot(emptyManagedSnapshot()).snapshotHash
    );
  });

  test("domain labels prevent accidental digest collision", () => {
    const bytes = utf8Bytes('{"tables":[]}');
    expect(domainHash(HASH_DOMAIN.snapshot, bytes)).not.toBe(
      domainHash(HASH_DOMAIN.sql, bytes)
    );
    expect(domainHash(HASH_DOMAIN.snapshot, bytes)).not.toBe(sha256Hex(bytes));
    expect(domainHash(HASH_DOMAIN.event, bytes)).not.toBe(
      domainHash(HASH_DOMAIN.plan, bytes)
    );
  });

  test("SQL blob ranges leave only display separators", () => {
    const blob = composeSqlBlob(["SELECT 1", "SELECT 2"]);
    const dispatches = blob.ranges.map((range) =>
      dispatch(blob.bytes, range.offset, range.length)
    );
    expect(blob.sqlHash).toBe(encodeSqlBlob(blob.bytes));
    expect(blob.ranges).toHaveLength(2);
    expect(new TextDecoder().decode(blob.bytes)).toBe("SELECT 1\n\nSELECT 2");
    expect(() => validateSqlRanges(blob.bytes, dispatches)).not.toThrow();
  });

  test("SQL range validation refuses gaps, overlaps, and extra bytes", () => {
    const gap = utf8Bytes("a\n\nXb");
    expect(() =>
      validateSqlRanges(gap, [dispatch(gap, 0, 1), dispatch(gap, 4, 1)])
    ).toThrow(MigrationError);

    const overlap = utf8Bytes("ab");
    expect(() =>
      validateSqlRanges(overlap, [
        dispatch(overlap, 0, 2),
        dispatch(overlap, 1, 1),
      ])
    ).toThrow(MigrationError);

    const extra = utf8Bytes("aX");
    expect(() => validateSqlRanges(extra, [dispatch(extra, 0, 1)])).toThrow(
      MigrationError
    );

    const wrongSeparator = utf8Bytes("a b");
    expect(() =>
      validateSqlRanges(wrongSeparator, [
        dispatch(wrongSeparator, 0, 1),
        dispatch(wrongSeparator, 2, 1),
      ])
    ).toThrow(MigrationError);
  });

  test("only one final newline may trail the last SQL range", () => {
    const optionalNewline = utf8Bytes("a\n");
    expect(() =>
      validateSqlRanges(optionalNewline, [dispatch(optionalNewline, 0, 1)])
    ).not.toThrow();

    const extraNewline = utf8Bytes("a\n\n");
    expect(() =>
      validateSqlRanges(extraNewline, [dispatch(extraNewline, 0, 1)])
    ).toThrow(MigrationError);
  });

  test("manual CRLF and DELIMITER are refused", () => {
    expect(() => composeSqlBlob(["SELECT 1\r\n"])).toThrow(MigrationError);
    expect(() => refuseMysqlDelimiter("DELIMITER //")).toThrow(MigrationError);
    const crlf = utf8Bytes("SELECT 1\r\n");
    expect(() =>
      validateSqlRanges(crlf, [dispatch(crlf, 0, crlf.length)])
    ).toThrow(MigrationError);
  });

  test("catalog array aliases fingerprint as the declared element type", () => {
    const catalog: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [{ name: "ids", type: "int4[]", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const declared: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [{ name: "ids", type: "integer[]", nullable: false }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    expect(fingerprintSnapshot(catalog, postgresMigrationDriver)).toBe(
      fingerprintSnapshot(declared, postgresMigrationDriver)
    );
  });

  test("NOW() fingerprints as the catalog now() spelling", () => {
    const generated: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [
            {
              name: "createdAt",
              type: "timestamptz",
              nullable: false,
              default: "NOW()",
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const catalog: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [
            {
              name: "createdAt",
              type: "timestamptz",
              nullable: false,
              default: "now()",
            },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    expect(fingerprintSnapshot(generated, postgresMigrationDriver)).toBe(
      fingerprintSnapshot(catalog, postgresMigrationDriver)
    );
  });

  test("a SQL NULL default fingerprints as an omitted default", () => {
    const withNull: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [
            { name: "label", type: "text", nullable: true, default: "NULL" },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const omitted: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [{ name: "label", type: "text", nullable: true }],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    expect(fingerprintSnapshot(withNull, postgresMigrationDriver)).toBe(
      fingerprintSnapshot(omitted, postgresMigrationDriver)
    );
  });

  test("sqlite INTEGER PRIMARY KEY without AUTOINCREMENT is not autoIncrement", () => {
    const declared: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [
            {
              name: "id",
              type: "INTEGER",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"] },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    const implicitRowid: SchemaSnapshot = {
      tables: [
        {
          name: "item",
          columns: [
            {
              name: "id",
              type: "INTEGER",
              nullable: false,
              autoIncrement: true,
            },
          ],
          primaryKey: { columns: ["id"] },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
    };
    expect(fingerprintSnapshot(declared, sqlite3MigrationDriver)).not.toBe(
      fingerprintSnapshot(implicitRowid, sqlite3MigrationDriver)
    );
  });

  test("sqlite live fingerprints ignore unique constraint names", () => {
    const named = uniqueEmailSnapshot("user_email_key");
    const sqliteNamed = uniqueEmailSnapshot("sqlite_autoindex_user_2");
    expect(encodeSnapshot(named).snapshotHash).not.toBe(
      encodeSnapshot(sqliteNamed).snapshotHash
    );
    expect(fingerprintSnapshot(named, sqlite3MigrationDriver)).toBe(
      fingerprintSnapshot(sqliteNamed, sqlite3MigrationDriver)
    );
    expect(fingerprintSnapshot(named, postgresMigrationDriver)).not.toBe(
      fingerprintSnapshot(sqliteNamed, postgresMigrationDriver)
    );
  });

  test("hostile sha256 values are refused", () => {
    expect(() => parseSha256("ABC", "id")).toThrow(MigrationError);
    try {
      parseSha256("not-a-hash", "id");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      expect(error).toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      });
    }
  });
});
