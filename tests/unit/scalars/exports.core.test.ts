import { BigIntScalar, createDefaultState, EnumScalar } from "@schema/scalars";
import v from "@validation/primitives/v";
import { describe, expect, it } from "vitest";

const BARRELS = [
  [
    "bigint",
    () => import("@schema/scalars/bigint"),
    ["BigIntScalar", "bigInt"],
  ],
  ["blob", () => import("@schema/scalars/blob"), ["BlobScalar", "blob"]],
  [
    "boolean",
    () => import("@schema/scalars/boolean"),
    ["BooleanScalar", "boolean"],
  ],
  [
    "datetime",
    () => import("@schema/scalars/datetime"),
    ["DateScalar", "DateTimeScalar", "TimeScalar", "date", "dateTime", "time"],
  ],
  ["decimal", () => import("@schema/scalars/decimal"), ["decimal"]],
  ["enum", () => import("@schema/scalars/enum"), ["EnumScalar", "enumScalar"]],
  ["int", () => import("@schema/scalars/int"), ["IntScalar", "int"]],
  ["json", () => import("@schema/scalars/json"), ["JsonScalar", "json"]],
  [
    "number",
    () => import("@schema/scalars/number"),
    ["NumberScalar", "number"],
  ],
  ["point", () => import("@schema/scalars/point"), ["PointScalar", "point"]],
  [
    "string",
    () => import("@schema/scalars/string"),
    ["StringScalar", "string"],
  ],
  [
    "vector",
    () => import("@schema/scalars/vector"),
    ["VectorScalar", "vector"],
  ],
] as const;

describe("scalar module exports", () => {
  it("executes the complete scalar surface", async () => {
    const [all, bigIntModule, blobModule, booleanModule, dateTimeModule] =
      await Promise.all([
        import("@schema/scalars"),
        import("@schema/scalars/bigint"),
        import("@schema/scalars/blob"),
        import("@schema/scalars/boolean"),
        import("@schema/scalars/datetime"),
      ]);

    expect(all).toMatchObject({
      PG: expect.any(Object),
      MYSQL: expect.any(Object),
      SQLITE: expect.any(Object),
      bigInt: bigIntModule.bigInt,
      blob: blobModule.blob,
      boolean: booleanModule.boolean,
      date: dateTimeModule.date,
      dateTime: dateTimeModule.dateTime,
      time: dateTimeModule.time,
    });
  });
});

describe("coverage low value", () => {
  it("executes the public schema barrel", async () => {
    const schema = await import("@schema/exports");

    expect(schema.s).toBeDefined();
    expect(schema.PG).toBeDefined();
    expect(schema.MYSQL).toBeDefined();
    expect(schema.SQLITE).toBeDefined();
  });

  it.each(
    BARRELS
  )("executes the internal %s barrel", async (_name, load, expected) => {
    expect(Object.keys(await load()).sort()).toEqual([...expected].sort());
  });

  it("executes the internal base module", async () => {
    expect(Object.keys(await import("@schema/scalars/base"))).toEqual([
      "createDefaultState",
    ]);
  });

  it("pins defensive public constructors and their internal state", () => {
    const enumScalar = new EnumScalar(createDefaultState("enum", v.string()));
    expect(enumScalar.enumValues).toEqual([]);

    const state = createDefaultState("bigint", v.bigint());
    const nativeType = { db: "pg", type: "contract_type" } as const;
    const bigIntScalar = new BigIntScalar(state, nativeType);
    expect(bigIntScalar["~"]).toEqual({ state, nativeType });
  });
});
