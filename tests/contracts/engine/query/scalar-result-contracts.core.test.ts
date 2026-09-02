import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { DriverResultParser } from "@drivers/driver";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { parseResult } from "@query-engine/result/ResultParser";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parserFor, prepareSchema } from "@tests/fixtures/query-scope";
import { type JsonValue, v } from "@validation";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

const ENUM_ERROR_PATTERN = /enum/i;
const INT_ERROR_PATTERN = /int/i;
const JSON_ERROR_PATTERN = /json/i;
const LIST_ERROR_PATTERN = /list/i;
const SPARSE_ERROR_PATTERN = /sparse/i;
const STRING_ERROR_PATTERN = /string/i;
const ASYNC_SCHEMA_ERROR_PATTERN = /asynchronous.*not supported/i;
const DECIMAL_ERROR_PATTERN = /decimal/i;
const DATETIME_ERROR_PATTERN = /datetime/i;
const DISTANCE_RESULT_ERROR_PATTERN = /distance result/i;

const customJsonSchema = v.object(
  {
    kind: v.literal("allowed"),
    score: v.number(),
  },
  { partial: false }
);

const asyncJsonSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "phase6-test",
    validate: async () => ({ value: { accepted: true } }),
  },
};

type JsonValidationResult = StandardSchemaV1.Result<JsonValue>;

let rejectedAsyncHandlerAttached = false;
let rejectedAsyncValueConsumed = false;

class ObservedRejectedValidation extends Promise<JsonValidationResult> {
  override then<TResult1 = JsonValidationResult, TResult2 = never>(
    onfulfilled?:
      | ((value: JsonValidationResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    if (!onrejected) return super.then(onfulfilled, onrejected);

    rejectedAsyncHandlerAttached = true;
    return super.then(onfulfilled, (reason) => {
      rejectedAsyncValueConsumed = true;
      return onrejected(reason);
    });
  }
}

const rejectedAsyncJsonSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "phase6-test",
    validate: () =>
      new ObservedRejectedValidation((_resolve, reject) => {
        reject(new Error("phase6-private-async-rejection"));
      }),
  },
};

let countingJsonValidationCalls = 0;
const countingJsonSchema: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "phase6-test",
    validate: () => {
      countingJsonValidationCalls += 1;
      return { value: countingJsonValidationCalls };
    },
  },
};

class ContinuationIdentityDriver extends SQLite3Driver {
  readonly adapterContinuations: ((value?: unknown) => unknown)[] = [];
  readonly driverContinuations: ((
    value: unknown,
    scalarType: string
  ) => unknown)[] = [];
  onAdapterField: ((value: unknown) => void) | undefined;
  override readonly result: DriverResultParser;

  constructor() {
    super();
    const adapterResult = this.adapter.result;
    this.adapter.result = {
      ...adapterResult,
      parseField: (value, _scalarType, next) => {
        this.adapterContinuations.push(next);
        this.onAdapterField?.(value);
        return next();
      },
    };
    this.result = {
      parseField: (value, scalarType, next) => {
        this.driverContinuations.push(next);
        return next(`${String(value)}-driver`, scalarType);
      },
    };
  }
}

class ThrowingFieldDriver extends SQLite3Driver {
  override readonly result: DriverResultParser;

  constructor(failure: unknown) {
    super();
    this.result = {
      parseField: () => {
        throw failure;
      },
    };
  }
}

