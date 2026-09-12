import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { D1Driver } from "@drivers/d1";
import { buildAggregateColumn } from "@query-engine/builders/aggregate-utils";
import {
  decodeIdValue,
  encodeIdValue,
  idColumnOf,
  idColumnOfScalar,
} from "@query-engine/builders/id-field";
import { assertSupportedScalarFilterOperator } from "@query-engine/builders/scalar-filter-operators";
import { projectScalarForTransport } from "@query-engine/builders/scalar-transport";
import { buildSelect } from "@query-engine/builders/select-builder";
import {
  buildScalarSqlValue,
  scalarValueLiteral,
} from "@query-engine/builders/values-builder";
import { buildWhere } from "@query-engine/builders/where-builder";
import { parseResult } from "@query-engine/result/ResultParser";
import { identityGuardFor } from "@query-engine/result/scalar-identity-parser";
import { QueryEngineError } from "@query-engine/types";
import { s } from "@schema";
import { MYSQL, PG } from "@schema/scalars/native-types";
import { sql } from "@sql";
import {
  parserFor,
  prepareSchema,
  scopeFor,
} from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_HEX = "a0eebc999c0b4ef8bb6d6bb9bd380a11";
const CUID = "tz4a98xxat96iws9zmbrgj3a";

const user = s.model({
  id: s.string().id().uuid("usr"),
  slug: s.string().cuid(),
  posts: s.toMany(() => post),
});
const post = s.model({
  id: s.string().id().ulid(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .toOne(() => user)
    .fields("authorId")
    .references("id"),
});
const textStored = s.model({
  id: s.string(PG.STRING.VARCHAR(36)).id().uuid("usr"),
  label: s.string(),
});
prepareSchema({ user, post, textStored });

const pg = new PostgresAdapter();
const mysql = new MySQLAdapter();
const sqlite = new SQLiteAdapter();

const OUTSIDE_DOMAIN = /outside its declared uuid domain/;
const NOT_A_STRING = /received number/;
const TEXT_PREDICATE_REFUSED = /stores the identifier itself/;
const UNSUPPORTED_OPERATION = /Unsupported filter operation/;
const VALUE_ABSENT = /absent/;
const REQUIRED_NULL = /required scalar is null/;
const NOT_IN_DOMAIN = /identifier domain/;
const DRIVER_SAID_SO = /the driver said so/;
const PROVIDER_DECODE_FAILED = /provider scalar decoding failed/;
/** `MIN("t"."id")` — the stored value aggregated directly, which is the shape this must NOT take. */
const BARE_COLUMN_AGGREGATE = /MIN\("[a-z0-9]+"\."id"\)/;

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );

describe("what the engine reads about an identifier column", () => {
  test("a declared key answers for itself on every dialect", () => {
    expect(idColumnOf(pg, user, "id", undefined)).toEqual({
      domain: { format: "uuid", prefix: "usr", length: undefined },
      representation: "uuid",
    });
    expect(idColumnOf(mysql, user, "id", undefined)?.representation).toBe(
      "bytes"
    );
    expect(idColumnOf(sqlite, post, "id", undefined)?.representation).toBe(
      "bytes"
    );
    expect(idColumnOf(pg, user, "slug", undefined)?.representation).toBe(
      "text"
    );
  });

  test("a foreign key needs the index, and finds its target's domain", () => {
    expect(idColumnOf(pg, post, "authorId", undefined)).toBeUndefined();
    const scope = scopeFor(pg, post);
    expect(idColumnOf(pg, post, "authorId", scope.relations)).toEqual({
      domain: { format: "uuid", prefix: "usr", length: undefined },
      representation: "uuid",
    });
  });

  test("a field with no domain is no identifier column", () => {
    expect(idColumnOf(pg, post, "title", undefined)).toBeUndefined();
    expect(idColumnOfScalar(pg, post["~"].state.scalars.title)).toBeUndefined();
    // A private column carries the referenced key's own scalar and answers
    // from its declaration, with no index and no derivation.
    expect(idColumnOfScalar(pg, post["~"].state.scalars.id)).toEqual({
      domain: { format: "ulid", prefix: undefined, length: undefined },
      representation: "bytes",
    });
  });

  test("a native text override keeps the domain and drops the compaction", () => {
    expect(idColumnOf(pg, textStored, "id", undefined)).toEqual({
      domain: { format: "uuid", prefix: "usr", length: undefined },
      representation: "text",
    });
  });
});

