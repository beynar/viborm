/**
 * RQ-07 follow-up — the output key `_distance` has ONE producer, and the
 * schema owns that fact (owner ruling, 2026-09-26: "_distance is reserved
 * too").
 *
 * A point's distance publishes under `_distance`. This file used to admit a
 * model owning a relation of that name, possibly recursive, and pin the
 * projection's refusal of the pair: selected together, the two producers
 * would publish under one key at some levels and the other at the rest, the
 * live cache would store that, and the rendered type would declare the key
 * twice. The member is now refused where the schema is validated (F010,
 * `memberNamesAreNotReserved`), so no selection can form the pair and the
 * projection's pair checks are gone. What stays pinned here:
 *
 * - the refusal itself for the recursive spelling: `validateSchema`, the
 *   engine's own schema gate and client construction, before any statement;
 * - under a renamed recursive relation, the distance and the recursive slot
 *   keep their own keys in every spelling the old pair used — distance first,
 *   relation first, the included spelling below admission (V4001 refuses
 *   `select` beside `include` at one level), and the repeated node selecting
 *   the distance — in the engine's prepared shape and in the schema-only
 *   renderer, and each producer alone keeps its key.
 *
 * The scalar and variant-slot spellings of the refusal, and the static pins,
 * live beside `_count`'s in
 * `tests/contracts/public-client/count-reserved-member.core.test.ts` and
 * `tests/types/client/count-reserved-member.core.types.ts`. Lowering only: no
 * provider is needed, and no PostGIS-less local provider spells a distance.
 */

import assert from "node:assert/strict";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { renderOperationResultType } from "@client/schema-introspection";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import { s } from "@schema";
import { SchemaValidationError, validateSchema } from "@schema/validation";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { describe, it } from "vitest";

/** The schema the pair needed: a recursive relation named `_distance`. */
const reservedPlace = s
  .model({
    id: s.string().id(),
    at: s.point(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => reservedPlace)
      .fields("parentId")
      .references("id")
      .name("rq07Places"),
    // @ts-expect-error `_distance` is a reserved member name (F010).
    _distance: s.toMany(() => reservedPlace).name("rq07Places"),
  })
  .map("rq07_places");
const reservedSchema = { place: reservedPlace };

const RESERVED = {
  code: "F010",
  message: `Model 'place' declares a member named '_distance'; '_distance' is reserved for distance results. Rename it, and use .map("_distance") on a renamed scalar to keep its column name.`,
  severity: "error",
  model: "place",
  field: "_distance",
};

/** The same graph with the relation renamed. */
const place = s
  .model({
    id: s.string().id(),
    at: s.point(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => place)
      .fields("parentId")
      .references("id")
      .name("rq07Places"),
    nearby: s.toMany(() => place).name("rq07Places"),
  })
  .map("rq07_places");
const schema = { place };
const paris = { longitude: 2.3522, latitude: 48.8566 };

const distanceFirst = {
  select: {
    id: true,
    at: { _distance: { to: paris } },
    nearby: { recurse: { depth: 2 }, select: { id: true } },
  },
};
const relationFirst = {
  select: {
    nearby: { recurse: { depth: 2 }, select: { id: true } },
    at: { _distance: { to: paris } },
    id: true,
  },
};
const included = {
  select: { id: true, at: { _distance: { to: paris } } },
  include: { nearby: { recurse: true, select: { id: true } } },
};
/**
 * `included` as the engine receives it, `recurse: true` already normalized:
 * admission refuses `select` beside `include` (V4001), so only the engine
 * entry takes this spelling.
 */
const includedAdmitted = {
  select: { id: true, at: { _distance: { to: paris } } },
  include: {
    nearby: {
      recurse: { depth: 100, cycles: "reject" },
      select: { id: true },
    },
  },
};
/** The repeated node itself selects the distance. */
const nested = {
  select: {
    id: true,
    nearby: {
      recurse: { depth: 2 },
      select: { id: true, at: { _distance: { to: paris } } },
    },
  },
};
const distanceAlone = {
  select: { id: true, at: { _distance: { to: paris } } },
};
const relationAlone = {
  select: { id: true, nearby: { recurse: { depth: 2 }, select: { id: true } } },
};

/** Lowering only: a provider-less PostgreSQL driver that counts statements. */
class CountingDriver extends SqlOnlyDriver {
  statements = 0;
  constructor() {
    super(
      new PostgresAdapter("public", true),
      "postgresql",
      "rq07-distance-key"
    );
  }
  protected override async execute<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.statements += 1;
    return await super.execute<T>();
  }
  protected override async executeRaw<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.statements += 1;
    return await super.executeRaw<T>();
  }
}

const engine = new EngineSchema(schema);
const queries = () => new Queries(engine, new PostgresAdapter("public", true));

