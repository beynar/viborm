/**
 * Compact identifier storage, read off the SQL the engine builds.
 *
 * The engine's half of the identifier contract lives in
 * `raptor3/shared/identifier.ts` and its four consumers in `shared/query.ts`:
 * the parameter a value binds as (`scalarValue`), the spelling a column travels
 * in (`projectedColumn`, the junction probe, the recursive identity), what
 * `MIN`/`MAX` run over (`aggregateExpression`), and the decode that turns the
 * physical value back into the public string (`decodeScalar`). Every pin below
 * is stated through `engine.build` — the SQL and the bound values a real
 * operation produces — or through the prepared read's own decoder, and never
 * through a helper the engine does not call.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { D1Driver } from "@drivers/d1";
import { QueryEngineError, ValidationError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  InvalidScalarResult,
  Queries,
} from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import type { Sql } from "@sql";
import { prepareSchema } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const UUID_HEX = "a0eebc999c0b4ef8bb6d6bb9bd380a11";
const USER = `usr-${UUID}`;
const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CUID = "tz4a98xxat96iws9zmbrgj3a";

const models = (() => {
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
    tags: s.toMany(() => tag),
    notes: s.toMany(() => note).name("subject"),
  });
  const tag = s.model({
    id: s.string().id().ulid(),
    name: s.string(),
    posts: s.toMany(() => post),
  });
  /** A second variant: the carrier holds ONE domain, so both keys are ULIDs. */
  const article = s.model({
    id: s.string().id().ulid(),
    notes: s.toMany(() => note).name("subject"),
  });
  /** The PRIVATE column: a row carrier whose id column holds either key. */
  const note = s.model({
    id: s.string().id(),
    body: s.string(),
    subject: s
      .toOne(
        { post: () => post, article: () => article },
        { values: { post: "p", article: "a" } }
      )
      .name("subject"),
  });
  const textStored = s.model({
    id: s.string(PG.STRING.VARCHAR(36)).id().uuid("usr"),
    label: s.string(),
  });
  const optional = s.model({
    id: s.string().id(),
    refId: s.string().uuid("usr").nullable(),
  });
  /** One scalar instance shared by two models' declarations. */
  const shared = s.string().uuid();
  const left = s.model({ id: shared.id(), label: s.string() });
  const mixed = s.model({ id: s.string(MYSQL.BLOB.BINARY(16)).id().uuid() });
  /** The same shapes with no identifier domain anywhere. */
  const plainUser = s.model({
    id: s.string().id(),
    slug: s.string(),
    posts: s.toMany(() => plainPost),
  });
  const plainPost = s.model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => plainUser)
      .fields("authorId")
      .references("id"),
  });
  /**
   * The same shapes with a TEXT-stored domain on every identifier column: a
   * text format everywhere, and a uuid kept text by its dialect's override.
   */
  const textUser = s.model({
    id: s.string().id().nanoid(),
    slug: s.string().cuid(),
    posts: s.toMany(() => textPost),
  });
  const textPost = s.model({
    id: s.string().id().cuid(),
    title: s.string(),
    authorId: s.string(),
    author: s
      .toOne(() => textUser)
      .fields("authorId")
      .references("id"),
  });
  const plainLabel = s.model({ id: s.string().id(), label: s.string() });
  const pgText = s.model({
    id: s.string(PG.STRING.TEXT).id().uuid("usr"),
    label: s.string(),
  });
  const mysqlText = s.model({
    id: s.string(MYSQL.STRING.VARCHAR(40)).id().uuid("usr"),
    label: s.string(),
  });
  const sqliteText = s.model({
    id: s.string(SQLITE.STRING.TEXT).id().uuid("usr"),
    label: s.string(),
  });
  return {
    user,
    post,
    tag,
    article,
    note,
    textStored,
    optional,
    left,
    mixed,
    plainUser,
    plainPost,
    textUser,
    textPost,
    plainLabel,
    pgText,
    mysqlText,
    sqliteText,
  };
})();
const {
  user,
  post,
  note,
  textStored,
  optional,
  left,
  mixed,
  plainUser,
  plainPost,
  textUser,
  textPost,
  plainLabel,
  pgText,
  mysqlText,
  sqliteText,
} = models;
prepareSchema(models);

