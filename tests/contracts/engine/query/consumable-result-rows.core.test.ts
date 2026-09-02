import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { D1Driver } from "@drivers/d1";
import type { DriverResultParser } from "@drivers/driver";
import {
  parsePreparedResult,
  parseResult,
  prepareResultRows,
  ResultParser,
} from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
} from "@query-engine/result-aliases";
import type { Operation } from "@query-engine/types";
import { s } from "@schema";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { isRecord } from "@validation/value-guards";
import { describe, expect, test, vi } from "vitest";

const EXPECTED_COLUMNS_PATTERN = /requested result columns/i;
const POINT_ERROR_PATTERN = /point/i;

const models = (() => {
  const root = s.model({
    id: s.string().id(),
    enabled: s.boolean(),
    children: s.toMany(() => child),
    rankedChildren: s.toMany(() => rankedChild),
  });
  const child = s.model({
    id: s.string().id(),
    rootId: s.string(),
    recordedAt: s.dateTime(),
    parent: s
      .toOne(() => root)
      .fields("rootId")
      .references("id"),
  });
  const rankedChild = s.model({
    id: s.string().id(),
    rootId: s.string(),
    rank: s.int(),
    parent: s
      .toOne(() => root)
      .fields("rootId")
      .references("id"),
  });
  return { root, child, rankedChild };
})();

prepareSchema(models);

const shapeModels = {
  empty: s.model({}),
  doc: s.model({ embedding: s.vector().dimension(3) }),
  pointDoc: s.model({ location: s.point() }),
};

prepareSchema(shapeModels);

const pointRelationModels = (() => {
  const root = s.model({
    id: s.string().id(),
    children: s.toMany(() => child),
  });
  const child = s.model({
    id: s.string().id(),
    rootId: s.string(),
    location: s.point(),
    parent: s
      .toOne(() => root)
      .fields("rootId")
      .references("id"),
  });
  return { root, child };
})();

prepareSchema(pointRelationModels);

function sqliteParser(driver?: D1Driver) {
  return parserFor(
    new SQLiteAdapter(),
    models.root,
    driver ?? new D1Driver({ database: Object.create(null) })
  );
}

class ReplacingResultDriver extends D1Driver {
  readonly replacement: unknown[];

  override readonly result: DriverResultParser;

  constructor(replacement: unknown[]) {
    super({ database: Object.create(null) });
    this.replacement = replacement;
    this.result = {
      parseResult: (_raw, operation, next) => next(this.replacement, operation),
    };
  }
}

function parseConsumableResult<T>(
  parser: ResultParser,
  operation: Operation,
  raw: unknown[],
  args: Record<string, unknown>,
  consumableRows: unknown[]
): T {
  const shape = buildExpectedResultShape(
    parser.model,
    operation,
    args,
    parser.relations
  );
  if (!shape) {
    throw new Error("The result does not compile to a root row parser.");
  }
  const compiled = prepareResultRows(parser, operation, shape);
  if (!compiled) {
    throw new Error("The result does not compile to a root row parser.");
  }
  return parsePreparedResult<T>(
    parser,
    operation,
    raw,
    args,
    shape,
    compiled,
    consumableRows
  );
}