describe("binding an identifier value", () => {
  const idColumn = (adapter: DatabaseAdapter) =>
    idColumnOf(adapter, user, "id", undefined)!;

  test("the prefix is stripped and the payload encoded per dialect", () => {
    expect(encodeIdValue("id", `usr-${UUID}`, idColumn(pg))).toBe(UUID);
    expect(encodeIdValue("id", `usr-${UUID}`, idColumn(mysql))).toEqual(
      bytesOf(UUID_HEX)
    );
    expect(encodeIdValue("id", `usr-${UUID}`, idColumn(sqlite))).toEqual(
      bytesOf(UUID_HEX)
    );
    expect(
      encodeIdValue(
        "id",
        `usr-${UUID}`,
        idColumnOf(pg, textStored, "id", undefined)!
      )
    ).toBe(`usr-${UUID}`);
  });

  test("an alias normalizes on the way in", () => {
    expect(encodeIdValue("id", `usr-${UUID.toUpperCase()}`, idColumn(pg))).toBe(
      UUID
    );
  });

  test("a value outside the domain is refused, never guessed", () => {
    expect(() => encodeIdValue("id", UUID, idColumn(pg))).toThrowError(
      OUTSIDE_DOMAIN
    );
    expect(() => encodeIdValue("id", 7, idColumn(pg))).toThrowError(
      NOT_A_STRING
    );
  });

  test("an INSERT value carries the dialect's own physical spelling", () => {
    const pgValue = buildScalarSqlValue(
      scopeFor(pg, user),
      user,
      "id",
      `usr-${UUID}`
    );
    expect(pgValue.toStatement()).toBe("CAST(? AS UUID)");
    expect(pgValue.values).toEqual([UUID]);

    const mysqlValue = buildScalarSqlValue(
      scopeFor(mysql, user),
      user,
      "id",
      `usr-${UUID}`
    );
    expect(mysqlValue.values).toEqual([bytesOf(UUID_HEX)]);
  });

  test("a FOREIGN KEY binds exactly as the key it references does", () => {
    const scope = scopeFor(pg, post);
    const fk = buildScalarSqlValue(scope, post, "authorId", `usr-${UUID}`);
    const key = buildScalarSqlValue(
      scopeFor(pg, user),
      user,
      "id",
      `usr-${UUID}`
    );
    expect(fk.toStatement()).toBe(key.toStatement());
    expect(fk.values).toEqual(key.values);
  });

  test("a comparison operand is the same physical value as the write", () => {
    const scope = scopeFor(mysql, user);
    expect(scalarValueLiteral(scope, "id", `usr-${UUID}`).values).toEqual([
      bytesOf(UUID_HEX),
    ]);
    // A text domain keeps its public string on every dialect.
    expect(scalarValueLiteral(scope, "slug", CUID).values).toEqual([CUID]);
  });

  test("null and undefined stay SQL NULL rather than an encoded value", () => {
    const scope = scopeFor(pg, user);
    expect(buildScalarSqlValue(scope, user, "id", null).toStatement()).toBe(
      "NULL"
    );
    expect(scalarValueLiteral(scope, "id", null).values).toEqual([null]);
  });
});

