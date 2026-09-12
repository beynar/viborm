import { s } from "@schema";
import type { ScalarState } from "@schema/scalars/common";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import {
  describeIdNativeTypes,
  type IdDialect,
  idDomainOfState,
  idStorageOf,
} from "@schema/scalars/string/id-domain";
import type { IdDomain } from "@validation/primitives/id-codec";
import { describe, expect, test } from "vitest";

const stateOf = (scalar: { "~": { state: ScalarState } }): ScalarState =>
  scalar["~"].state;

const domain = (
  format: IdDomain["format"],
  extra: Omit<IdDomain, "format"> = {}
): IdDomain => ({ format, ...extra });

describe("the declared domain", () => {
  test("every generator modifier declares its own domain", () => {
    expect(idDomainOfState(stateOf(s.string().uuid()))).toMatchObject({
      format: "uuid",
    });
    expect(idDomainOfState(stateOf(s.string().uuidv7()))).toMatchObject({
      format: "uuidv7",
    });
    expect(idDomainOfState(stateOf(s.string().ulid()))).toMatchObject({
      format: "ulid",
    });
    expect(idDomainOfState(stateOf(s.string().ksuid()))).toMatchObject({
      format: "ksuid",
    });
    expect(idDomainOfState(stateOf(s.string().cuid()))).toMatchObject({
      format: "cuid",
    });
  });

  test("a bare `.id()` declares a KEY, not a domain", () => {
    // The generator it installs was never NAMED by the caller, so it asserts
    // nothing about the values the field will hold and narrows no storage.
    expect(idDomainOfState(stateOf(s.string().id()))).toBeUndefined();
    expect(idDomainOfState(stateOf(s.string().id("usr")))).toBeUndefined();
  });

  test("naming the format is what declares the domain a key carries", () => {
    expect(idDomainOfState(stateOf(s.string().ulid().id()))).toMatchObject({
      format: "ulid",
    });
    expect(idDomainOfState(stateOf(s.string().id().uuid("usr")))).toMatchObject(
      {
        format: "uuid",
        prefix: "usr",
      }
    );
  });

  test("the prefix and the nanoid length come from the declaration", () => {
    expect(idDomainOfState(stateOf(s.string().uuid("usr")))).toMatchObject({
      format: "uuid",
      prefix: "usr",
    });
    expect(idDomainOfState(stateOf(s.string().nanoid(8, "n")))).toMatchObject({
      format: "nanoid",
      length: 8,
      prefix: "n",
    });
  });

  test("the last generator spelled is the declared domain", () => {
    expect(idDomainOfState(stateOf(s.string().uuid().ulid()))).toMatchObject({
      format: "ulid",
    });
  });

  test("a plain string, a non-string scalar and a list declare none", () => {
    expect(idDomainOfState(stateOf(s.string()))).toBeUndefined();
    expect(idDomainOfState(stateOf(s.int().increment()))).toBeUndefined();
    expect(idDomainOfState(stateOf(s.dateTime().now()))).toBeUndefined();
    expect(idDomainOfState(stateOf(s.string().uuid().array()))).toBeUndefined();
    expect(idDomainOfState(undefined)).toBeUndefined();
  });

  test("the projection is one object per state, not one per lookup", () => {
    const state = stateOf(s.string().uuid("usr"));
    expect(idDomainOfState(state)).toBe(idDomainOfState(state));
  });

  test("a custom `.default(fn)` keeps the declared domain", () => {
    const state = stateOf(
      s
        .string()
        .uuid("usr")
        .default(() => "usr-x")
    );
    expect(idDomainOfState(state)).toMatchObject({
      format: "uuid",
      prefix: "usr",
    });
  });
});

