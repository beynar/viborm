import { BigIntScalar, createDefaultState, EnumScalar } from "@schema/scalars";
import v from "@validation/primitives/v";
import { describe, expect, it } from "vitest";

describe("scalar module exports", () => {
  it("executes the complete scalar surface", async () => {
    // The scalar OWNERS, not a re-export shell. Follow-up F-5 deleted the
    // eleven `scalars/<name>/index.ts` shells: they were reachable from no
    // package entry point, and `@schema/scalars` — the one barrel this estate
    // keeps — always re-exported `./<name>/scalar` directly, never through
    // them. What this cell asserts is unchanged: the public barrel publishes
    // the SAME function objects the owning modules declare.
    const [
      all,
      bigIntModule,
      blobModule,
      booleanModule,
      dateTimeModule,
      dateModule,
      timeModule,
    ] = await Promise.all([
      import("@schema/scalars"),
      import("@schema/scalars/bigint/scalar"),
      import("@schema/scalars/blob/scalar"),
      import("@schema/scalars/boolean/scalar"),
      import("@schema/scalars/datetime/scalar"),
      import("@schema/scalars/datetime/date-scalar"),
      import("@schema/scalars/datetime/time-scalar"),
    ]);

    expect(all).toMatchObject({
      PG: expect.any(Object),
      MYSQL: expect.any(Object),
      SQLITE: expect.any(Object),
      bigInt: bigIntModule.bigInt,
      blob: blobModule.blob,
      boolean: booleanModule.boolean,
      date: dateModule.date,
      dateTime: dateTimeModule.dateTime,
      time: timeModule.time,
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
