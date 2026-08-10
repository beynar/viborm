import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import { isOperationValueReference } from "@src/query-engine/write-engine/OperationFragment";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import {
  producedFieldSchema,
  registerProducedFieldBehavior,
  registerTwoSequenceBehavior,
  twoSequenceSchema,
} from "@tests/contracts/engine/write/fresh-produced-field-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE F — the structural half. The behavior module owns "the child holds the value
 * the parent's INSERT produced"; this file owns HOW MANY statements that costs and WHICH
 * statement reports the value, because those are the two things §6 F's keep gate is
 * written in terms of.
 *
 * FALSIFIED 2026-08-10 against `src/query-engine/write-engine/CreateOperation.ts`
 * (original restored from a scratchpad copy taken before each edit):
 *
 *  · dropping the `this.publishReads.has(writeStepId)` disjunct from
 *    `capturesGeneratedIdentity`. The FIRST attempt reddened NOTHING, and that is
 *    recorded because it changed this file: every produced-field record it pinned was a
 *    ROOT, whose identity is captured for its own terminal read anyway. The disjunct's
 *    unique coverage is a NON-root producer — a before-parent target nothing else wants
 *    the key of — so that case was added ("a NON-root record's focused read still gets an
 *    identity to address it by") and the same mutation then reddened it alone.
 *  · replacing `producedKey(field)`'s namespace with the bare field name. Eight pins
 *    reddened, and the one that matters is the collision case: `knob.create`'s outputs
 *    collapsed from two entries to ONE, so the consumer of the produced column named
 *    `id` would have silently read the generated key `key` instead. That is the failure
 *    the namespace alone catches.
 */

const substrates = [
  {
    name: "transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
] as const;

function pushed(schema: Record<string, unknown>): () => Promise<any> {
  let shared: any;
  return async () => {
    if (!shared) {
      shared = createClient({
        schema,
        driver: substrates[0].make(),
      } as any) as any;
      await push(shared, { force: true });
    }
    return shared;
  };
}

// ONE client over the union: PGlite is PostgreSQL, so it hosts both halves, and `push`
// drops what the pushed schema does not declare — two clients on one database would
// leave whichever pushed last holding the tables.
const connectPGlite = pushed({ ...producedFieldSchema, ...twoSequenceSchema });
registerProducedFieldBehavior("PGlite transaction", connectPGlite);
registerTwoSequenceBehavior("PGlite transaction", connectPGlite);

// ---------------------------------------------------------------------------
// The three substrate answers, as statements
// ---------------------------------------------------------------------------

function engineFor(
  driver: AnyDriver,
  schema: Record<string, unknown> = producedFieldSchema
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema as any, createSchemaRegistry(schema as any))
  );
}

function normalized(value: unknown): unknown {
  if (isOperationValueReference(value)) {
    return { ref: `${value.step}.${value.output}` };
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, member]) => [key, normalized(member)])
  );
}

function shapeOf(
  driver: AnyDriver,
  model: Model<any>,
  args: Record<string, unknown>,
  schema: Record<string, unknown> = producedFieldSchema
): unknown {
  const operation = new CreateOperation(engineFor(driver, schema), model, args);
  return operation.compile({}).steps.map((step) => {
    if (step.kind === "guard") throw new Error("Unexpected guard step.");
    const query = driver._prepare(step.statement);
    return {
      id: step.id,
      kind: step.kind,
      sql: query.sql,
      params: normalized(query.params),
      outputs: normalized(step.outputs),
    };
  });
}

const CRATE_LEAF = {
  data: { id: "d1", name: "D", crates: { create: { id: "c1" } } },
  select: { id: true },
};