/** The prepared top-level keys and the kind each publishes, or the shape's kind. */
const fieldKinds = (args: object) => {
  const { shape } = queries().select(place, args);
  if (shape.kind !== "object") return shape.kind;
  return Object.fromEntries(
    Object.entries(shape.fields).map(([key, field]) => [key, field.kind])
  );
};

const DISTANCE_NUMBER = /_distance: number/;
const ANY_DISTANCE = /_distance/;
const RECURSIVE_SLOT = /nearby\?: Array<VibORMRecursiveNode1>/;
const ANY_RECURSIVE_NODE = /VibORMRecursiveNode/;
const RECURSIVE_CTE = /WITH RECURSIVE/;

describe("the output key `_distance` has one producer", () => {
  it("refuses a recursive relation named `_distance` where the schema is validated, before any statement", () => {
    assert.deepEqual(validateSchema(reservedSchema).errors, [RESERVED]);
    const driver = new CountingDriver();
    for (const construct of [
      () => new EngineSchema(reservedSchema),
      () => createClient({ schema: reservedSchema, driver }),
    ])
      assert.throws(
        construct,
        (error: unknown) =>
          error instanceof SchemaValidationError &&
          error.message.includes(RESERVED.message)
      );
    assert.equal(driver.statements, 0, "a refused schema reaches no provider");
  });

  it("keeps the distance and a renamed recursive slot under their own keys, in every order and form", () => {
    for (const args of [
      ...[distanceFirst, relationFirst].map((raw) =>
        engine.admit(place, "findMany", raw)
      ),
      includedAdmitted,
    ])
      assert.deepEqual(
        fieldKinds(args),
        { id: "scalar", _distance: "scalar", nearby: "recursive" },
        JSON.stringify(args)
      );

    const inside = queries().select(
      place,
      engine.admit(place, "findMany", nested)
    );
    assert.equal(inside.shape.kind, "object");
    if (inside.shape.kind !== "object") return;
    const slot = inside.shape.fields.nearby;
    assert.equal(slot?.kind, "recursive");
    if (slot?.kind !== "recursive") return;
    assert.equal(slot.row.kind, "object");
    if (slot.row.kind !== "object") return;
    assert.equal(slot.row.fields._distance?.kind, "scalar");
    assert.equal(inside.shape.fields._distance, undefined);
  });

  it("renders the same keys for the schema-only result shape", () => {
    for (const args of [distanceFirst, relationFirst]) {
      const rendered = renderOperationResultType(
        schema,
        "place",
        "findMany",
        args
      );
      assert.match(rendered, DISTANCE_NUMBER, JSON.stringify(args));
      assert.match(rendered, RECURSIVE_SLOT, JSON.stringify(args));
    }
    const inside = renderOperationResultType(
      schema,
      "place",
      "findMany",
      nested
    );
    assert.match(inside, RECURSIVE_SLOT);
    assert.match(inside, DISTANCE_NUMBER);

    // Admission refuses `select` beside `include` (V4001) before any shape is
    // built, so the schema-only owner is asked directly for that spelling.
    const shape = buildExpectedResultShape(
      place,
      "findMany",
      included,
      engine.index
    );
    assert.ok(shape?.distanceScalar, "the distance keeps its producer");
    assert.ok(shape?.relations.get("nearby")?.recurrence, "the slot recurses");

    const distanceOnly = renderOperationResultType(
      schema,
      "place",
      "findMany",
      distanceAlone
    );
    assert.match(distanceOnly, DISTANCE_NUMBER);
    assert.doesNotMatch(distanceOnly, ANY_RECURSIVE_NODE);
    const relationOnly = renderOperationResultType(
      schema,
      "place",
      "findMany",
      relationAlone
    );
    assert.match(relationOnly, RECURSIVE_SLOT);
    assert.doesNotMatch(relationOnly, ANY_DISTANCE);
  });

  it("keeps the key for each producer alone", () => {
    const distance = queries().select(
      place,
      engine.admit(place, "findMany", distanceAlone)
    );
    assert.equal(distance.shape.kind, "object");
    if (distance.shape.kind !== "object") return;
    assert.equal(distance.shape.fields._distance?.kind, "scalar");
    assert.doesNotMatch(distance.sql.toStatement("$n"), RECURSIVE_CTE);

    const relation = queries().select(
      place,
      engine.admit(place, "findMany", relationAlone)
    );
    assert.equal(relation.shape.kind, "object");
    if (relation.shape.kind !== "object") return;
    assert.equal(relation.shape.fields.nearby?.kind, "recursive");
    assert.equal(relation.shape.fields._distance, undefined);
    assert.match(relation.sql.toStatement("$n"), RECURSIVE_CTE);
  });
});
