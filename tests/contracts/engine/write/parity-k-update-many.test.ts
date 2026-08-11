import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { planningKey } from "@src/query-engine/write-engine/Part";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { fragmentAtom } from "@tests/fixtures/routed-fragment-atom";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package K (§6 K, "Lift root relation-bearing updateMany").
 *
 * Package K routes relation-bearing `data` to a new `UpdateManyRecordSeries` whose
 * shape is the opposite of today's: a locking capture, then one selected-record
 * update per captured root. Its keep gate is that "scalar-only SQL and round trips
 * are unchanged" (§6 K, Keep gate). The scalar arm's whole identity is that it has
 * NO capture — one statement, one round trip, count straight from the provider — so
 * that is what this file records, byte for byte, at `constructRoutedOperation`, the
 * seam K2 edits.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order, planning SQL and parameters, planning outputs — EMPTY
 *     on every `{ count }` arm. This is the load-bearing one: K3 introduces a capture,
 *     and a capture that leaks onto the scalar arm doubles its round trips while every
 *     behavioral assertion still passes;
 *   · final IDs and order — the step id is literally the operation kind, `updateMany`;
 *   · final SQL and parameters — three dialects, plus both `limit` spellings, verbatim.
 *     `bulk-write-limit-plan.test.ts` pins the limit spellings by REGEX, which cannot
 *     see a changed predicate, alias, or parameter order; these are the bytes;
 *   · guards and expects — none exist on this path, asserted rather than assumed;
 *   · race pins — none;
 *   · exact errors — the refusal K1 lifts, verbatim;
 *   · statement and round-trip counts — planning steps plus final steps IS the round
 *     trip count here, because `updateMany` takes no branch: 1 for the `{ count }` arm
 *     and for the returning arm on a RETURNING driver, 3 for the non-returning arm.
 *
 * THE SIBLING FAMILY. `deleteMany` shares BOTH seams K2 edits — the same
 * `returnsRows(args) ? ManyAndReturnOperation : BulkCountOperation` ternary at
 * routing.ts:199, and `BulkCountOperation`, whose `BulkCountKind` is
 * `"updateMany" | "deleteMany"` and which K3 must not give a mode flag. Its whole matrix
 * is mirrored below so a router change or a leaked capture cannot land there unseen.
 *
 * CAPTURED ORDER. The non-returning arm's assertions FEED the captured rows, so an
 * already-sorted feed proves nothing about the engine's own ordering. A reversed feed is
 * asserted separately: today the order is PRESERVED, member for member, in both the write
 * predicate and the re-read.
 *
 * CAVEAT on the falsification below: returning the existing write step from `planning()`
 * is a PHASE-only simulation. It exercises no capture SQL, so it shows that a step
 * appearing in the planning list is caught — not that a capture whose statement text or
 * lock differed would be. That is the right minimum for the scalar arm and should not be
 * read as covering K3.
 *
 * COUNT SEMANTICS. Today `count` is the provider's affected-row total, read from the
 * one write's `rowCount` and passed through `parse`. §5.2 replaces that with the
 * captured-root count for the series arm, citing MySQL reporting zero affected rows
 * for a no-op assignment — so the scalar arm's passthrough, including the zero, is
 * pinned here as the thing that must survive on this side of the split.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/BulkCountOperation.ts`:
 * changing `planning()` to return the write step as a planning step
 * (`{ steps: this.write ? [this.write] : [], outputs: {} }`) — the minimal simulation
 * of a capture leaking onto the scalar arm — turned every planning assertion red while
 * the SQL bytes stayed identical, so this file separates "which phase" from "what SQL".
 * The original was restored from a scratchpad copy taken before the edit.
 */

const parityKSchema = (() => {
  const gadget = s
    .model({
      id: s.string().id(),
      name: s.string(),
      qty: s.int(),
      binId: s.int().nullable(),
      bin: s
        .manyToOne(() => bin)
        .fields("binId")
        .references("id")
        .optional(),
    })
    .map("pk_gadgets");
  const bin = s
    .model({
      id: s.int().id(),
      name: s.string(),
      gadgets: s.oneToMany(() => gadget),
    })
    .map("pk_bins");
  return { gadget, bin };
})();

hydrateSchemaNames(parityKSchema);

function engineFor(driver: AnyDriver): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(parityKSchema, createSchemaRegistry(parityKSchema))
  );
}

/** Routes through the public operation name — the seam K2 edits. */
function routeKind(
  driver: AnyDriver,
  kind: "updateMany" | "deleteMany",
  args: Record<string, unknown>
) {
  return fragmentAtom(
    constructRoutedOperation(
      engineFor(driver),
      parityKSchema.gadget,
      kind,
      args
    ),
    kind
  );
}

function route(driver: AnyDriver, args: Record<string, unknown>) {
  return routeKind(driver, "updateMany", args);
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

function reference(step: string, output: string): unknown {
  return { ref: `${step}.${output}` };
}

function prepared(
  driver: AnyDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function stepContract(driver: AnyDriver, current: OperationStep): unknown {
  if (current.kind === "guard") throw new Error("updateMany plans no guard.");
  return {
    id: current.id,
    kind: current.kind,
    ...prepared(driver, current),
    outputs: normalized(current.outputs),
    expects: current.expects ?? null,
    racePin: current.kind === "write" ? (current.racePin ?? null) : null,
    onUniqueConflict:
      current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
  };
}

function fragmentContract(
  driver: AnyDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) => stepContract(driver, current)),
    outputs: normalized(publishedOutputs(fragment)),
  };
}

const NO_BRANCH = {
  expects: null,
  racePin: null,
  onUniqueConflict: null,
} as const;

/** An INT filter, so the bytes below are about `updateMany` and not about the
 *  dialect's case-sensitive string equality — which gets its own pin further down. */
const SCALAR_ARGS = {
  where: { qty: 5 },
  data: { name: "beta" },
};

describe("parity K — the scalar updateMany is ONE statement and no planning", () => {
  const dialects = [
    {
      name: "PostgreSQL",
      driver: () => new PGliteDriver(),
      sql: 'UPDATE "pk_gadgets" SET "name" = $1 WHERE "pk_gadgets"."qty" = $2',
    },
    {
      name: "SQLite",
      driver: () => new SQLite3Driver(),
      sql: 'UPDATE "pk_gadgets" SET "name" = ? WHERE "pk_gadgets"."qty" = ?',
    },
    {
      name: "MySQL",
      driver: () => new MySQL2Driver(),
      sql: "UPDATE `pk_gadgets` SET `name` = ? WHERE `pk_gadgets`.`qty` = ?",
    },
  ];

  for (const dialect of dialects) {
    test(`${dialect.name}: planning is empty and the write is the whole plan`, () => {
      const driver = dialect.driver();
      const operation = route(driver, SCALAR_ARGS);

      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [],
        outputs: {},
      });
      expect(fragmentContract(driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "updateMany",
            kind: "write",
            sql: dialect.sql,
            params: ["beta", 5],
            outputs: { count: { kind: "rowCount" } },
            ...NO_BRANCH,
          },
        ],
        outputs: { count: reference("updateMany", "count") },
      });
    });
  }

  test("a string filter keeps each dialect's case-sensitive equality spelling", () => {
    // Portable case sensitivity is part of the one statement, so it is part of the
    // bytes K must not move. MySQL asserts the collated comparison BESIDE the plain
    // one — two predicates, two bound copies of the same value.
    const dialects = [
      {
        driver: new PGliteDriver(),
        sql: 'UPDATE "pk_gadgets" SET "qty" = $1 WHERE "pk_gadgets"."name" = $2',
        params: [1, "Alpha"],
      },
      {
        driver: new SQLite3Driver(),
        sql: 'UPDATE "pk_gadgets" SET "qty" = ? WHERE "pk_gadgets"."name" COLLATE BINARY = ?',
        params: [1, "Alpha"],
      },
      {
        driver: new MySQL2Driver(),
        sql: "UPDATE `pk_gadgets` SET `qty` = ? WHERE (`pk_gadgets`.`name` = ? AND BINARY `pk_gadgets`.`name` = ?) LIMIT 3",
        params: [1, "Alpha", "Alpha"],
      },
    ];
    for (const dialect of dialects) {
      const operation = route(dialect.driver, {
        where: { name: "Alpha" },
        data: { qty: 1 },
        // MySQL is the only one that keeps a native LIMIT on the write, so the cap
        // rides along here rather than duplicating the whole matrix.
        ...(dialect.driver instanceof MySQL2Driver ? { limit: 3 } : {}),
      });
      expect(fragmentContract(dialect.driver, operation.compile({}))).toEqual({
        steps: [
          {
            id: "updateMany",
            kind: "write",
            sql: dialect.sql,
            params: dialect.params,
            outputs: { count: { kind: "rowCount" } },
            ...NO_BRANCH,
          },
        ],
        outputs: { count: reference("updateMany", "count") },
      });
    }
  });

  test("count is the provider's affected-row total, passed straight through", () => {
    const operation = route(new PGliteDriver(), SCALAR_ARGS);
    expect(operation.parse({ count: 3 })).toEqual({ count: 3 });
    // The zero §5.2 calls out: a no-op assignment reports zero affected rows today,
    // and today that IS the answer. The series arm will answer the captured count.
    expect(operation.parse({ count: 0 })).toEqual({ count: 0 });
    // A driver that reports counts as BigInt narrows to the same public number.
    expect(operation.parse({ count: 2n })).toEqual({ count: 2 });
  });

  test("limit: 0 is the one shape with no statement, and it answers zero", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, { ...SCALAR_ARGS, limit: 0 });
    expect(operation.planning().steps).toEqual([]);
    const compiled = operation.compile({});
    expect(compiled.steps).toEqual([]);
    expect(compiled.outputs).toEqual({});
    expect(operation.parse(compiled.outputs)).toEqual({ count: 0 });
  });
});

describe("parity K — the two limit spellings, byte for byte", () => {
  test.each([
    [
      "PostgreSQL",
      () => new PGliteDriver(),
      'UPDATE "pk_gadgets" SET "name" = $1 WHERE "pk_gadgets"."id" IN (SELECT "t1"."id" AS "id" FROM "pk_gadgets" AS "t1" WHERE "t1"."qty" = $2 ORDER BY "t1"."id" ASC LIMIT $3)',
    ],
    [
      // The dialect `bulk-write-limit-plan.test.ts` covers by regex only.
      "SQLite",
      () => new SQLite3Driver(),
      'UPDATE "pk_gadgets" SET "name" = ? WHERE "pk_gadgets"."id" IN (SELECT "t1"."id" AS "id" FROM "pk_gadgets" AS "t1" WHERE "t1"."qty" = ? ORDER BY "t1"."id" ASC LIMIT ?)',
    ],
  ])("%s caps through a primary-key subquery", (_name, makeDriver, sql) => {
    const driver = makeDriver();
    const operation = route(driver, { ...SCALAR_ARGS, limit: 3 });
    expect(operation.planning().steps).toEqual([]);
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "updateMany",
          kind: "write",
          sql,
          params: ["beta", 5, 3],
          outputs: { count: { kind: "rowCount" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { count: reference("updateMany", "count") },
    });
  });

  test("MySQL caps with a native LIMIT and never re-reads the mutated table", () => {
    const driver = new MySQL2Driver();
    const operation = route(driver, { ...SCALAR_ARGS, limit: 3 });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "updateMany",
          kind: "write",
          sql: "UPDATE `pk_gadgets` SET `name` = ? WHERE `pk_gadgets`.`qty` = ? LIMIT 3",
          params: ["beta", 5],
          outputs: { count: { kind: "rowCount" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { count: reference("updateMany", "count") },
    });
  });
});

describe("parity K — the returning arm's round trips", () => {
  test("a RETURNING driver still issues exactly ONE statement", () => {
    const driver = new PGliteDriver();
    const operation = route(driver, {
      ...SCALAR_ARGS,
      select: { id: true, qty: true },
    });
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          // The `{ count }` arm's step id is the bare operation kind; the returning
          // owner's is model-qualified. The two owners are distinguishable from the
          // fragment alone, which is what makes a router change visible here.
          id: "gadget.updateManyReturn",
          kind: "write",
          sql: 'UPDATE "pk_gadgets" SET "name" = $1 WHERE "pk_gadgets"."qty" = $2 RETURNING "id" AS "id", "qty" AS "qty"',
          params: ["beta", 5],
          outputs: { result: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { result: reference("gadget.updateManyReturn", "result") },
    });
  });

  test("a NON-returning driver captures first, then writes and re-reads by key", () => {
    // THREE round trips, and the only path on which today's scalar `updateMany`
    // plans anything at all. K3's capture must not turn the `{ count }` arm into
    // this shape.
    const driver = new MySQL2Driver();
    const operation = route(driver, {
      ...SCALAR_ARGS,
      select: { id: true, qty: true },
    });

    const planning = operation.planning();
    expect(fragmentContract(driver, planning)).toEqual({
      steps: [
        {
          id: "gadget.updateManyReturn.capture",
          kind: "read",
          sql: "SELECT `t0`.`id` AS `id` FROM `pk_gadgets` AS `t0` WHERE `t0`.`qty` = ? FOR UPDATE",
          params: [5],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: {
        "gadget.updateManyReturn.capture.rows": reference(
          "gadget.updateManyReturn.capture",
          "rows"
        ),
      },
    });

    const compiled = operation.compile({
      [planningKey("gadget.updateManyReturn.capture", "rows")]: [
        { id: "g1" },
        { id: "g2" },
      ],
    });
    expect(fragmentContract(driver, compiled)).toEqual({
      steps: [
        {
          id: "gadget.updateManyReturn.write",
          kind: "write",
          // A STRING primary key carries the same portable case sensitivity as any
          // other string comparison, so the captured set is a per-key OR of collated
          // equality rather than one `IN` list. K5 addresses each member by its
          // captured key; this is the spelling that addressing has today.
          sql: "UPDATE `pk_gadgets` SET `name` = ? WHERE ((`pk_gadgets`.`id` = ? AND BINARY `pk_gadgets`.`id` = ?) OR (`pk_gadgets`.`id` = ? AND BINARY `pk_gadgets`.`id` = ?))",
          params: ["beta", "g1", "g1", "g2", "g2"],
          outputs: {},
          ...NO_BRANCH,
        },
        {
          id: "gadget.updateManyReturn.read",
          kind: "read",
          sql: "SELECT `t0`.`id` AS `id`, `t0`.`qty` AS `qty` FROM `pk_gadgets` AS `t0` WHERE ((`t0`.`id` = ? AND BINARY `t0`.`id` = ?) OR (`t0`.`id` = ? AND BINARY `t0`.`id` = ?))",
          params: ["g1", "g1", "g2", "g2"],
          outputs: { result: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { result: reference("gadget.updateManyReturn.read", "result") },
    });
  });
});

describe("parity K — captured order is the FED order, not a sorted one", () => {
  test("reversing the captured rows reverses both predicates, member for member", () => {
    // The sibling above feeds `[g1, g2]` and asserts `[g1, g2]`, which a re-sort would
    // reproduce. K5 addresses each member by its captured key and K6 must "preserve
    // deterministic captured order in the output", so the engine's own ordering needs a
    // before-picture: today it PRESERVES what planning handed it.
    const driver = new MySQL2Driver();
    const operation = route(driver, {
      ...SCALAR_ARGS,
      select: { id: true, qty: true },
    });
    operation.planning();
    const compiled = operation.compile({
      [planningKey("gadget.updateManyReturn.capture", "rows")]: [
        { id: "g2" },
        { id: "g1" },
      ],
    });
    expect(
      (compiled.steps as readonly StatementStep[]).map((step) => [
        step.id,
        driver._prepare(step.statement).params,
      ])
    ).toEqual([
      ["gadget.updateManyReturn.write", ["beta", "g2", "g2", "g1", "g1"]],
      ["gadget.updateManyReturn.read", ["g2", "g2", "g1", "g1"]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// deleteMany — the SAME seam and the SAME owner, pinned so K cannot leak onto it
// ---------------------------------------------------------------------------

/** `routing.ts:199` sends both bulk families through one
 *  `returnsRows(args) ? ManyAndReturnOperation : BulkCountOperation` ternary, and
 *  `BulkCountKind` is `"updateMany" | "deleteMany"`. K2 edits that ternary and K3 gives
 *  `BulkCountOperation` a capture, so a router change or a leaked mode flag lands on
 *  `deleteMany` too. Its bytes are the control. */
describe("parity K — deleteMany rides the same owners and must not move", () => {
  test.each([
    [
      "PostgreSQL",
      () => new PGliteDriver(),
      'DELETE FROM "pk_gadgets" WHERE "pk_gadgets"."qty" = $1',
    ],
    [
      "SQLite",
      () => new SQLite3Driver(),
      'DELETE FROM "pk_gadgets" WHERE "pk_gadgets"."qty" = ?',
    ],
    [
      "MySQL",
      () => new MySQL2Driver(),
      "DELETE FROM `pk_gadgets` WHERE `pk_gadgets`.`qty` = ?",
    ],
  ])("%s: planning is empty and the step id is the bare kind", (_name, makeDriver, sql) => {
    const driver = makeDriver();
    const operation = routeKind(driver, "deleteMany", { where: { qty: 5 } });
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "deleteMany",
          kind: "write",
          sql,
          params: [5],
          outputs: { count: { kind: "rowCount" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { count: reference("deleteMany", "count") },
    });
    expect(operation.parse({ count: 3 })).toEqual({ count: 3 });
  });

  test.each([
    [
      "PostgreSQL",
      () => new PGliteDriver(),
      'DELETE FROM "pk_gadgets" WHERE "pk_gadgets"."id" IN (SELECT "t1"."id" AS "id" FROM "pk_gadgets" AS "t1" WHERE "t1"."qty" = $1 ORDER BY "t1"."id" ASC LIMIT $2)',
      [5, 3],
    ],
    [
      "MySQL",
      () => new MySQL2Driver(),
      "DELETE FROM `pk_gadgets` WHERE `pk_gadgets`.`qty` = ? LIMIT 3",
      [5],
    ],
  ])("%s: the limit spelling matches its updateMany twin", (_name, makeDriver, sql, params) => {
    const driver = makeDriver();
    const operation = routeKind(driver, "deleteMany", {
      where: { qty: 5 },
      limit: 3,
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "deleteMany",
          kind: "write",
          sql,
          params,
          outputs: { count: { kind: "rowCount" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { count: reference("deleteMany", "count") },
    });
  });

  test("a RETURNING driver deletes and returns in ONE statement, model-qualified", () => {
    const driver = new PGliteDriver();
    const operation = routeKind(driver, "deleteMany", {
      where: { qty: 5 },
      select: { id: true, qty: true },
    });
    expect(operation.planning().steps).toEqual([]);
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "gadget.deleteManyReturn",
          kind: "write",
          sql: 'DELETE FROM "pk_gadgets" WHERE "pk_gadgets"."qty" = $1 RETURNING "id" AS "id", "qty" AS "qty"',
          params: [5],
          outputs: { result: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { result: reference("gadget.deleteManyReturn", "result") },
    });
  });

  test("a NON-returning driver captures first, and refuses if the capture is absent", () => {
    const driver = new MySQL2Driver();
    const operation = routeKind(driver, "deleteMany", {
      where: { qty: 5 },
      select: { id: true, qty: true },
    });
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "gadget.deleteManyReturn.capture",
          kind: "read",
          sql: "SELECT `t0`.`id` AS `id` FROM `pk_gadgets` AS `t0` WHERE `t0`.`qty` = ? FOR UPDATE",
          params: [5],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: {
        "gadget.deleteManyReturn.capture.rows": reference(
          "gadget.deleteManyReturn.capture",
          "rows"
        ),
      },
    });
    let thrown: unknown;
    try {
      operation.compile({});
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toBe(
      "query-engine-v2 deleteMany with 'select' planning did not expose the captured rows."
    );
  });
});

// ---------------------------------------------------------------------------
// The other side of the split: what K1 accepts and where K2 sends it
// ---------------------------------------------------------------------------

/** The routed operation WITHOUT the fragment-atom narrowing — the union itself,
 *  which is what says which destination the router picked. */
function routeRouted(driver: AnyDriver, args: Record<string, unknown>) {
  const operation = constructRoutedOperation(
    engineFor(driver),
    parityKSchema.gadget,
    "updateMany",
    args
  );
  if (!operation) throw new Error("updateMany did not route");
  return operation;
}

describe("parity K — the refusal K1 lifted, and the destination that replaced it", () => {
  test("a relation key in data used to be an unknown key; it now routes to a series", async () => {
    // BEFORE K1 both arms answered "Validation failed for updateMany: Unknown key:
    // bin", because `data` bound to the model's SCALAR-ONLY update schema — the
    // relation was not "unsupported", it was not a key at all. K1 binds `data` to
    // `core.update`, so the diagnostic disappears rather than changing wording, and
    // the payload becomes a record series. Both arms, because the router's
    // discriminant is `data` and must not consult `select`.
    const client = createClient({
      schema: parityKSchema,
      driver: new PGliteDriver(),
    }) as any;
    const stillUnknown = await client.gadget
      .updateMany({
        where: { name: "Alpha" },
        data: { qty: 1, bni: { connect: { id: 9 } } },
      })
      .then(
        () => undefined,
        (thrown: unknown) => (thrown as Error).message
      );
    // A TYPO beside a real key still rejects, at the same boundary and with the same
    // wording — the widening admitted the relation, not every key.
    expect(stillUnknown).toBe(
      "Validation failed for updateMany: Unknown key: bni"
    );

    for (const args of [
      {
        where: { name: "Alpha" },
        data: { qty: 1, bin: { connect: { id: 9 } } },
      },
      {
        where: { name: "Alpha" },
        data: { qty: 1, bin: { disconnect: true } },
        select: { id: true },
      },
    ]) {
      const routed = routeRouted(new PGliteDriver(), args);
      expect(isRecordSeries(routed)).toBe(true);
    }
  });

  test("data with no relation VALUE keeps the one-statement owner", () => {
    // The router reads the RAW data, and `undefined` is absent on every path — so
    // the spread-an-optional idiom does not cost a caller their fast path.
    const driver = new PGliteDriver();
    const routed = routeRouted(driver, {
      ...SCALAR_ARGS,
      data: { name: "beta", bin: undefined },
    });
    expect(isRecordSeries(routed)).toBe(false);
    expect(
      fragmentContract(driver, fragmentAtom(routed, "updateMany").compile({}))
    ).toEqual({
      steps: [
        {
          id: "updateMany",
          kind: "write",
          sql: 'UPDATE "pk_gadgets" SET "name" = $1 WHERE "pk_gadgets"."qty" = $2',
          params: ["beta", 5],
          outputs: { count: { kind: "rowCount" } },
          ...NO_BRANCH,
        },
      ],
      outputs: { count: reference("updateMany", "count") },
    });
  });

  test("the series captures the complete row key, locked, once, capped in SQL", () => {
    const driver = new PGliteDriver();
    const routed = routeRouted(driver, {
      where: { qty: 5 },
      data: { name: "beta", bin: { connect: { id: 9 } } },
      limit: 3,
    });
    const series = asSeries(routed);
    expect(fragmentContract(driver, series.capture())).toEqual({
      steps: [
        {
          id: "gadget.updateManySeries.capture",
          kind: "read",
          // ONE evaluation of the public `where`, the `limit` applied HERE (before
          // the in-memory sort), `FOR UPDATE`, and the row key alone.
          sql: 'SELECT "t0"."id" AS "id" FROM "pk_gadgets" AS "t0" WHERE "t0"."qty" = $1 ORDER BY "t0"."id" ASC LIMIT $2 FOR UPDATE',
          params: [5, 3],
          outputs: { rows: { kind: "rows" } },
          ...NO_BRANCH,
        },
      ],
      outputs: {
        "gadget.updateManySeries.capture.rows": reference(
          "gadget.updateManySeries.capture",
          "rows"
        ),
      },
    });
  });

  test("limit: 0 never becomes a series — a cap of no rows keeps the existing owner", () => {
    // RETARGETED at the Package K gate, from "the series builds no capture" to "the
    // router builds no series". Both spellings answer `{ count: 0 }` with no
    // statement on a transaction driver, but only this one answers it on a
    // batch-only one: a record series REQUIRES an interactive transaction, so the
    // old route turned `limit: 0` into `withTransaction`'s "does not support
    // callback transactions" for a call that writes nothing — the exact trap J
    // routed `createMany({ data: [] })` around, one operation name over. Keeping the
    // limit-0 answer with the owners also leaves ONE owner of "this payload writes
    // nothing", instead of a second copy inside the shell.
    const driver = new PGliteDriver();
    const routed = routeRouted(driver, {
      where: { qty: 5 },
      data: { name: "beta", bin: { connect: { id: 9 } } },
      limit: 0,
    });
    expect(isRecordSeries(routed)).toBe(false);
    expect(
      fragmentContract(driver, fragmentAtom(routed, "updateMany").compile({}))
    ).toEqual({ steps: [], outputs: {} });
  });

  test("limit: 0 with relation data answers zero on a batch-only substrate", async () => {
    const client = createClient({
      schema: parityKSchema,
      driver: new BatchOnlyPGliteDriver(),
    }) as any;
    // The scalar twin's answer, for a payload whose only difference is a relation
    // key that no row exists to apply.
    expect(
      await client.gadget.updateMany({
        where: { qty: 5 },
        limit: 0,
        data: { name: "beta", bin: { connect: { id: 9 } } },
      })
    ).toEqual({ count: 0 });
    expect(
      await client.gadget.updateMany({
        where: { qty: 5 },
        limit: 0,
        data: { name: "beta" },
      })
    ).toEqual({ count: 0 });
    await client.$disconnect();
  });

  test("members run in deterministic captured order, not the fed order", () => {
    // The sibling above (`captured order is the FED order`) pins the SCALAR returning
    // owner, which preserves what planning handed it. The series is the one place
    // that sorts, because an uncapped capture carries no ORDER BY at all.
    const series = asSeries(
      routeRouted(new PGliteDriver(), {
        where: { qty: 5 },
        data: { name: "beta", bin: { connect: { id: 9 } } },
      })
    );
    const members = series.compileMembers({
      [planningKey("gadget.updateManySeries.capture", "rows")]: [
        { id: "g3" },
        { id: "g1" },
        { id: "g2" },
      ],
    });
    expect(
      members.map((member) => memberLocateParams(new PGliteDriver(), member))
    ).toEqual([["g1"], ["g2"], ["g3"]]);
  });

  test("count is the CAPTURED root count, not the provider's affected rows", () => {
    // The scalar arm's passthrough is pinned above, including the zero MySQL reports
    // for a no-op assignment. This is the other side of that split: the series never
    // asks the provider how many rows changed.
    const series = asSeries(
      routeRouted(new PGliteDriver(), {
        where: { qty: 5 },
        data: { name: "beta", bin: { connect: { id: 9 } } },
      })
    );
    const captured = {
      [planningKey("gadget.updateManySeries.capture", "rows")]: [
        { id: "g1" },
        { id: "g2" },
      ],
    };
    expect(
      series.parseSeries({
        captured,
        memberResults: [{ id: "g1" }, { id: "g2" }],
        resultReadResults: [],
      })
    ).toEqual({ count: 2 });
  });

  test("N greater than one refuses child-held connect BEFORE building any member", () => {
    // `gadgets` is the INVERSE of the parent-held `bin` edge: the membership is
    // stored on the GADGET row, so two bins cannot both own gadget "g9".
    const binSeries = constructRoutedOperation(
      engineFor(new PGliteDriver()),
      parityKSchema.bin,
      "updateMany",
      {
        where: { name: "Shelf" },
        data: { gadgets: { connect: [{ id: "g9" }] } },
      }
    );
    expect(() =>
      asSeries(binSeries as never).compileMembers({
        [planningKey("bin.updateManySeries.capture", "rows")]: [
          { id: 1 },
          { id: 2 },
        ],
      })
    ).toThrow(
      "updateMany matched 2 rows, so it cannot apply 'connect' to relation 'gadgets': that membership is stored on the target row, which can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call."
    );
  });

  test("the SAME payload at N = 1 builds its member and refuses nothing", () => {
    const binSeries = constructRoutedOperation(
      engineFor(new PGliteDriver()),
      parityKSchema.bin,
      "updateMany",
      {
        where: { name: "Shelf" },
        data: { gadgets: { connect: [{ id: "g9" }] } },
      }
    );
    expect(
      asSeries(binSeries as never).compileMembers({
        [planningKey("bin.updateManySeries.capture", "rows")]: [{ id: 1 }],
      })
    ).toHaveLength(1);
  });

  test("a PARENT-held connect is meaningful at any N and is not refused", () => {
    // `bin` stores its membership in the GADGET's own `binId` column, so each of the
    // N roots gets its own copy and they agree by construction.
    const series = asSeries(
      routeRouted(new PGliteDriver(), {
        where: { qty: 5 },
        data: { bin: { connect: { id: 9 } } },
      })
    );
    expect(
      series.compileMembers({
        [planningKey("gadget.updateManySeries.capture", "rows")]: [
          { id: "g1" },
          { id: "g2" },
        ],
      })
    ).toHaveLength(2);
  });
});

/** The record-series view of a routed operation — the mirror of `fragmentAtom`. */
function asSeries(routed: ReturnType<typeof routeRouted>) {
  if (!isRecordSeries(routed)) {
    throw new Error("updateMany did not route to a record series");
  }
  return routed;
}

/** The parameters of a member's own locate read: which row it addresses. */
function memberLocateParams(driver: AnyDriver, member: ExecutableOperation) {
  const [locate] = member.planning().steps as readonly StatementStep[];
  if (!locate) throw new Error("a series member planned no locate read");
  return driver._prepare(locate.statement).params;
}