describe("F2 — a RETURNING provider publishes in the INSERT it already sends", () => {
  test("the produced column joins the RETURNING list; no statement is added", () => {
    const driver = new PGliteDriver();
    expect(
      shapeOf(driver, producedFieldSchema.depot as Model<any>, CRATE_LEAF)
    ).toEqual([
      {
        id: "depot.create",
        kind: "write",
        // ONE clause added to the statement that was already being sent. `slot` is
        // spelled NULL because it is omitted-and-nullable; `serial` is absent from the
        // column list because the database assigns it — and returned because a
        // descendant asked.
        sql: 'INSERT INTO "pkgf_depots" ("id", "name", "slot") VALUES ($1, $2, NULL) RETURNING "serial" AS "serial"',
        params: ["d1", "D"],
        outputs: {
          "produced:serial": { kind: "firstRowField", field: "serial" },
        },
      },
      {
        id: "crate.create",
        kind: "write",
        // The destination cast is untouched: it lives at the CONSUMING column, which
        // sees a `Ref` here exactly as it saw the generated identity's `Ref` before F.
        sql: 'INSERT INTO "pkgf_crates" ("id", "depotSerial") VALUES ($1, CAST($2 AS INTEGER))',
        params: ["c1", { ref: "depot.create.produced:serial" }],
        outputs: {},
      },
      {
        id: "depot.select",
        kind: "read",
        sql: 'SELECT "t0"."id" AS "id" FROM "pkgf_depots" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
        params: ["d1"],
        outputs: { result: { kind: "rows" } },
      },
    ]);
  });

  test("TWO consumers cost ONE returned column, ONE output, and spend ONE reference", () => {
    const driver = new PGliteDriver();
    const steps = shapeOf(driver, producedFieldSchema.depot as Model<any>, {
      data: {
        id: "d2",
        name: "D",
        crates: { create: { id: "c2" } },
        bins: { create: { id: "b2" } },
      },
      select: { id: true },
    }) as any[];
    expect(steps).toHaveLength(4);
    expect(steps[0].sql).toContain('RETURNING "serial" AS "serial"');
    expect(steps[0].sql.match(/RETURNING/g)).toHaveLength(1);
    expect(Object.keys(steps[0].outputs)).toEqual(["produced:serial"]);
    expect(steps[1].params).toEqual([
      "c2",
      { ref: "depot.create.produced:serial" },
    ]);
    expect(steps[2].params).toEqual([
      "b2",
      { ref: "depot.create.produced:serial" },
    ]);
  });

  test("a produced PK and a produced non-PK keep SEPARATE channels, identity first", () => {
    const driver = new PGliteDriver();
    const identityOnly = shapeOf(
      driver,
      twoSequenceSchema.hub as Model<any>,
      { data: { spans: { create: { id: "s1" } } }, select: { id: true } },
      twoSequenceSchema
    ) as any[];
    // The CONTROL: `code` is produced too, and is NOT published, because nothing asked.
    // Demand publishes; presence in the schema does not.
    expect(identityOnly[0].sql).toContain('RETURNING "id" AS "id"');
    expect(identityOnly[0].outputs).toEqual({
      id: { kind: "firstRowField", field: "id" },
    });

    const both = shapeOf(
      driver,
      twoSequenceSchema.hub as Model<any>,
      {
        data: {
          spans: { create: { id: "s1" } },
          marks: { create: { id: "m1" } },
        },
        select: { id: true },
      },
      twoSequenceSchema
    ) as any[];
    // The generated identity keeps its historical `id` output on every path, and leads
    // the projection so its column position cannot move when another field joins.
    expect(both[0].sql).toContain('RETURNING "id" AS "id", "code" AS "code"');
    expect(both[0].outputs).toEqual({
      id: { kind: "firstRowField", field: "id" },
      "produced:code": { kind: "firstRowField", field: "code" },
    });
    expect(both[1].params).toEqual(["s1", { ref: "hub.create.id" }]);
    expect(both[2].params).toEqual(["m1", { ref: "hub.create.produced:code" }]);
  });
});