const scalarModel = s.model({
  id: s.string().id(),
  text: s.string(),
  nullableText: s.string().nullable(),
  _distance: s.string(),
  integer: s.int(),
  ratio: s.number(),
  decimal: s.decimal({ precision: 40, scale: 30 }),
  money: s.decimal({ precision: 10, scale: 2 }),
  whole: s.decimal({ precision: 18, scale: 0 }),
  amounts: s.decimal({ precision: 10, scale: 2 }).array(),
  maybeMoney: s.decimal({ precision: 10, scale: 2 }).nullable(),
  large: s.bigInt(),
  flag: s.boolean(),
  happenedAt: s.dateTime(),
  epochTime: s.dateTime({ db: "sqlite", type: "INTEGER" }),
  julianTime: s.dateTime({ db: "sqlite", type: "REAL" }),
  bornOn: s.date(),
  wakeAt: s.time(),
  statusA: s.enum(["open"]),
  statusB: s.enum(["closed"]),
  statuses: s.enum(["plain", "a,b", 'a"b', "a\\b"]).array(),
  texts: s.string().array(),
  integers: s.int().array(),
  flags: s.boolean().array(),
  nullableTexts: s.string().array().nullable(),
  jsonValue: s.json(),
  vector3: s.vector().dimension(3),
  vectorAny: s.vector(),
  pointValue: s.point(),
  customJson: s.json().schema(customJsonSchema),
  asyncJson: s.json().schema(asyncJsonSchema),
  rejectedAsyncJson: s.json().schema(rejectedAsyncJsonSchema),
  countingJson: s.json().schema(countingJsonSchema),
});

const parent = s.model({
  id: s.string().id(),
  children: s.toMany(() => child),
});

const child = s.model({
  id: s.string().id(),
  parentId: s.string(),
  score: s.int(),
  parent: s
    .toOne(() => parent)
    .fields("parentId")
    .references("id"),
});

const schema = { scalarModel, parent, child };
prepareSchema(schema);
function createScalarContext(adapter: DatabaseAdapter = new PostgresAdapter()) {
  return parserFor(adapter, scalarModel);
}

function parseField(
  field: string,
  value: unknown,
  adapter?: DatabaseAdapter
): unknown {
  const [row] = parseResult<Record<string, unknown>[]>(
    createScalarContext(adapter),
    "findMany",
    [{ [field]: value }],
    { select: { [field]: true } }
  );
  return row?.[field];
}

function captureParserError(run: () => unknown): QueryEngineError {
  try {
    run();
  } catch (error) {
    if (error instanceof QueryEngineError) return error;
    throw error;
  }
  throw new Error(
    "Expected malformed scalar output to throw QueryEngineError."
  );
}