describe("projecting an identifier column", () => {
  const column = sql`"t"."id"`;

  test("a byte-stored column travels as lowercase hex", () => {
    for (const adapter of [mysql, sqlite]) {
      const projected = projectScalarForTransport(
        adapter,
        user["~"].state.scalars.id,
        column,
        idColumnOf(adapter, user, "id", undefined)
      );
      expect(projected.toStatement().toUpperCase()).toContain("HEX(");
    }
    expect(
      projectScalarForTransport(
        pg,
        post["~"].state.scalars.id,
        column,
        idColumnOf(pg, post, "id", undefined)
      ).toStatement()
    ).toContain("encode(");
  });

  test("a uuid column and a text domain travel as the column itself", () => {
    expect(
      projectScalarForTransport(
        pg,
        user["~"].state.scalars.id,
        column,
        idColumnOf(pg, user, "id", undefined)
      )
    ).toBe(column);
    expect(
      projectScalarForTransport(
        pg,
        user["~"].state.scalars.slug,
        column,
        idColumnOf(pg, user, "slug", undefined)
      )
    ).toBe(column);
  });

  test("a NULLABLE byte column keeps its null across the hex encoding", () => {
    // SQLite's `hex(NULL)` is the EMPTY STRING, which reads back as a
    // zero-byte identifier rather than as an absent one. Falsified live before
    // this guard existed: every create through a model with a nullable
    // identifier foreign key failed to decode its own returned row.
    const optional = s.model({
      id: s.string().id(),
      refId: s.string().uuid("usr").nullable(),
    });
    prepareSchema({ optional });
    const projected = projectScalarForTransport(
      sqlite,
      optional["~"].state.scalars.refId,
      column,
      idColumnOf(sqlite, optional, "refId", undefined)
    );
    const statement = projected.toStatement();
    expect(statement.toUpperCase()).toContain("HEX(");
    expect(statement.toUpperCase()).toContain("CASE");
    expect(statement.toUpperCase()).toContain("IS NULL");
  });

  test("a flat select uses the same projection the transport owner decides", () => {
    const scope = scopeFor(sqlite, post);
    const select = buildSelect(
      scope,
      { id: true, title: true },
      undefined,
      scope.rootAlias
    );
    expect(select.toStatement().toUpperCase()).toContain("HEX(");
  });
});

describe("aggregating an identifier column", () => {
  test("MIN/MAX run over the TRANSPORTED value, not the stored one", () => {
    // PostgreSQL 16 has neither `min(uuid)` nor `max(bytea)`, and JSON cannot
    // hold binary, so the aggregate is taken over the spelling the column
    // travels in. It is the same answer: every compact format's canonical text
    // is fixed-width lowercase, so its text order IS its byte order.
    const pgScope = scopeFor(pg, user);
    const pgSql =
      buildAggregateColumn(
        pgScope,
        { id: true },
        pgScope.rootAlias,
        "min"
      )?.toStatement() ?? "";
    expect(pgSql).toContain("MIN(");
    expect(pgSql).toContain("CAST");
    expect(pgSql).not.toMatch(BARE_COLUMN_AGGREGATE);

    const sqliteScope = scopeFor(sqlite, post);
    const sqliteSql =
      buildAggregateColumn(
        sqliteScope,
        { id: true },
        sqliteScope.rootAlias,
        "max"
      )?.toStatement() ?? "";
    expect(sqliteSql.toUpperCase()).toContain("HEX(");
    // The null guard sits INSIDE the aggregate: SQLite's `hex(NULL)` is the
    // empty string, which would otherwise win every MIN.
    expect(sqliteSql.toUpperCase()).toContain("CASE");
  });

  test("a field with no identifier domain aggregates the column itself", () => {
    const scope = scopeFor(sqlite, post);
    const statement =
      buildAggregateColumn(
        scope,
        { title: true },
        scope.rootAlias,
        "min"
      )?.toStatement() ?? "";
    expect(statement.toUpperCase()).not.toContain("HEX(");
  });
});

