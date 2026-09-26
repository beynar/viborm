/**
 * KNOWN DEFECT B2 — a model member named `_count` beside a to-many relation.
 *
 * THESE ASSERTIONS DOCUMENT A DEFECT, NOT A CONTRACT. They record what
 * admission (`validateOperationPayload`), the schema-only renderer
 * (`renderOperationResultType`), the Raptor 3 runtime (SQLite) and the static
 * client types answer TODAY for one real model that owns a scalar `_count` and
 * a to-many relation. The four surfaces disagree:
 *
 * - admission reads `select._count` / `include._count` as relation counts
 *   (the count schema is spread over the scalar entry, and `true` is
 *   desugared to `{ select: { things: true } }`);
 * - the runtime decides by MODEL (raptor3/shared/query.ts, the
 *   `name === "_count" && !scalars[name]` branch) and always publishes the
 *   scalar, even when the caller omitted it;
 * - the renderer reads the value's shape: a count object renders counts, and
 *   counts beside a projected scalar `_count` are refused;
 * - the static select input accepts only the scalar spelling, and the result
 *   type intersects the scalar with the counts.
 *
 * The same runtime branch leaks a scalar `_count` that the MODEL hides with
 * `.omit({ _count: true })`. There admission and the renderer answer counts
 * (the hidden scalar is in no select or omit schema), the static result type
 * answers counts (merged with the scalar's number members for `_count: true`),
 * and the runtime publishes the stored value, against the hard exclusion
 * src/validation/model/core/projection.ts promises ("No client option and no
 * query argument can put it back").
 *
 * No single public promise exists yet (docs/architecture/selection-owner-scoping.md,
 * "B2"). The owner rules on the collision contract first; the implementation
 * that follows REPLACES these assertions with the ruled contract. Until then a
 * change to any recorded answer is a behaviour change that must be deliberate:
 * update this file and the scoping report together.
 */

import { createClient } from "@client/client";
import {
  renderOperationResultType,
  validateOperationPayload,
} from "@client/schema-introspection";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

const tally = s.model({
  id: s.string().id(),
  _count: s.int(),
  things: s.toMany(() => thing),
});
const thing = s.model({
  id: s.string().id(),
  tallyId: s.string(),
  tally: s
    .toOne(() => tally)
    .fields("tallyId")
    .references("id"),
});
// The same pair, with the scalar `_count` hidden by the model itself.
const hiddenTally = s
  .model({
    id: s.string().id(),
    _count: s.int(),
    things: s.toMany(() => hiddenThing),
  })
  .omit({ _count: true });
const hiddenThing = s.model({
  id: s.string().id(),
  hiddenTallyId: s.string(),
  hiddenTally: s
    .toOne(() => hiddenTally)
    .fields("hiddenTallyId")
    .references("id"),
});
const schema = { tally, thing, hiddenTally, hiddenThing };

const RENDERER_PAIR_REFUSAL =
  "Relation counts cannot be selected together with a model field named '_count'.";
const COUNTS_RENDERED = `Array<{
  id: string;
  _count: {
    things: number;
  };
}>`;
const ADMITTED_COUNTS = { select: { things: true } };

const driver = createInMemorySQLite3Driver();
const client = createClient({ schema, driver });

beforeAll(async () => {
  await syncLiveSchema(client);
  await client.tally.create({ data: { id: "t1", _count: 5 } });
  await client.thing.createMany({
    data: [
      { id: "a", tallyId: "t1" },
      { id: "b", tallyId: "t1" },
    ],
  });
  // `create` writes the hidden column; only reads exclude it.
  await client.hiddenTally.create({ data: { id: "h1", _count: 42 } });
  await client.hiddenThing.create({ data: { id: "c", hiddenTallyId: "h1" } });
});

afterAll(async () => {
  await driver.disconnect();
});

