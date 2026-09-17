import type { DatabaseAdapter } from "@adapters/database-adapter";
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
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  readonly statements: string[] = [];
  readonly result: DriverResultParser | undefined;
  private readonly rows: Record<string, unknown>[];
  constructor(
    rows: Record<string, unknown>[],
    dialect: Dialect = "sqlite",
    result?: DriverResultParser
  ) {
    super(dialect, "scripted");
    this.rows = rows;
    this.result = result;
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
    at: s.point().nullable(),
    _distance: s.string().nullable(),
    children: s.toMany(() => child),
  })
  .map("parity_decode_parents");

const schema = { parent, child };
beforeAll(() => hydrateSchemaNames(schema));

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

  test("the registered _distance collision sentence, in both orders", () => {
    const paris = { longitude: 2.3522, latitude: 48.8566 };
    const sentence =
      "A distance result cannot be selected together with a model field named '_distance'.";
    expect(() =>
      build(parent, {
        select: { _distance: true, at: { _distance: { to: paris } } },
      })
    ).toThrow(sentence);
    expect(() =>
      build(parent, {
        select: { at: { _distance: { to: paris } }, _distance: true },
      })
    ).toThrow(sentence);
    // The OTHER registered sentence is unchanged and still owned by the same
    // arm; `tests/raptor3/g4/unit01/repairs.test.ts` pins it on two point
    // fields, which this model does not have a second of.
  });
});
