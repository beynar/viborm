import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { sql } from "@sql";
import type { IdDomain } from "@validation/primitives/id-codec";
import { describe, expect, test } from "vitest";

const pg = new PostgresAdapter();
const mysql = new MySQLAdapter();
const sqlite = new SQLiteAdapter();

const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);

const domain = (format: IdDomain["format"]): IdDomain => ({ format });

describe("the physical promise each dialect declares", () => {
  test("PostgreSQL: uuid formats are its own uuid type, the rest bytea", () => {
    const declared = pg.result.idRepresentation!;
    expect(declared(domain("uuid"), undefined)).toBe("uuid");
    expect(declared(domain("uuidv7"), undefined)).toBe("uuid");
    expect(declared(domain("ulid"), undefined)).toBe("bytes");
    expect(declared(domain("ksuid"), undefined)).toBe("bytes");
    expect(declared(domain("nanoid"), undefined)).toBe("text");
    expect(declared(domain("cuid"), undefined)).toBe("text");
  });

  test("MySQL and SQLite store every compact format as bytes", () => {
    for (const adapter of [mysql, sqlite]) {
      const declared = adapter.result.idRepresentation!;
      for (const format of ["uuid", "uuidv7", "ulid", "ksuid"] as const) {
        expect(declared(domain(format), undefined)).toBe("bytes");
      }
      expect(declared(domain("cuid"), undefined)).toBe("text");
    }
  });

  test("a text-family override keeps text storage on every dialect", () => {
    expect(pg.result.idRepresentation!(domain("uuid"), PG.STRING.TEXT)).toBe(
      "text"
    );
    expect(
      mysql.result.idRepresentation!(domain("ulid"), MYSQL.STRING.CHAR(26))
    ).toBe("text");
    expect(
      sqlite.result.idRepresentation!(domain("ksuid"), SQLITE.STRING.TEXT)
    ).toBe("text");
  });

  test("a spelling the domain cannot live in is text, never a guess", () => {
    // The schema gate refuses such a declaration (F013); the adapter's own
    // answer stays the conservative one rather than inventing a width.
    expect(pg.result.idRepresentation!(domain("uuid"), PG.INT.INTEGER)).toBe(
      "text"
    );
    expect(mysql.result.idRepresentation!(domain("uuid"), MYSQL.INT.INT)).toBe(
      "text"
    );
    expect(
      sqlite.result.idRepresentation!(domain("uuid"), SQLITE.INT.INTEGER)
    ).toBe("text");
  });
});

describe("binding an identifier operand", () => {
  test("a PostgreSQL uuid operand is TYPED, because uuid = text has no operator", () => {
    const operand = pg.literals.id(UUID, "uuid");
    expect(operand.toStatement()).toBe("CAST(? AS UUID)");
    expect(operand.values).toEqual([UUID]);
  });

  test("bytes bind as the ordinary binary parameter on all three", () => {
    for (const adapter of [pg, mysql, sqlite]) {
      const operand = adapter.literals.id(bytes, "bytes");
      expect(operand.values).toEqual([bytes]);
      expect(operand.toStatement()).not.toContain("CAST");
    }
  });

  test("a text-stored identifier binds the public string unchanged", () => {
    for (const adapter of [pg, mysql, sqlite]) {
      const operand = adapter.literals.id("usr-abc", "text");
      expect(operand.values).toEqual(["usr-abc"]);
      expect(operand.toStatement()).not.toContain("CAST");
    }
  });

  test("MySQL and SQLite need no cast for a uuid-shaped value either", () => {
    for (const adapter of [mysql, sqlite]) {
      expect(adapter.literals.id(UUID, "uuid").values).toEqual([UUID]);
    }
  });
});

describe("binding a deferred identifier", () => {
  const deferred = sql`"t"."id"`;

  // A deferred value is a STEP OUTPUT, and a step output is a row the driver
  // returned — so it arrives in the TRANSPORT spelling, which for a byte column
  // is lowercase hex. Casting that hex into the binary type would bind the hex
  // text's own bytes, so the binary arm decodes it instead. The transport and
  // this are one round trip, which is why `blobToHex` sits beside it above.
  test("PostgreSQL decodes the transported hex and names its own types", () => {
    expect(pg.expressions.idCast(deferred, "uuid").toStatement()).toBe(
      'CAST("t"."id" AS UUID)'
    );
    expect(pg.expressions.idCast(deferred, "bytes").toStatement()).toBe(
      `decode("t"."id", 'hex')`
    );
    expect(pg.expressions.idCast(deferred, "text").toStatement()).toBe(
      'CAST("t"."id" AS TEXT)'
    );
  });

  test("MySQL unhexes, or casts to CHAR — the text target its CAST list has", () => {
    expect(mysql.expressions.idCast(deferred, "bytes").toStatement()).toBe(
      'UNHEX("t"."id")'
    );
    expect(mysql.expressions.idCast(deferred, "text").toStatement()).toBe(
      'CAST("t"."id" AS CHAR)'
    );
    expect(mysql.expressions.idCast(deferred, "uuid").toStatement()).toBe(
      'CAST("t"."id" AS CHAR)'
    );
  });

  test("SQLite unhexes, or casts to TEXT", () => {
    expect(sqlite.expressions.idCast(deferred, "bytes").toStatement()).toBe(
      'unhex("t"."id")'
    );
    expect(sqlite.expressions.idCast(deferred, "text").toStatement()).toBe(
      'CAST("t"."id" AS TEXT)'
    );
    expect(sqlite.expressions.idCast(deferred, "uuid").toStatement()).toBe(
      'CAST("t"."id" AS TEXT)'
    );
  });
});