describe("consumable root row contracts", () => {
  test("reuses one consumable single-record row for same-key conversion", () => {
    const row = { id: "root-1", enabled: 1 };
    const raw = [row];

    const parsed = parseConsumableResult<{ id: string; enabled: boolean }>(
      sqliteParser(),
      "findUnique",
      raw,
      {},
      raw
    );

    expect(parsed).toBe(row);
    expect(parsed.enabled).toBe(true);
  });

  test("reuses consumable roots for same-key conversion and returns a fresh array", () => {
    const first = { id: "root-1", enabled: 1 };
    const second = { id: "root-2", enabled: 0 };
    const raw = [first, second];

    const parsed = parseConsumableResult<
      Array<{ id: string; enabled: boolean }>
    >(sqliteParser(), "findMany", raw, {}, raw);

    expect(parsed).not.toBe(raw);
    expect(parsed[0]).toBe(first);
    expect(parsed[1]).toBe(second);
    expect(parsed.map((row) => row.enabled)).toEqual([true, false]);
  });

  test("validates every root shape before mutating the first consumable row", () => {
    const first = { id: "root-1", enabled: 1 };
    const raw = [first, { id: "root-2" }];

    expect(() =>
      parseConsumableResult(sqliteParser(), "findMany", raw, {}, raw)
    ).toThrow(EXPECTED_COLUMNS_PATTERN);
    expect(first.enabled).toBe(1);
  });

  test("does not mutate a prior consumable point row when a later point is malformed", () => {
    const first = {
      location: '{"longitude":2.3522,"latitude":48.8566}',
    };
    const raw = [first, { location: '{"longitude":2.3522}' }];

    expect(() =>
      parseConsumableResult(
        parserFor(new SQLiteAdapter(), shapeModels.pointDoc),
        "findMany",
        raw,
        { select: { location: true } },
        raw
      )
    ).toThrow(POINT_ERROR_PATTERN);
    expect(first.location).toBe('{"longitude":2.3522,"latitude":48.8566}');
  });

  test("copies a relation-count carrier instead of reusing it", () => {
    const row = {
      id: "root-1",
      [RELATION_COUNTS_RESULT_KEY]: { children: 2 },
    };
    const raw = [row];

    const parsed = parseConsumableResult<
      Array<{ id: string; _count: { children: number } }>
    >(
      parserFor(new PostgresAdapter(), models.root),
      "findMany",
      raw,
      { select: { id: true, _count: { select: { children: true } } } },
      raw
    );

    expect(parsed[0]).not.toBe(row);
    expect(parsed[0]?._count).toEqual({ children: 2 });
    expect(row).not.toHaveProperty("_count");
  });

  test("copies the private empty-row carrier", () => {
    const row = { [EMPTY_ROW_RESULT_KEY]: 1 };
    const raw = [row];

    const parsed = parseConsumableResult<Record<string, unknown>[]>(
      parserFor(new PostgresAdapter(), shapeModels.empty),
      "findMany",
      raw,
      {},
      raw
    );

    expect(parsed[0]).not.toBe(row);
    expect(parsed).toEqual([{}]);
    expect(row).toEqual({ [EMPTY_ROW_RESULT_KEY]: 1 });
  });

  test("copies and renames the vector-distance carrier", () => {
    const row = { [DISTANCE_RESULT_KEY]: "0.25" };
    const raw = [row];

    const parsed = parseConsumableResult<Array<{ _distance: number }>>(
      parserFor(new PostgresAdapter(), shapeModels.doc),
      "findMany",
      raw,
      {
        select: {
          embedding: { _distance: { to: [1, 0, 0], metric: "l2" } },
        },
      },
      raw
    );

    expect(parsed[0]).not.toBe(row);
    expect(parsed).toEqual([{ _distance: 0.25 }]);
    expect(row).toEqual({ [DISTANCE_RESULT_KEY]: "0.25" });
  });

  test("copies and renames an aggregate carrier", () => {
    const aggregateKey = getAggregateResultKey("_count");
    const row = { [aggregateKey]: "2" };
    const raw = [row];

    const parsed = parseConsumableResult<{ _count: number }>(
      parserFor(new PostgresAdapter(), models.root),
      "aggregate",
      raw,
      { _count: true },
      raw
    );

    expect(parsed).not.toBe(row);
    expect(parsed).toEqual({ _count: 2 });
    expect(row).toEqual({ [aggregateKey]: "2" });
  });

  test("middleware replacement demotes the root to borrowed", () => {
    const original = [{ id: "root-1", enabled: 1 }];
    const replacementRow = { id: "root-2", enabled: 0 };
    const replacement = [replacementRow];
    const driver = new ReplacingResultDriver(replacement);

    const parsed = parseConsumableResult<
      Array<{ id: string; enabled: boolean }>
    >(sqliteParser(driver), "findMany", original, {}, original);

    expect(parsed[0]).not.toBe(replacementRow);
    expect(parsed[0]).toEqual({ id: "root-2", enabled: false });
    expect(replacementRow.enabled).toBe(0);
    expect(original[0]?.enabled).toBe(1);

    driver.result.parseResult = (_raw, _operation, next) =>
      next([{ id: "root-3", enabled: 2 }], "findFirst");
    let failure: unknown;
    try {
      parseConsumableResult(
        sqliteParser(driver),
        "findMany",
        original,
        {},
        original
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ meta: { operation: "findFirst" } });
  });

  test("reuses the root but copies a provider-owned nested object graph", () => {
    const child = {
      id: "child-1",
      rootId: "root-1",
      recordedAt: "2026-08-24T10:00:00.000Z",
    };
    const root = { id: "root-1", enabled: 1, children: [child] };
    const raw = [root];

    const parsed = parseConsumableResult<
      Array<{ children: Array<{ recordedAt: Date }> }>
    >(sqliteParser(), "findMany", raw, { include: { children: true } }, raw);

    expect(parsed[0]).toBe(root);
    expect(parsed[0]?.children[0]).not.toBe(child);
    expect(parsed[0]?.children[0]?.recordedAt).toEqual(
      new Date("2026-08-24T10:00:00.000Z")
    );
    expect(child.recordedAt).toBe("2026-08-24T10:00:00.000Z");
  });

  test("keeps a JSON-owned identity row when its guard needs conversion", () => {
    let jsonOwnedRow: unknown;
    const originalParse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text) => {
      const parsed: unknown = originalParse(text);
      if (Array.isArray(parsed) && parsed.length === 1) {
        jsonOwnedRow = parsed[0];
      }
      return parsed;
    });
    const root = {
      id: "root-1",
      enabled: true,
      rankedChildren: JSON.stringify([
        { id: "ranked-1", rootId: "root-1", rank: "7" },
      ]),
    };
    const raw = [root];

    try {
      const parsed = parseConsumableResult<
        Array<{ rankedChildren: Array<{ rank: number }> }>
      >(
        parserFor(new PostgresAdapter(), models.root),
        "findMany",
        raw,
        { include: { rankedChildren: true } },
        raw
      );

      expect(parsed[0]).toBe(root);
      expect(parsed[0]?.rankedChildren[0]).toBe(jsonOwnedRow);
      expect(parsed[0]?.rankedChildren[0]?.rank).toBe(7);
    } finally {
      parseSpy.mockRestore();
    }
  });

  test("does not mutate a prior JSON-owned point row when a later point is malformed", () => {
    let firstOwnedRow: Record<string, unknown> | undefined;
    let firstOwnedPoint: unknown;
    const originalParse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text) => {
      const parsed: unknown = originalParse(text);
      if (Array.isArray(parsed) && parsed.length === 2 && isRecord(parsed[0])) {
        firstOwnedRow = parsed[0];
        firstOwnedPoint = firstOwnedRow?.location;
      }
      return parsed;
    });

    try {
      expect(() =>
        parseResult(
          parserFor(new MySQLAdapter(), pointRelationModels.root),
          "findMany",
          [
            {
              id: "root-1",
              children: JSON.stringify([
                {
                  id: "child-1",
                  rootId: "root-1",
                  location: { longitude: 2.3522, latitude: 48.8566 },
                },
                {
                  id: "child-2",
                  rootId: "root-1",
                  location: { longitude: 2.3522 },
                },
              ]),
            },
          ],
          { include: { children: true } }
        )
      ).toThrow(POINT_ERROR_PATTERN);
      expect(firstOwnedRow?.location).toBe(firstOwnedPoint);
    } finally {
      parseSpy.mockRestore();
    }
  });

  test("manual parsing remains borrowed while native identity passthrough stays unchanged", () => {
    expect(Object.getOwnPropertySymbols(ResultParser.prototype)).toEqual([]);
    expect(Object.getOwnPropertyNames(ResultParser.prototype)).not.toContain(
      "parseConsumableResult"
    );
    expect(Object.getOwnPropertyNames(ResultParser.prototype)).not.toContain(
      "parsePreparedResult"
    );

    const converted = { id: "root-1", enabled: 1 };
    const convertedRaw = [converted];
    const convertedParsed = parseResult<Array<{ enabled: boolean }>>(
      sqliteParser(),
      "findMany",
      convertedRaw,
      {}
    );

    expect(convertedParsed).not.toBe(convertedRaw);
    expect(convertedParsed[0]).not.toBe(converted);
    expect(converted.enabled).toBe(1);

    const native = { id: "root-2", enabled: true };
    const nativeParsed = parseResult<Array<{ enabled: boolean }>>(
      parserFor(new PostgresAdapter(), models.root),
      "findMany",
      [native],
      {}
    );
    expect(nativeParsed[0]).toBe(native);
  });
});