describe("filtering an identifier column", () => {
  test("a compact domain loses the four text predicates", () => {
    const state = user["~"].state.scalars.id!["~"].state;
    const domain = idColumnOf(pg, user, "id", undefined)!.domain;
    for (const operation of ["equals", "not", "in", "notIn", "lt", "gte"]) {
      expect(() =>
        assertSupportedScalarFilterOperator("id", state, operation, domain)
      ).not.toThrow();
    }
    for (const operation of ["contains", "startsWith", "endsWith", "mode"]) {
      expect(() =>
        assertSupportedScalarFilterOperator("id", state, operation, domain)
      ).toThrowError(TEXT_PREDICATE_REFUSED);
    }
  });

  test("a text domain keeps every string operator", () => {
    const state = user["~"].state.scalars.slug!["~"].state;
    const domain = idColumnOf(pg, user, "slug", undefined)!.domain;
    expect(() =>
      assertSupportedScalarFilterOperator("slug", state, "contains", domain)
    ).not.toThrow();
  });

  test("an operator no string has is still the ordinary refusal", () => {
    const state = user["~"].state.scalars.id!["~"].state;
    const domain = idColumnOf(pg, user, "id", undefined)!.domain;
    expect(() =>
      assertSupportedScalarFilterOperator("id", state, "hasEvery", domain)
    ).toThrowError(UNSUPPORTED_OPERATION);
  });

  test("a compact column is compared as bytes, not collated as text", () => {
    const scope = scopeFor(mysql, user);
    const where = buildWhere(
      scope,
      { id: { equals: `usr-${UUID}` } },
      scope.rootAlias
    );
    expect(where?.values).toEqual([bytesOf(UUID_HEX)]);
    expect(where?.toStatement()).not.toContain("BINARY ");
  });

  test("a SUBSTRING operand binds as the fragment it is, never as a value", () => {
    // `contains: "tz4a"` asks about part of a cuid, not about a cuid. Only a
    // text-stored domain can be asked at all — a compact one refuses the four
    // text predicates — and encoding the fragment through the domain would
    // refuse every such query. Falsified live on sqlite3 before this split.
    const scope = scopeFor(pg, user);
    const where = buildWhere(
      scope,
      { slug: { contains: "tz4a" } },
      scope.rootAlias
    );
    expect(where?.values).toEqual(["tz4a"]);
    // The whole value still binds as a domain value on the same field.
    expect(
      buildWhere(scope, { slug: { equals: CUID } }, scope.rootAlias)?.values
    ).toEqual([CUID]);
  });

  test("a text-stored domain is still compared as text", () => {
    const scope = scopeFor(mysql, user);
    const where = buildWhere(
      scope,
      { slug: { contains: CUID } },
      scope.rootAlias
    );
    expect(where?.toStatement()).toContain("BINARY");
    expect(where?.values).toEqual([CUID]);
  });
});

describe("decoding an identifier column", () => {
  const idColumn = (adapter: DatabaseAdapter) =>
    idColumnOf(adapter, user, "id", undefined)!;

  test("every driver binary shape decodes to one public string", () => {
    const column = idColumn(sqlite);
    const raw = bytesOf(UUID_HEX);
    for (const shape of [
      raw,
      Buffer.from(raw),
      raw.buffer.slice(0),
      [...raw],
      UUID_HEX,
      `\\x${UUID_HEX}`,
      `base64:type252:${Buffer.from(raw).toString("base64")}`,
    ]) {
      expect(decodeIdValue(shape, column)).toBe(`usr-${UUID}`);
    }
  });

  test("a PostgreSQL uuid column decodes its text, prefix re-applied", () => {
    expect(decodeIdValue(UUID, idColumn(pg))).toBe(`usr-${UUID}`);
    expect(decodeIdValue(UUID.toUpperCase(), idColumn(pg))).toBe(`usr-${UUID}`);
  });

  test("a row comes back as the public string on every dialect", () => {
    const select = { select: { id: true, slug: true } };
    expect(
      parseResult(
        parserFor(pg, user),
        "findMany",
        [{ id: UUID, slug: CUID }],
        select
      )
    ).toEqual([{ id: `usr-${UUID}`, slug: CUID }]);

    expect(
      parseResult(
        parserFor(sqlite, user),
        "findMany",
        [{ id: bytesOf(UUID_HEX), slug: CUID }],
        select
      )
    ).toEqual([{ id: `usr-${UUID}`, slug: CUID }]);
  });

  test("a FOREIGN KEY row decodes through its derived domain", () => {
    const ULID_HEX = "0173b5f0a1d5c2b3a4958677a8b9cadb";
    expect(
      parseResult(
        parserFor(mysql, post),
        "findMany",
        [{ id: ULID_HEX, title: "t", authorId: UUID_HEX }],
        { select: { id: true, title: true, authorId: true } }
      )
    ).toEqual([
      { id: expect.any(String), title: "t", authorId: `usr-${UUID}` },
    ]);
  });

  test("an absent or null value on a required key is malformed", () => {
    const select = { select: { id: true } };
    expect(() =>
      parseResult(parserFor(pg, user), "findMany", [{ id: undefined }], select)
    ).toThrowError(VALUE_ABSENT);
    expect(() =>
      parseResult(parserFor(pg, user), "findMany", [{ id: null }], select)
    ).toThrowError(REQUIRED_NULL);
  });

  test("a physical value outside the domain is malformed, not returned", () => {
    expect(() =>
      parseResult(parserFor(pg, user), "findMany", [{ id: "not-a-uuid" }], {
        select: { id: true },
      })
    ).toThrowError(NOT_IN_DOMAIN);
  });

  test("a nullable identifier keeps its null", () => {
    const optional = s.model({
      id: s.string().id(),
      ref: s.string().uuid().nullable(),
    });
    prepareSchema({ optional });
    expect(
      parseResult(parserFor(pg, optional), "findMany", [{ ref: null }], {
        select: { ref: true },
      })
    ).toEqual([{ ref: null }]);
  });

  test("a captured row key is the canonical PUBLIC string, a primitive", () => {
    // Row keys are what `fkEquals`, deduplication and the identity map compare,
    // and what a later statement re-binds. Bytes would compare by reference and
    // a prefixed payload would address another row.
    const nullableRef = s.model({
      id: s.string().id(),
      ref: s.string().uuid("usr").nullable(),
    });
    prepareSchema({ nullableRef });
    const [, keys] = parserFor(sqlite, nullableRef).parseRowsWithRowKeys(
      "findMany",
      [{ ref: bytesOf(UUID_HEX) }, { ref: null }],
      { select: { ref: true } },
      ["ref"]
    );
    expect(keys).toEqual([{ ref: `usr-${UUID}` }, { ref: null }]);
    expect(typeof keys[0]?.ref).toBe("string");
  });

  test("the identity fast path is off for every identifier field", () => {
    expect(identityGuardFor(user["~"].state.scalars.id!, true)).toBeUndefined();
    // Even a text-stored, unprefixed domain: the column may hold an alias.
    expect(
      identityGuardFor(user["~"].state.scalars.slug!, true)
    ).toBeUndefined();
    expect(identityGuardFor(post["~"].state.scalars.title!, false)).toBeTypeOf(
      "function"
    );
  });

  test("a chain is compiled per column, not per scalar", () => {
    const shared = s.string().uuid();
    const left = s.model({ id: shared.id(), label: s.string() });
    prepareSchema({ left });
    expect(
      parseResult(
        parserFor(mysql, left),
        "findMany",
        [{ id: UUID_HEX, label: "a" }],
        { select: { id: true, label: true } }
      )
    ).toEqual([{ id: UUID, label: "a" }]);
  });
});

