import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { compileTransitionSchema } from "@tests/contracts/engine/write/compiled-key-transition-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package D (§6 D, "Unify old-read and new-write transition provenance").
 *
 * D1 makes transition legality and occupied-slot construction consume one correlated
 * binding; D2 lifts the non-cascading deeper edges the `pastSurface` regime refuses today;
 * D3 rebuilds occupied-slot predicates from that binding and requires "conjunct and
 * parameter order" to be preserved. All three edit
 * `RecordUpdateCompiler.interpretReferencedKeyTransition` (:2389) and its
 * `pushOccupiedGuard` (:2454), so this witness pins what those two produce TODAY, in the
 * shapes the `compiled-key-transition` family already owns (its schema is imported rather
 * than re-declared, so the boundary pinned here is that family's own).
 *
 * PRIOR ART, and what is actually new. record-compiler-contract.test.ts:617-640 already
 * pins the guarded regime's transition probe byte-for-byte on a transaction driver — its
 * OLD-value SQL and parameters, the planning output map, the final step id order and the
 * root UPDATE — with `create` where the first test below writes `connect`. The additive
 * material here is: the ATOMIC-BATCH arm (the `seat.guard.occupied` notExists premise,
 * which is the only compile-side carrier of the old value), the `pastSurface` and `none`
 * regimes, every guarded nested kind other than the adopt pair, and the two-relation
 * ordering at the end.
 *
 * The three regimes are named by the production code and all three are pinned:
 *   · `"guarded"` — a single primary key pinned by the unique `where`. Two facts D must
 *     keep: the occupied probe reads the OLD value, the adopt write binds the NEW one,
 *     and the adopt is ORDERED AFTER the root UPDATE (§D2's "membership reads use old
 *     values and adoption writes use new values", verbatim).
 *   · `"pastSurface"` — a compound edge, a non-primary-key referenced unique, or an
 *     unpinned pre-value. Every kind but `create` / `createMany` refuses; those two
 *     proceed on a compile-derived literal. §D2 is exactly the lift of that refusal, so
 *     its text is the before-picture.
 *   · `"none"` — `ON UPDATE CASCADE`, no referenced column written, or a no-op
 *     transition. §D's keep gate says "no extra planning read when the existing target
 *     projection already captured the field": today these three emit NO transition probe
 *     at all, which is the strongest form of that claim.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order — the transition probe is FIRST, ahead of every other
 *     relation read, and is ABSENT in all three `none` shapes;
 *   · planning SQL and parameters — including the probe's `ORDER BY … LIMIT $n` tail and
 *     the substrate's `FOR UPDATE`, which is what §D3's "preserve conjunct and parameter
 *     order" is measured against;
 *   · planning outputs — the probe publishes `rows` only, never an identity;
 *   · final IDs and order — the reorder decision (`reorderRootUpdateAfterChildren`,
 *     :564) differs across the regimes and each side is pinned;
 *   · final SQL and parameters — the OLD/NEW value split, and the arithmetic case where
 *     the root SET is `"id" = "id" + $1` in SQL while the child binds the JS-derived 15;
 *   · guards and expects — the batch occupied guard's `notExists` premise and failure;
 *   · race pins — none survive on these shapes, pinned as `null`;
 *   · exact errors — the `pastSurface` refusal for two kinds, the compile-time occupied
 *     `NestedWriteError`, and the non-literal-operand refusal;
 *   · statement counts — the step list IS the statement count; the refusals compile
 *     nothing at all.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/RecordUpdateCompiler.ts`:
 * feeding `pushOccupiedGuard` the post-transition value (`before: after` at the call site,
 * :2442) — i.e. inferring the old value from the new one, the very inference §D1 says to
 * delete — turned four assertions red and left ten green. Red: both guarded PLANNING
 * assertions (the probe bound "o2" instead of "o1"), the batch guarded COMPILE (the
 * occupied premise bound "o2"), and the arithmetic shape (the probe bound 15 instead of
 * 10). Green and correctly so: the TRANSACTION guarded compile, whose occupied verdict is
 * a planning-time read rather than a step, plus every `pastSurface` and `none` assertion.
 * The original was restored from a scratchpad copy taken before the edit.
 *
 * CAVEAT on that falsification. The transaction-mode occupied verdict stays green because
 * these tests FEED synthetic `seat.transition.find.rows`. On that substrate the old/new
 * distinction rests entirely on the ONE planning assertion (probe params `["o1", 1]`); the
 * compile-side old-value claim is carried by the atomic-batch guard alone. If D moves the
 * occupied verdict from planning to compile on the transaction substrate, only the batch
 * leg can catch a new-value binding.
 *
 * NOT PINNED HERE, recorded so the family stays auditable: D's focused families name
 * `pk-transition-junction-mixed-edge` and a polymorphic referenced-identity transition.
 * Neither `compileTransitionSchema` nor either local schema below has a many-to-many or a
 * polymorphic member, so a junction writing join rows with the NEW parent key while its
 * membership probes read the OLD one — and the polymorphic twin of that split — have no
 * before-picture here.
 */

hydrateSchemaNames(compileTransitionSchema);

/** The one shape `compiled-key-transition` has no member of: an `ON UPDATE CASCADE`
 *  edge, whose referenced column the root rewrites. It is the `none` regime's first
 *  branch (RecordUpdateCompiler.ts:2402) and the one §D2 must leave to the database. */
const cascadeSchema = (() => {
  const depot = s
    .model({
      id: s.string().id(),
      bins: s.oneToMany(() => bin),
    })
    .map("parity_d_depots");
  const bin = s
    .model({
      id: s.string().id(),
      depotId: s.string().nullable(),
      depot: s
        .manyToOne(() => depot)
        .fields("depotId")
        .references("id")
        .optional()
        .onUpdate("cascade"),
    })
    .map("parity_d_bins");
  return { depot, bin };
})();

hydrateSchemaNames(cascadeSchema);

function engineFor(
  schema: Record<string, Model<any>>,
  driver: AnyDriver
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
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

function reference(step: string, output: string): unknown {
  return { ref: `${step}.${output}` };
}

function prepared(
  driver: PGliteDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function guardContract(driver: PGliteDriver, current: OperationStep): unknown {
  if (current.kind !== "guard") throw new Error("Expected a guard step.");
  const query = driver._prepare(current.premise.statement);
  return {
    id: current.id,
    premise: {
      kind: current.premise.kind,
      sql: query.sql,
      params: normalized(query.params),
    },
    failure: current.failure,
  };
}

function fragmentContract(
  driver: PGliteDriver,
  fragment: PlanningFragment | OperationFragment
): unknown {
  return {
    steps: fragment.steps.map((current) =>
      current.kind === "guard"
        ? guardContract(driver, current)
        : {
            id: current.id,
            kind: current.kind,
            ...prepared(driver, current),
            outputs: normalized(current.outputs),
            expects: current.expects ?? null,
            racePin:
              current.kind === "write" ? (current.racePin ?? null) : null,
            onUniqueConflict:
              current.kind === "write"
                ? (current.onUniqueConflict ?? null)
                : null,
          }
    ),
    outputs: normalized(fragment.outputs),
  };
}

const orgNotFound = {
  kind: "notFound",
  message: "query-engine-v2 update located no 'org' row for its unique where.",
  raceable: false,
};

const orgTerminalFailure = {
  kind: "query",
  message: "query-engine-v2 update terminal read expected exactly one row.",
  raceable: false,
};

function orgUpdate(
  driver: PGliteDriver,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): UpdateOperation {
  return new UpdateOperation(
    engineFor(compileTransitionSchema, driver),
    compileTransitionSchema.org as Model<any>,
    { where, data, select: { id: true } }
  );
}

// ---------------------------------------------------------------------------
// regime "guarded" — the pinned single primary key
// ---------------------------------------------------------------------------

for (const substrate of [
  { name: "transaction", batch: false, createDriver: () => new PGliteDriver() },
  {
    name: "atomic batch",
    batch: true,
    createDriver: () => new BatchOnlyPGliteDriver(),
  },
]) {
  const lock = substrate.batch ? "" : " FOR UPDATE";

  /** The occupied probe: the OLD referenced value, and nothing else. */
  const OCCUPIED_PROBE_SQL = `SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."orgId" = $1 ORDER BY "t0"."id" ASC LIMIT $2`;

  describe(`parity D — regime "guarded" (${substrate.name})`, () => {
    test("the transition probe reads the OLD value and leads the planning list", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(
        driver,
        { id: "o1" },
        { id: "o2", seats: { connect: [{ id: "st1" }] } }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          {
            id: "org.locate",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "e67_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["o1"],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id" },
            },
            expects: { kind: "exactlyOneRow", failure: orgNotFound },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            // OLD-READ. `o1` is the value the root UPDATE is about to vacate.
            id: "seat.transition.find",
            kind: "read",
            sql: `${OCCUPIED_PROBE_SQL}${lock}`,
            params: ["o1", 1],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "seat.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["st1"],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          "org.locate.rows": reference("org.locate", "rows"),
          "org.locate.id": reference("org.locate", "id"),
          "seat.transition.find.rows": reference(
            "seat.transition.find",
            "rows"
          ),
          "seat.find.rows": reference("seat.find", "rows"),
        },
      });
    });

    test("an empty old slot: the root UPDATE runs first and the adopt binds the NEW value", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(
        driver,
        { id: "o1" },
        { id: "o2", seats: { connect: [{ id: "st1" }] } }
      );
      operation.planning();
      expect(
        fragmentContract(
          driver,
          operation.compile({
            "org.locate.rows": [{ id: "o1" }],
            "seat.transition.find.rows": [],
            "seat.find.rows": [{ id: "st1" }],
          })
        )
      ).toEqual({
        steps: [
          ...(substrate.batch
            ? [
                {
                  id: "org.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "e67_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["o1"],
                  },
                  failure: orgNotFound,
                },
                {
                  // The occupied verdict in batch mode: an absence premise over the
                  // SAME old-value statement the probe ran, raceable because a
                  // concurrent plant can invalidate it.
                  id: "seat.guard.occupied",
                  premise: {
                    kind: "notExists",
                    sql: OCCUPIED_PROBE_SQL,
                    params: ["o1", 1],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot update relation 'seats' with onUpdate('setNull') while the current relation is occupied.",
                    relation: "seats",
                    raceable: true,
                  },
                },
                {
                  id: "seat.guard.exists",
                  premise: {
                    kind: "exists",
                    sql: 'SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
                    params: ["st1"],
                  },
                  failure: {
                    kind: "nestedWrite",
                    message:
                      "Cannot connect relation 'seats': target record was not found.",
                    relation: "seats",
                    raceable: false,
                  },
                },
              ]
            : []),
          {
            id: "org.update",
            kind: "write",
            sql: 'UPDATE "e67_orgs" SET "id" = $1 WHERE "e67_orgs"."id" = $2 RETURNING "id" AS "id"',
            params: ["o2", "o1"],
            outputs: {},
            expects: substrate.batch
              ? null
              : {
                  kind: "affectedRows",
                  expected: 1,
                  failure: orgNotFound,
                },
            racePin: null,
            onUniqueConflict: null,
          },
          {
            // NEW-WRITE, ordered AFTER the root UPDATE that makes `o2` exist.
            id: "seat.connect",
            kind: "write",
            sql: 'UPDATE "e67_seats" SET "orgId" = CAST($1 AS TEXT) WHERE "e67_seats"."id" = $2 RETURNING "id" AS "id"',
            params: ["o2", "st1"],
            outputs: {},
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
          {
            id: "org.select",
            kind: "read",
            sql: 'SELECT "t0"."id" AS "id" FROM "e67_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
            params: ["o2"],
            outputs: { result: { kind: "rows" } },
            expects: substrate.batch
              ? null
              : { kind: "exactlyOneRow", failure: orgTerminalFailure },
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: { result: reference("org.select", "result") },
      });
    });
  });
}

describe("parity D — the occupied verdict fires at compile, in transaction mode", () => {
  test("an occupied old slot throws before any write is emitted", () => {
    const driver = new PGliteDriver();
    const operation = orgUpdate(
      driver,
      { id: "o1" },
      { id: "o2", seats: { connect: [{ id: "st1" }] } }
    );
    operation.planning();
    let thrown: unknown;
    try {
      operation.compile({
        "org.locate.rows": [{ id: "o1" }],
        "seat.transition.find.rows": [{ id: "incumbent" }],
        "seat.find.rows": [{ id: "st1" }],
      });
    } catch (error) {
      thrown = error;
    }
    // The batch twin above pins the whole failure object; this arm pins the constructor
    // and the complete message, so a prefix or suffix cannot slip past a substring match.
    expect({
      name: (thrown as Error).constructor.name,
      message: (thrown as Error).message,
    }).toEqual({
      name: "NestedWriteError",
      message:
        "Cannot update relation 'seats' with onUpdate('setNull') while the current relation is occupied.",
    });
  });
});

describe("parity D — the derived post-transition value equals the SQL operand", () => {
  test("an arithmetic key: the probe binds 10, the child binds 15, the SET stays relative", () => {
    const driver = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(compileTransitionSchema, driver),
      compileTransitionSchema.counter as Model<any>,
      {
        where: { id: 10 },
        data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
        select: { id: true },
      }
    );
    const planning = operation.planning();
    expect(
      (planning.steps as readonly StatementStep[]).map((step) => [
        step.id,
        driver._prepare(step.statement).params,
      ])
    ).toEqual([
      ["counter.locate", [10]],
      // OLD-READ: the located pre-value, never `before + 5`.
      ["tick.transition.find", [10, 1]],
    ]);
    expect(
      fragmentContract(
        driver,
        operation.compile({
          "counter.locate.rows": [{ id: 10 }],
          "tick.transition.find.rows": [],
        })
      )
    ).toEqual({
      steps: [
        {
          id: "counter.update",
          kind: "write",
          // The database does the arithmetic …
          sql: 'UPDATE "e67_counters" SET "id" = "id" + $1 WHERE "e67_counters"."id" = $2 RETURNING "id" AS "id"',
          params: [5, 10],
          outputs: {},
          expects: {
            kind: "affectedRows",
            expected: 1,
            failure: {
              kind: "notFound",
              message:
                "query-engine-v2 update located no 'counter' row for its unique where.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          // … and the compile derivation produced the same number in JS. A drift
          // between the two is a foreign-key violation, not a wrong row.
          id: "tick.create",
          kind: "write",
          sql: 'INSERT INTO "e67_ticks" ("id", "counterId") VALUES ($1, CAST($2 AS INTEGER))',
          params: ["tk1", 15],
          outputs: {},
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "counter.select",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "e67_counters" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
          params: [15],
          outputs: { result: { kind: "rows" } },
          expects: {
            kind: "exactlyOneRow",
            failure: {
              kind: "query",
              message:
                "query-engine-v2 update terminal read expected exactly one row.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: { result: reference("counter.select", "result") },
    });
  });
});

// ---------------------------------------------------------------------------
// regime "pastSurface" — what §D2 lifts
// ---------------------------------------------------------------------------

describe('parity D — regime "pastSurface"', () => {
  test("a compound referenced edge emits NO transition probe and folds create onto literals", () => {
    const driver = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(compileTransitionSchema, driver),
      compileTransitionSchema.zone as Model<any>,
      {
        where: { region_code: { region: "eu", code: "west" } },
        data: { code: "east", spots: { create: { id: "sp1", name: "n" } } },
        select: { code: true },
      }
    );
    const zoneNotFound = {
      kind: "notFound",
      message:
        "query-engine-v2 update located no 'zone' row for its unique where.",
      raceable: false,
    };
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "zone.locate",
          kind: "read",
          sql: 'SELECT "t0"."region" AS "region", "t0"."code" AS "code" FROM "e67_zones" AS "t0" WHERE ("t0"."region" = $1 AND "t0"."code" = $2) LIMIT 1 FOR UPDATE',
          params: ["eu", "west"],
          outputs: {
            rows: { kind: "rows" },
            region: { kind: "firstRowField", field: "region" },
            code: { kind: "firstRowField", field: "code" },
          },
          expects: { kind: "exactlyOneRow", failure: zoneNotFound },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "zone.locate.rows": reference("zone.locate", "rows"),
        "zone.locate.region": reference("zone.locate", "region"),
        "zone.locate.code": reference("zone.locate", "code"),
      },
    });
    expect(
      fragmentContract(
        driver,
        operation.compile({
          "zone.locate.rows": [{ region: "eu", code: "west" }],
        })
      )
    ).toEqual({
      steps: [
        {
          id: "zone.update",
          kind: "write",
          sql: 'UPDATE "e67_zones" SET "code" = $1 WHERE ("e67_zones"."region" = $2 AND "e67_zones"."code" = $3) RETURNING "region" AS "region", "code" AS "code"',
          params: ["east", "eu", "west"],
          outputs: {},
          expects: {
            kind: "affectedRows",
            expected: 1,
            failure: zoneNotFound,
          },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          // Per-member provenance, already: `region` comes back verbatim from the
          // `where` and `code` takes the root SET's value. Both are literals resolved
          // at construction — no located-row source is consulted.
          id: "spot.create",
          kind: "write",
          sql: 'INSERT INTO "e67_spots" ("id", "name", "zoneRegion", "zoneCode") VALUES ($1, $2, CAST($3 AS TEXT), CAST($4 AS TEXT))',
          params: ["sp1", "n", "eu", "east"],
          outputs: {},
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "zone.select",
          kind: "read",
          sql: 'SELECT "t0"."code" AS "code" FROM "e67_zones" AS "t0" WHERE ("t0"."region" = $1 AND "t0"."code" = $2) LIMIT 1',
          params: ["eu", "east"],
          outputs: { result: { kind: "rows" } },
          expects: {
            kind: "exactlyOneRow",
            failure: {
              kind: "query",
              message:
                "query-engine-v2 update terminal read expected exactly one row.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: { result: reference("zone.select", "result") },
    });
  });

  /** WHICH phase refuses is part of the pin: §D2 lifts these shapes, and a lift that
   *  moved the refusal later would still "throw the same message". */
  const refusal = (
    build: () => UpdateOperation,
    known: Record<string, unknown>
  ): { phase: string; name: string; message: string } => {
    const record = (phase: string, thrown: unknown) => ({
      phase,
      name: (thrown as Error).constructor.name,
      message: (thrown as Error).message,
    });
    let operation: UpdateOperation;
    try {
      operation = build();
    } catch (thrown) {
      return record("construct", thrown);
    }
    try {
      operation.planning();
    } catch (thrown) {
      return record("planning", thrown);
    }
    try {
      operation.compile(known);
    } catch (thrown) {
      return record("compile", thrown);
    }
    return { phase: "none", name: "", message: "" };
  };

  test.each([
    [
      "an unpinned pre-value (located by another unique)",
      () =>
        orgUpdate(
          new PGliteDriver(),
          { slug: "s1" },
          { id: "o2", seats: { connect: [{ id: "st1" }] } }
        ),
      {},
      "construct",
      "query-engine-v2 update does not support a nested 'connect' on the child-held relation 'seats' while the root update transitions a compound / non-PK / unpinned referenced column.",
    ],
    [
      "a compound edge under connect",
      () =>
        new UpdateOperation(
          engineFor(compileTransitionSchema, new PGliteDriver()),
          compileTransitionSchema.zone as Model<any>,
          {
            where: { region_code: { region: "eu", code: "west" } },
            data: { code: "east", spots: { connect: [{ id: "sp1" }] } },
            select: { code: true },
          }
        ),
      {},
      "construct",
      "query-engine-v2 update does not support a nested 'connect' on the child-held relation 'spots' while the root update transitions a compound / non-PK / unpinned referenced column.",
    ],
    [
      "a compound edge under update",
      () =>
        new UpdateOperation(
          engineFor(compileTransitionSchema, new PGliteDriver()),
          compileTransitionSchema.zone as Model<any>,
          {
            where: { region_code: { region: "eu", code: "west" } },
            data: {
              code: "east",
              spots: {
                update: [{ where: { id: "sp1" }, data: { name: "x" } }],
              },
            },
            select: { code: true },
          }
        ),
      {},
      "construct",
      "query-engine-v2 update does not support a nested 'update' on the child-held relation 'spots' while the root update transitions a compound / non-PK / unpinned referenced column.",
    ],
    [
      // The one shape that reaches `resolveLiteralCreateParent`'s operand refusal
      // through the public spelling: a nullable member of a non-primary-key
      // referenced unique, rewritten to `null`. It is the only member of this family
      // that waits for COMPILE, because the operand is paired with the located row.
      "a rewritten column with no construction value",
      () =>
        new UpdateOperation(
          engineFor(compileTransitionSchema, new PGliteDriver()),
          compileTransitionSchema.bay as Model<any>,
          {
            where: { id: "b1" },
            data: { slot: null, pads: { create: { id: "p1" } } },
            select: { id: true },
          }
        ),
      { "bay.locate.rows": [{ id: "b1", area: "eu", slot: "west" }] },
      "compile",
      // NON-DISCRIMINATING: this exact sentence is emitted at RecordUpdateCompiler.ts:1877
      // AND :1956, and a third site (:1670) differs only by the missing `-v2` prefix, so
      // the row cannot name the guard that answered. §O2's duplicate-cluster ledger owns
      // separating them; recorded here rather than worked around.
      "query-engine-v2 update nested create on relation 'pads' references a non-literal rewritten column 'slot'.",
    ],
  ])("%s refuses typed", (_label, build, known, phase, message) => {
    expect(refusal(build, known)).toEqual({
      phase,
      name: UnsupportedOperationError.name,
      message,
    });
  });
});

// ---------------------------------------------------------------------------
// regime "none" — the three shapes that must gain nothing
// ---------------------------------------------------------------------------

describe('parity D — regime "none" emits no transition probe', () => {
  const planningIds = (operation: UpdateOperation): string[] =>
    operation.planning().steps.map((step) => step.id);

  test("ON UPDATE CASCADE leaves the effect to the database and writes the child first", () => {
    const driver = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(cascadeSchema, driver),
      cascadeSchema.depot as Model<any>,
      {
        where: { id: "d1" },
        data: { id: "d2", bins: { connect: [{ id: "b1" }] } },
        select: { id: true },
      }
    );
    expect(planningIds(operation)).toEqual(["depot.locate", "bin.find"]);
    expect(
      fragmentContract(
        driver,
        operation.compile({
          "depot.locate.rows": [{ id: "d1" }],
          "bin.find.rows": [{ id: "b1" }],
        })
      )
    ).toEqual({
      steps: [
        {
          // The adopt binds the OLD value and runs BEFORE the root UPDATE
          // (`reorderRootUpdateAfterChildren`, :564): the declared cascade is what
          // carries `b1` to `d2`, so the engine must not do it a second time.
          id: "bin.connect",
          kind: "write",
          sql: 'UPDATE "parity_d_bins" SET "depotId" = CAST($1 AS TEXT) WHERE "parity_d_bins"."id" = $2 RETURNING "id" AS "id"',
          params: ["d1", "b1"],
          outputs: {},
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "depot.update",
          kind: "write",
          sql: 'UPDATE "parity_d_depots" SET "id" = $1 WHERE "parity_d_depots"."id" = $2 RETURNING "id" AS "id"',
          params: ["d2", "d1"],
          outputs: {},
          expects: {
            kind: "affectedRows",
            expected: 1,
            failure: {
              kind: "notFound",
              message:
                "query-engine-v2 update located no 'depot' row for its unique where.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "depot.select",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "parity_d_depots" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
          params: ["d2"],
          outputs: { result: { kind: "rows" } },
          expects: {
            kind: "exactlyOneRow",
            failure: {
              kind: "query",
              message:
                "query-engine-v2 update terminal read expected exactly one row.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: { result: reference("depot.select", "result") },
    });
  });

  test("a same-value SET is not a transition, and the child still leads", () => {
    const driver = new PGliteDriver();
    const operation = orgUpdate(
      driver,
      { id: "o1" },
      { id: "o1", seats: { connect: [{ id: "st1" }] } }
    );
    expect(planningIds(operation)).toEqual(["org.locate", "seat.find"]);
    expect(
      (
        operation.compile({
          "org.locate.rows": [{ id: "o1" }],
          "seat.find.rows": [{ id: "st1" }],
        }).steps as readonly StatementStep[]
      ).map((step) => [step.id, driver._prepare(step.statement).params])
    ).toEqual([
      ["seat.connect", ["o1", "st1"]],
      ["org.update", ["o1", "o1"]],
      ["org.select", ["o1"]],
    ]);
  });

  test("a SET that touches no referenced column keeps the root-first order", () => {
    const driver = new PGliteDriver();
    const operation = orgUpdate(
      driver,
      { id: "o1" },
      { slug: "s9", seats: { connect: [{ id: "st1" }] } }
    );
    expect(planningIds(operation)).toEqual(["org.locate", "seat.find"]);
    expect(
      (
        operation.compile({
          "org.locate.rows": [{ id: "o1" }],
          "seat.find.rows": [{ id: "st1" }],
        }).steps as readonly StatementStep[]
      ).map((step) => [step.id, driver._prepare(step.statement).params])
    ).toEqual([
      ["org.update", ["s9", "o1"]],
      ["seat.connect", ["o1", "st1"]],
      ["org.select", ["o1"]],
    ]);
  });
});

// ---------------------------------------------------------------------------
// regime "guarded" — every OTHER nested kind consumes the same OLD/NEW split
// ---------------------------------------------------------------------------

/** Under `guarded` every nested kind proceeds; the `pastSurface` refusal is the only one
 *  that stops a kind. All of them spend `interpretReferencedKeyTransition`'s single
 *  `adopt = { parentId: literalParentId(after), membershipReadSource: input.parentIdSource }`
 *  (:2360-2367), so each is a separate chance for D1 to bind the post-transition value to
 *  a membership READ. The split is asserted per kind: which parameter is "o1" and which
 *  is "o2", and on which side of the root UPDATE the child write lands. */
for (const substrate of [
  { name: "transaction", batch: false, createDriver: () => new PGliteDriver() },
  {
    name: "atomic batch",
    batch: true,
    createDriver: () => new BatchOnlyPGliteDriver(),
  },
]) {
  const lock = substrate.batch ? "" : " FOR UPDATE";

  const orgLocate = {
    id: "org.locate",
    kind: "read",
    sql: `SELECT "t0"."id" AS "id" FROM "e67_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
    params: ["o1"],
    outputs: {
      rows: { kind: "rows" },
      id: { kind: "firstRowField", field: "id" },
    },
    expects: { kind: "exactlyOneRow", failure: orgNotFound },
    racePin: null,
    onUniqueConflict: null,
  };

  const transitionProbe = {
    id: "seat.transition.find",
    kind: "read",
    sql: `SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."orgId" = $1 ORDER BY "t0"."id" ASC LIMIT $2${lock}`,
    params: ["o1", 1],
    outputs: { rows: { kind: "rows" } },
    expects: null,
    racePin: null,
    onUniqueConflict: null,
  };

  const ORG_GUARD = {
    id: "org.guard.exists",
    premise: {
      kind: "exists",
      sql: 'SELECT "t0"."id" AS "id" FROM "e67_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
      params: ["o1"],
    },
    failure: orgNotFound,
  };

  const OCCUPIED_GUARD = {
    id: "seat.guard.occupied",
    premise: {
      kind: "notExists",
      sql: 'SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."orgId" = $1 ORDER BY "t0"."id" ASC LIMIT $2',
      params: ["o1", 1],
    },
    failure: {
      kind: "nestedWrite",
      message:
        "Cannot update relation 'seats' with onUpdate('setNull') while the current relation is occupied.",
      relation: "seats",
      raceable: true,
    },
  };

  const orgUpdateStep = {
    id: "org.update",
    kind: "write",
    sql: 'UPDATE "e67_orgs" SET "id" = $1 WHERE "e67_orgs"."id" = $2 RETURNING "id" AS "id"',
    params: ["o2", "o1"],
    outputs: {},
    expects: substrate.batch
      ? null
      : { kind: "affectedRows", expected: 1, failure: orgNotFound },
    racePin: null,
    onUniqueConflict: null,
  };

  const orgTerminal = {
    id: "org.select",
    kind: "read",
    sql: 'SELECT "t0"."id" AS "id" FROM "e67_orgs" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
    params: ["o2"],
    outputs: { result: { kind: "rows" } },
    expects: substrate.batch
      ? null
      : { kind: "exactlyOneRow", failure: orgTerminalFailure },
    racePin: null,
    onUniqueConflict: null,
  };

  const emptyOldSlot = {
    "org.locate.rows": [{ id: "o1" }],
    "seat.transition.find.rows": [],
    "seat.find.rows": [{ id: "st1" }],
  };

  const planningOutputs = {
    "org.locate.rows": reference("org.locate", "rows"),
    "org.locate.id": reference("org.locate", "id"),
    "seat.transition.find.rows": reference("seat.transition.find", "rows"),
    "seat.find.rows": reference("seat.find", "rows"),
  };

  describe(`parity D — regime "guarded", the other nested kinds (${substrate.name})`, () => {
    test("set: the departing half binds OLD, the arriving half binds NEW", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(
        driver,
        { id: "o1" },
        { id: "o2", seats: { set: [{ id: "st1" }] } }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          orgLocate,
          transitionProbe,
          {
            // `set` locates globally, so this probe carries no membership conjunct.
            id: "seat.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${lock}`,
            params: ["st1"],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: planningOutputs,
      });
      expect(fragmentContract(driver, operation.compile(emptyOldSlot))).toEqual(
        {
          steps: [
            ...(substrate.batch
              ? [
                  ORG_GUARD,
                  OCCUPIED_GUARD,
                  {
                    id: "seat.guard.exists",
                    premise: {
                      kind: "exists",
                      sql: 'SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                      params: ["st1", "st1", 1],
                    },
                    failure: {
                      kind: "nestedWrite",
                      message:
                        "Cannot set relation 'seats': target record was not found.",
                      relation: "seats",
                      raceable: false,
                    },
                  },
                ]
              : []),
            orgUpdateStep,
            {
              // OLD: the orphan clears rows that still carry the vacated key.
              id: "seat.orphan",
              kind: "write",
              sql: 'UPDATE "e67_seats" SET "orgId" = NULL WHERE ("e67_seats"."orgId" = $1 AND NOT ("e67_seats"."id" = $2))',
              params: ["o1", "st1"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            {
              // NEW: the adopt writes the post-transition key.
              id: "seat.set",
              kind: "write",
              sql: 'UPDATE "e67_seats" SET "orgId" = CAST($1 AS TEXT) WHERE "e67_seats"."id" IN ($2)',
              params: ["o2", "st1"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            orgTerminal,
          ],
          outputs: { result: reference("org.select", "result") },
        }
      );
    });

    test("disconnect: the membership probe and premise read OLD, and the child leads", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(
        driver,
        { id: "o1" },
        { id: "o2", seats: { disconnect: [{ id: "st1" }] } }
      );
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          orgLocate,
          transitionProbe,
          {
            id: "seat.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."orgId" = $2) ORDER BY "t0"."id" ASC LIMIT $3${lock}`,
            // The membership value is the located row's PRE-transition key.
            params: ["st1", reference("org.locate", "id"), 1],
            outputs: { rows: { kind: "rows" } },
            expects: null,
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: planningOutputs,
      });
      expect(fragmentContract(driver, operation.compile(emptyOldSlot))).toEqual(
        {
          steps: [
            ...(substrate.batch
              ? [
                  ORG_GUARD,
                  OCCUPIED_GUARD,
                  {
                    id: "seat.guard.exists",
                    premise: {
                      kind: "exists",
                      sql: 'SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."orgId" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
                      params: ["st1", "o1", 1],
                    },
                    failure: {
                      kind: "nestedWrite",
                      message:
                        "Cannot disconnect relation 'seats': target record was not found for this parent.",
                      relation: "seats",
                      raceable: false,
                    },
                  },
                ]
              : []),
            {
              // No adopt to order after the root UPDATE, so the child leads.
              id: "seat.disconnect",
              kind: "write",
              sql: 'UPDATE "e67_seats" SET "orgId" = NULL WHERE "e67_seats"."id" = $1 RETURNING "id" AS "id"',
              params: ["st1"],
              outputs: {},
              expects: null,
              racePin: null,
              onUniqueConflict: null,
            },
            orgUpdateStep,
            orgTerminal,
          ],
          outputs: { result: reference("org.select", "result") },
        }
      );
    });

    test("update: the correlated probe reads OLD while the root moves to NEW", () => {
      const driver = substrate.createDriver();
      const operation = orgUpdate(
        driver,
        { id: "o1" },
        {
          id: "o2",
          seats: { update: [{ where: { id: "st1" }, data: { name: "n" } }] },
        }
      );
      const targetMissing = {
        kind: "nestedWrite",
        message:
          "Cannot update relation 'seats': target record was not found for this parent.",
        relation: "seats",
        raceable: false,
      };
      expect(fragmentContract(driver, operation.planning())).toEqual({
        steps: [
          orgLocate,
          transitionProbe,
          {
            id: "seat.find",
            kind: "read",
            sql: `SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."orgId" = $2) ORDER BY "t0"."id" ASC LIMIT $3${lock}`,
            params: ["st1", reference("org.locate", "id"), 1],
            outputs: {
              rows: { kind: "rows" },
              id: { kind: "firstRowField", field: "id" },
            },
            expects: { kind: "exactlyOneRow", failure: targetMissing },
            racePin: null,
            onUniqueConflict: null,
          },
        ],
        outputs: {
          ...planningOutputs,
          "seat.find.id": reference("seat.find", "id"),
        },
      });
      expect(fragmentContract(driver, operation.compile(emptyOldSlot))).toEqual(
        {
          steps: [
            ...(substrate.batch
              ? [
                  ORG_GUARD,
                  OCCUPIED_GUARD,
                  {
                    id: "seat.guard.exists",
                    premise: {
                      kind: "exists",
                      sql: 'SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."orgId" = $2 AND "t0"."id" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
                      params: ["st1", "o1", "st1", 1],
                    },
                    failure: targetMissing,
                  },
                ]
              : []),
            {
              id: "seat.update",
              kind: "write",
              sql: 'UPDATE "e67_seats" SET "name" = $1 WHERE "e67_seats"."id" = $2 RETURNING "id" AS "id"',
              params: ["n", "st1"],
              outputs: {},
              expects: substrate.batch
                ? null
                : {
                    kind: "affectedRows",
                    expected: 1,
                    failure: {
                      kind: "notFound",
                      message:
                        "query-engine-v2 update located no 'seat' row for its unique where.",
                      raceable: false,
                    },
                  },
              racePin: null,
              onUniqueConflict: null,
            },
            orgUpdateStep,
            orgTerminal,
          ],
          outputs: { result: reference("org.select", "result") },
        }
      );
    });
  });
}

// ---------------------------------------------------------------------------
// TWO transitioned child-held edges under one root: the order §D3 preserves
// ---------------------------------------------------------------------------

/** `interpretReferencedKeyTransition` runs once per relation and pushes its occupied
 *  guard onto a list `compileRelationKeyGuards` compiles as a group. With one relation
 *  there is no order to preserve; with two there is, in three places at once. */
const twinTransitionSchema = (() => {
  const hub = s
    .model({
      id: s.string().id(),
      seats: s.oneToMany(() => seat),
      ticks: s.oneToMany(() => tick),
    })
    .map("parity_d_hubs");
  const seat = s
    .model({
      id: s.string().id(),
      hubId: s.string().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("parity_d_seats");
  const tick = s
    .model({
      id: s.string().id(),
      hubId: s.string().nullable(),
      hub: s
        .manyToOne(() => hub)
        .fields("hubId")
        .references("id")
        .optional()
        .onUpdate("setNull"),
    })
    .map("parity_d_ticks");
  return { hub, seat, tick };
})();

hydrateSchemaNames(twinTransitionSchema);

describe("parity D — two transitioned edges keep one order in three places", () => {
  const twinUpdate = (driver: PGliteDriver): UpdateOperation =>
    new UpdateOperation(
      engineFor(twinTransitionSchema, driver),
      twinTransitionSchema.hub as Model<any>,
      {
        where: { id: "h1" },
        data: {
          id: "h2",
          seats: { connect: [{ id: "s1" }] },
          ticks: { connect: [{ id: "t1" }] },
        },
        select: { id: true },
      }
    );

  const KNOWN = {
    "hub.locate.rows": [{ id: "h1" }],
    "seat.transition.find.rows": [],
    "tick.transition.find.rows": [],
    "seat.find.rows": [{ id: "s1" }],
    "tick.find.rows": [{ id: "t1" }],
  };

  test("planning interleaves neither: both transition probes lead, in schema order", () => {
    const driver = new PGliteDriver();
    expect(
      twinUpdate(driver)
        .planning()
        .steps.map((step) => step.id)
    ).toEqual([
      "hub.locate",
      "seat.transition.find",
      "tick.transition.find",
      "seat.find",
      "tick.find",
    ]);
  });

  test("the batch guard list groups both occupied premises ahead of both existence premises", () => {
    const driver = new BatchOnlyPGliteDriver();
    const operation = twinUpdate(driver);
    operation.planning();
    expect(
      operation.compile(KNOWN).steps.map((step) => [step.id, step.kind])
    ).toEqual([
      ["hub.guard.exists", "guard"],
      ["seat.guard.occupied", "guard"],
      ["tick.guard.occupied", "guard"],
      ["seat.guard.exists", "guard"],
      ["tick.guard.exists", "guard"],
      ["hub.update", "write"],
      ["seat.connect", "write"],
      ["tick.connect", "write"],
      ["hub.select", "read"],
    ]);
    expect(
      (operation.compile(KNOWN).steps as readonly OperationStep[]).map(
        (step) =>
          step.kind === "guard"
            ? driver._prepare(step.premise.statement).params
            : driver._prepare(step.statement).params
      )
    ).toEqual([
      ["h1"],
      // Both occupied premises read the OLD key …
      ["h1", 1],
      ["h1", 1],
      ["s1"],
      ["t1"],
      ["h2", "h1"],
      // … and both adopts write the NEW one.
      ["h2", "s1"],
      ["h2", "t1"],
      ["h2"],
    ]);
  });
});
