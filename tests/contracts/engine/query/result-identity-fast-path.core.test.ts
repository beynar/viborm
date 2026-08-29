import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  parsePreparedResult,
  prepareResultRows,
  type ResultParser,
} from "@query-engine/result/ResultParser";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import { s } from "@schema";
import {
  indexFor,
  parserFor,
  prepareSchema,
} from "@tests/fixtures/query-scope";
import Decimal from "decimal.js";
import { describe, expect, test } from "vitest";

const ENUM_ERROR = /enum/i;
const INTEGER_ERROR = /integer/i;

/**
 * The read fast path (identity decoders + whole-row passthrough) is a PURE
 * performance optimization: for plain string/int/number/boolean columns on a
 * native-passthrough provider (Postgres family), the row parser skips the typed
 * decode switch and, when every cell of an all-scalar row is native, returns the
 * driver row itself. These tests pin the one property that matters — the fast
 * path is BYTE-IDENTICAL to the full parser — and prove the gate excludes every
 * coercing type so a wrong value can never slip through unchecked.
 *
 * Falsified (manually, recorded in the report): adding `case "enum"` /
 * `case "json"` to `identityGuardFor` makes the "invalid enum is rejected" test
 * below fail (the bad value passes through), and adding those cases also breaks
 * the mixed-projection equality — restore to green.
 */

// A wide mixed projection: identity-eligible scalars (string/int/number/boolean,
// nullable string) interleaved with every coercing type the gate must exclude
// (enum, json, date, bigint, decimal).
const mixedModel = s.model({
  id: s.string().id(),
  name: s.string(),
  nick: s.string().nullable(),
  age: s.int(),
  score: s.number(),
  active: s.boolean(),
  status: s.enum(["ACTIVE", "INACTIVE"] as const),
  meta: s.json(),
  born: s.date(),
  big: s.bigInt(),
  price: s.decimal({ precision: 10, scale: 2 }),
});

// A pure identity-eligible projection: the whole-row passthrough path.
const pureScalarModel = s.model({
  id: s.string().id(),
  name: s.string(),
  nick: s.string().nullable(),
  age: s.int(),
  score: s.number(),
  active: s.boolean(),
});

const decimalModel = s.model({
  amount: s.decimal({ precision: 10, scale: 2 }),
});

prepareSchema({
  mixed: mixedModel,
  pureScalar: pureScalarModel,
  decimal: decimalModel,
});

/** Fast path ON: Postgres declares native passthrough and there is no driver. */
function fastPathParser(
  model: ConstructorParameters<typeof ResultParser>[1]
): ResultParser {
  return parserFor(new PostgresAdapter(), model);
}

/**
 * Fast path OFF, everything else identical: the SAME passthrough field decode
 * (so native values arrive unchanged), but the identity shortcut disabled. This
 * models any provider that cannot take the fast path — its output must match the
 * fast path exactly.
 */
function fullPathParser(
  model: ConstructorParameters<typeof ResultParser>[1]
): ResultParser {
  const adapter = new PostgresAdapter();
  (
    adapter.result as { nativeScalarPassthrough?: boolean }
  ).nativeScalarPassthrough = false;
  return parserFor(adapter, model);
}

// Fresh row objects per call so each parser gets independent inputs (the
// whole-row passthrough may return the input row by reference).
function mixedRows(): Record<string, unknown>[] {
  return [
    {
      id: "a",
      name: "Ann",
      nick: null,
      age: 30,
      score: 3.5,
      active: true,
      status: "ACTIVE",
      meta: { k: 1, nested: { z: true } },
      born: "2024-01-15",
      big: "9007199254740993",
      price: "12.34",
    },
    {
      id: "b",
      name: "Bo",
      nick: "bee",
      age: 0,
      score: 0,
      active: false,
      status: "INACTIVE",
      meta: [1, 2, 3],
      born: "2000-12-31",
      big: "-42",
      price: "0.5",
    },
  ];
}

function requireDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  throw new Error(`expected a Decimal, received ${typeof value}`);
}

function omitPrice(row: Record<string, unknown>): Record<string, unknown> {
  const { price: _price, ...rest } = row;
  return rest;
}

function pureScalarRows(): Record<string, unknown>[] {
  return [
    { id: "a", name: "Ann", nick: "x", age: 30, score: 3.5, active: true },
    { id: "b", name: "Bo", nick: "y", age: 41, score: 0, active: false },
  ];
}

