import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { tryParseJsonString } from "@adapters/shared/result-parsing";
import { SQLite3Driver } from "@drivers/sqlite3";
import { QueryEngineError } from "@errors";
import { parseResult, ResultParser } from "@query-engine/result/ResultParser";
import { hydrateSchemaNames, s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type JsonValue, v } from "@validation";
import { describe, expect, test } from "vitest";

const ENUM_ERROR_PATTERN = /enum/i;
const INT_ERROR_PATTERN = /int/i;
const JSON_ERROR_PATTERN = /json/i;
const LIST_ERROR_PATTERN = /list/i;
const SPARSE_ERROR_PATTERN = /sparse/i;
const STRING_ERROR_PATTERN = /string/i;
const ASYNC_SCHEMA_ERROR_PATTERN = /asynchronous.*not supported/i;

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

const scalarModel = s.model({
  id: s.string().id(),
  text: s.string(),
  nullableText: s.string().nullable(),
  _distance: s.string(),
  integer: s.int(),
  float: s.float(),
  decimal: s.decimal(),
  large: s.bigInt(),
  flag: s.boolean(),
  happenedAt: s.dateTime(),
  bornOn: s.date(),
  wakeAt: s.time(),
  statusA: s.enum(["open"]),
  statusB: s.enum(["closed"]),
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
  children: s.oneToMany(() => child),
});

const child = s.model({
  id: s.string().id(),
  parentId: s.string(),
  score: s.int(),
  parent: s
    .manyToOne(() => parent)
    .fields("parentId")
    .references("id"),
});

const schema = { scalarModel, parent, child };
hydrateSchemaNames(schema);
function createScalarContext(adapter: DatabaseAdapter = new PostgresAdapter()) {
  return new ResultParser(adapter, scalarModel);
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
    expect(parseField("float", "1e2")).toBe(100);
    // W6-U1: a decimal decodes to its canonical STRING, never a double. The
    // provider hands it over as text on every dialect; the only work is
    // agreeing on one spelling.
    expect(parseField("decimal", "-0.5")).toBe("-0.5");
    expect(parseField("decimal", "-0.500")).toBe("-0.5");
    expect(parseField("decimal", "1.000000000000000000000000000001")).toBe(
      "1.000000000000000000000000000001"
    );
    expect(parseField("large", "9007199254740993")).toBe(
      9_007_199_254_740_993n
    );
    expect(parseField("happenedAt", "2026-07-10 12:30:45.123")).toEqual(
      new Date("2026-07-10T12:30:45.123Z")
    );
    expect(parseField("bornOn", "2024-02-29")).toEqual(
      new Date("2024-02-29T00:00:00.000Z")
    );
    expect(parseField("wakeAt", "13:45:30.123000+00")).toBe("13:45:30.123");
    expect(parseField("nullableText", null)).toBeNull();
    expect(parseField("jsonValue", null)).toBeNull();
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
    expect(() => parseField("texts", null)).toThrow(LIST_ERROR_PATTERN);

    const sparse = new Array<unknown>(1);
    expect(() => parseField("texts", sparse)).toThrow(SPARSE_ERROR_PATTERN);
  });

  test.each([
    ["boolean outside domain", "flag", 2, "boolean"],
    ["boolean string", "flag", "1", "boolean"],
    ["fractional integer", "integer", 1.5, "int"],
    ["unsafe integer", "integer", Number.MAX_SAFE_INTEGER + 1, "int"],
    ["hex integer", "integer", "0x10", "int"],
    ["exponent integer", "integer", "1e2", "int"],
    ["non-finite float", "float", Number.POSITIVE_INFINITY, "float"],
    ["hex float", "float", "0x10", "float"],
    ["malformed decimal", "decimal", "phase6-private-value", "decimal"],
    ["unsafe bigint number", "large", Number.MAX_SAFE_INTEGER + 1, "bigint"],
    ["fractional bigint", "large", 1.5, "bigint"],
    ["hex bigint", "large", "0x10", "bigint"],
    ["invalid datetime", "happenedAt", "not-a-date", "datetime"],
    ["rollover datetime", "happenedAt", "2024-02-30T10:00:00Z", "datetime"],
    ["numeric datetime", "happenedAt", 0, "datetime"],
    ["rollover date", "bornOn", "2024-02-30", "date"],
    ["numeric date", "bornOn", 0, "date"],
    ["object time", "wakeAt", { hour: 1 }, "time"],
    ["invalid time", "wakeAt", "25:00:00", "time"],
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
    const parentContext = new ResultParser(new PostgresAdapter(), parent);

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
    expect(parseField("pointValue", { x: 1, y: -2 })).toEqual({
      x: 1,
      y: -2,
    });
    expect(parseField("pointValue", "(-1.25,2e+3)")).toEqual({
      x: -1.25,
      y: 2000,
    });
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
    ["missing coordinate", { x: 1 }],
    ["extra key", { x: 1, y: 2, z: 3 }],
    ["numeric string coordinate", { x: "1", y: 2 }],
    ["infinite coordinate", { x: Number.POSITIVE_INFINITY, y: 2 }],
    ["spaced text", "(1, 2)"],
    ["outer whitespace", " (1,2)"],
    ["non-finite text", "(NaN,2)"],
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
      new ResultParser(adapter, scalarModel),
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
      new ResultParser(driver.adapter, scalarModel, driver),
      "findMany",
      [{ countingJson: '{"value":"raw"}' }],
      { select: { countingJson: true } }
    );

    expect(row?.countingJson).toBe(1);
    expect(countingJsonValidationCalls).toBe(1);
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
});