describe("a native binary override of the wrong dialect", () => {
  test("takes the dialect's automatic storage instead", () => {
    const mixed = s.model({ id: s.string(MYSQL.BLOB.BINARY(16)).id().uuid() });
    prepareSchema({ mixed });
    expect(idColumnOf(pg, mixed, "id", undefined)?.representation).toBe("uuid");
    expect(idColumnOf(mysql, mixed, "id", undefined)?.representation).toBe(
      "bytes"
    );
  });
});

describe("an adapter or driver that stands between the row and the codec", () => {
  /** The same dialect, with one promise or one middleware changed. */
  const variant = (
    base: DatabaseAdapter,
    result: Partial<DatabaseAdapter["result"]>
  ): DatabaseAdapter => ({ ...base, result: { ...base.result, ...result } });

  test("an adapter that declares no identifier promise stores text", () => {
    const silent = variant(pg, { idRepresentation: undefined });
    expect(idColumnOf(silent, user, "id", undefined)).toEqual({
      domain: { format: "uuid", prefix: "usr", length: undefined },
      representation: "text",
    });
  });

  test("a driver's own field middleware still runs before the codec", () => {
    const driver = new D1Driver({ database: Object.create(null) });
    expect(
      parseResult(
        parserFor(sqlite, user, driver),
        "findMany",
        [{ id: UUID_HEX, slug: CUID }],
        { select: { id: true, slug: true } }
      )
    ).toEqual([{ id: `usr-${UUID}`, slug: CUID }]);
  });

  test("a VibORM error from a provider decode reaches the caller intact", () => {
    const named = variant(sqlite, {
      parseField: () => {
        throw new QueryEngineError("the driver said so");
      },
    });
    expect(() =>
      parseResult(parserFor(named, user), "findMany", [{ id: UUID_HEX }], {
        select: { id: true },
      })
    ).toThrowError(DRIVER_SAID_SO);
  });

  test("a provider decode that throws is malformed, not a leaked error", () => {
    const hostile = variant(sqlite, {
      parseField: () => {
        throw new Error("provider exploded");
      },
    });
    expect(() =>
      parseResult(parserFor(hostile, user), "findMany", [{ id: UUID_HEX }], {
        select: { id: true },
      })
    ).toThrowError(PROVIDER_DECODE_FAILED);
  });
});