describe("F3 — a non-returning transaction provider adds ONE focused read", () => {
  test("INSERT, then one read of only the demanded fields by the created-row selector", () => {
    const driver = new MySQL2Driver();
    expect(
      shapeOf(driver, producedFieldSchema.depot as Model<any>, CRATE_LEAF)
    ).toEqual([
      {
        id: "depot.create",
        kind: "write",
        // Byte-identical to the INSERT this substrate always sent.
        sql: "INSERT INTO `pkgf_depots` (`id`, `name`, `slot`) VALUES (?, ?, NULL)",
        params: ["d1", "D"],
        outputs: {},
      },
      {
        // THE ONE post-insert read. It selects the demanded field ALONE, and names the
        // row by the selector the compiler already owns — here a literal primary key,
        // so no identity capture is needed at all.
        id: "depot.produced",
        kind: "read",
        sql: "SELECT `t0`.`serial` AS `serial` FROM `pkgf_depots` AS `t0` WHERE `t0`.`id` = ? LIMIT 1",
        params: ["d1"],
        outputs: {
          "produced:serial": { kind: "firstRowField", field: "serial" },
        },
      },
      {
        id: "crate.create",
        kind: "write",
        sql: "INSERT INTO `pkgf_crates` (`id`, `depotSerial`) VALUES (?, CAST(? AS SIGNED))",
        params: ["c1", { ref: "depot.produced.produced:serial" }],
        outputs: {},
      },
      {
        id: "depot.select",
        kind: "read",
        sql: "SELECT `t0`.`id` AS `id` FROM `pkgf_depots` AS `t0` WHERE `t0`.`id` = ? LIMIT 1",
        params: ["d1"],
        outputs: { result: { kind: "rows" } },
      },
    ]);
  });

  /**
   * STRUCTURAL ONLY, and the reason is measured rather than stylistic: this shape asks
   * one record for a generated primary key AND another database-produced column, which on
   * a non-returning provider means a MySQL table with two AUTO_INCREMENT columns — DDL
   * MySQL refuses (`ER_WRONG_AUTO_KEY`). mysql2 and PlanetScale are the only adapters
   * declaring `supportsReturning: false`, so NO provider this repo ships can host the row.
   * The branch is pinned anyway because it is the consistency between two owners, not a
   * defense: `buildInsertStep` must declare the `id` output that `createdRowWhere` spends,
   * or the focused read carries a dangling reference. See both owners' notes.
   */
  test("insertId NAMES the row for that read; it is never the field's value", () => {
    const driver = new MySQL2Driver();
    const control = shapeOf(
      driver,
      twoSequenceSchema.hub as Model<any>,
      { data: { spans: { create: { id: "s1" } } }, select: { id: true } },
      twoSequenceSchema
    ) as any[];
    // CONTROL: demand for the identity alone adds no read, on this substrate as on any
    // other. So the extra step below belongs to the produced non-identity column.
    expect(control.map((step) => step.id)).toEqual([
      "hub.create",
      "span.create",
      "hub.select",
    ]);

    const steps = shapeOf(
      driver,
      twoSequenceSchema.hub as Model<any>,
      { data: { marks: { create: { id: "m1" } } }, select: { id: true } },
      twoSequenceSchema
    ) as any[];
    expect(steps.map((step) => step.id)).toEqual([
      "hub.create",
      "hub.produced",
      "mark.create",
      "hub.select",
    ]);
    // The INSERT captures the identity because the READ needs a row to name — that is
    // the whole of what `insertId` does here.
    expect(steps[0].outputs).toEqual({ id: { kind: "insertId" } });
    expect(steps[1].sql).toBe(
      "SELECT `t0`.`code` AS `code` FROM `pkgf_hubs` AS `t0` WHERE `t0`.`id` = CAST(? AS SIGNED) LIMIT 1"
    );
    expect(steps[1].params).toEqual([{ ref: "hub.create.id" }]);
    // …and the consumer spends the READ's value, not the insert id.
    expect(steps[2].params).toEqual([
      "m1",
      { ref: "hub.produced.produced:code" },
    ]);
  });

  /** Structural for the same measured reason as the test above. */
  test("a NON-root record's focused read still gets an identity to address it by", () => {
    // The root's identity is captured for its own terminal read, so a root can hide the
    // coupling. Here the producing record is a BEFORE-parent target: nothing else in the
    // operation wants its key, and only the focused read does.
    const driver = new MySQL2Driver();
    const steps = shapeOf(
      driver,
      twoSequenceSchema.mark as Model<any>,
      { data: { id: "m1", hub: { create: {} } }, select: { id: true } },
      twoSequenceSchema
    ) as any[];
    expect(steps.map((step) => step.id)).toEqual([
      "hub.create",
      "hub.produced",
      "mark.create",
      "mark.select",
    ]);
    expect(steps[0].outputs).toEqual({ id: { kind: "insertId" } });
    expect(steps[1].sql).toBe(
      "SELECT `t0`.`code` AS `code` FROM `pkgf_hubs` AS `t0` WHERE `t0`.`id` = CAST(? AS SIGNED) LIMIT 1"
    );
    expect(steps[1].params).toEqual([{ ref: "hub.create.id" }]);
    expect(steps[2].params).toEqual([
      "m1",
      { ref: "hub.produced.produced:code" },
    ]);
  });
});