describe("strict scalar result contracts", () => {
  test("requires request args for result parsing at compile time", () => {
    const context = createScalarContext();
    const rows: unknown[] = [];
    // @ts-expect-error request-aware parsing requires explicit query args
    const parseWithoutArgs = () => parseResult(context, "findMany", rows);

    expect(parseWithoutArgs).toBeTypeOf("function");
  });

  test("preserves valid cross-provider scalar representations", () => {
    expect(parseField("flag", 1, new MySQLAdapter())).toBe(true);
    expect(parseField("flag", 0n)).toBe(false);
    expect(parseField("integer", "-42")).toBe(-42);
    expect(parseField("ratio", "1e2")).toBe(100);
    expect(parseField("large", "9007199254740993")).toBe(
      9_007_199_254_740_993n
    );
    expect(
      parseField("happenedAt", "2026-07-10 12:30:45.123", new MySQLAdapter())
    ).toEqual(new Date("2026-07-10T12:30:45.123Z"));
    expect(parseField("happenedAt", "2026-07-10T12:30:45.123")).toEqual(
      new Date("2026-07-10T12:30:45.123Z")
    );
    expect(parseField("happenedAt", "0000-01-01T23:59:59.999+23:59")).toEqual(
      new Date("0000-01-01T00:00:59.999Z")
    );
    expect(parseField("happenedAt", "9999-12-31T00:00:00.000-23:59")).toEqual(
      new Date("9999-12-31T23:59:00.000Z")
    );
    expect(parseField("bornOn", "2024-02-29")).toEqual(
      new Date("2024-02-29T00:00:00.000Z")
    );
    expect(parseField("bornOn", "0000-01-01")).toEqual(
      new Date("0000-01-01T00:00:00.000Z")
    );
    expect(parseField("bornOn", "9999-12-31")).toEqual(
      new Date("9999-12-31T00:00:00.000Z")
    );
    expect(parseField("bornOn", new Date("0000-01-01T00:00:00.000Z"))).toEqual(
      new Date("0000-01-01T00:00:00.000Z")
    );
    expect(parseField("bornOn", new Date("9999-12-31T00:00:00.000Z"))).toEqual(
      new Date("9999-12-31T00:00:00.000Z")
    );
    expect(parseField("wakeAt", "13:45:30.123000+00")).toBe("13:45:30.123");
    expect(parseField("nullableText", null)).toBeNull();
    expect(parseField("jsonValue", null)).toBeNull();
  });

  test("rejects present scalar columns whose provider value is absent", () => {
    expect(() => parseField("text", undefined)).toThrow(STRING_ERROR_PATTERN);
    expect(() => parseField("money", undefined)).toThrow(DECIMAL_ERROR_PATTERN);
    expect(() => parseField("amounts", undefined)).toThrow(
      DECIMAL_ERROR_PATTERN
    );
  });

  test("captures nullable row keys in their private null form", () => {
    const parser = createScalarContext();
    const [rows, rowKeys] = parser.parseRowsWithRowKeys<
      Record<string, unknown>[]
    >(
      "findMany",
      [{ maybeMoney: null, nullableText: null }],
      { select: { maybeMoney: true, nullableText: true } },
      ["maybeMoney", "nullableText"]
    );

    expect(rows).toEqual([{ maybeMoney: null, nullableText: null }]);
    expect(rowKeys).toEqual([{ maybeMoney: null, nullableText: null }]);
  });

  test("decodes each declared numeric SQLite DateTime form", () => {
    expect(parseField("epochTime", 0, new SQLiteAdapter())).toEqual(
      new Date("1970-01-01T00:00:00.000Z")
    );
    expect(parseField("julianTime", 2_440_587.5, new SQLiteAdapter())).toEqual(
      new Date("1970-01-01T00:00:00.000Z")
    );
    expect(() => parseField("epochTime", "0", new SQLiteAdapter())).toThrow(
      DATETIME_ERROR_PATTERN
    );
    expect(() =>
      parseField("julianTime", "2440587.5", new SQLiteAdapter())
    ).toThrow(DATETIME_ERROR_PATTERN);
  });

  test("translates provider scalar decoder failures without hiding VibORM errors", () => {
    const privateFailure = new Error("private-provider-value");
    const throwingDriver = new ThrowingFieldDriver(privateFailure);
    const translated = captureParserError(() =>
      parseResult(
        parserFor(throwingDriver.adapter, scalarModel, throwingDriver),
        "findMany",
        [{ text: "value" }],
        { select: { text: true } }
      )
    );
    expect(translated.message).not.toContain(privateFailure.message);

    const decimalFailure = new Error("private-decimal-provider-value");
    const decimalDriver = new ThrowingFieldDriver(decimalFailure);
    const translatedDecimal = captureParserError(() =>
      parseResult(
        parserFor(decimalDriver.adapter, scalarModel, decimalDriver),
        "findMany",
        [{ money: "1234" }],
        { select: { money: true } }
      )
    );
    expect(translatedDecimal.message).not.toContain(decimalFailure.message);

    const decimalListFailure = new Error("private-decimal-list-provider-value");
    const decimalListDriver = new ThrowingFieldDriver(decimalListFailure);
    const translatedDecimalList = captureParserError(() =>
      parseResult(
        parserFor(decimalListDriver.adapter, scalarModel, decimalListDriver),
        "findMany",
        [{ amounts: ["1.20"] }],
        { select: { amounts: true } }
      )
    );
    expect(translatedDecimalList.message).not.toContain(
      decimalListFailure.message
    );

    const vibormFailure = new QueryEngineError("owned decoder failure");
    const driver = new ThrowingFieldDriver(vibormFailure);
    for (const { field, value } of [
      { field: "text", value: "value" },
      { field: "money", value: "1234" },
      { field: "amounts", value: ["1.20"] },
    ]) {
      expect(() =>
        parseResult(
          parserFor(driver.adapter, scalarModel, driver),
          "findMany",
          [{ [field]: value }],
          { select: { [field]: true } }
        )
      ).toThrow(vibormFailure);
    }
  });

  test("keeps distinct enum contracts isolated by scalar identity", () => {
    const ctx = createScalarContext();
    const [row] = parseResult<Record<string, unknown>[]>(
      ctx,
      "findMany",
      [{ statusA: "open", statusB: "closed" }],
      { select: { statusA: true, statusB: true } }
    );

    expect(row).toEqual({ statusA: "open", statusB: "closed" });
    expect(() =>
      parseResult(ctx, "findMany", [{ statusA: "closed" }], {
        select: { statusA: true },
      })
    ).toThrow(ENUM_ERROR_PATTERN);
    expect(() =>
      parseResult(ctx, "findMany", [{ statusB: "open" }], {
        select: { statusB: true },
      })
    ).toThrow(ENUM_ERROR_PATTERN);
  });

  test("parses valid list transports and enforces list boundaries", () => {
    expect(parseField("texts", '["a","b"]')).toEqual(["a", "b"]);
    expect(parseField("integers", [1n, "2", 3])).toEqual([1, 2, 3]);
    expect(parseField("flags", [1, 0n, true])).toEqual([true, false, true]);
    expect(parseField("nullableTexts", null)).toBeNull();

    expect(() => parseField("integer", [1])).toThrow(INT_ERROR_PATTERN);
    expect(() => parseField("texts", "not-json")).toThrow(LIST_ERROR_PATTERN);
    expect(() => parseField("texts", '{"not":"a list"}')).toThrow(
      LIST_ERROR_PATTERN
    );
    expect(() => parseField("integers", [1, "wat"])).toThrow(INT_ERROR_PATTERN);
    expect(() => parseField("texts", [null])).toThrow(STRING_ERROR_PATTERN);
    expect(() => parseField("texts", [undefined])).toThrow(
      STRING_ERROR_PATTERN
    );
    expect(() => parseField("texts", null)).toThrow(LIST_ERROR_PATTERN);

    const sparse = new Array<unknown>(1);
    expect(() => parseField("texts", sparse)).toThrow(SPARSE_ERROR_PATTERN);
  });

  test("parses the PostgreSQL enum-array output grammar without JSON coercion", () => {
    expect(
      parseField(
        "statuses",
        String.raw`{plain,"a,b","a\"b","a\\b"}`,
        new PostgresAdapter()
      )
    ).toEqual(["plain", "a,b", 'a"b', "a\\b"]);
    expect(parseField("statuses", "{}", new PostgresAdapter())).toEqual([]);
  });

  test.each([
    ["missing braces", "plain,a,b"],
    ["unterminated quote", '{"plain}'],
    ["empty member", "{plain,,a}"],
    ["trailing delimiter", "{plain,}"],
    ["text after a quoted member", '{"plain"x}'],
    ["null member", "{plain,NULL}"],
  ])("rejects malformed PostgreSQL enum-array output: %s", (_label, value) => {
    expect(() =>
      parseField("statuses", value, new PostgresAdapter())
    ).toThrow();
  });

  test.each([
    ["boolean outside domain", "flag", 2, "boolean"],
    ["boolean string", "flag", "1", "boolean"],
    ["fractional integer", "integer", 1.5, "int"],
    ["unsafe integer", "integer", Number.MAX_SAFE_INTEGER + 1, "int"],
    ["hex integer", "integer", "0x10", "int"],
    ["exponent integer", "integer", "1e2", "int"],
    ["non-finite number", "ratio", Number.POSITIVE_INFINITY, "number"],
    ["hex number", "ratio", "0x10", "number"],
    ["malformed decimal", "money", "phase6-private-value", "decimal"],
    ["unsafe bigint number", "large", Number.MAX_SAFE_INTEGER + 1, "bigint"],
    ["fractional bigint", "large", 1.5, "bigint"],
    ["hex bigint", "large", "0x10", "bigint"],
    ["invalid datetime", "happenedAt", "not-a-date", "datetime"],
    ["rollover datetime", "happenedAt", "2024-02-30T10:00:00Z", "datetime"],
    ["hour-24 datetime", "happenedAt", "2024-02-29T24:00:00Z", "datetime"],
    [
      "zoned datetime with a space separator",
      "happenedAt",
      "2024-02-29 12:00:00+00:00",
      "datetime",
    ],
    [
      "datetime timezone outside the domain",
      "happenedAt",
      "2024-02-29T12:00:00+24:00",
      "datetime",
    ],
    [
      "datetime below the public range",
      "happenedAt",
      "0000-01-01T00:00:00.000+23:59",
      "datetime",
    ],
    [
      "datetime above the public range",
      "happenedAt",
      "9999-12-31T23:59:59.999-23:59",
      "datetime",
    ],
    [
      "Date below the public range",
      "happenedAt",
      new Date(-62_167_219_200_001),
      "datetime",
    ],
    [
      "Date above the public range",
      "happenedAt",
      new Date(253_402_300_800_000),
      "datetime",
    ],
    ["numeric datetime", "happenedAt", 0, "datetime"],
    ["rollover date", "bornOn", "2024-02-30", "date"],
    [
      "Date below the four-digit range",
      "bornOn",
      new Date(-62_167_219_200_001),
      "date",
    ],
    [
      "Date above the four-digit range",
      "bornOn",
      new Date(253_402_300_800_000),
      "date",
    ],
    ["numeric date", "bornOn", 0, "date"],
    ["object time", "wakeAt", { hour: 1 }, "time"],
    ["invalid time", "wakeAt", "25:00:00", "time"],
    ["invalid time zone hour", "wakeAt", "12:00:00+24:00", "time"],
    ["excess time precision", "wakeAt", "12:00:00.1234", "time"],
    ["numeric string scalar", "text", 1, "string"],
    ["unknown enum member", "statusA", "closed", "enum"],
    ["numeric enum", "statusA", 1, "enum"],
    ["required null", "text", null, "string"],
  ])("rejects $label", (_label, field, value, scalarType) => {
    const error = captureParserError(() => parseField(field, value));

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType,
    });
    expect(error.message).not.toContain("phase6-private-value");
  });

  test("rejects malformed scalar values inside nested relation rows", () => {
    const parentContext = parserFor(new PostgresAdapter(), parent);

    expect(() =>
      parseResult(
        parentContext,
        "findMany",
        [
          {
            id: "parent-1",
            children: [{ id: "child-1", parentId: "parent-1", score: "wat" }],
          },
        ],
        { include: { children: true } }
      )
    ).toThrow(INT_ERROR_PATTERN);
  });

  test("keeps JSON keys unconstrained while rejecting non-JSON values", () => {
    expect(
      parseField("jsonValue", {
        arbitrary: { nested: [1, "two", true, null] },
      })
    ).toEqual({ arbitrary: { nested: [1, "two", true, null] } });

    expect(() => parseField("jsonValue", Number.NaN)).toThrow(
      JSON_ERROR_PATTERN
    );
    expect(() => parseField("jsonValue", 9_007_199_254_740_993n)).toThrow(
      JSON_ERROR_PATTERN
    );
    expect(() => parseField("jsonValue", new Date())).toThrow(
      JSON_ERROR_PATTERN
    );
    expect(() => parseField("jsonValue", { missing: undefined })).toThrow(
      JSON_ERROR_PATTERN
    );
  });

  test("parses strict vector, point, and custom JSON representations", () => {
    expect(parseField("vector3", [1, -2.5, 3])).toEqual([1, -2.5, 3]);
    expect(parseField("vector3", "[1,-2.5,3]")).toEqual([1, -2.5, 3]);
    expect(parseField("vectorAny", [])).toEqual([]);
    expect(parseField("vectorAny", [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(parseField("pointValue", { longitude: -180, latitude: -0 })).toEqual(
      {
        longitude: 180,
        latitude: 0,
      }
    );
    expect(parseField("customJson", { kind: "allowed", score: 7 })).toEqual({
      kind: "allowed",
      score: 7,
    });
  });

  test.each([
    ["object", { x: 1, y: 2 }],
    ["malformed JSON text", "not-json"],
    ["non-array JSON text", '{"x":1}'],
    ["wrong dimension", [1, 2]],
    ["numeric string coordinate", [1, "2", 3]],
    ["NaN coordinate", [1, Number.NaN, 3]],
    ["infinite coordinate", [1, Number.POSITIVE_INFINITY, 3]],
    ["required null", null],
  ])("rejects malformed vector output: %s", (_label, value) => {
    const error = captureParserError(() => parseField("vector3", value));

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "vector",
    });
    expect(error.message).not.toContain("phase6-private-value");
  });

  test("rejects sparse vector output", () => {
    const sparse = new Array<unknown>(3);
    sparse[0] = 1;
    sparse[2] = 3;

    const error = captureParserError(() => parseField("vector3", sparse));
    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "vector",
    });
    expect(error.message).toMatch(SPARSE_ERROR_PATTERN);
  });

  test.each([
    ["primitive", 1],
    ["retired coordinate names", { x: 1, y: 2 }],
    ["missing coordinate", { longitude: 1 }],
    ["extra key", { longitude: 1, latitude: 2, altitude: 3 }],
    ["numeric string coordinate", { longitude: "1", latitude: 2 }],
    [
      "infinite coordinate",
      { longitude: Number.POSITIVE_INFINITY, latitude: 2 },
    ],
    ["PostgreSQL point text", "(1,2)"],
    ["GeoJSON point", { type: "Point", coordinates: [1, 2] }],
    ["required null", null],
  ])("rejects malformed point output: %s", (_label, value) => {
    const error = captureParserError(() => parseField("pointValue", value));

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "point",
    });
    expect(error.message).not.toContain("phase6-private-value");
  });

  test("redacts custom JSON validation details", () => {
    const error = captureParserError(() =>
      parseField("customJson", {
        kind: "phase6-private-value",
        score: 7,
      })
    );

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "json",
    });
    expect(error.message).not.toContain("phase6-private-value");
    expect(error.message).not.toContain("Expected literal");
  });

  test("rejects asynchronous custom JSON output schemas explicitly", () => {
    const error = captureParserError(() =>
      parseField("asyncJson", { phase6: "private-value" })
    );

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "json",
    });
    expect(error.message).toMatch(ASYNC_SCHEMA_ERROR_PATTERN);
    expect(error.message).not.toContain("private-value");
  });

  test("runs custom JSON output validation exactly once", () => {
    countingJsonValidationCalls = 0;

    expect(parseField("countingJson", { value: "raw" })).toBe(1);
    expect(countingJsonValidationCalls).toBe(1);
  });

  test("runs custom JSON validation once after adapter decoding", () => {
    countingJsonValidationCalls = 0;
    const adapter = new PostgresAdapter();
    adapter.result.parseField = (value, scalarType, next) => {
      if (scalarType !== "json") return next();
      const parsed = tryParseJsonString(value);
      return parsed === undefined ? next() : next(parsed);
    };
    const [row] = parseResult<Record<string, unknown>[]>(
      parserFor(adapter, scalarModel),
      "findMany",
      [{ countingJson: '{"value":"raw"}' }],
      { select: { countingJson: true } }
    );

    expect(row?.countingJson).toBe(1);
    expect(countingJsonValidationCalls).toBe(1);
  });

  test("runs custom JSON validation once after driver and adapter decoding", () => {
    countingJsonValidationCalls = 0;
    const driver = new SQLite3Driver();
    const [row] = parseResult<Record<string, unknown>[]>(
      parserFor(driver.adapter, scalarModel, driver),
      "findMany",
      [{ countingJson: '{"value":"raw"}' }],
      { select: { countingJson: true } }
    );

    expect(row?.countingJson).toBe(1);
    expect(countingJsonValidationCalls).toBe(1);
  });

  test("reuses field continuations without leaking reentrant input", () => {
    const driver = new ContinuationIdentityDriver();
    const parser = parserFor(driver.adapter, scalarModel, driver);
    driver.onAdapterField = (value) => {
      if (value !== "outer-driver") return;
      const [nested] = parseResult<Record<string, unknown>[]>(
        parser,
        "findMany",
        [{ text: "inner" }],
        { select: { text: true } }
      );
      expect(nested).toEqual({ text: "inner-driver" });
    };

    const rows = parseResult<Record<string, unknown>[]>(
      parser,
      "findMany",
      [{ text: "outer" }, { text: "second" }],
      { select: { text: true } }
    );

    expect(rows).toEqual([{ text: "outer-driver" }, { text: "second-driver" }]);
    expect(new Set(driver.driverContinuations)).toHaveLength(1);
    expect(new Set(driver.adapterContinuations)).toHaveLength(1);
  });

  test("observes rejected async JSON schemas without leaking the rejection", async () => {
    rejectedAsyncHandlerAttached = false;
    rejectedAsyncValueConsumed = false;

    const error = captureParserError(() =>
      parseField("rejectedAsyncJson", { value: "raw" })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "json",
    });
    expect(error.message).toMatch(ASYNC_SCHEMA_ERROR_PATTERN);
    expect(error.message).not.toContain("phase6-private-async-rejection");
    expect(rejectedAsyncHandlerAttached).toBe(true);
    expect(rejectedAsyncValueConsumed).toBe(true);
  });

  test("does not confuse a real _distance scalar with the private carrier", () => {
    expect(parseField("_distance", "ordinary scalar text")).toBe(
      "ordinary scalar text"
    );
  });

  test("refuses a distance projection that collides with a real _distance scalar", () => {
    expect(() =>
      parseResult(createScalarContext(), "findMany", [], {
        select: {
          _distance: true,
          vector3: { _distance: { to: [0, 0, 0] } },
        },
      })
    ).toThrow(DISTANCE_RESULT_ERROR_PATTERN);
  });
});