describe("automatic storage", () => {
  const storage = (
    format: IdDomain["format"],
    dialect: IdDialect
  ): { representation: string; columnType: string } =>
    idStorageOf(domain(format), undefined, dialect)!;

  test("PostgreSQL gives uuid formats its own uuid type, read as text", () => {
    expect(storage("uuid", "pg")).toEqual({
      representation: "uuid",
      columnType: "uuid",
    });
    expect(storage("uuidv7", "pg")).toEqual({
      representation: "uuid",
      columnType: "uuid",
    });
  });

  test("a ULID is never spelled as a uuid", () => {
    expect(storage("ulid", "pg")).toEqual({
      representation: "bytes",
      columnType: "bytea",
    });
    expect(storage("ksuid", "pg")).toEqual({
      representation: "bytes",
      columnType: "bytea",
    });
  });

  test("MySQL sizes the binary column to the format's own width", () => {
    expect(storage("uuid", "mysql")).toEqual({
      representation: "bytes",
      columnType: "BINARY(16)",
    });
    expect(storage("ulid", "mysql")).toEqual({
      representation: "bytes",
      columnType: "BINARY(16)",
    });
    expect(storage("ksuid", "mysql")).toEqual({
      representation: "bytes",
      columnType: "BINARY(20)",
    });
  });

  test("SQLite stores every compact format as a BLOB", () => {
    for (const format of ["uuid", "uuidv7", "ulid", "ksuid"] as const) {
      expect(storage(format, "sqlite")).toEqual({
        representation: "bytes",
        columnType: "BLOB",
      });
    }
  });

  test("nanoid and cuid keep the text column they already had", () => {
    expect(storage("nanoid", "pg")).toEqual({
      representation: "text",
      columnType: "text",
    });
    expect(storage("cuid", "mysql")).toEqual({
      representation: "text",
      columnType: "TEXT",
    });
    expect(storage("cuid", "sqlite")).toEqual({
      representation: "text",
      columnType: "TEXT",
    });
  });

  test("a prefix does not change the physical type", () => {
    expect(
      idStorageOf(domain("uuid", { prefix: "usr" }), undefined, "pg")
    ).toEqual({ representation: "uuid", columnType: "uuid" });
  });
});