describe("F1 — the published channel is per field, not per record", () => {
  test("a produced column CALLED 'id' does not collide with the generated key's channel", () => {
    const driver = new PGliteDriver();
    const steps = shapeOf(
      driver,
      twoSequenceSchema.knob as Model<any>,
      {
        data: {
          byKey: { create: { id: "t1" } },
          byId: { create: { id: "g1" } },
        },
        select: { key: true },
      },
      twoSequenceSchema
    ) as any[];
    // `key` is the generated primary key and keeps the historical `id` output; the
    // column literally named `id` is produced too, and takes a namespaced one. Collapse
    // the two onto one name and the second consumer silently reads the first's value.
    expect(steps[0].outputs).toEqual({
      id: { kind: "firstRowField", field: "key" },
      "produced:id": { kind: "firstRowField", field: "id" },
    });
    expect(steps[1].params).toEqual(["t1", { ref: "knob.create.id" }]);
    expect(steps[2].params).toEqual(["g1", { ref: "knob.create.produced:id" }]);
  });
});

describe("F4 — the substrate row of the value-state table", () => {
  test("a batch substrate refuses in its own sentence, before any statement", () => {
    let thrown: unknown;
    try {
      new CreateOperation(
        engineFor(new BatchOnlyPGliteDriver()),
        producedFieldSchema.depot as Model<any>,
        CRATE_LEAF
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedOperationError);
    expect((thrown as Error).message).toBe(
      "query-engine-v2 create cannot publish the database-produced field 'serial' of 'depot' on a batch substrate: an atomic batch addresses no statement's rows, and its reference storage carries the generated identity alone. Run this write on a driver that offers an interactive transaction."
    );
  });

  test("KEEP: the nullable-unique row raises the SAME sentence it always did", () => {
    let thrown: unknown;
    try {
      new CreateOperation(
        engineFor(new PGliteDriver()),
        producedFieldSchema.depot as Model<any>,
        { data: { id: "d9", name: "D", latches: { create: { id: "l9" } } } }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedOperationError);
    expect((thrown as Error).message).toBe(
      "query-engine-v2 create cannot resolve referenced field 'slot' for relation 'latches': it is neither this record's primary key nor a knowable value in its own create data."
    );
  });

  test("K2: a shared primary key on a produced non-PK column compiles on both transaction substrates", () => {
    const args = {
      data: { note: "n", depot: { create: { id: "d5", name: "D" } } },
      select: { depotSerial: true },
    };
    const pglite = shapeOf(
      new PGliteDriver(),
      producedFieldSchema.seal as Model<any>,
      args
    ) as any[];
    // The record's OWN primary key is the published reference, spent in its INSERT and
    // again in the terminal read — one produced value, never re-derived.
    expect(pglite.map((step) => step.id)).toEqual([
      "depot.create",
      "seal.create",
      "seal.select",
    ]);
    expect(pglite[1].params).toEqual([
      { ref: "depot.create.produced:serial" },
      "n",
    ]);
    expect(pglite[2].params).toEqual([{ ref: "depot.create.produced:serial" }]);

    const mysql = shapeOf(
      new MySQL2Driver(),
      producedFieldSchema.seal as Model<any>,
      args
    ) as any[];
    expect(mysql.map((step) => step.id)).toEqual([
      "depot.create",
      "depot.produced",
      "seal.create",
      "seal.select",
    ]);
    expect(mysql[2].params).toEqual([
      { ref: "depot.produced.produced:serial" },
      "n",
    ]);
  });

  test("K2 SURVIVORS: a connect by a non-referenced unique still refuses", () => {
    let thrown: unknown;
    try {
      new CreateOperation(
        engineFor(new PGliteDriver()),
        producedFieldSchema.seal as Model<any>,
        { data: { note: "n", depot: { connect: { id: "d1" } } } }
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedOperationError);
    expect((thrown as Error).message).toBe(
      "query-engine-v2 create does not support a shared-primary-key connect on relation 'depot' whose foreign key 'depotSerial' (this record's primary key) is not a compile-time literal."
    );
  });
});