/**
 * The decimal result boundary.
 *
 * Every typed decimal read is a FRESH `Decimal` built from the codec's canonical
 * text — no JS number, no transport string, no provider-owned instance — and the
 * only physical spellings it accepts are the ones the active adapter promised
 * for that column: native decimal text where the dialect has an exact decimal
 * type, and the signed integer coefficient where it does not.
 */
function decimalAt(field: string, value: unknown, adapter?: DatabaseAdapter) {
  const parsed = parseField(field, value, adapter);
  if (parsed instanceof Decimal) return parsed;
  throw new Error(`expected a Decimal leaf, received ${typeof parsed}`);
}

/**
 * A provider whose decimals arrive as the unscaled integer coefficient.
 *
 * Built by DECLARING it on an otherwise text-spelling adapter, so the seam is
 * pinned on its own: the fact is a promise the adapter makes, not a driver name
 * the parser recognizes, and an adapter that says nothing reads as text.
 */
function coefficientAdapter(): DatabaseAdapter {
  const adapter: DatabaseAdapter = new PostgresAdapter();
  adapter.result = { ...adapter.result, decimalRepresentation: "coefficient" };
  return adapter;
}

describe("decimal results are fresh exact values", () => {
  test("native decimal text becomes one Decimal per leaf", () => {
    expect(decimalAt("money", "-0.50").eq("-0.5")).toBe(true);
    expect(decimalAt("money", "0.00").eq(0)).toBe(true);
    expect(decimalAt("whole", "9007199254740993").eq("9007199254740993")).toBe(
      true
    );
    // Past 2^53 in the fraction: a double could not tell this apart from 1.
    const exact = decimalAt("decimal", "1.000000000000000000000000000001");
    expect(exact.eq("1.000000000000000000000000000001")).toBe(true);
    expect(exact.eq(1)).toBe(false);
  });

  test("equal values are equal by .eq() and never by identity", () => {
    const left = decimalAt("money", "12.34");
    const right = decimalAt("money", "12.34");
    expect(left.eq(right)).toBe(true);
    expect(left).not.toBe(right);
  });

  test("a negative zero and a padded zero are the same canonical value", () => {
    // Canonicalization is what makes text equality a value equality: `-0.00`
    // and `0` name one number, so a row key built from either is one key.
    expect(decimalAt("money", "-0.00").isZero()).toBe(true);
    expect(decimalAt("money", "-0.00").isNegative()).toBe(false);
    expect(decimalAt("money", "-0").isZero()).toBe(true);
  });

  test("scale is a domain limit, not a spelling", () => {
    // `1.0` on a scale-ZERO column is the value 1 — the zero is insignificant
    // and canonicalization removes it before the domain is checked. Only a
    // NON-ZERO digit past the scale is outside the column.
    expect(decimalAt("whole", "1.0").eq(1)).toBe(true);
    expect(decimalAt("money", "12.3").eq("12.30")).toBe(true);
  });

  test("list members each materialize", () => {
    // A native decimal array arrives as one JavaScript member per element (the
    // measured `numeric(p,s)[]` shape), which is the vocabulary this default
    // adapter declares for a list. The JSON container is the OTHER vocabulary
    // and has its own witnesses in `decimal-list-container.core.test.ts`.
    const parsed = parseField("amounts", ["1.20", "-0.03"]);
    expect(Array.isArray(parsed)).toBe(true);
    const members = Array.isArray(parsed) ? parsed : [];
    expect(members).toHaveLength(2);
    expect(members.every((member) => member instanceof Decimal)).toBe(true);
    expect(members[0]).not.toBe(members[1]);
  });

  test("the shipped adapters declare the vocabulary this parser reads", () => {
    // The live control for the seam above: SQLite has no exact decimal type, so
    // it stores the coefficient and says so; PostgreSQL and MySQL return native
    // decimal text and say nothing, which is the default.
    const shipped: DatabaseAdapter[] = [
      new SQLiteAdapter(),
      new PostgresAdapter(),
      new MySQLAdapter(),
    ];

    expect(
      shipped.map((adapter) => adapter.result.decimalRepresentation)
    ).toEqual(["coefficient", undefined, undefined]);
  });

  test("a coefficient provider reads the unscaled integer, and only that", () => {
    const coefficient = coefficientAdapter();
    expect(decimalAt("money", "1234", coefficient).eq("12.34")).toBe(true);
    expect(decimalAt("money", "-3", coefficient).eq("-0.03")).toBe(true);
    // The SAME text means two different numbers under the two vocabularies,
    // which is exactly why the fact is declared and never inferred.
    expect(decimalAt("money", "1234").eq("1234")).toBe(true);
    // A logical spelling is not a coefficient: no adapter writes it there, and
    // neither is a coefficient with a leading zero, an explicit sign, or a
    // negative zero — one integer has exactly one physical spelling.
    for (const forged of ["12.34", "01234", "+1234", "-0", 1234n, 1234]) {
      expect(() => parseField("money", forged, coefficient)).toThrow(
        DECIMAL_ERROR_PATTERN
      );
    }
  });

  test("a SQLite driver decodes coefficient decimals through its field chain", () => {
    const driver = new SQLite3Driver();
    const [row] = parseResult<Record<string, unknown>[]>(
      parserFor(driver.adapter, scalarModel, driver),
      "findMany",
      [{ money: "1234", maybeMoney: null }],
      { select: { money: true, maybeMoney: true } }
    );

    expect(row?.money).toBeInstanceOf(Decimal);
    expect(row?.maybeMoney).toBeNull();
    if (!(row?.money instanceof Decimal)) {
      throw new Error("Expected the SQLite decimal to materialize.");
    }
    expect(row.money.eq("12.34")).toBe(true);
  });

  test.each([
    ["a bigint where text was promised", "money", 1234n],
    ["a JS number", "money", 12.34],
    ["a provider-owned Decimal", "money", new Decimal("12.34")],
    ["a leading zero", "money", "012.34"],
    ["an explicit plus", "money", "+12.34"],
    ["exponent notation", "money", "1.234e1"],
    ["a bare point", "money", ".5"],
    ["a trailing point", "money", "5."],
    ["excess scale for the column", "money", "12.345"],
    ["excess precision for the column", "money", "123456789.01"],
    ["a forged Decimal-shaped object", "money", { s: 1, e: 1, d: [12, 34] }],
    ["a JSON number as a list member", "amounts", [1.2]],
    ["a JSON container where a native array was promised", "amounts", "[1.2]"],
    ["a real fraction on a scale-zero column", "whole", "1.5"],
  ])("refuses %s", (_label, field, value) => {
    const error = captureParserError(() => parseField(field, value));

    expect(error.meta).toMatchObject({
      driver: "query-engine",
      operation: "findMany",
      scalarType: "decimal",
    });
    expect(error.message).toMatch(DECIMAL_ERROR_PATTERN);
  });

  test("a nullable decimal keeps null and a required one refuses it", () => {
    expect(parseField("maybeMoney", null)).toBeNull();
    expect(() => parseField("money", null)).toThrow(DECIMAL_ERROR_PATTERN);
  });
});