/** A SQL-only driver that records every statement it is handed. */
class RecordingDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  readonly statements: [string, unknown[]][] = [];

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `identifier-sql-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // The SQL contract owns no provider resource.
  }

  protected async execute<T>(
    _client: null,
    text: string,
    params: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push([text, params]);
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (client: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const pg = new PostgresAdapter();
const mysql = new MySQLAdapter();
const sqlite = new SQLiteAdapter();
const DIALECT = new Map<DatabaseAdapter, Dialect>([
  [pg, "postgresql"],
  [mysql, "mysql"],
  [sqlite, "sqlite"],
]);

function engineFor(adapter: DatabaseAdapter): {
  engine: QueryEngine;
  driver: RecordingDriver;
} {
  const registry = createModelRegistry(models, createSchemaRegistry(models));
  const driver = new RecordingDriver(adapter, DIALECT.get(adapter) ?? "sqlite");
  return { engine: new QueryEngine(driver, registry), driver };
}

type AnyModel = (typeof models)[keyof typeof models];

function build(
  adapter: DatabaseAdapter,
  model: AnyModel,
  operation: "findMany" | "findUnique" | "aggregate" | "groupBy",
  args: Record<string, unknown>
): Sql {
  return engineFor(adapter).engine.build(model, operation, args);
}

/**
 * The FIRST statement one write issues — its INSERT or UPDATE — whether or not
 * the empty rows the recording driver answers satisfy the rest of it.
 */
async function firstStatementOf(
  adapter: DatabaseAdapter,
  model: AnyModel,
  operation: "create" | "updateMany",
  args: Record<string, unknown>
): Promise<[string, unknown[]]> {
  const { engine, driver } = engineFor(adapter);
  await engine.prepare(model, operation, args).then(
    () => undefined,
    () => undefined
  );
  const [first] = driver.statements;
  if (first === undefined) throw new Error("Expected the write's statement");
  return first;
}

/** The prepared read's own decoder, over rows the test hands it. */
function decode(
  adapter: DatabaseAdapter,
  model: AnyModel,
  select: Record<string, boolean>,
  rows: Record<string, unknown>[],
  options: { internal?: boolean; driver?: Driver<unknown, unknown> } = {}
): Record<string, unknown>[] {
  const queries = new Queries(
    new EngineSchema(models),
    adapter,
    options.driver?.result
  );
  const prepared = queries.prepareProjection(model, { select });
  return queries.decodeProjection(prepared.shape, rows, options.internal);
}

const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );

/** The malformed-scalar refusal's reason, which the route puts in its message. */
function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof InvalidScalarResult) return error.reason;
    throw error;
  }
  throw new Error("Expected a malformed provider scalar");
}

/** The same dialect adapter, with one result promise or middleware changed. */
function variant(
  base: DatabaseAdapter,
  result: Partial<DatabaseAdapter["result"]>
): DatabaseAdapter {
  const changed: DatabaseAdapter = Object.create(base);
  Object.defineProperty(changed, "result", {
    value: { ...base.result, ...result },
  });
  return changed;
}

const REQUIRED_NULL = "a required scalar is null";
const VALUE_ABSENT = "the value is absent";
const NOT_IN_DOMAIN =
  "the value is not in this column's declared identifier domain";
const PROVIDER_DECODE_FAILED = "provider scalar decoding failed";
/** `MIN("q0"."id")` — the stored value aggregated directly, the shape this must NOT take. */
const BARE_COLUMN_AGGREGATE = /MIN\("q\d+"\."id"\)/;

describe("what the engine reads about an identifier column", () => {
  test("a declared key answers for itself on every dialect", () => {
    const where = { where: { id: USER }, select: { id: true } };
    const onPg = build(pg, user, "findMany", where);
    expect(onPg.toStatement("$n")).toContain("CAST($1 AS UUID)");
    expect(onPg.values).toEqual([UUID]);
    expect(build(mysql, user, "findMany", where).values).toEqual([
      bytesOf(UUID_HEX),
    ]);
    // A ULID key is sixteen bytes on SQLite, and so on PostgreSQL (`bytea`).
    for (const adapter of [sqlite, pg]) {
      const [bound] = build(adapter, post, "findMany", {
        where: { id: ULID },
        select: { id: true },
      }).values;
      expect(bound).toBeInstanceOf(Uint8Array);
      expect(bound).toHaveLength(16);
    }
    // A text format is its own public string.
    expect(
      build(pg, user, "findMany", { where: { slug: CUID } }).values
    ).toEqual([CUID]);
  });

  test("a foreign key finds its target's domain through the resolved index", () => {
    const fk = build(pg, post, "findMany", {
      where: { authorId: USER },
      select: { id: true },
    });
    expect(fk.toStatement("$n")).toContain('"authorId" = CAST($1 AS UUID)');
    expect(fk.values).toEqual([UUID]);
  });

  test("a field with no domain is no identifier column; a private column names its key", () => {
    expect(
      build(sqlite, post, "findMany", { where: { title: USER } }).values
    ).toEqual([USER]);
    // The carrier's id column holds the variants' KEY, so it binds that key's
    // bytes; its type discriminator stands in for no key and binds text.
    const edge = new EngineSchema(models).index.get(note)?.get("subject")?.edge;
    if (edge?.kind !== "variantRowCarrier")
      throw new Error("Expected the row carrier");
    for (const adapter of [pg, mysql, sqlite]) {
      const queries = new Queries(new EngineSchema(models), adapter);
      const carried = queries.fieldValue(
        note,
        edge.storage.idColumn.name,
        ULID
      );
      expect(carried.values).toEqual(
        build(adapter, post, "findMany", { where: { id: ULID } }).values
      );
      expect(carried.values[0]).toHaveLength(16);
      expect(
        queries.fieldValue(note, edge.storage.typeColumn.name, "p").values
      ).toEqual(["p"]);
    }
  });

  test("a native text override keeps the domain and drops the compaction", () => {
    const where = build(pg, textStored, "findMany", {
      where: { id: USER },
      select: { id: true },
    });
    expect(where.toStatement("$n")).not.toContain("UUID");
    expect(where.values).toEqual([USER]);
  });
});

describe("binding an identifier value", () => {
  test("the prefix is stripped and the payload encoded per dialect", () => {
    const args = { where: { id: USER }, select: { id: true } };
    expect(build(pg, user, "findMany", args).values).toEqual([UUID]);
    expect(build(mysql, user, "findMany", args).values).toEqual([
      bytesOf(UUID_HEX),
    ]);
    expect(build(sqlite, user, "findMany", args).values).toEqual([
      bytesOf(UUID_HEX),
    ]);
    expect(build(pg, textStored, "findMany", args).values).toEqual([USER]);
  });

  test("an alias normalizes on the way in", () => {
    expect(
      build(pg, user, "findMany", {
        where: { id: `usr-${UUID.toUpperCase()}` },
        select: { id: true },
      }).values
    ).toEqual([UUID]);
  });

  test("a value outside the domain is refused at admission, never guessed", () => {
    // Admission is the one owner: nothing outside the domain reaches the
    // engine's binding, which states that as an invariant.
    expect(() =>
      build(pg, user, "findMany", { where: { id: UUID } })
    ).toThrowError(ValidationError);
    expect(() =>
      build(pg, user, "findMany", { where: { id: 7 } })
    ).toThrowError(ValidationError);
  });

  test("an INSERT value carries the dialect's own physical spelling", async () => {
    const data = { data: { id: USER, slug: CUID } };
    const [pgInsert, pgValues] = await firstStatementOf(
      pg,
      user,
      "create",
      data
    );
    expect(pgInsert).toContain("CAST($1 AS UUID)");
    expect(pgValues).toEqual([UUID, CUID]);
    const [, mysqlValues] = await firstStatementOf(mysql, user, "create", data);
    expect(mysqlValues).toEqual([bytesOf(UUID_HEX), CUID]);
  });

  test("a FOREIGN KEY binds exactly as the key it references does", async () => {
    const [insert, values] = await firstStatementOf(pg, post, "create", {
      data: { id: ULID, title: "t", authorId: USER },
    });
    expect(insert).toContain("CAST($3 AS UUID)");
    const key = build(pg, user, "findMany", {
      where: { id: USER },
      select: { id: true },
    });
    expect(values[2]).toEqual(key.values[0]);
  });

  test("a comparison operand is the same physical value as the write", async () => {
    const [, written] = await firstStatementOf(mysql, user, "create", {
      data: { id: USER, slug: CUID },
    });
    const compared = build(mysql, user, "findMany", {
      where: { id: { in: [USER] }, slug: CUID },
      select: { id: true },
    });
    expect(compared.values[0]).toEqual(written[0]);
    // A text domain keeps its public string on every dialect.
    expect(compared.values.slice(1)).toEqual([CUID, CUID]);
  });

  test("null stays SQL NULL rather than an encoded value", async () => {
    const filtered = build(pg, optional, "findMany", {
      where: { refId: null },
      select: { id: true },
    });
    expect(filtered.toStatement("$n")).toContain('"refId" IS NULL');
    expect(filtered.values).toEqual([]);
    const [update, values] = await firstStatementOf(
      pg,
      optional,
      "updateMany",
      {
        where: { id: "o1" },
        data: { refId: null },
      }
    );
    expect(update).toContain('"refId" = NULL');
    expect(values).toEqual(["o1"]);
  });
});

describe("projecting an identifier column", () => {
  test("a byte-stored column travels as lowercase hex", () => {
    for (const adapter of [mysql, sqlite]) {
      const select = build(adapter, user, "findMany", {
        select: { id: true },
      });
      expect(select.toStatement("$n").toUpperCase()).toContain("LOWER(HEX(");
    }
    expect(
      build(pg, post, "findMany", { select: { id: true } }).toStatement("$n")
    ).toContain(`encode("q0"."id", 'hex') AS "id"`);
  });

  test("a uuid column and a text domain travel as the column itself", () => {
    const select = build(pg, user, "findMany", {
      select: { id: true, slug: true },
    }).toStatement("$n");
    expect(select).toBe(
      `SELECT "q0"."id" AS "id", "q0"."slug" AS "slug" FROM "public"."user" AS "q0" WHERE TRUE`
    );
  });

  test("a NULLABLE byte column keeps its null across the hex encoding", () => {
    // SQLite's `hex(NULL)` is the EMPTY STRING, which reads back as a
    // zero-byte identifier rather than as an absent one.
    const statement = build(sqlite, optional, "findMany", {
      select: { refId: true },
    }).toStatement("$n");
    expect(statement).toContain(
      `CASE WHEN "q0"."refId" IS NULL THEN NULL ELSE lower(hex("q0"."refId")) END AS "refId"`
    );
  });

  test("a flat select and a JSON carrier take the same transport", () => {
    const statement = build(sqlite, user, "findMany", {
      select: { id: true, posts: { select: { id: true } } },
    }).toStatement("$n");
    // The page column is transported once; the carrier reads it unchanged.
    expect(statement).toContain(`lower(hex("q0"."id")) AS "id"`);
    expect(statement).toContain(`lower(hex("q1"."id")) AS "id"`);
    expect(statement).toContain(`json_object($1, "q2"."id")`);
  });
});

describe("aggregating an identifier column", () => {
  test("MIN/MAX run over the TRANSPORTED value, not the stored one", () => {
    // PostgreSQL has neither `min(uuid)` nor `max(bytea)`, and JSON cannot
    // hold binary, so the aggregate is taken over the spelling the column
    // travels in. It is the same answer: every compact format's canonical text
    // is fixed-width lowercase, so its text order IS its byte order.
    const pgSql = build(pg, user, "aggregate", {
      _min: { id: true },
    }).toStatement("$n");
    expect(pgSql).toContain(`MIN(CAST("q1"."id" AS TEXT))`);
    expect(pgSql).not.toMatch(BARE_COLUMN_AGGREGATE);

    const sqliteSql = build(sqlite, post, "aggregate", {
      _max: { id: true },
    }).toStatement("$n");
    // The null guard sits INSIDE the aggregate: SQLite's `hex(NULL)` is the
    // empty string, which would otherwise win every MIN.
    expect(sqliteSql).toContain(
      `MAX(CASE WHEN "q1"."id" IS NULL THEN NULL ELSE lower(hex("q1"."id")) END)`
    );
  });

  test("HAVING aggregates the same expression the select list does", () => {
    // One column, one answer to what is aggregated over it — on a declared
    // key and on a derived foreign key alike.
    for (const field of ["id", "authorId"]) {
      const having = build(pg, post, "groupBy", {
        by: [field],
        having: { [field]: { _min: { equals: null } } },
      }).toStatement("$n");
      expect(having).toContain("HAVING MIN(");
      expect(having).not.toMatch(BARE_COLUMN_AGGREGATE);
    }
    expect(
      build(sqlite, post, "groupBy", {
        by: ["id"],
        having: { id: { _min: { equals: null } } },
      }).toStatement("$n")
    ).toContain(
      `HAVING MIN(CASE WHEN "q0"."id" IS NULL THEN NULL ELSE lower(hex("q0"."id")) END) IS NULL`
    );
  });

  test("a HAVING operand over an identifier aggregate is a number, never an identifier", () => {
    // Admission types every non-decimal aggregate operand as a number, so no
    // identifier ever needs the transported spelling on the operand side.
    expect(() =>
      build(pg, post, "groupBy", {
        by: ["authorId"],
        having: { id: { _min: { equals: ULID } } },
      })
    ).toThrowError(ValidationError);
    expect(
      build(pg, post, "groupBy", {
        by: ["authorId"],
        having: { id: { _count: { gt: 1 } } },
      }).values
    ).toEqual([1]);
  });

  test("a field with no identifier domain aggregates the column itself", () => {
    const statement = build(sqlite, post, "aggregate", {
      _min: { title: true },
    }).toStatement("$n");
    expect(statement).toContain(`MIN("q1"."title")`);
    expect(statement.toUpperCase()).not.toContain("HEX(");
  });
});

describe("filtering an identifier column", () => {
  test("a compact domain loses the four text predicates at admission", () => {
    for (const operator of [
      { equals: USER },
      { not: USER },
      { in: [USER] },
      { notIn: [USER] },
      { lt: USER },
      { gte: USER },
    ]) {
      expect(() =>
        build(pg, user, "findMany", { where: { id: operator } })
      ).not.toThrow();
    }
    for (const operator of [
      { contains: "a0ee" },
      { startsWith: "usr" },
      { endsWith: "a11" },
      { equals: USER, mode: "insensitive" },
    ]) {
      expect(() =>
        build(pg, user, "findMany", { where: { id: operator } })
      ).toThrowError(ValidationError);
    }
  });

  test("a text domain keeps every string operator", () => {
    expect(() =>
      build(pg, user, "findMany", {
        where: { slug: { contains: "tz4", mode: "insensitive" } },
      })
    ).not.toThrow();
  });

  test("an operator no string has is still the ordinary refusal", () => {
    expect(() =>
      build(pg, user, "findMany", { where: { id: { hasEvery: [USER] } } })
    ).toThrowError(ValidationError);
  });

  test("a compact column is compared as bytes, not collated as text", () => {
    const where = build(mysql, user, "findMany", {
      where: { id: { equals: USER } },
      select: { slug: true },
    });
    expect(where.values).toEqual([bytesOf(UUID_HEX)]);
    expect(where.toStatement("$n")).toBe(
      "SELECT `q0`.`slug` AS `slug` FROM `user` AS `q0` WHERE `q0`.`id` = $1"
    );
    // The same column under `notIn` is not wrapped for exact text either.
    expect(
      build(sqlite, user, "findMany", {
        where: { id: { notIn: [USER] } },
        select: { slug: true },
      }).toStatement("$n")
    ).toContain(`"q0"."id" NOT IN ($1)`);
  });

  test("a SUBSTRING operand binds as the fragment it is, never as a value", () => {
    // `contains: "tz4a"` asks about part of a cuid, not about a cuid; only a
    // text-stored domain can be asked at all.
    expect(
      build(pg, user, "findMany", {
        where: { slug: { contains: "tz4a" } },
        select: { id: true },
      }).values
    ).toEqual(["tz4a"]);
    // The whole value still binds as a domain value on the same field.
    expect(
      build(pg, user, "findMany", {
        where: { slug: { equals: CUID } },
        select: { id: true },
      }).values
    ).toEqual([CUID]);
  });

  test("a text-stored domain is still compared as text", () => {
    const where = build(mysql, user, "findMany", {
      where: { slug: { equals: CUID } },
      select: { id: true },
    });
    expect(where.toStatement("$n")).toContain("BINARY `q0`.`slug`");
    expect(where.values).toEqual([CUID, CUID]);
  });
});

/** The storage refusal's own words, in each of the four shapes it names. */
const BYTES_VS_TEXT =
  /'id' is a ulid value, stored as payload bytes and 'title' is plain string text/;
const TEXT_VS_BYTES =
  /'title' is plain string text and 'id' is a ulid value, stored as payload bytes/;
const TWO_COMPACT_DOMAINS =
  /'id' is a ulid value, stored as payload bytes and 'authorId' is a uuid value prefixed 'usr-', stored as payload bytes/;
const UUID_PAYLOAD = /stored as a uuid payload/;

/**
 * A FIELD REFERENCE compares two columns rather than a column and a value, so
 * the question is not "is this value in the domain" but "does one public value
 * have one physical spelling in both columns". Admission cannot ask it — the
 * interned filter schemas are model-blind and see two strings — and
 * `Queries.prepareOperand` is the first owner holding the model that can.
 */
describe("comparing two identifier columns", () => {
  const userRefs = createModelFieldRefs("user", user);
  const postRefs = createModelFieldRefs("post", post);
  const textRefs = createModelFieldRefs("textStored", textStored);

  test("a compact column and a plain string column are refused, both ways", () => {
    expect(() =>
      build(sqlite, post, "findMany", {
        where: { id: { equals: postRefs.title } },
      })
    ).toThrowError(BYTES_VS_TEXT);
    expect(() =>
      build(sqlite, post, "findMany", {
        where: { title: { equals: postRefs.id } },
      })
    ).toThrowError(TEXT_VS_BYTES);
  });

  test("two compact columns of DIFFERENT domains are refused", () => {
    // On MySQL both columns are `BINARY(16)`, so the comparison would run and
    // answer TRUE for two rows whose public values differ.
    expect(() =>
      build(mysql, post, "findMany", {
        where: { id: { equals: postRefs.authorId } },
      })
    ).toThrowError(TWO_COMPACT_DOMAINS);
    // On PostgreSQL they are not even the same column type.
    expect(() =>
      build(pg, post, "findMany", {
        where: { id: { equals: postRefs.authorId } },
      })
    ).toThrowError(UUID_PAYLOAD);
    expect(() =>
      build(pg, post, "findMany", {
        where: { id: { equals: postRefs.authorId } },
      })
    ).toThrowError(QueryEngineError);
  });

  test("one domain in one storage compares with itself", () => {
    for (const adapter of [pg, mysql, sqlite]) {
      expect(
        build(adapter, post, "findMany", {
          where: { id: { equals: postRefs.id } },
          select: { title: true },
        }).values
      ).toEqual([]);
    }
  });

  test("two TEXT columns compare, whatever their domains", () => {
    expect(
      build(pg, textStored, "findMany", {
        where: { id: { equals: textRefs.label } },
        select: { label: true },
      }).values
    ).toEqual([]);
    expect(
      build(pg, user, "findMany", {
        where: { slug: { equals: userRefs.slug } },
        select: { slug: true },
      }).values
    ).toEqual([]);
  });
});

describe("decoding an identifier column", () => {
  test("every driver binary shape decodes to one public string", () => {
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
      expect(decode(sqlite, user, { id: true }, [{ id: shape }])).toEqual([
        { id: USER },
      ]);
    }
  });

  test("a PostgreSQL uuid column decodes its text, prefix re-applied", () => {
    expect(
      decode(pg, user, { id: true }, [{ id: UUID }, { id: UUID.toUpperCase() }])
    ).toEqual([{ id: USER }, { id: USER }]);
  });

  test("a row comes back as the public string on every dialect", () => {
    const select = { id: true, slug: true };
    expect(decode(pg, user, select, [{ id: UUID, slug: CUID }])).toEqual([
      { id: USER, slug: CUID },
    ]);
    expect(
      decode(sqlite, user, select, [{ id: bytesOf(UUID_HEX), slug: CUID }])
    ).toEqual([{ id: USER, slug: CUID }]);
  });

  test("a FOREIGN KEY row decodes through its derived domain", () => {
    const ULID_HEX = "0173b5f0a1d5c2b3a4958677a8b9cadb";
    expect(
      decode(mysql, post, { id: true, title: true, authorId: true }, [
        { id: ULID_HEX, title: "t", authorId: UUID_HEX },
      ])
    ).toEqual([{ id: expect.any(String), title: "t", authorId: USER }]);
  });

  test("an absent or null value on a required key is malformed", () => {
    expect(
      reasonOf(() => decode(pg, user, { id: true }, [{ id: undefined }]))
    ).toBe(VALUE_ABSENT);
    expect(reasonOf(() => decode(pg, user, { id: true }, [{ id: null }]))).toBe(
      REQUIRED_NULL
    );
  });

  test("a physical value outside the domain is malformed, not returned", () => {
    expect(
      reasonOf(() => decode(pg, user, { id: true }, [{ id: "not-a-uuid" }]))
    ).toBe(NOT_IN_DOMAIN);
  });

  test("a nullable identifier keeps its null", () => {
    expect(decode(pg, optional, { refId: true }, [{ refId: null }])).toEqual([
      { refId: null },
    ]);
  });

  test("a captured row key is the canonical PUBLIC string, a primitive", () => {
    // Captured keys are what the engine compares and re-binds. Bytes would
    // compare by reference and a prefixed payload would address another row.
    const keys = decode(
      sqlite,
      optional,
      { refId: true },
      [{ refId: bytesOf(UUID_HEX) }, { refId: null }],
      { internal: true }
    );
    expect(keys).toEqual([{ refId: USER }, { refId: null }]);
    expect(typeof keys[0]?.refId).toBe("string");
  });

  test("every identifier field crosses the codec; a plain string does not", () => {
    // A TEXT-stored domain is decoded too: publicly its canonical spelling,
    // internally the spelling the row holds, so a captured key re-binds the
    // stored bytes and addresses its own row.
    const aliased = `usr-${UUID.toUpperCase()}`;
    expect(decode(pg, textStored, { id: true }, [{ id: aliased }])).toEqual([
      { id: USER },
    ]);
    expect(
      decode(pg, textStored, { id: true }, [{ id: aliased }], {
        internal: true,
      })
    ).toEqual([{ id: aliased }]);
    expect(
      reasonOf(() => decode(pg, user, { slug: true }, [{ slug: "not a cuid" }]))
    ).toBe(NOT_IN_DOMAIN);
    expect(decode(pg, post, { title: true }, [{ title: "any text" }])).toEqual([
      { title: "any text" },
    ]);
  });

  test("a leaf is resolved per column, not per scalar", () => {
    expect(
      decode(mysql, left, { id: true, label: true }, [
        { id: UUID_HEX, label: "a" },
      ])
    ).toEqual([{ id: UUID, label: "a" }]);
  });
});

describe("a native binary override of the wrong dialect", () => {
  test("takes the dialect's automatic storage instead", () => {
    const where = { where: { id: UUID }, select: { id: true } };
    expect(build(pg, mixed, "findMany", where).toStatement("$n")).toContain(
      "CAST($1 AS UUID)"
    );
    expect(build(mysql, mixed, "findMany", where).values).toEqual([
      bytesOf(UUID_HEX),
    ]);
  });
});

describe("an adapter or driver that stands between the row and the codec", () => {
  test("an adapter that declares no identifier promise stores text", () => {
    const silent = variant(pg, { idRepresentation: undefined });
    const where = build(silent, user, "findMany", {
      where: { id: USER },
      select: { id: true },
    });
    expect(where.toStatement("$n")).not.toContain("UUID");
    expect(where.values).toEqual([USER]);
  });

  test("a driver's own field middleware still runs before the codec", () => {
    const driver = new D1Driver({ database: Object.create(null) });
    expect(
      decode(
        sqlite,
        user,
        { id: true, slug: true },
        [{ id: UUID_HEX, slug: CUID }],
        { driver }
      )
    ).toEqual([{ id: USER, slug: CUID }]);
  });

  test("a VibORM error from a provider decode reaches the caller intact", () => {
    // A provider that raises the library's own error has already said what
    // went wrong; the provider chain's owner (`Queries.fieldReader`) passes
    // it through and reports only a FOREIGN throw as a malformed scalar.
    const named = variant(sqlite, {
      parseField: () => {
        throw new QueryEngineError("the driver said so");
      },
    });
    const run = () => decode(named, user, { id: true }, [{ id: UUID_HEX }]);
    expect(run).toThrowError(QueryEngineError);
    expect(run).toThrowError("the driver said so");
  });

  test("a provider decode that throws is malformed, not a leaked error", () => {
    const hostile = variant(sqlite, {
      parseField: () => {
        throw new Error("provider exploded");
      },
    });
    expect(
      reasonOf(() => decode(hostile, user, { id: true }, [{ id: UUID_HEX }]))
    ).toBe(PROVIDER_DECODE_FAILED);
  });
});

/**
 * A TEXT-stored identifier is, below admission, a string column: it binds,
 * projects, collates and aggregates exactly as a column with no domain. The
 * port was measured byte-identical against the engine before it (a 148-case
 * dump over three dialects); this keeps that fact as a standing pin by
 * building the same operations over the same shapes with and without domains.
 */
describe("a text-stored identifier builds the SQL of a plain string column", () => {
  const NANO = "V1StGXR8_Z5jdHi6B-myT";
  const operations: [
    "findMany" | "findUnique" | "aggregate" | "groupBy",
    Record<string, unknown>,
    Record<string, unknown>,
  ][] = [
    [
      "findMany",
      { where: { id: { equals: NANO }, slug: { in: [CUID] } } },
      { where: { id: { equals: NANO }, slug: { in: [CUID] } } },
    ],
    [
      "findMany",
      { where: { slug: { contains: "tz4", mode: "insensitive" } } },
      { where: { slug: { contains: "tz4", mode: "insensitive" } } },
    ],
    [
      "findMany",
      { cursor: { id: NANO }, orderBy: { slug: "asc" }, take: 2 },
      { cursor: { id: NANO }, orderBy: { slug: "asc" }, take: 2 },
    ],
    ["findUnique", { where: { id: NANO } }, { where: { id: NANO } }],
    [
      "findMany",
      { include: { posts: { where: { authorId: NANO, id: CUID } } } },
      { include: { posts: { where: { authorId: NANO, id: CUID } } } },
    ],
    [
      "aggregate",
      { _min: { id: true, slug: true }, _max: { id: true } },
      { _min: { id: true, slug: true }, _max: { id: true } },
    ],
    [
      "groupBy",
      { by: ["slug"], having: { id: { _min: { not: null } } } },
      { by: ["slug"], having: { id: { _min: { not: null } } } },
    ],
  ];
  const textModel = { user: textUser, post: textPost };
  const plainModel = { user: plainUser, post: plainPost };

  test.each([
    ["pg", pg, pgText],
    ["mysql", mysql, mysqlText],
    ["sqlite", sqlite, sqliteText],
  ] as const)("on %s", (_name, adapter, overridden) => {
    for (const [operation, withDomain, withoutDomain] of operations) {
      const text = build(adapter, textModel.user, operation, withDomain);
      const plain = build(adapter, plainModel.user, operation, withoutDomain);
      const rename = (statement: string) =>
        statement
          .replaceAll("textUser", "plainUser")
          .replaceAll("textPost", "plainPost");
      expect(rename(text.toStatement("$n"))).toBe(plain.toStatement("$n"));
      expect(text.values).toEqual(plain.values);
    }
    // A uuid domain kept text by this dialect's own override is a string
    // column too, prefix and all.
    for (const args of [
      { where: { id: { in: [USER] } }, orderBy: { id: "desc" } },
      { _min: { id: true }, _max: { id: true } },
    ]) {
      const operation = "where" in args ? "findMany" : "aggregate";
      const text = build(adapter, overridden, operation, args);
      const plain = build(adapter, plainLabel, operation, args);
      const rename = (statement: string) =>
        statement.replaceAll(overridden["~"].names.sql ?? "", "plainLabel");
      expect(rename(text.toStatement("$n"))).toBe(plain.toStatement("$n"));
      expect(text.values).toEqual(plain.values);
    }
    // A foreign key deriving a text domain binds the public string too.
    const derived = build(adapter, textModel.post, "findMany", {
      where: { id: CUID, authorId: NANO },
    }).values;
    expect(derived).toContain(NANO);
    expect(derived.every((value) => typeof value === "string")).toBe(true);
  });
});