describe("native type overrides", () => {
  test("a text-family override keeps text storage on every dialect", () => {
    expect(idStorageOf(domain("uuid"), PG.STRING.TEXT, "pg")).toEqual({
      representation: "text",
      columnType: "text",
    });
    expect(idStorageOf(domain("ulid"), PG.STRING.VARCHAR(26), "pg")).toEqual({
      representation: "text",
      columnType: "varchar(26)",
    });
    expect(idStorageOf(domain("ulid"), PG.STRING.CHAR(26), "pg")).toEqual({
      representation: "text",
      columnType: "char(26)",
    });
    expect(idStorageOf(domain("uuid"), PG.STRING.CITEXT, "pg")).toEqual({
      representation: "text",
      columnType: "citext",
    });
    expect(
      idStorageOf(domain("uuid"), MYSQL.STRING.VARCHAR(36), "mysql")
    ).toEqual({ representation: "text", columnType: "VARCHAR(36)" });
    expect(idStorageOf(domain("uuid"), MYSQL.STRING.CHAR(36), "mysql")).toEqual(
      {
        representation: "text",
        columnType: "CHAR(36)",
      }
    );
    expect(idStorageOf(domain("uuid"), MYSQL.STRING.LONGTEXT, "mysql")).toEqual(
      { representation: "text", columnType: "LONGTEXT" }
    );
    expect(idStorageOf(domain("uuid"), SQLITE.STRING.TEXT, "sqlite")).toEqual({
      representation: "text",
      columnType: "TEXT",
    });
  });

  test("a binary override of the format's own width is accepted", () => {
    expect(idStorageOf(domain("ulid"), PG.BLOB.BYTEA, "pg")).toEqual({
      representation: "bytes",
      columnType: "bytea",
    });
    expect(idStorageOf(domain("uuid"), PG.STRING.UUID, "pg")).toEqual({
      representation: "uuid",
      columnType: "uuid",
    });
    expect(
      idStorageOf(domain("ksuid"), MYSQL.BLOB.BINARY(20), "mysql")
    ).toEqual({ representation: "bytes", columnType: "BINARY(20)" });
    expect(
      idStorageOf(domain("ksuid"), MYSQL.BLOB.VARBINARY(20), "mysql")
    ).toEqual({ representation: "bytes", columnType: "VARBINARY(20)" });
    expect(idStorageOf(domain("uuid"), MYSQL.BLOB.BLOB, "mysql")).toEqual({
      representation: "bytes",
      columnType: "BLOB",
    });
    expect(idStorageOf(domain("ulid"), SQLITE.BLOB.BLOB, "sqlite")).toEqual({
      representation: "bytes",
      columnType: "BLOB",
    });
  });

  test("a binary override of the wrong width names no column this domain fits", () => {
    expect(
      idStorageOf(domain("ksuid"), MYSQL.BLOB.BINARY(16), "mysql")
    ).toBeUndefined();
    expect(
      idStorageOf(domain("uuid"), MYSQL.BLOB.VARBINARY(20), "mysql")
    ).toBeUndefined();
  });

  test("a ULID may not take PostgreSQL's uuid column", () => {
    expect(idStorageOf(domain("ulid"), PG.STRING.UUID, "pg")).toBeUndefined();
    expect(idStorageOf(domain("ksuid"), PG.STRING.UUID, "pg")).toBeUndefined();
  });

  test("a text format has no binary column at all", () => {
    expect(idStorageOf(domain("cuid"), PG.BLOB.BYTEA, "pg")).toBeUndefined();
    expect(
      idStorageOf(domain("nanoid"), SQLITE.BLOB.BLOB, "sqlite")
    ).toBeUndefined();
  });

  test("any other column type is refused", () => {
    expect(idStorageOf(domain("uuid"), PG.JSON.JSONB, "pg")).toBeUndefined();
    expect(idStorageOf(domain("uuid"), PG.INT.INTEGER, "pg")).toBeUndefined();
    expect(idStorageOf(domain("uuid"), MYSQL.INT.INT, "mysql")).toBeUndefined();
    expect(
      idStorageOf(domain("uuid"), SQLITE.INT.INTEGER, "sqlite")
    ).toBeUndefined();
  });

  test("an override for another dialect names no column here", () => {
    expect(idStorageOf(domain("uuid"), PG.STRING.UUID, "mysql")).toEqual({
      representation: "bytes",
      columnType: "BINARY(16)",
    });
    expect(idStorageOf(domain("uuid"), MYSQL.BLOB.BLOB, "pg")).toEqual({
      representation: "uuid",
      columnType: "uuid",
    });
  });
});

describe("the refusal message's vocabulary", () => {
  test("it names the binary and the text spellings this domain accepts", () => {
    expect(describeIdNativeTypes("uuid", "pg")).toBe(
      "uuid, bytea, text, citext, varchar(n), char(n)"
    );
    expect(describeIdNativeTypes("ulid", "pg")).toBe(
      "bytea, text, citext, varchar(n), char(n)"
    );
    expect(describeIdNativeTypes("ksuid", "mysql")).toBe(
      "BINARY(20), VARBINARY(20), BLOB, TEXT, TINYTEXT, MEDIUMTEXT, LONGTEXT, VARCHAR(n), CHAR(n)"
    );
    expect(describeIdNativeTypes("ulid", "sqlite")).toBe("BLOB, TEXT");
  });

  test("a text format names only the text spellings", () => {
    expect(describeIdNativeTypes("cuid", "pg")).toBe(
      "text, citext, varchar(n), char(n)"
    );
    expect(describeIdNativeTypes("nanoid", "sqlite")).toBe("TEXT");
    expect(describeIdNativeTypes("nanoid", "mysql")).toBe(
      "TEXT, TINYTEXT, MEDIUMTEXT, LONGTEXT, VARCHAR(n), CHAR(n)"
    );
  });
});
