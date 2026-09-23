/**
 * RQ-07 follow-up — the output key `_distance` has ONE producer.
 *
 * A point's distance publishes under `_distance`; a model may also own a
 * relation of that name, and that relation may recurse. Selected together, the
 * two producers would publish under one key at some levels and the other at
 * the rest (the recursive slot overwrites the leaf wherever the repeated key
 * is present and leaves the leaf where the cutoff omits it), the live cache
 * would store that, and the rendered type would declare the key twice. The
 * projection's preparation refuses the pair once, whichever producer comes
 * first; the schema-only shape refuses it with the same sentence; each
 * producer alone keeps its key. The pair also forms one level down: a
 * recursive `_distance` slot whose repeated node selects a distance gives
 * that node's key both producers, and meets the same sentence. Admission
 * refuses `select` beside `include` at one level (V4001), so the included
 * spelling is reachable only below admission — the engine entry and the
 * schema-only shape prove the guard is order- and form-independent there; the
 * public cells hold the two selected orders and the nested spelling, the cache
 * half through `$withCache()`, the only read the cache answers.
 *
 * Lowering only: the refusal precedes the first statement, so no provider is
 * needed to observe it, and no PostGIS-less local provider spells a distance.
 */

import assert from "node:assert/strict";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import { renderOperationResultType } from "@client/schema-introspection";
import { QueryEngineError } from "@errors";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import { s } from "@schema";
import { CountingMemoryCache } from "@tests/fixtures/counting-memory-cache";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { describe, it } from "vitest";

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
    _distance: s.toMany(() => place).name("rq07Places"),
  })
  .map("rq07_places");
const schema = { place };
const paris = { longitude: 2.3522, latitude: 48.8566 };

const COLLISION =
  "A distance result cannot be selected together with a model field named '_distance'.";

const distanceFirst = {
  select: {
    id: true,
    at: { _distance: { to: paris } },
    _distance: { recurse: { depth: 2 }, select: { id: true } },
  },
};
const relationFirst = {
  select: {
    _distance: { recurse: { depth: 2 }, select: { id: true } },
    at: { _distance: { to: paris } },
    id: true,
  },
};
const included = {
  select: { id: true, at: { _distance: { to: paris } } },
  include: { _distance: { recurse: true, select: { id: true } } },
};
/** The pair one level down: the repeated node itself selects the distance. */
const nested = {
  select: {
    id: true,
    _distance: {
      recurse: { depth: 2 },
      select: { id: true, at: { _distance: { to: paris } } },
    },
  },
};
/**
 * `included` as the engine receives it, `recurse: true` already normalized:
 * admission refuses `select` beside `include` (V4001), so only the engine
 * entry below takes this spelling.
 */
const includedAdmitted = {
  select: { id: true, at: { _distance: { to: paris } } },
  include: {
    _distance: {
      recurse: { depth: 100, cycles: "reject" },
      select: { id: true },
    },
  },
};
const distanceAlone = { select: { id: true, at: { _distance: { to: paris } } } };
const relationAlone = {
  select: { id: true, _distance: { recurse: { depth: 2 }, select: { id: true } } },
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

describe("the output key `_distance` has one producer", () => {
  it("refuses a distance beside a relation named `_distance`, in either order, before any statement", async () => {
    for (const args of [
      ...[distanceFirst, relationFirst, nested].map((raw) =>
        engine.admit(place, "findMany", raw)
      ),
      includedAdmitted,
    ])
      assert.throws(
        () => queries().select(place, args),
        (error: unknown) =>
          error instanceof QueryEngineError && error.message === COLLISION,
        JSON.stringify(args)
      );

    const driver = new CountingDriver();
    const memory = new CountingMemoryCache();
    const background: Promise<unknown>[] = [];
    const client = createClient({ schema, driver }).$extends(
      cache({
        driver: memory,
        waitUntil(promise) {
          background.push(promise);
        },
      })
    );
    try {
      for (const args of [distanceFirst, relationFirst, nested]) {
        await assert.rejects(
          Reflect.apply(client.place.findMany, client.place, [args]),
          (error: unknown) =>
            error instanceof QueryEngineError && error.message === COLLISION,
          JSON.stringify(args)
        );
        // The plain read never reaches the cache; `$withCache()` is the read
        // the cache answers, so its lookup and store are what this counts.
        const cached = client.$withCache().place;
        await assert.rejects(
          Reflect.apply(cached.findMany, cached, [args]),
          (error: unknown) =>
            error instanceof QueryEngineError && error.message === COLLISION,
          `$withCache() ${JSON.stringify(args)}`
        );
      }
      await Promise.all(background);
      assert.equal(driver.statements, 0, "a refused projection reaches no provider");
      assert.equal(memory.reads, 0, "a refused projection is never looked up");
      assert.equal(memory.writes, 0, "a refused projection is never cached");
    } finally {
      await client.$disconnect();
    }
  });

  it("renders the same refusal for the schema-only result shape", () => {
    for (const args of [distanceFirst, relationFirst, nested])
      assert.throws(
        () => renderOperationResultType(schema, "place", "findMany", args),
        (error: unknown) =>
          error instanceof QueryEngineError && error.message === COLLISION,
        JSON.stringify(args)
      );
    const distanceOnly = renderOperationResultType(
      schema,
      "place",
      "findMany",
      distanceAlone
    );
    assert.match(distanceOnly, /_distance: number/);
    assert.doesNotMatch(distanceOnly, /VibORMRecursiveNode/);
    const relationOnly = renderOperationResultType(
      schema,
      "place",
      "findMany",
      relationAlone
    );
    assert.match(relationOnly, /_distance\?: Array<VibORMRecursiveNode1>/);
    assert.doesNotMatch(relationOnly, /_distance: number/);
  });

  it("refuses the included spelling in the schema-only shape below admission", () => {
    // Admission refuses `select` beside `include` (V4001) before any shape is
    // built, so no public entry reaches this spelling: the schema-only owner
    // is asked directly, as the engine entry is in the first cell.
    const { index } = new EngineSchema(schema);
    assert.throws(
      () => buildExpectedResultShape(place, "findMany", included, index),
      (error: unknown) =>
        error instanceof QueryEngineError && error.message === COLLISION
    );
  });

  it("keeps the key for each producer alone", () => {
    const distance = queries().select(
      place,
      engine.admit(place, "findMany", distanceAlone)
    );
    assert.equal(distance.shape.kind, "object");
    if (distance.shape.kind !== "object") return;
    assert.equal(distance.shape.fields._distance?.kind, "scalar");
    assert.doesNotMatch(distance.sql.toStatement("$n"), /WITH RECURSIVE/);

    const relation = queries().select(
      place,
      engine.admit(place, "findMany", relationAlone)
    );
    assert.equal(relation.shape.kind, "object");
    if (relation.shape.kind !== "object") return;
    assert.equal(relation.shape.fields._distance?.kind, "recursive");
    assert.match(relation.sql.toStatement("$n"), /WITH RECURSIVE/);
  });
});