describe("KNOWN DEFECT B2: a scalar `_count` beside a to-many (documents a defect, not a contract)", () => {
  test("documents the defect: select `_count: true` is admitted as counts, rendered as counts, returned as the scalar", async () => {
    const payload = { select: { id: true, _count: true } } as const;

    expect(
      validateOperationPayload(schema, "tally", "findMany", payload)
    ).toEqual({ select: { id: true, _count: ADMITTED_COUNTS } });
    expect(
      renderOperationResultType(schema, "tally", "findMany", payload)
    ).toBe(COUNTS_RENDERED);
    const rows = await client.tally.findMany(payload);
    expect(rows).toEqual([{ id: "t1", _count: 5 }]);
    // The static result intersects the scalar with the counts: `.things`
    // compiles as a number while the runtime value is the scalar 5.
    expectTypeOf<
      (typeof rows)[number]["_count"]["things"]
    >().toEqualTypeOf<number>();
    expect(typeof rows[0]?._count).toBe("number");
  });

  test("documents the defect: the explicit count object is refused by the static input and still returns the scalar", async () => {
    const payload = {
      select: { id: true, _count: { select: { things: true } } },
    } as const;

    expect(
      validateOperationPayload(schema, "tally", "findMany", payload)
    ).toEqual({ select: { id: true, _count: ADMITTED_COUNTS } });
    expect(
      renderOperationResultType(schema, "tally", "findMany", payload)
    ).toBe(COUNTS_RENDERED);
    // @ts-expect-error KNOWN DEFECT B2: the select input type admits only `true` for `_count`.
    const rows = await client.tally.findMany(payload);
    expect(rows).toEqual([{ id: "t1", _count: 5 }]);
  });

  test("documents the defect: include `_count` is refused by the renderer and returns the scalar at runtime", async () => {
    const payload = { include: { _count: true } } as const;

    expect(
      validateOperationPayload(schema, "tally", "findMany", payload)
    ).toEqual({ include: { _count: ADMITTED_COUNTS } });
    expect(() =>
      renderOperationResultType(schema, "tally", "findMany", payload)
    ).toThrow(RENDERER_PAIR_REFUSAL);
    await expect(client.tally.findMany(payload)).resolves.toEqual([
      { id: "t1", _count: 5 },
    ]);
  });

  test("documents the defect: the runtime publishes an omitted scalar `_count` when counts are included", async () => {
    const payload = {
      omit: { _count: true },
      include: { _count: true },
    } as const;

    expect(
      validateOperationPayload(schema, "tally", "findMany", payload)
    ).toEqual({ select: { id: true }, include: { _count: ADMITTED_COUNTS } });
    expect(
      renderOperationResultType(schema, "tally", "findMany", payload)
    ).toBe(COUNTS_RENDERED);
    await expect(client.tally.findMany(payload)).resolves.toEqual([
      { id: "t1", _count: 5 },
    ]);
  });

  test("documents the defect: a nested include of `_count` is refused by the renderer and returns the scalar at runtime", async () => {
    const payload = {
      include: { tally: { include: { _count: true } } },
    } as const;

    expect(
      validateOperationPayload(schema, "thing", "findMany", payload)
    ).toEqual({
      include: {
        tally: {
          include: { _count: ADMITTED_COUNTS },
          select: { id: true, _count: true },
        },
      },
    });
    expect(() =>
      renderOperationResultType(schema, "thing", "findMany", payload)
    ).toThrow(RENDERER_PAIR_REFUSAL);
    await expect(
      client.thing.findMany({ ...payload, orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: "a", tallyId: "t1", tally: { id: "t1", _count: 5 } },
      { id: "b", tallyId: "t1", tally: { id: "t1", _count: 5 } },
    ]);
  });

  test("documents the defect: a bulk select of `_count` compiles and is refused at admission", async () => {
    const payload = {
      data: [{ id: "t3", _count: 1 }],
      select: { id: true, _count: true },
    };
    const refusal =
      "'select._count' is not supported on 'createMany': a bulk write projects scalar fields only.";

    expect(() =>
      validateOperationPayload(schema, "tally", "createMany", payload)
    ).toThrow(refusal);
    // The static bulk input accepts the boolean the runtime refuses.
    await expect(
      client.tally.createMany({
        data: [{ id: "t3", _count: 1 }],
        select: { id: true, _count: true },
      })
    ).rejects.toThrow(refusal);
  });
  test("documents the defect: a model-level `.omit()`ted scalar `_count` is published by every counts spelling", async () => {
    // The exclusion holds where counts are not asked for.
    await expect(client.hiddenTally.findMany()).resolves.toEqual([
      { id: "h1" },
    ]);
    expect(() =>
      validateOperationPayload(schema, "hiddenTally", "findMany", {
        omit: { _count: true },
      })
    ).toThrow("Unknown key: _count");

    const hiddenCounts = `Array<{
  id: string;
  _count: {
    things: number;
  };
}>`;
    const selectTrue = { select: { id: true, _count: true } } as const;
    const selectObject = {
      select: { id: true, _count: { select: { things: true } } },
    } as const;
    const includeTrue = { include: { _count: true } } as const;
    // Admission and the renderer read counts ...
    for (const payload of [selectTrue, selectObject, includeTrue]) {
      expect(
        validateOperationPayload(schema, "hiddenTally", "findMany", payload)
      ).toEqual(
        "select" in payload
          ? { select: { id: true, _count: ADMITTED_COUNTS } }
          : { include: { _count: ADMITTED_COUNTS } }
      );
      expect(
        renderOperationResultType(schema, "hiddenTally", "findMany", payload)
      ).toBe(hiddenCounts);
    }
    const bySelectTrue = await client.hiddenTally.findMany(selectTrue);
    const bySelectObject = await client.hiddenTally.findMany(selectObject);
    const byInclude = await client.hiddenTally.findMany(includeTrue);
    // The static result of `_count: true` merges the hidden scalar's number
    // members into the counts, as it does on the unhidden model above.
    expectTypeOf<
      (typeof bySelectTrue)[number]["_count"]["things"]
    >().toEqualTypeOf<number>();
    expectTypeOf<(typeof bySelectTrue)[number]["_count"]>().toHaveProperty(
      "toFixed"
    );
    expectTypeOf<(typeof bySelectObject)[number]["_count"]>().toEqualTypeOf<{
      things: number;
    }>();
    expectTypeOf<(typeof byInclude)[number]["_count"]>().toEqualTypeOf<{
      things: number;
    }>();
    // ... and the runtime publishes the column the model hides.
    for (const rows of [bySelectTrue, bySelectObject, byInclude]) {
      expect(rows).toEqual([{ id: "h1", _count: 42 }]);
    }
  });

  test("documents the defect: a nested include of counts publishes the model-hidden scalar `_count`", async () => {
    const payload = {
      include: { hiddenTally: { include: { _count: true } } },
    } as const;

    expect(
      validateOperationPayload(schema, "hiddenThing", "findMany", payload)
    ).toEqual({
      include: {
        hiddenTally: {
          include: { _count: ADMITTED_COUNTS },
          select: { id: true },
        },
      },
    });
    expect(
      renderOperationResultType(schema, "hiddenThing", "findMany", payload)
    ).toBe(`Array<{
  id: string;
  hiddenTallyId: string;
  hiddenTally: {
    id: string;
    _count: {
      things: number;
    };
  };
}>`);
    await expect(client.hiddenThing.findMany(payload)).resolves.toEqual([
      { id: "c", hiddenTallyId: "h1", hiddenTally: { id: "h1", _count: 42 } },
    ]);
    // Without counts the nested default projection keeps it hidden.
    await expect(
      client.hiddenThing.findMany({ include: { hiddenTally: true } })
    ).resolves.toEqual([
      { id: "c", hiddenTallyId: "h1", hiddenTally: { id: "h1" } },
    ]);
  });
});
