import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";
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
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PARITY WITNESS — Package D (§6 D, "Unify old-read and new-write transition provenance").
 *
 * D1 makes transition legality and occupied-slot construction consume one correlated
 * binding; D2 lifts the non-cascading deeper edges the `pastSurface` regime refused;
 * D3 rebuilds occupied-slot predicates from that binding and requires "conjunct and
 * parameter order" to be preserved. All three edit
 * `RecordUpdateCompiler.interpretReferencedKeyTransition` and its `pushOccupiedGuard`,
 * so this witness pins what those two produce, in the shapes the
 * `compiled-key-transition` family already owns (its schema is imported rather than
 * re-declared, so the boundary pinned here is that family's own).
 *
 * AFTER PACKAGE D this file carries both pictures. The pre-D regimes and their
 * statements are pinned unchanged (that is the "preserve conjunct and parameter order"
 * gate, measured rather than asserted); the block that used to pin `pastSurface`
 * refusals now pins the shapes that replaced them, with the deleted messages quoted in
 * place so the before-picture stays readable.
 *
 * PRIOR ART, and what is actually new. `record-compiler-contract.test.ts` already pins
 * the guarded regime's transition probe byte-for-byte on a transaction driver — its
 * OLD-value SQL and parameters, the planning output map, the final step id order and the
 * root UPDATE — with `create` where the first test below writes `connect`. The additive
 * material here is: the ATOMIC-BATCH arm (the `seat.guard.occupied` notExists premise,
 * which is the only compile-side carrier of the old value), the `none` regime, the
 * shapes D2 lifted, every guarded nested kind other than the adopt pair, the polymorphic
 * topology, and the two-relation ordering at the end.
 *
 * TWO regimes survive Package D, and both are pinned:
 *   · `"guarded"` — a real non-cascade transition. Two facts D must keep: the occupied
 *     probe reads the OLD value, the adopt write binds the NEW one, and the adopt is
 *     ORDERED AFTER the root UPDATE (§D2's "membership reads use old values and
 *     adoption writes use new values", verbatim). Its pinned single-member shape keeps
 *     construction-time literals; its compound and unpinned shapes — what `pastSurface`
 *     used to refuse — read the located row instead, and are pinned in the block below.
 *   · `"none"` — `ON UPDATE CASCADE`, no referenced column written, or a no-op
 *     transition the locator pins both ends of. §D's keep gate says "no extra planning
 *     read when the existing target projection already captured the field": these three
 *     emit NO transition probe at all, which is the strongest form of that claim.
 *
 * `"pastSurface"` is GONE (D2). Its refusals are quoted at the block that replaced them.
 *
 * WHAT DID NOT ONLY GET WIDER, carried here because this is the file a reader opens to
 * learn what Package D moved:
 *   · THE NO-OP RESIDUE. `none`'s third branch — a same-value write of a referenced
 *     column — is decidable only where `before` is a construction literal, which needs
 *     BOTH a single-member reference and a locator that pins it. A compound reference
 *     has no construction-time post-value even when the locator pins every member, so
 *     it takes `guarded` and the occupied guard governs it. Recorded at the regime's
 *     own doc comment and in `forbidden-shapes-reference.md`.
 *   · A NEW REFUSAL. `pastSurface` returned BEFORE the occupied guard was emitted, and
 *     its caller let nested `create` / `createMany` through untouched — so a compound /
 *     non-PK / unpinned reference carrying create-only relations used to compile with
 *     no probe and no guard, and SUCCEEDED over an occupied slot (every edge in
 *     `compileTransitionSchema` is `onUpdate("setNull")`: the database nulls the
 *     occupant rather than refusing). It is now refused, exactly as the PINNED twin of
 *     the same payload always was. Behavior on every driver leg in
 *     `compiled-key-transition-behavior.ts`; §3.1 deviation in the ledger.
 *   · A NULL MEMBER of the old reference tuple addresses no row (MATCH SIMPLE), so the
 *     guard does not fire for it — decided once for both substrates, because the
 *     planning probe binds a null pre-value as a parameter and the batch premise
 *     resolves it to a literal `IS NULL`. Behavior, both substrates, same file.
 *
 * DIMENSIONS PINNED (plan §6 A2's nine):
 *   · planning IDs and order — the transition probe is FIRST, ahead of every other
 *     relation read, and is ABSENT in all three `none` shapes;
 *   · planning SQL and parameters — including the probe's `ORDER BY … LIMIT $n` tail and
 *     the substrate's `FOR UPDATE`, which is what §D3's "preserve conjunct and parameter
 *     order" is measured against;
 *   · planning outputs — the probe publishes `rows` only, never an identity;
 *   · final IDs and order — the reorder decision (`reorderRootUpdateAfterChildren`,
 *     differs across the regimes and each side is pinned;
 *   · final SQL and parameters — the OLD/NEW value split, and the arithmetic case where
 *     the root SET is `"id" = "id" + $1` in SQL while the child binds the JS-derived 15;
 *   · guards and expects — the batch occupied guard's `notExists` premise and failure;
 *   · race pins — none survive on these shapes, pinned as `null`;
 *   · exact errors — the compile-time occupied `NestedWriteError` and the
 *     non-literal-operand refusal;
 *   · statement counts — the step list IS the statement count; the refusal compiles
 *     nothing at all.
 *
 * FALSIFIED 2026-08-09 against `src/query-engine/write-engine/RecordUpdateCompiler.ts`:
 * feeding `pushOccupiedGuard` the post-transition value — i.e. inferring the old value
 * from the new one, the very inference §D1 says to delete — turned four assertions red
 * and left ten green. Red: both guarded PLANNING assertions (the probe bound "o2"
 * instead of "o1"), the batch guarded COMPILE (the occupied premise bound "o2"), and the
 * arithmetic shape (the probe bound 15 instead of 10). Green and correctly so: the
 * TRANSACTION guarded compile, whose occupied verdict is a planning-time read rather
 * than a step, plus every `pastSurface` and `none` assertion. The original was restored
 * from a scratchpad copy taken before the edit.
 *
 * FALSIFIED THREE WAYS 2026-08-10, after D1/D2/D3, each against a different claim.
 * The originals were restored from scratchpad copies taken before each edit.
 *
 *  (a) OLD READ FROM THE NEW VALUE — `pushOccupiedGuard`'s read sources built from
 *      `write` instead of from the locator/located row. 17 red, 9 green, and in TWO
 *      failure modes worth telling apart: where the locator pins the reference, `write`
 *      is a literal and the probe silently binds the post-transition value; where it
 *      does not, `write` is a `transitionedPlanningField` and `planningSourceFromFinal`
 *      refuses it at construction — the module's own type boundary rejecting a
 *      planning read of a value that does not exist yet. Green and correctly so: the
 *      three `none` shapes (no probe to mis-bind), the transaction-mode occupied
 *      verdict (a planning read, see the caveat below), and all three polymorphic
 *      assertions (no guard at all on that topology).
 *  (b) NEW WRITE FROM THE OLD VALUE — `postTransitionReference` returning `before`
 *      unchanged in the `membership` position, i.e. adopting onto the key the root is
 *      vacating. 4 red across two files and both substrates: the two lifted structural
 *      shapes here, and `nested-update-pk-transition-cascade`'s D2 arm on tx and batch.
 *      The lift witnesses whose deeper edge is a `create` stay green, correctly — a
 *      create leaf resolves through the `nested create` position, which this mutation
 *      leaves alone.
 *  (c) THE GUARD COLLAPSED TO ONE MEMBER — `where: filters[0]` instead of the whole
 *      conjunct list. 2 red, both compound: the planning probe and the batch premise.
 *      Everything single-member stays green, which is the same statement as "a
 *      one-member edge is byte-identical to what it was before D3".
 *
 * CAVEAT on that falsification. The transaction-mode occupied verdict stays green because
 * these tests FEED synthetic `seat.transition.find.rows`. On that substrate the old/new
 * distinction rests entirely on the ONE planning assertion (probe params `["o1", 1]`); the
 * compile-side old-value claim is carried by the atomic-batch guard alone. If D moves the
 * occupied verdict from planning to compile on the transaction substrate, only the batch
 * leg can catch a new-value binding.
 *
 * THE TWO TOPOLOGIES PACKAGE A RECORDED AS D'S UNPINNED HOLE, both closed:
 *   · JUNCTION — a junction writing join rows with the NEW parent key while its
 *     membership probes read the OLD one. `compileTransitionSchema` has no many-to-many
 *     member, so it is pinned where the topology already lives:
 *     `pk-transition-junction-mixed-edge.test.ts`, behaviorally and on both substrates,
 *     including the non-PK locator D2 lifted.
 *   · POLYMORPHIC — pinned STRUCTURALLY at the bottom of this file, which is what was
 *     missing: `polymorphic-write-family.test.ts` already measured the behaviour (the
 *     old member keeps the vacated id, the adopt and the create take the new one), but
 *     no test named the SQL, the parameters, or the step order that produce it.
 */

hydrateSchemaNames(compileTransitionSchema);

/** The one shape `compiled-key-transition` has no member of: an `ON UPDATE CASCADE`
 *  edge, whose referenced column the root rewrites. It is the `none` regime's first
 *  branch and the one §D2 leaves to the database. */
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

/** The polymorphic inverse topology, whose referenced identity the root rewrites.
 *  `PolymorphicChildHeldRelation.onUpdate` is hard-coded `undefined` — there is no
 *  polymorphic foreign key for a referential action to hang on — so the database can
 *  never carry this transition and the engine owns every value in it. */
const polymorphicSchema = (() => {
  const post = s
    .model({
      id: s.int().id(),
      slug: s.string().unique(),
      comments: s.oneToMany(() => comment).name("commentable"),
    })
    .map("parity_d_posts");
  const comment = s
    .model({
      id: s.int().id(),
      body: s.string(),
      commentable: s
        .polymorphic({ post: () => post }, { values: { post: "parity.d.v1" } })
        .name("commentable")
        .optional(),
    })
    .map("parity_d_comments");
  return { post, comment };
})();

hydrateSchemaNames(polymorphicSchema);
validateSchemaOrThrow(polymorphicSchema);

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
    outputs: normalized(publishedOutputs(fragment)),
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
// LIFTED BY D2 — what the "pastSurface" regime used to refuse
//
// The three refusals this block carried before Package D are gone; the payloads
// compile. What replaces them below is the AFTER-picture in the same nine dimensions,
// because a lift is only pinned when the accepted shape is pinned, not when the
// refusal merely stops firing. The before-picture, verbatim from the deleted
// assertions (all `UnsupportedOperationError`, all at CONSTRUCTION, all with zero
// statements):
//
//   query-engine-v2 update does not support a nested 'connect' on the child-held
//   relation 'seats' while the root update transitions a compound / non-PK / unpinned
//   referenced column.
//
//   (the same sentence with 'connect' on 'spots', and with 'update' on 'spots')
//
// and one arm-side refusal, from `assertPinnedTransitionIsCompilable`, deleted with
// them (pinned before Package D at nested-arm-dispatch.test.ts):
//
//   query-engine-v2 update for relation 'teams' transitions the target primary key
//   'id' while writing a deeper edge whose foreign key does not cascade on update; it
//   must locate the target by that primary key.
//
// One SHAPE change beside the lift, deliberate and pinned in the first test: a
// transition past the pinned single-member surface now emits the occupied guard too.
// The guard is kind-blind and relation-level, so unifying the pinned and unpinned
// spellings could not leave it behind. What that costs is a NEW REFUSAL, not a
// better diagnostic: before D this family reached a nested `create` with no guard and
// no probe at all, and every edge in `compileTransitionSchema` is `onUpdate("setNull")`
// — a SET NULL foreign key does not fail, it quietly nulls the occupant — so the
// pre-D outcome for an occupied slot was a silent orphan, and the payload SUCCEEDED.
// It is now refused with the typed occupied message, which is what the PINNED twin of
// the same payload always did. Measured as behavior, on every driver leg, in
// `compiled-key-transition-behavior.ts` ("an OCCUPIED old slot refuses the same nested
// create the empty slot accepts"); recorded as a §3.1 deviation in
// `docs/architecture/forbidden-shapes-reference.md`.
// ---------------------------------------------------------------------------

describe("parity D — the shapes D2 lifted", () => {
  test("a compound referenced edge guards the OLD tuple and folds create onto literals", () => {
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
        {
          // D3 — the occupied probe's conjuncts are lowered from the COMPLETE
          // correlated binding, so a compound edge names BOTH stored-reference
          // members in schema order against BOTH pinned pre-values. A single-member
          // edge collapses to the same one-conjunct `where` and single parameter it
          // had before (the guarded describes above still pin that byte for byte).
          id: "spot.transition.find",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "e67_spots" AS "t0" WHERE ("t0"."zoneRegion" = $1 AND "t0"."zoneCode" = $2) ORDER BY "t0"."id" ASC LIMIT $3 FOR UPDATE',
          params: ["eu", "west", 1],
          outputs: { rows: { kind: "rows" } },
          expects: null,
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "zone.locate.rows": reference("zone.locate", "rows"),
        "zone.locate.region": reference("zone.locate", "region"),
        "zone.locate.code": reference("zone.locate", "code"),
        "spot.transition.find.rows": reference("spot.transition.find", "rows"),
      },
    });
    expect(
      fragmentContract(
        driver,
        operation.compile({
          "zone.locate.rows": [{ region: "eu", code: "west" }],
          "spot.transition.find.rows": [],
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
          // Per-member provenance: `region` comes back verbatim and `code` takes the
          // root SET's value. Both are resolved at COMPILE against the LOCATED ROW,
          // not at construction — a compound reference routes through
          // `resolveCreateParent` → `transitionedCreateParent` → `postTransitionReference`,
          // whose source reads `zone.locate.rows`. That is why the locate publishes
          // `region` and `code` as `firstRowField` outputs above, and why the "eu"
          // below is the row's value rather than the `where`'s: delete the publication
          // and this parameter goes undefined.
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
      // The one shape whose operand still has NO derivable post-transition value:
      // a nullable member of a non-primary-key referenced unique, rewritten to
      // `null`. It waits for COMPILE because the operand is paired with the located
      // row. D2 lifted the surface, not this: `null` references no row, so there is
      // nothing for the fresh child's foreign key to name.
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
      {
        "bay.locate.rows": [{ id: "b1", area: "eu", slot: "west" }],
        "pad.transition.find.rows": [],
      },
      "compile",
      // NON-DISCRIMINATING no longer — but NOT because the sentence has one emitter.
      // CORRECTED BY PACKAGE O (the previous text claimed "ONE emitter" and was false
      // at its own HEAD). This sentence has TWO emitters and they are two different
      // decisions:
      //   · `RecordUpdateCompiler.postTransitionReference` (:1800), the per-member
      //     derivation, whose `position` argument is the only thing that varies
      //     ("nested create" here, "membership" on the adopt path). It refuses on
      //     `literal === null || isSql(literal)`.
      //   · `RecordUpdateCompiler.resolveCreateParent` (:2017), the arity-1
      //     NON-primary-key branch, which spells "nested create" literally and refuses
      //     the strictly WIDER `!isConstructionLiteral(literal)` — also an arithmetic
      //     envelope and a batch-value `Ref` — and whose accepted arm returns
      //     `afterRoot: false` where this one's returns `afterRoot: true`.
      // THIS payload reaches the first: `(area, slot)` is a COMPOUND reference, so the
      // arity-1 branch is never entered. Package O measured the pair and KEPT both
      // (guard-ownership-ledger.md, disagreement 1); collapsing them would accept
      // operands that are refused today. The three near-duplicate spellings D1
      // replaced — including one that differed only by a missing `-v2` prefix — are
      // still gone.
      "query-engine-v2 update nested create on relation 'pads' references a non-literal rewritten column 'slot'.",
    ],
  ])("%s refuses typed", (_label, build, known, phase, message) => {
    expect(refusal(build, known)).toEqual({
      phase,
      name: UnsupportedOperationError.name,
      message,
    });
  });

  /**
   * D2's lift, in the two shapes the deleted refusals named, on both substrates.
   * The claim under test is §D2's own sentence — "all membership reads use OLD values
   * and all adoption writes use NEW values" — now that neither value is a construction
   * literal of the same kind:
   *
   *   · UNPINNED single member: the occupied probe binds `Ref(org.locate.id)`, i.e. the
   *     row the locate ACTED ON, never the `where` re-consulted (the wrong-row
   *     doctrine); the adopt binds the derived `o2`.
   *   · COMPOUND: the occupied probe binds BOTH members; the adopt binds the whole
   *     post-transition TUPLE — `region` verbatim because the SET leaves it alone,
   *     `code` transitioned — which is per-member provenance with no second source.
   *
   * In both, the adopt UPDATE is ordered AFTER the root UPDATE, because a NO-ACTION
   * foreign key cannot point at a key the root has not written yet.
   */
  const seatConnect = (driver: PGliteDriver) =>
    orgUpdate(
      driver,
      { slug: "s1" },
      { id: "o2", seats: { connect: [{ id: "st1" }] } }
    );

  const zoneConnect = (driver: PGliteDriver) =>
    new UpdateOperation(
      engineFor(compileTransitionSchema, driver),
      compileTransitionSchema.zone as Model<any>,
      {
        where: { region_code: { region: "eu", code: "west" } },
        data: { code: "east", spots: { connect: [{ id: "sp1" }] } },
        select: { code: true },
      }
    );

  test("an UNPINNED pre-value: the probe binds the located row, the adopt binds the derived key", () => {
    const driver = new PGliteDriver();
    const operation = seatConnect(driver);
    expect(operation.planning().steps.map((step) => step.id)).toEqual([
      "org.locate",
      "seat.transition.find",
      "seat.find",
    ]);
    const planning = fragmentContract(driver, operation.planning()) as any;
    expect(planning.steps[1]).toEqual({
      id: "seat.transition.find",
      kind: "read",
      sql: 'SELECT "t0"."id" AS "id" FROM "e67_seats" AS "t0" WHERE "t0"."orgId" = $1 ORDER BY "t0"."id" ASC LIMIT $2 FOR UPDATE',
      // THE lift: a pre-transition value with no `where` literal behind it, read from
      // the located row by reference. Before D2 this payload never reached planning.
      params: [reference("org.locate", "id"), 1],
      outputs: { rows: { kind: "rows" } },
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    const compiled = fragmentContract(
      driver,
      operation.compile({
        "org.locate.rows": [{ id: "o1", slug: "s1" }],
        "seat.transition.find.rows": [],
        "seat.find.rows": [{ id: "st1" }],
      })
    ) as any;
    expect(compiled.steps.map((step: any) => step.id)).toEqual([
      "org.update",
      "seat.connect",
      "org.select",
    ]);
    expect(compiled.steps[1]).toEqual({
      id: "seat.connect",
      kind: "write",
      sql: 'UPDATE "e67_seats" SET "orgId" = CAST($1 AS TEXT) WHERE "e67_seats"."id" = $2 RETURNING "id" AS "id"',
      params: ["o2", "st1"],
      outputs: {},
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
  });

  test("a COMPOUND edge: the probe binds both members, the adopt binds the whole tuple", () => {
    const driver = new PGliteDriver();
    const operation = zoneConnect(driver);
    const compiled = fragmentContract(
      driver,
      operation.compile({
        "zone.locate.rows": [{ region: "eu", code: "west" }],
        "spot.transition.find.rows": [],
        "spot.find.rows": [{ id: "sp1" }],
      })
    ) as any;
    expect(compiled.steps.map((step: any) => step.id)).toEqual([
      "zone.update",
      "spot.connect",
      "zone.select",
    ]);
    expect(compiled.steps[1]).toEqual({
      id: "spot.connect",
      kind: "write",
      sql: 'UPDATE "e67_spots" SET "zoneRegion" = CAST($1 AS TEXT), "zoneCode" = CAST($2 AS TEXT) WHERE "e67_spots"."id" = $3 RETURNING "id" AS "id"',
      // Per member: `region` is not in the SET so it comes back verbatim; `code` is,
      // so it is derived. One source, two answers.
      params: ["eu", "east", "sp1"],
      outputs: {},
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
  });

  test("a COMPOUND edge under update: the correlated probe reads OLD while the root moves to NEW", () => {
    const driver = new PGliteDriver();
    const operation = new UpdateOperation(
      engineFor(compileTransitionSchema, driver),
      compileTransitionSchema.zone as Model<any>,
      {
        where: { region_code: { region: "eu", code: "west" } },
        data: {
          code: "east",
          spots: { update: [{ where: { id: "sp1" }, data: { name: "x" } }] },
        },
        select: { code: true },
      }
    );
    const planning = fragmentContract(driver, operation.planning()) as any;
    expect(planning.steps.map((step: any) => step.id)).toEqual([
      "zone.locate",
      "spot.transition.find",
      "spot.find",
    ]);
    expect(planning.steps[2].sql).toBe(
      'SELECT "t0"."id" AS "id" FROM "e67_spots" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."zoneRegion" = $2 AND "t0"."zoneCode" = $3) ORDER BY "t0"."id" ASC LIMIT $4 FOR UPDATE'
    );
    expect(planning.steps[2].params).toEqual([
      "sp1",
      reference("zone.locate", "region"),
      reference("zone.locate", "code"),
      1,
    ]);
    const compiled = fragmentContract(
      driver,
      operation.compile({
        "zone.locate.rows": [{ region: "eu", code: "west" }],
        "spot.transition.find.rows": [],
        "spot.find.rows": [{ id: "sp1" }],
      })
    ) as any;
    // The child write leads: correlation is on the value the row still holds, and the
    // root UPDATE that vacates it is reordered behind it.
    expect(compiled.steps.map((step: any) => step.id)).toEqual([
      "spot.update",
      "zone.update",
      "zone.select",
    ]);
  });

  test("atomic batch: the compound occupied premise binds the OLD tuple ahead of every write", () => {
    const driver = new BatchOnlyPGliteDriver();
    const operation = zoneConnect(driver as unknown as PGliteDriver);
    const compiled = fragmentContract(
      driver as unknown as PGliteDriver,
      operation.compile({
        "zone.locate.rows": [{ region: "eu", code: "west" }],
        "spot.transition.find.rows": [],
        "spot.find.rows": [{ id: "sp1" }],
      })
    ) as any;
    expect(compiled.steps.map((step: any) => step.id)).toEqual([
      "zone.guard.exists",
      "spot.guard.occupied",
      "spot.guard.exists",
      "zone.update",
      "spot.connect",
      "zone.select",
    ]);
    expect(compiled.steps[1]).toEqual({
      id: "spot.guard.occupied",
      premise: {
        kind: "notExists",
        sql: 'SELECT "t0"."id" AS "id" FROM "e67_spots" AS "t0" WHERE ("t0"."zoneRegion" = $1 AND "t0"."zoneCode" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
        params: ["eu", "west", 1],
      },
      failure: {
        kind: "nestedWrite",
        message:
          "Cannot update relation 'spots' with onUpdate('setNull') while the current relation is occupied.",
        relation: "spots",
        raceable: true,
      },
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
          // (`reorderRootUpdateAfterChildren`): the declared cascade is what
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

/** Under `guarded` every nested kind proceeds — since D2 deleted `pastSurface` there is
 *  no regime left that stops one, and the occupied guard the regime emits is kind-blind.
 *  All of them spend `interpretReferencedKeyTransition`'s single
 *  `adoptWrite = keyTransition.write` (routed by the dispatch's adopt list, `input.afterRootParts`),
 *  which carries the NEW value only: existing membership keeps
 *  reading through `WritePartBase.membershipReadSource`, and that split of one field
 *  against the other IS the old-read / new-write rule. So each kind below is a separate
 *  chance for D1 to bind the post-transition value to a membership READ. The split is
 *  asserted per kind: which parameter is "o1" and which is "o2", and on which side of
 *  the root UPDATE the child write lands. */
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
            : step.kind === "recordSeries"
              ? []
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

// ---------------------------------------------------------------------------
// POLYMORPHIC referenced-identity transition — the structural pin Package A
// recorded as missing.
//
// `polymorphic-write-family.test.ts` already measures the BEHAVIOUR of this shape
// (":586", ":2654", ":2701", ":2828"): the old member keeps the vacated id, the adopt
// and the create take the new one. What no test named until now is the plan those
// outcomes come from — the SQL, the parameters, the step order, and above all the two
// things this family is about that are ABSENT here.
//
// The topology is fixed, not payload-selected: `PolymorphicChildHeldRelation.onUpdate`
// is hard-coded `undefined` (`relation-data-builder.ts`), because there is no
// polymorphic foreign key for a referential action to hang on. Two consequences, both
// asserted below rather than reasoned about:
//
//   1. NO occupied guard and NO `*.transition.find` probe — the guard reproduces a
//      referential action, and there is none. Existing members are deliberately left on
//      the vacated value (`query-engine/AGENTS.md`: "Existing members are not rewritten
//      because the database has no polymorphic foreign key or automatic referential
//      action"), which is also §D2's "keep untouched existing memberships unchanged".
//   2. The locator does not change the plan. `resolvePolymorphicParent` reads the
//      pre-transition value from the `where` when it pins one and from the located row
//      when it does not, and derives the post-transition value from whichever it got —
//      so the two spellings differ in PROVENANCE and in nothing else. That is the same
//      claim D2 makes for the ordinary child-held path, on the path that already had it.
// ---------------------------------------------------------------------------

describe("parity D — a polymorphic referenced-identity transition", () => {
  const polymorphicUpdate = (
    driver: PGliteDriver,
    where: Record<string, unknown>
  ) =>
    new UpdateOperation(
      engineFor(polymorphicSchema, driver),
      polymorphicSchema.post as Model<any>,
      {
        where,
        data: {
          id: 2,
          comments: { connect: { id: 10 }, create: { id: 11, body: "fresh" } },
        },
        select: { id: true },
      }
    );

  const POLYMORPHIC_KNOWN = {
    "post.locate.rows": [{ id: 1, slug: "s" }],
    "comment.find.rows": [{ id: 10 }],
  };

  test("no occupied guard and no transition probe: there is no referential action to reproduce", () => {
    const driver = new PGliteDriver();
    const operation = polymorphicUpdate(driver, { slug: "s" });
    expect(operation.planning().steps.map((step) => step.id)).toEqual([
      "post.locate",
      "comment.find",
    ]);
    expect(
      operation
        .compile(POLYMORPHIC_KNOWN)
        .steps.filter((step) => step.kind === "guard")
    ).toEqual([]);
  });

  test("the adopt and the create both bind the NEW identity, after the root UPDATE", () => {
    const driver = new PGliteDriver();
    const operation = polymorphicUpdate(driver, { slug: "s" });
    const compiled = fragmentContract(
      driver,
      operation.compile(POLYMORPHIC_KNOWN)
    ) as { steps: Record<string, unknown>[] };
    expect(compiled.steps.map((step) => step.id)).toEqual([
      "post.update",
      "comment.connect",
      "comment.create",
      "post.select",
    ]);
    // The root moves 1 → 2, addressed by the located pre-transition key …
    expect(compiled.steps[0]).toMatchObject({
      sql: 'UPDATE "parity_d_posts" SET "id" = $1 WHERE "parity_d_posts"."id" = $2 RETURNING "id" AS "id"',
      params: [2, 1],
    });
    // … the adopt writes the private pair with the POST-transition identity …
    expect(compiled.steps[1]).toMatchObject({
      sql: 'UPDATE "parity_d_comments" SET "commentable_type" = $1, "commentable_id" = CAST($2 AS INTEGER) WHERE "parity_d_comments"."id" = $3 RETURNING "id" AS "id"',
      params: ["parity.d.v1", 2, 10],
    });
    // … and so does the fresh row. The discriminator is a fixed qualifier of the
    // MEMBERSHIP key, never a member of the target's row key, so the transition
    // touches only the id half of the pair.
    expect(compiled.steps[2]).toMatchObject({
      sql: 'INSERT INTO "parity_d_comments" ("id", "body", "commentable_type", "commentable_id") VALUES ($1, $2, $3, CAST($4 AS INTEGER))',
      params: [11, "fresh", "parity.d.v1", 2],
    });
  });

  test("a pinned locator and an unpinned one compile the same plan", () => {
    const pinnedDriver = new PGliteDriver();
    const unpinnedDriver = new PGliteDriver();
    const pinned = fragmentContract(
      pinnedDriver,
      polymorphicUpdate(pinnedDriver, { id: 1 }).compile({
        "post.locate.rows": [{ id: 1 }],
        "comment.find.rows": [{ id: 10 }],
      })
    );
    const unpinned = fragmentContract(
      unpinnedDriver,
      polymorphicUpdate(unpinnedDriver, { slug: "s" }).compile(
        POLYMORPHIC_KNOWN
      )
    );
    // Identical down to the parameters: a `where` that pins the pre-value and a
    // located row that carries it are two provenances for one number.
    expect(unpinned).toEqual(pinned);
  });
});