describe("read fast path — identity decoders + whole-row passthrough", () => {
  test("wide mixed-type projection: fast path === full parser (byte-identical)", () => {
    const fast = fastPathParser(mixedModel).parse<Record<string, unknown>[]>(
      "findMany",
      mixedRows(),
      {}
    );
    const full = fullPathParser(mixedModel).parse("findMany", mixedRows(), {});
    expect(fast).toEqual(full);
    // And the values are the correctly-decoded ones, not raw strings. The
    // decimals are compared with `.eq()`: two fresh instances of one value are
    // equal as VALUES, independent of JavaScript object identity.
    expect(fast.map((row) => omitPrice(row))).toEqual([
      {
        id: "a",
        name: "Ann",
        nick: null,
        age: 30,
        score: 3.5,
        active: true,
        status: "ACTIVE",
        meta: { k: 1, nested: { z: true } },
        born: new Date("2024-01-15T00:00:00.000Z"),
        big: 9_007_199_254_740_993n,
      },
      {
        id: "b",
        name: "Bo",
        nick: "bee",
        age: 0,
        score: 0,
        active: false,
        status: "INACTIVE",
        meta: [1, 2, 3],
        born: new Date("2000-12-31T00:00:00.000Z"),
        big: -42n,
      },
    ]);
    expect(requireDecimal(fast[0]?.price).eq("12.34")).toBe(true);
    expect(requireDecimal(fast[1]?.price).eq("0.5")).toBe(true);
  });

  test("a decimal column keeps the row off the whole-row passthrough", () => {
    // The passthrough returns the DRIVER's row by reference. A decimal cell can
    // never be returned unchanged — it materializes a fresh value object — so a
    // decimal-bearing projection is always built, and the driver's row is left
    // exactly as the driver handed it over.
    const rows = mixedRows();
    const parsed = fastPathParser(mixedModel).parse<Record<string, unknown>[]>(
      "findMany",
      rows,
      {}
    );

    expect(parsed[0]).not.toBe(rows[0]);
    expect(parsed[0]?.price).toBeInstanceOf(Decimal);
    expect(rows[0]?.price).toBe("12.34");
  });

  test("a native-passthrough decimal skips the generic field continuation", () => {
    const adapter = new PostgresAdapter();
    const parseField = adapter.result.parseField;
    let continuationCalls = 0;
    adapter.result.parseField = (value, scalarType, next) => {
      continuationCalls += 1;
      return parseField(value, scalarType, next);
    };
    const [row] = parserFor(adapter, decimalModel).parse<
      Record<string, unknown>[]
    >("findMany", [{ amount: "12.34" }], {});

    expect(requireDecimal(row?.amount).eq("12.34")).toBe(true);
    expect(continuationCalls).toBe(0);
  });

  test("a custom decimal field continuation remains authoritative", () => {
    const adapter = new PostgresAdapter();
    let continuationCalls = 0;
    adapter.result = {
      ...adapter.result,
      nativeScalarPassthrough: false,
      parseField: (value, scalarType, next) => {
        continuationCalls += 1;
        return scalarType === "decimal" ? next("12.34") : next(value);
      },
    };
    const [row] = parserFor(adapter, decimalModel).parse<
      Record<string, unknown>[]
    >("findMany", [{ amount: "not-provider-decimal" }], {});

    expect(requireDecimal(row?.amount).eq("12.34")).toBe(true);
    expect(continuationCalls).toBe(1);
  });

  test("a consumable row is written in place with the materialized decimal", () => {
    // Plan 4.2: same-key scalar decoding may replace the physical value with
    // the fresh Decimal in an OWNED row. A decimal column keeps the container
    // policy at "reusable" — never "copy" — which is observable as the returned
    // row being the very object the caller offered.
    const rows = mixedRows();
    const parser = fastPathParser(mixedModel);
    const shape = buildExpectedResultShape(
      mixedModel,
      "findMany",
      {},
      indexFor(mixedModel)
    );
    if (!shape) throw new Error("the mixed read has no expected result shape");
    const compiled = prepareResultRows(parser, "findMany", shape);
    if (!compiled) throw new Error("the mixed read compiled no row program");

    expect(compiled.containerPolicy).toBe("reusable");
    const parsed = parsePreparedResult<Record<string, unknown>[]>(
      parser,
      "findMany",
      rows,
      {},
      shape,
      compiled,
      rows
    );

    expect(parsed[0]).toBe(rows[0]);
    expect(parsed[0]?.price).toBeInstanceOf(Decimal);
  });

  test("pure-scalar projection: whole-row passthrough === full parser", () => {
    const fast = fastPathParser(pureScalarModel).parse(
      "findMany",
      pureScalarRows(),
      {}
    );
    const full = fullPathParser(pureScalarModel).parse(
      "findMany",
      pureScalarRows(),
      {}
    );
    expect(fast).toEqual(full);
  });

  test("whole-row passthrough returns the driver row by reference when every cell is native", () => {
    const rows = pureScalarRows();
    const parsed = fastPathParser(pureScalarModel).parse<
      Record<string, unknown>[]
    >("findMany", rows, {});
    expect(parsed[0]).toBe(rows[0]);
    expect(parsed[1]).toBe(rows[1]);
  });

  test("a non-native cell falls the row back to the full build, still byte-identical", () => {
    const row = {
      id: "a",
      name: "Ann",
      nick: null,
      age: 30,
      score: 3.5,
      active: true,
    };
    const parsed = fastPathParser(pureScalarModel).parse<
      Record<string, unknown>[]
    >("findMany", [{ ...row }], {});
    // A freshly built object (not the input) — but the same values.
    expect(parsed[0]).toEqual(row);
  });

  test("gate: enum is never identity-shortcut — an invalid member is still rejected under the fast path", () => {
    const rows = mixedRows();
    (rows[0] as Record<string, unknown>).status = "NOPE";
    expect(() =>
      fastPathParser(mixedModel).parse("findMany", rows, {})
    ).toThrow(ENUM_ERROR);
  });

  test("gate: the int guard defers a non-integer number to the full parser's rejection", () => {
    const rows = pureScalarRows();
    (rows[0] as Record<string, unknown>).age = 3.5;
    expect(() =>
      fastPathParser(pureScalarModel).parse("findMany", rows, {})
    ).toThrow(INTEGER_ERROR);
  });

  test("gate: a wrong-typed value defers to the full parser (int column receiving a string)", () => {
    const rows = pureScalarRows();
    (rows[0] as Record<string, unknown>).age = "not-a-number";
    expect(() =>
      fastPathParser(pureScalarModel).parse("findMany", rows, {})
    ).toThrow(INTEGER_ERROR);
  });
});
