import { passThroughParseResult } from "@adapters/adapter-result-parser";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver, type DriverResultParser } from "@drivers";
import { sqliteResultParser } from "@drivers/shared";
import { QueryEngineError } from "@errors";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { CURSOR_CARRIER_PREFIX } from "@query-engine/result-aliases";
import { hydrateSchemaNames, s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Lane Q / U5 — one physical result vocabulary, and the driver result seam.
 *
 * The provider-backed half of this unit is witnessed by
 * `tests/providers/local/sqlite3-scalar-roundtrip.test.ts` (decimal exactness,
 * every scalar inside an include, JSON primitives) and by the polymorphic
 * suites. What a live provider cannot show is a driver that answers WRONG:
 * these cells hand the decoder rows no real provider would return and assert
 * that each one fails closed, with the public error class.
 */

/** A driver that answers exactly the rows a cell hands it. */
class ScriptedDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  readonly statements: string[] = [];
  readonly result: DriverResultParser | undefined;
  private readonly rows: Record<string, unknown>[];
  constructor(
    rows: Record<string, unknown>[],
    dialect: Dialect = "sqlite",
    result?: DriverResultParser,
    adapter: DatabaseAdapter = new SQLiteAdapter()
  ) {
    super(dialect, "scripted");
    this.rows = rows;
    this.result = result;
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // Scripted rows own no provider resource.
  }
  protected async execute<T>(
    _client: null,
    sql: string
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(sql);
    return { rows: this.rows as T[], rowCount: this.rows.length };
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

const child = s
  .model({
    id: s.int().id(),
    parentId: s.int(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  })
  .map("parity_decode_children");

const parent = s
  .model({
    id: s.int().id(),
    meta: s.json().nullable(),
    price: s.decimal({ precision: 12, scale: 2 }),
    bucket: s.string().nullable(),
    children: s.toMany(() => child),
  })
  .map("parity_decode_parents");

const schema = { parent, child };

/**
 * The D-40 cells count over a model with no provider-limited scalar, so the
 * same schema admits the PostgreSQL and MySQL adapters as well as SQLite.
 */
const counted = s
  .model({ id: s.int().id(), rank: s.int() })
  .map("parity_decode_counted");
const countedSchema = { counted };

beforeAll(() => {
  hydrateSchemaNames(schema);
  hydrateSchemaNames(countedSchema);
});

const scripted = (
  rows: Record<string, unknown>[],
  result?: DriverResultParser
) => {
  const driver = new ScriptedDriver(rows, "sqlite", result);
  return { driver, client: createClient({ schema, driver }) };
};

describe("the decoder fails closed on a wrong provider row", () => {
  test("a null _count carrier is a malformed row, not a null count", async () => {
    const { client } = scripted([{ id: 1, _count: null }]);
    await expect(
      client.parent.findMany({ select: { id: true, _count: true } })
    ).rejects.toBeInstanceOf(QueryEngineError);
    await client.$disconnect();
  });

  // The prototype-named field the deleted suite pinned (`toString`,
  // `constructor`, `valueOf`) cannot reach this decoder at all: the schema's
  // identifier preflight refuses such a field when the schema is hydrated
  // (`schema/hydration.ts:134`), which is a stronger statement than the cell
  // made. The decoder reads own keys anyway, because the document it reads is
  // a `JSON.parse` result whose key set the PROVIDER chose.

  test("a relation that is not an array raises the public class", async () => {
    const { client } = scripted([{ id: 1, children: "{}" }]);
    const read = client.parent.findMany({
      select: { id: true, children: { select: { id: true } } },
    });
    await expect(read).rejects.toBeInstanceOf(QueryEngineError);
    await client.$disconnect();
  });

  test("a document that is not a row raises the public class", async () => {
    const { client } = scripted([{ id: 1, parent: "5" }]);
    await expect(
      client.child.findMany({
        select: { id: true, parent: { select: { id: true } } },
      })
    ).rejects.toBeInstanceOf(QueryEngineError);
    await client.$disconnect();
  });
});

describe("the driver result seam is reached (D-17)", () => {
  test("the driver's own json rule decodes a top-level document", async () => {
    // SQLite stores `json` as TEXT and its DRIVER owns that fact. Without the
    // seam the decoder had to re-implement it — and then re-ran it on values a
    // JSON window had already decoded.
    const { client } = scripted(
      [{ id: 1, meta: '"just a json string"' }],
      sqliteResultParser
    );
    await expect(
      client.parent.findMany({ select: { id: true, meta: true } })
    ).resolves.toEqual([{ id: 1, meta: "just a json string" }]);
    await client.$disconnect();
  });

  test("a driver rule that throws is a malformed value, not a raw SyntaxError", async () => {
    const { client } = scripted(
      [{ id: 1, meta: "{not json" }],
      sqliteResultParser
    );
    const read = client.parent.findMany({ select: { id: true, meta: true } });
    await expect(read).rejects.toBeInstanceOf(QueryEngineError);
    await client.$disconnect();
  });

  test("the count and the exists answer are the decoder's, not the seam's (D-35)", async () => {
    // Until D-35 the shipped SQLite parser also carried a RESULT arm: for
    // `count`/`exist` it offered `normalizeCountResult(raw)` — a shared helper
    // D-40 has since deleted with its last caller — which recognised a
    // single-column row named `0viborm_count_result` or `COUNT(…)`. This
    // engine asks for `_count` and the SQLite providers preserve the alias, so
    // the arm decided `undefined` on every real answer (measured on a live
    // better-sqlite3: `g4/rulings/d35/receipts/arm-inert-before.log`) and was
    // deleted. The rows below are that measured raw — an INTEGER column read
    // with `safeIntegers`, hence BigInt — and the answers are unchanged, with
    // the shipped parser installed and nothing of its own between the transport
    // and the decoder. `driver-export-surface.core.test.ts` carries the same
    // parser to sqlite3, bun-sqlite, d1 and libsql.
    expect(sqliteResultParser.parseResult).toBeUndefined();

    const counted = scripted([{ _count: 2n }], sqliteResultParser);
    await expect(counted.client.parent.count({})).resolves.toBe(2);
    await counted.client.$disconnect();

    const present = scripted([{ _count: 1n }], sqliteResultParser);
    await expect(
      present.client.parent.exist({ where: { id: 1 } })
    ).resolves.toBe(true);
    await present.client.$disconnect();

    const absent = scripted([{ _count: 0n }], sqliteResultParser);
    await expect(
      absent.client.parent.exist({ where: { id: 1 } })
    ).resolves.toBe(false);
    await absent.client.$disconnect();
  });

  test("a JSON integer outside the safe range is refused, and a safe one is a number", async () => {
    const { client } = scripted([{ id: 1, meta: 42n }]);
    await expect(
      client.parent.findMany({ select: { id: true, meta: true } })
    ).resolves.toEqual([{ id: 1, meta: 42 }]);
    await client.$disconnect();

    const huge = scripted([{ id: 1, meta: 2n ** 70n }]);
    await expect(
      huge.client.parent.findMany({ select: { id: true, meta: true } })
    ).rejects.toBeInstanceOf(QueryEngineError);
    await huge.client.$disconnect();
  });
});

describe("the adapter result seam decides nothing (D-40)", () => {
  /**
   * The same scripted transport carrying a REAL provider adapter, so what
   * answers is the shipped `parseResult` of that dialect and the decoder
   * below it.
   *
   * Until D-40 MySQL's leg offered `normalizeCountResult(raw)` for
   * `count`/`exist` and PostgreSQL's offered `convertBigIntToNumber(raw)` for
   * every verb; both were measured answering `undefined` on every live
   * operation of both routes (`g4/rulings/o2/receipts/leg-probe-*.log`),
   * because the engine asks for the alias `_count` and `Queries.decodeResult`
   * hands the leg a ROW ARRAY, which is never a bigint. That each adapter's
   * member is now the contract's pass-through is pinned once, at the adapter
   * seam, by `tests/contracts/adapters/internals-and-geo.core.test.ts`; the
   * two provider cells below assert only what the DECODER answers with that
   * adapter in the path.
   */
  const on =
    (adapter: DatabaseAdapter, dialect: Dialect) =>
    (rows: Record<string, unknown>[]) => {
      const driver = new ScriptedDriver(rows, dialect, undefined, adapter);
      return createClient({ schema: countedSchema, driver });
    };

  test("PostgreSQL answers the count and the exists from the decoder alone", async () => {
    const scriptedPg = on(new PostgresAdapter(), "postgresql");

    // The answers are the ones measured live, over the raw `pg` and
    // `postgres.js` actually answer: `COUNT(*)` as integer TEXT.
    const counted = scriptedPg([{ _count: "2" }]);
    await expect(counted.counted.count({})).resolves.toBe(2);
    await counted.$disconnect();

    const present = scriptedPg([{ _count: "1" }]);
    await expect(present.counted.exist({ where: { id: 1 } })).resolves.toBe(
      true
    );
    await present.$disconnect();

    const absent = scriptedPg([{ _count: "0" }]);
    await expect(absent.counted.exist({ where: { id: 1 } })).resolves.toBe(
      false
    );
    await absent.$disconnect();

    // The bigint the deleted leg claimed to convert: the `int` codec owns that
    // conversion, per VALUE, and it also refuses what the helper only fell
    // through on.
    const carried = scriptedPg([{ _count: 2n }]);
    await expect(carried.counted.count({})).resolves.toBe(2);
    await carried.$disconnect();

    const unsafe = scriptedPg([{ _count: 2n ** 70n }]);
    await expect(unsafe.counted.count({})).rejects.toBeInstanceOf(
      QueryEngineError
    );
    await unsafe.$disconnect();
  });

  test("MySQL answers them from the decoder alone, and only under its own alias", async () => {
    const scriptedMysql = on(new MySQLAdapter(), "mysql");

    // The raw mysql2 answers, measured live.
    const counted = scriptedMysql([{ _count: 2 }]);
    await expect(counted.counted.count({})).resolves.toBe(2);
    await counted.$disconnect();

    const present = scriptedMysql([{ _count: 1 }]);
    await expect(present.counted.exist({ where: { id: 1 } })).resolves.toBe(
      true
    );
    await present.$disconnect();

    const absent = scriptedMysql([{ _count: 0 }]);
    await expect(absent.counted.exist({ where: { id: 1 } })).resolves.toBe(
      false
    );
    await absent.$disconnect();

    // The alias the engine asked for is the ONLY authority on where a count
    // lives: the column `normalizeCountResult` used to RECOGNISE and the one it
    // used to PRODUCE both fail closed, with the public class, exactly as they
    // did before the deletion — the key it produced was one the decoder cannot
    // read either.
    const recognised = scriptedMysql([{ "COUNT(*)": 2 }]);
    await expect(recognised.counted.count({})).rejects.toBeInstanceOf(
      QueryEngineError
    );
    await recognised.$disconnect();

    const produced = scriptedMysql([{ "0viborm_count_result": 2 }]);
    await expect(produced.counted.count({})).rejects.toBeInstanceOf(
      QueryEngineError
    );
    await produced.$disconnect();
  });

  /** An adapter from outside this estate, carrying a `parseResult` of its own. */
  class CustomAdapter extends SQLiteAdapter {
    readonly asked: { operation: string; raw: unknown }[] = [];
    constructor() {
      super();
      this.result = {
        ...this.result,
        parseResult: (raw, operation, next) => {
          this.asked.push({ operation, raw });
          // Recovering a result its transport named otherwise — the reason the
          // seam is an extension point and not an internal detail.
          const rows = raw as Record<string, unknown>[];
          return next(rows.map((row) => ({ _count: row.zz_count })));
        },
      };
    }
  }

  test("the three shipped adapters share one pass-through, and a custom adapter's own is still asked", async () => {
    // Arnaud's D-43: after D-40 the three shipped members were byte-identical,
    // and one fact gets one owner — the constant declared beside the contract
    // member it implements. Identity, not behavior: what each adapter's leg
    // DOES is `internals-and-geo.core.test.ts`'s cell above.
    expect(new SQLiteAdapter().result.parseResult).toBe(passThroughParseResult);
    expect(new MySQLAdapter().result.parseResult).toBe(passThroughParseResult);
    expect(new PostgresAdapter().result.parseResult).toBe(
      passThroughParseResult
    );

    // Arnaud's D-42: what the cells above measure is a CHOICE of the shipped
    // adapters, not a dead seam, and sharing one do-nothing member does not
    // close it. `Queries.decodeResult` still asks the adapter it was given,
    // once, with the operation's verb and its own rows, and still honours what
    // that adapter hands `next` — here the alias its transport did not
    // preserve, which is the recovery this contract exists for.
    const custom = new CustomAdapter();
    const client = on(custom, "sqlite")([{ zz_count: 2 }]);
    await expect(client.counted.count({})).resolves.toBe(2);
    await client.$disconnect();
    expect(custom.asked).toEqual([
      { operation: "count", raw: [{ zz_count: 2 }] },
    ]);
  });
});

describe("one physical vocabulary", () => {
  function build(
    model: typeof child | typeof parent,
    args: Record<string, unknown>
  ): string {
    const engine = new QueryEngine(
      new SqlOnlyDriver(new SQLiteAdapter(), "sqlite"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    return engine
      .build(model, "findMany" as never, args as never)
      .toStatement("?");
  }

  test("a decimal carried inside a window stays TEXT", () => {
    const statement = build(child, {
      select: { id: true, parent: { select: { price: true } } },
    });
    // The projection casts a decimal to text; the carrier must state the same
    // physical fact, or the container rounds it into a JSON number.
    expect(statement.match(/CAST\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the cursor carrier has one home", () => {
    // The null-guarded arm — the one spelling that carries the cursor row's
    // own values — is taken by a NULLABLE sort column.
    const statement = build(parent, {
      take: 2,
      cursor: { id: 1 },
      orderBy: { bucket: "asc" },
    });
    expect(statement).toContain(CURSOR_CARRIER_PREFIX);
  });
});
