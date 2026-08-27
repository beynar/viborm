import type { AnyDriver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { validateSchemaOrThrow } from "@schema/validation";
import { CreateOperation } from "@src/query-engine/write-engine/CreateOperation";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { UpsertOperation } from "@src/query-engine/write-engine/UpsertOperation";
import { createJunctionUpsertSchema } from "@tests/contracts/engine/write/create-junction-upsert-behavior";
import { producedIdentitySchema as junctionIdentitySchema } from "@tests/contracts/engine/write/junction-produced-identity-behavior";
import { locatedParentRefSchema } from "@tests/contracts/engine/write/located-parent-ref-behavior";
import { postTransitionAdoptSchema } from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { producedIdentitySchema } from "@tests/contracts/engine/write/produced-identity-depth-behavior";
import {
  correlatedUpsertArgs,
  updateSliceSchema,
} from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { nestedWriteBehaviorSchema } from "@tests/fixtures/nested-write-behavior-schema";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const MUTATION_CTE_PREFIX = /^WITH /;

hydrateSchemaNames(nestedWriteBehaviorSchema);

/** PACKAGE G — an inverse to-one whose child's ROW KEY has two members and is not the
 *  correlation, so the found arm's address can only come from the captured row. */
const compoundUpsertSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      slot: s.toOne(() => slot),
    })
    .map("g_compound_owners");
  const slot = s
    .model({
      tenantId: s.string(),
      code: s.string(),
      note: s.string(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .id(["tenantId", "code"])
    .map("g_compound_slots");
  return { owner, slot };
})();
hydrateSchemaNames(compoundUpsertSchema);

/** PACKAGE G — an inverse to-one whose child's row key is an INT, the only shape that
 *  can spell a NON-PORTABLE primary-key update operation. This is the schema the §3.1
 *  timing witness below needs: a string key accepts only `set`, so its single-operation
 *  rule can never be broken. */
const portabilityUpsertSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      slot: s.toOne(() => slot),
    })
    .map("g_portable_owners");
  const slot = s
    .model({
      id: s.int().id(),
      note: s.string(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
    })
    .map("g_portable_slots");
  return { owner, slot };
})();
hydrateSchemaNames(portabilityUpsertSchema);

/** PACKAGE G — an ORDINARY inverse to-one whose child carries its OWN direct
 *  polymorphic field. A `disconnect` there resolves to an intent with no relation
 *  program, so it exists only in the third parsed member. */
const polymorphicArmSchema = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      card: s.toOne(() => card),
    })
    .map("g_poly_owners");
  const article = s
    .model({ id: s.string().id(), title: s.string() })
    .map("g_poly_articles");
  const clip = s
    .model({ id: s.string().id(), title: s.string() })
    .map("g_poly_clips");
  const card = s
    .model({
      id: s.string().id(),
      body: s.string(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .toOne(() => owner)
        .fields("ownerId")
        .references("id"),
      subject: s
        .toOne(
          { article: () => article, clip: () => clip },
          { values: { article: "poly.article.v1", clip: "poly.clip.v1" } }
        )
        .optional(),
    })
    .map("g_poly_cards");
  return { owner, article, clip, card };
})();
hydrateSchemaNames(polymorphicArmSchema);
// Polymorphic private storage is registered by the schema validation rule, not by
// hydration; without it the parse never sees a polymorphic payload at all.
validateSchemaOrThrow(polymorphicArmSchema);

function engineFor(
  driver: AnyDriver,
  schema: Record<string, Model<any>>
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function updateFor(
  driver: PGliteDriver,
  schema: Record<string, Model<any>>,
  model: Model<any>,
  args: Record<string, unknown>
): UpdateOperation {
  return new UpdateOperation(engineFor(driver, schema), model, args);
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

function ids(fragment: PlanningFragment | OperationFragment): string[] {
  return fragment.steps.map((step) => step.id);
}

function step(
  fragment: PlanningFragment | OperationFragment,
  id: string
): OperationStep {
  const found = fragment.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Expected fragment step '${id}'.`);
  return found;
}

function statementStep(
  fragment: PlanningFragment | OperationFragment,
  id: string
): StatementStep {
  const found = step(fragment, id);
  if (found.kind === "guard" || found.kind === "recordSeries") {
    throw new Error(`Expected statement '${id}'.`);
  }
  return found;
}

function prepared(
  driver: PGliteDriver,
  current: StatementStep
): { readonly sql: string; readonly params: unknown } {
  const query = driver._prepare(current.statement);
  return { sql: query.sql, params: normalized(query.params) };
}

function effects(current: StatementStep): {
  readonly outputs: unknown;
  readonly expects: unknown;
  readonly racePin: unknown;
  readonly onUniqueConflict: unknown;
} {
  return {
    outputs: normalized(current.outputs),
    expects: current.expects ?? null,
    racePin: current.kind === "write" ? (current.racePin ?? null) : null,
    onUniqueConflict:
      current.kind === "write" ? (current.onUniqueConflict ?? null) : null,
  };
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
            ...effects(current),
          }
    ),
    outputs: normalized(publishedOutputs(fragment)),
  };
}

function outputContract(
  fragment: PlanningFragment | OperationFragment
): unknown {
  return normalized(publishedOutputs(fragment));
}

const terminalExpectation = (operation: "create" | "update") => ({
  kind: "exactlyOneRow",
  failure: {
    kind: "query",
    message: `query-engine-v2 ${operation} terminal read expected exactly one row.`,
    raceable: false,
  },
});

function inverseToOneUpsert(
  driver: PGliteDriver,
  update: Record<string, unknown>
): UpdateOperation {
  return updateFor(
    driver,
    nestedWriteBehaviorSchema,
    nestedWriteBehaviorSchema.user,
    {
      where: { id: "u1" },
      data: {
        profile: {
          upsert: {
            create: { id: "pr-new", bio: "fresh" },
            update,
          },
        },
      },
      select: { id: true },
    }
  );
}

describe("one record, one compiler parity", () => {
  for (const substrate of [
    {
      name: "transaction",
      batch: false,
      createDriver: () => new PGliteDriver(),
    },
    {
      name: "atomic batch",
      batch: true,
      createDriver: () => new BatchOnlyPGliteDriver(),
    },
  ]) {
    test(`inverse child-held to-one upsert preserves found, missing, and replacement contracts (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = inverseToOneUpsert(driver, { bio: "updated" });
      const planning = operation.planning();
      expect(ids(planning)).toEqual(["user.locate", "profile.find"]);
      expect(prepared(driver, statementStep(planning, "user.locate"))).toEqual({
        sql: `SELECT "t0"."id" AS "id" FROM "public"."nested_behavior_users" AS "t0" WHERE "t0"."id" = $1 LIMIT 1${substrate.batch ? "" : " FOR UPDATE"}`,
        params: ["u1"],
      });
      expect(effects(statementStep(planning, "user.locate"))).toEqual({
        outputs: {
          rows: { kind: "rows" },
          id: { kind: "firstRowField", field: "id" },
        },
        expects: {
          kind: "exactlyOneRow",
          failure: {
            kind: "notFound",
            message:
              "query-engine-v2 update located no 'user' row for its unique where.",
            raceable: false,
          },
        },
        racePin: null,
        onUniqueConflict: null,
      });
      expect(prepared(driver, statementStep(planning, "profile.find"))).toEqual(
        {
          sql: `SELECT "t0"."id" AS "id" FROM "public"."nested_behavior_profiles" AS "t0" WHERE "t0"."userId" = $1 ORDER BY "t0"."id" ASC LIMIT $2${substrate.batch ? "" : " FOR UPDATE"}`,
          params: [reference("user.locate", "id"), 1],
        }
      );
      expect(effects(statementStep(planning, "profile.find"))).toEqual({
        outputs: {
          rows: { kind: "rows" },
          id: { kind: "firstRowField", field: "id", optional: true },
        },
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      });
      expect(outputContract(planning)).toEqual({
        "user.locate.rows": reference("user.locate", "rows"),
        "user.locate.id": reference("user.locate", "id"),
        "profile.find.rows": reference("profile.find", "rows"),
        "profile.find.id": reference("profile.find", "id"),
      });

      const found = operation.compile({
        "user.locate.rows": [{ id: "u1" }],
        "profile.find.rows": [{ id: "pr1", userId: "u1" }],
      });
      expect(ids(found)).toEqual(
        substrate.batch
          ? [
              "user.guard.exists",
              "profile.guard.exists",
              "profile.update",
              "user.select",
            ]
          : ["profile.update", "user.select"]
      );
      if (substrate.batch) {
        expect(guardContract(driver, step(found, "user.guard.exists"))).toEqual(
          {
            id: "user.guard.exists",
            premise: {
              kind: "exists",
              sql: 'SELECT "t0"."id" AS "id" FROM "public"."nested_behavior_users" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
              params: ["u1"],
            },
            failure: {
              kind: "notFound",
              message:
                "query-engine-v2 update located no 'user' row for its unique where.",
              raceable: false,
            },
          }
        );
        expect(
          guardContract(driver, step(found, "profile.guard.exists"))
        ).toEqual({
          id: "profile.guard.exists",
          premise: {
            kind: "exists",
            sql: 'SELECT "t0"."id" AS "id" FROM "public"."nested_behavior_profiles" AS "t0" WHERE ("t0"."userId" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
            params: ["u1", "pr1", 1],
          },
          failure: {
            kind: "nestedWrite",
            message: "Nested upsert premise changed for relation 'profile'.",
            relation: "profile",
            raceable: false,
          },
        });
      }
      expect(prepared(driver, statementStep(found, "profile.update"))).toEqual({
        sql: 'UPDATE "public"."nested_behavior_profiles" SET "bio" = $1 WHERE "nested_behavior_profiles"."id" = $2 RETURNING "id" AS "id"',
        params: ["updated", "pr1"],
      });
      expect(effects(statementStep(found, "profile.update"))).toEqual({
        outputs: {},
        expects: substrate.batch
          ? null
          : {
              kind: "affectedRows",
              expected: 1,
              failure: {
                kind: "notFound",
                message:
                  "Nested upsert target for relation 'profile' vanished before its update.",
                relation: "profile",
                raceable: false,
              },
            },
        racePin: null,
        onUniqueConflict: null,
      });

      const missing = operation.compile({
        "user.locate.rows": [{ id: "u1" }],
        "profile.find.rows": [],
      });
      expect(ids(missing)).toEqual(
        substrate.batch
          ? ["user.guard.exists", "profile.create", "user.select"]
          : ["profile.create", "user.select"]
      );
      expect(
        prepared(driver, statementStep(missing, "profile.create"))
      ).toEqual({
        sql: 'INSERT INTO "public"."nested_behavior_profiles" ("id", "bio", "userId") VALUES ($1, $2, CAST($3 AS TEXT))',
        params: ["pr-new", "fresh", "u1"],
      });
      expect(effects(statementStep(missing, "profile.create"))).toEqual({
        outputs: {},
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      });
      for (const final of [found, missing]) {
        expect(prepared(driver, statementStep(final, "user.select"))).toEqual({
          sql: 'SELECT "t0"."id" AS "id" FROM "public"."nested_behavior_users" AS "t0" WHERE "t0"."id" = $1 LIMIT 1',
          params: ["u1"],
        });
        expect(effects(statementStep(final, "user.select"))).toEqual({
          outputs: { result: { kind: "rows" } },
          expects: substrate.batch ? null : terminalExpectation("update"),
          racePin: null,
          onUniqueConflict: null,
        });
        expect(outputContract(final)).toEqual({
          result: reference("user.select", "result"),
        });
      }
    });

    test(`inverse child-held to-one upsert keeps a found empty update effect-free (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = inverseToOneUpsert(driver, {});
      const planning = operation.planning();
      expect(ids(planning)).toEqual(["user.locate", "profile.find"]);
      expect(effects(statementStep(planning, "profile.find"))).toEqual({
        outputs: { rows: { kind: "rows" } },
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      });
      expect(outputContract(planning)).toEqual({
        "user.locate.rows": reference("user.locate", "rows"),
        "user.locate.id": reference("user.locate", "id"),
        "profile.find.rows": reference("profile.find", "rows"),
      });
      const final = operation.compile({
        "user.locate.rows": [{ id: "u1" }],
        "profile.find.rows": [{ id: "pr1", userId: "u1" }],
      });
      expect(ids(final)).toEqual(
        substrate.batch ? ["user.guard.exists", "user.select"] : ["user.select"]
      );
      expect(outputContract(final)).toEqual({
        result: reference("user.select", "result"),
      });
    });

    /**
     * PACKAGE G — the shape this test used to REFUSE. Until G it threw at construction
     * with an empty statement log:
     *
     *   UnsupportedOperationError: query-engine-v2 upsert for relation 'profile' does
     *   not support nested relation writes in its data.
     *
     * The refusal was the last upsert arm that did not delegate to the record compiler;
     * every other one (root, to-many, parent-held to-one) already did. So the claim
     * here is CONVERGENCE, not merely "it compiles": for the same relation-bearing
     * payload the found arm emits exactly what the sibling nested `update` kind emits —
     * same ids, same SQL, same parameters — and the only planning difference is the one
     * the relation owner is supposed to keep, its own found/missing decision.
     *
     * The payload is the deleted test's, deliberately: `user: { connect }` is a
     * parent-held write on the relation this arm ARRIVED THROUGH, so the found arm
     * reparents the profile off the parent that located it. That is not new to the
     * upsert — `buildToOneUpdatePart` has always accepted it — and pinning the same
     * payload on both kinds is what makes "the upsert now agrees with the update" a
     * measured fact instead of an assertion. (`userId: "u2"` spelled directly stays
     * refused — since Package N1 by the PARSE BOUNDARY, which omits the key from
     * nested update data; the engine guard that once backed it up is deleted
     * (distinct-truth Phase 2 aligned the two inverse scanners, closing its only
     * route). Either way the asymmetry is the relation schema's, not this seam's,
     * and `nested-update-owned-fk.test.ts` owns it on every schema.)
     */
    test(`inverse child-held to-one upsert compiles relation-bearing update data as one selected record (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const armData = { bio: "updated", user: { connect: { id: "u2" } } };
      const known = {
        "user.locate.rows": [{ id: "u1" }],
        "profile.find.rows": [{ id: "pr1", userId: "u1" }],
        "user.find.rows": [{ id: "u2" }],
      };

      const operation = inverseToOneUpsert(driver, armData);
      const planning = operation.planning();
      expect(ids(planning)).toEqual([
        "user.locate",
        "profile.find",
        "user.find",
      ]);
      // The owner keeps the decision: no expectation may reject planning while the
      // create arm may still be the one taken, and the located row key stays optional.
      expect(effects(statementStep(planning, "profile.find"))).toEqual({
        outputs: {
          rows: { kind: "rows" },
          id: { kind: "firstRowField", field: "id", optional: true },
        },
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      });

      const found = operation.compile(known);
      // The write addresses the CAPTURED row key, not the correlation it was found by.
      expect(prepared(driver, statementStep(found, "profile.update"))).toEqual({
        sql: 'UPDATE "public"."nested_behavior_profiles" SET "bio" = $1, "userId" = CAST($2 AS TEXT) WHERE "nested_behavior_profiles"."id" = $3 RETURNING "id" AS "id"',
        params: ["updated", "u2", "pr1"],
      });

      // Convergence with the nested `update` kind: same steps, same SQL, same
      // parameters. What stays DIFFERENT is exactly what the relation owner owns —
      // its found/missing failure wording — asserted positively below rather than
      // excluded silently.
      const sibling = updateFor(
        driver,
        nestedWriteBehaviorSchema,
        nestedWriteBehaviorSchema.user,
        {
          where: { id: "u1" },
          data: { profile: { update: armData } },
          select: { id: true },
        }
      );
      const siblingFound = sibling.compile(known);
      expect(ids(found)).toEqual(ids(siblingFound));
      for (const current of found.steps) {
        const twin = step(siblingFound, current.id);
        expect(current.kind).toBe(twin.kind);
        if (current.kind === "guard" && twin.kind === "guard") {
          const premise = (guard: typeof current) => ({
            kind: guard.premise.kind,
            sql: driver._prepare(guard.premise.statement).sql,
            params: normalized(driver._prepare(guard.premise.statement).params),
          });
          expect(premise(current)).toEqual(premise(twin));
          continue;
        }
        if (
          current.kind === "guard" ||
          twin.kind === "guard" ||
          current.kind === "recordSeries" ||
          twin.kind === "recordSeries"
        ) {
          throw new Error(
            `Step '${current.id}' changed kind across the seams.`
          );
        }
        expect(prepared(driver, current)).toEqual(prepared(driver, twin));
        const { expects: _armExpects, ...armEffects } = effects(current);
        const { expects: _twinExpects, ...twinEffects } = effects(twin);
        expect(armEffects).toEqual(twinEffects);
      }
      // The owner's two failure channels keep the upsert family's wording.
      if (substrate.batch) {
        expect(
          guardContract(driver, step(found, "profile.guard.exists"))
        ).toMatchObject({
          failure: {
            message: "Nested upsert premise changed for relation 'profile'.",
          },
        });
      } else {
        expect(statementStep(found, "profile.update").expects).toEqual({
          kind: "affectedRows",
          expected: 1,
          failure: {
            kind: "notFound",
            message:
              "Nested upsert target for relation 'profile' vanished before its update.",
            relation: "profile",
            raceable: false,
          },
        });
      }

      // …and the untaken arm compiles NOTHING of that subtree.
      const missing = operation.compile({
        "user.locate.rows": [{ id: "u1" }],
        "profile.find.rows": [],
        "user.find.rows": [],
      });
      expect(ids(missing)).toEqual(
        substrate.batch
          ? ["user.guard.exists", "profile.create", "user.select"]
          : ["profile.create", "user.select"]
      );
    });

    /**
     * PACKAGE G — the seam parsed the update arm twice over into two of the three
     * members it needed: `scalarData` and `relations`. A DIRECT polymorphic
     * `disconnect` resolves to an intent with NO relation program, so it lived only in
     * the dropped third member. Measured at a8349793 on this exact payload: the found
     * arm compiled to `["owner.guard.exists", "owner.select"]` — the relation Part
     * emitted zero steps, the call succeeded, and the membership was never cleared.
     * The sibling nested `update` kind, which always forwarded all three, emitted
     * `card.update` for the same data. This asserts the two now agree.
     */
    test(`inverse child-held to-one upsert forwards a program-less polymorphic mutation (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const known = {
        "owner.locate.rows": [{ id: "o1" }],
        "card.find.rows": [
          {
            id: "c1",
            ownerId: "o1",
            subjectId: "a1",
            subjectType: "poly.article.v1",
          },
        ],
      };
      const armData = { subject: { disconnect: true } };
      const upsertArm = updateFor(
        driver,
        polymorphicArmSchema,
        polymorphicArmSchema.owner,
        {
          where: { id: "o1" },
          data: {
            card: {
              upsert: {
                create: { id: "c-new", body: "fresh" },
                update: armData,
              },
            },
          },
          select: { id: true },
        }
      ).compile(known);
      const updateArm = updateFor(
        driver,
        polymorphicArmSchema,
        polymorphicArmSchema.owner,
        {
          where: { id: "o1" },
          data: { card: { update: armData } },
          select: { id: true },
        }
      ).compile(known);

      expect(ids(upsertArm)).toEqual(ids(updateArm));
      expect(ids(upsertArm)).toContain("card.update");
      expect(prepared(driver, statementStep(upsertArm, "card.update"))).toEqual(
        prepared(driver, statementStep(updateArm, "card.update"))
      );
      // Both private columns are cleared atomically, by the captured row key.
      expect(prepared(driver, statementStep(upsertArm, "card.update"))).toEqual(
        {
          sql: 'UPDATE "public"."g_poly_cards" SET "subject_type" = NULL, "subject_id" = NULL WHERE "g_poly_cards"."id" = $1 RETURNING "id" AS "id"',
          params: ["c1"],
        }
      );
    });

    /**
     * PACKAGE G — "the root update addresses the captured complete row key" with a row
     * key that has TWO members and a decoy row that shares neither. An inverse to-one
     * has no unique `where`, so nothing about the target is construction-known: every
     * member of the address can only come from the row the probe captured.
     */
    test(`inverse child-held to-one upsert addresses a compound captured row key (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const operation = updateFor(
        driver,
        compoundUpsertSchema,
        compoundUpsertSchema.owner,
        {
          where: { id: "o1" },
          data: {
            slot: {
              upsert: {
                create: { tenantId: "t-new", code: "c-new", note: "fresh" },
                update: { note: "updated" },
              },
            },
          },
          select: { id: true },
        }
      );
      expect(
        prepared(driver, statementStep(operation.planning(), "slot.find")).sql
      ).toBe(
        `SELECT "t0"."tenantId" AS "tenantId", "t0"."code" AS "code" FROM "public"."g_compound_slots" AS "t0" WHERE "t0"."ownerId" = $1 ORDER BY "t0"."tenantId" ASC, "t0"."code" ASC LIMIT $2${substrate.batch ? "" : " FOR UPDATE"}`
      );
      const found = operation.compile({
        "owner.locate.rows": [{ id: "o1" }],
        // The decoy: a row whose members are BOTH different from the create arm's and
        // from anything derivable from the correlation.
        "slot.find.rows": [{ tenantId: "t9", code: "c9", ownerId: "o1" }],
      });
      expect(prepared(driver, statementStep(found, "slot.update"))).toEqual({
        sql: 'UPDATE "public"."g_compound_slots" SET "note" = $1 WHERE ("g_compound_slots"."tenantId" = $2 AND "g_compound_slots"."code" = $3) RETURNING "tenantId" AS "tenantId", "code" AS "code"',
        params: ["updated", "t9", "c9"],
      });
      if (substrate.batch) {
        // The batch premise reasserts the correlation AND every captured member.
        expect(guardContract(driver, step(found, "slot.guard.exists"))).toEqual(
          {
            id: "slot.guard.exists",
            premise: {
              kind: "exists",
              sql: 'SELECT "t0"."tenantId" AS "tenantId", "t0"."code" AS "code" FROM "public"."g_compound_slots" AS "t0" WHERE ("t0"."ownerId" = $1 AND "t0"."tenantId" = $2 AND "t0"."code" = $3) ORDER BY "t0"."tenantId" ASC, "t0"."code" ASC LIMIT $4',
              params: ["o1", "t9", "c9", 1],
            },
            failure: {
              kind: "nestedWrite",
              message: "Nested upsert premise changed for relation 'slot'.",
              relation: "slot",
              raceable: false,
            },
          }
        );
      }
    });

    /**
     * PACKAGE G — the §3.1 timing change itself, on the ONE assert whose timing moved
     * for a payload class that used to be ACCEPTED in shape.
     *
     * Before G this seam parsed its arm through `parseScalarUpdateData`, which ran all
     * of `assertPortablePrimaryKeyUpdateInput` at CONSTRUCTION, then refused any payload
     * carrying relations. So for a RELATION-FREE arm — the only kind that got past that
     * wall — a non-portable primary-key operation threw with an empty statement log
     * whether or not the found arm was taken. It now runs in the deferred closure: the
     * missing arm CREATES, and only the found arm refuses.
     *
     * This is deliberately not the `updateMany` payload the sibling deferral test uses.
     * That one's refusal could never have fired before G (the relations wall answered it
     * first), so deleting this assert from the closure would leave that test green. This
     * one names the failure THIS assert alone catches at THIS call site, which is what
     * the house's one-guard-per-invariant rule asks of every member of the closure.
     */
    test(`inverse child-held to-one upsert defers primary-key portability to the found arm (${substrate.name})`, () => {
      const driver = substrate.createDriver();
      const armData = { id: { increment: 1, multiply: 2 }, note: "x" };
      const operation = updateFor(
        driver,
        portabilityUpsertSchema,
        portabilityUpsertSchema.owner,
        {
          where: { id: "o1" },
          data: {
            slot: {
              upsert: {
                create: { id: 9, note: "fresh" },
                update: armData,
              },
            },
          },
          select: { id: true },
        }
      );
      // Construction and planning both survive: nothing about the arm is judged yet.
      expect(ids(operation.planning())).toEqual(["owner.locate", "slot.find"]);

      // MISSING: the create arm runs and the update subtree is never judged.
      expect(
        ids(
          operation.compile({
            "owner.locate.rows": [{ id: "o1" }],
            "slot.find.rows": [],
          })
        )
      ).toEqual(
        substrate.batch
          ? ["owner.guard.exists", "slot.create", "owner.select"]
          : ["slot.create", "owner.select"]
      );

      // FOUND: the same payload is refused, by the assert's own message.
      let failure: unknown;
      try {
        operation.compile({
          "owner.locate.rows": [{ id: "o1" }],
          "slot.find.rows": [{ id: 4, ownerId: "o1" }],
        });
      } catch (error) {
        failure = error;
      }
      expect(
        failure instanceof Error
          ? { name: failure.name, message: failure.message }
          : failure
      ).toEqual({
        name: "QueryEngineError",
        message:
          "Primary key field 'id' accepts exactly one update operation; received increment, multiply.",
      });

      // The sibling `update` kind has no untaken arm, so it keeps refusing eagerly —
      // the divergence is the branch, not the check.
      let eager: unknown;
      try {
        updateFor(
          driver,
          portabilityUpsertSchema,
          portabilityUpsertSchema.owner,
          {
            where: { id: "o1" },
            data: { slot: { update: armData } },
            select: { id: true },
          }
        ).planning();
      } catch (error) {
        eager = error;
      }
      expect(eager instanceof Error ? eager.message : eager).toBe(
        "Primary key field 'id' accepts exactly one update operation; received increment, multiply."
      );
    });
  }

  test("a direct scalar update remains one self-contained statement", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      updateSliceSchema,
      updateSliceSchema.user,
      {
        where: { email: "direct@x" },
        data: { count: { increment: 3 } },
        select: { id: true, email: true, count: true },
      }
    );

    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    expect(fragmentContract(driver, operation.compile({}))).toEqual({
      steps: [
        {
          id: "user.update",
          kind: "write",
          sql: 'UPDATE "public"."update_slice_users" SET "count" = "count" + $1 WHERE "update_slice_users"."email" = $2 RETURNING "id" AS "id", "email" AS "email", "count" AS "count"',
          params: [3, "direct@x"],
          outputs: { result: { kind: "rows" } },
          expects: {
            kind: "affectedRows",
            expected: 1,
            failure: {
              kind: "notFound",
              message:
                "query-engine-v2 update located no 'user' row for its unique where.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: { result: reference("user.update", "result") },
    });
  });

  test("a relation projection keeps locate, captured-PK update, and terminal read", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      updateSliceSchema,
      updateSliceSchema.user,
      {
        where: { email: "projected@x" },
        data: { count: { increment: 2 } },
        select: {
          id: true,
          posts: {
            where: { author: { count: { equals: 2 } } },
            select: { id: true, title: true },
          },
        },
      }
    );

    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [
        {
          id: "user.locate",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id" FROM "public"."update_slice_users" AS "t0" WHERE "t0"."email" = $1 LIMIT 1 FOR UPDATE',
          params: ["projected@x"],
          outputs: {
            rows: { kind: "rows" },
            id: { kind: "firstRowField", field: "id" },
          },
          expects: {
            kind: "exactlyOneRow",
            failure: {
              kind: "notFound",
              message:
                "query-engine-v2 update located no 'user' row for its unique where.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: {
        "user.locate.rows": reference("user.locate", "rows"),
        "user.locate.id": reference("user.locate", "id"),
      },
    });
    expect(
      fragmentContract(
        driver,
        operation.compile({ "user.locate.rows": [{ id: 41 }] })
      )
    ).toEqual({
      steps: [
        {
          id: "user.update",
          kind: "write",
          sql: 'UPDATE "public"."update_slice_users" SET "count" = "count" + $1 WHERE "update_slice_users"."id" = $2 RETURNING "id" AS "id"',
          params: [2, 41],
          outputs: {},
          expects: {
            kind: "affectedRows",
            expected: 1,
            failure: {
              kind: "notFound",
              message:
                "query-engine-v2 update located no 'user' row for its unique where.",
              raceable: false,
            },
          },
          racePin: null,
          onUniqueConflict: null,
        },
        {
          id: "user.select",
          kind: "read",
          sql: 'SELECT "t0"."id" AS "id", "t2"."_result" AS "posts" FROM "public"."update_slice_users" AS "t0" LEFT JOIN LATERAL (SELECT COALESCE(json_agg("t4"."_json"), \'[]\'::json) AS "_result" FROM (SELECT json_build_object($1::text, "t1"."id", $2::text, "t1"."title") AS "_json" FROM "public"."update_slice_posts" AS "t1" WHERE ("t0"."id" = "t1"."userId" AND EXISTS (SELECT 1 FROM "public"."update_slice_users" AS "t3" WHERE ("t1"."userId" = "t3"."id" AND "t3"."count" = $3)))) "t4") AS "t2" ON TRUE WHERE "t0"."id" = $4 LIMIT 1',
          params: ["id", "title", 2, 41],
          outputs: { result: { kind: "rows" } },
          expects: terminalExpectation("update"),
          racePin: null,
          onUniqueConflict: null,
        },
      ],
      outputs: { result: reference("user.select", "result") },
    });
  });

  test("literal and planned parent positions emit the same final fragment", () => {
    const driver = new PGliteDriver();
    const args = {
      data: { notes: { create: { id: 10, body: "fresh" } } },
      select: { id: true },
    };
    const literal = updateFor(
      driver,
      locatedParentRefSchema,
      locatedParentRefSchema.account,
      { where: { id: 2 }, ...args }
    );
    const planned = updateFor(
      driver,
      locatedParentRefSchema,
      locatedParentRefSchema.account,
      { where: { email: "target@x" }, ...args }
    );
    expect(ids(literal.planning())).toEqual(["account.locate"]);
    expect(ids(planned.planning())).toEqual(["account.locate"]);
    expect(
      prepared(driver, statementStep(literal.planning(), "account.locate"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "public"."n1_ref_accounts" AS "t0" WHERE "t0"."id" = $1 LIMIT 1 FOR UPDATE',
      params: [2],
    });
    expect(
      prepared(driver, statementStep(planned.planning(), "account.locate"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "public"."n1_ref_accounts" AS "t0" WHERE "t0"."email" = $1 LIMIT 1 FOR UPDATE',
      params: ["target@x"],
    });
    expect(
      effects(statementStep(planned.planning(), "account.locate"))
    ).toEqual(effects(statementStep(literal.planning(), "account.locate")));
    expect(outputContract(planned.planning())).toEqual({
      "account.locate.rows": reference("account.locate", "rows"),
      "account.locate.id": reference("account.locate", "id"),
    });

    const literalFinal = literal.compile({
      "account.locate.rows": [{ id: 2 }],
    });
    const plannedFinal = planned.compile({
      "account.locate.rows": [{ id: 2 }],
    });
    expect(fragmentContract(driver, plannedFinal)).toEqual(
      fragmentContract(driver, literalFinal)
    );
    expect(ids(literalFinal)).toEqual(["note.create", "account.select"]);
    expect(
      prepared(driver, statementStep(literalFinal, "note.create"))
    ).toEqual({
      sql: 'INSERT INTO "public"."n1_ref_notes" ("id", "body", "accountId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: [10, "fresh", 2],
    });
    expect(effects(statementStep(literalFinal, "note.create"))).toEqual({
      outputs: {},
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(statementStep(literalFinal, "account.select").expects).toEqual(
      terminalExpectation("update")
    );
    expect(outputContract(literalFinal)).toEqual({
      result: reference("account.select", "result"),
    });
  });

  test("a transitioned position binds the new key after the root update", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      postTransitionAdoptSchema,
      postTransitionAdoptSchema.list,
      {
        where: { id: 1 },
        data: {
          id: 5,
          items: { create: { id: 20, label: "fresh" } },
        },
        select: { id: true },
      }
    );
    const planning = operation.planning();
    expect(ids(planning)).toEqual(["list.locate", "item.transition.find"]);
    expect(
      prepared(driver, statementStep(planning, "item.transition.find"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "public"."n5_pta_items" AS "t0" WHERE "t0"."listId" = $1 ORDER BY "t0"."id" ASC LIMIT $2 FOR UPDATE',
      params: [1, 1],
    });
    expect(outputContract(planning)).toEqual({
      "list.locate.rows": reference("list.locate", "rows"),
      "list.locate.id": reference("list.locate", "id"),
      "item.transition.find.rows": reference("item.transition.find", "rows"),
    });

    const final = operation.compile({ "list.locate.rows": [{ id: 1 }] });
    expect(ids(final)).toEqual(["list.update", "item.create", "list.select"]);
    expect(prepared(driver, statementStep(final, "list.update"))).toEqual({
      sql: 'UPDATE "public"."n5_pta_lists" SET "id" = $1 WHERE "n5_pta_lists"."id" = $2 RETURNING "id" AS "id"',
      params: [5, 1],
    });
    expect(prepared(driver, statementStep(final, "item.create"))).toEqual({
      sql: 'INSERT INTO "public"."n5_pta_items" ("id", "label", "listId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: [20, "fresh", 5],
    });
    expect(statementStep(final, "list.update").expects).toMatchObject({
      kind: "affectedRows",
      expected: 1,
    });
    expect(statementStep(final, "list.select").expects).toEqual(
      terminalExpectation("update")
    );
    expect(outputContract(final)).toEqual({
      result: reference("list.select", "result"),
    });
    expect(() => operation.compile({})).toThrowError(
      "query-engine-v2 update planning did not expose the locate rows."
    );
  });

  test("scalar and relation-bearing upsert arms share the root record", () => {
    const driver = new PGliteDriver();
    const operation = (withTask: boolean) =>
      updateFor(driver, producedIdentitySchema, producedIdentitySchema.org, {
        where: { id: 2 },
        data: {
          teams: {
            upsert: {
              where: { code: "T-FRESH" },
              create: {
                id: 20,
                code: "T-FRESH",
                title: "fresh",
                ...(withTask
                  ? { tasks: { create: { id: 100, label: "deep" } } }
                  : {}),
              },
              update: { title: "adopted" },
            },
          },
        },
        select: { id: true },
      });
    const scalar = operation(false);
    const nested = operation(true);
    expect(fragmentContract(driver, nested.planning())).toEqual(
      fragmentContract(driver, scalar.planning())
    );
    expect(ids(scalar.planning())).toEqual(["org.locate", "team.find"]);
    const known = {
      "org.locate.rows": [{ id: 2 }],
      "team.find.rows": [],
    };
    const scalarFinal = scalar.compile(known);
    const nestedFinal = nested.compile(known);
    expect(ids(scalarFinal)).toEqual(["team.create", "org.select"]);
    expect(ids(nestedFinal)).toEqual([
      "team.create",
      "task.create",
      "org.select",
    ]);
    expect(
      fragmentContract(driver, {
        steps: [statementStep(nestedFinal, "team.create")],
        outputs: {},
      })
    ).toEqual(
      fragmentContract(driver, {
        steps: [statementStep(scalarFinal, "team.create")],
        outputs: {},
      })
    );
    expect(prepared(driver, statementStep(nestedFinal, "team.create"))).toEqual(
      {
        sql: 'INSERT INTO "public"."n4pi_teams" ("id", "code", "title", "orgId", "leadId") VALUES ($1, $2, $3, CAST($4 AS INTEGER), NULL)',
        params: [20, "T-FRESH", "fresh", 2],
      }
    );
    expect(effects(statementStep(nestedFinal, "team.create"))).toEqual({
      outputs: {},
      expects: null,
      racePin: {
        fields: ["code"],
        table: "n4pi_teams",
        columns: ["code"],
        constraints: ["n4pi_teams_code_key"],
      },
      onUniqueConflict: null,
    });
    expect(prepared(driver, statementStep(nestedFinal, "task.create"))).toEqual(
      {
        sql: 'INSERT INTO "public"."n4pi_tasks" ("id", "label", "teamId", "ownerId") VALUES ($1, $2, CAST($3 AS INTEGER), NULL)',
        params: [100, "deep", 20],
      }
    );
    expect(outputContract(nestedFinal)).toEqual({
      result: reference("org.select", "result"),
    });
  });

  test("junction create orders target, descendants, then attachment", () => {
    const driver = new PGliteDriver();
    const operation = new CreateOperation(
      engineFor(driver, junctionIdentitySchema),
      junctionIdentitySchema.post,
      {
        data: {
          id: "p1",
          title: "fresh",
          stamps: {
            create: {
              name: "stamp",
              notes: { create: { id: "n1", body: "deep" } },
            },
          },
        },
        select: { id: true },
      }
    );
    expect(fragmentContract(driver, operation.planning())).toEqual({
      steps: [],
      outputs: {},
    });
    const final = operation.compile({});
    expect(ids(final)).toEqual([
      "post.create",
      "stamp.create",
      "note.create",
      "stamp.junction.insert",
      "post.select",
    ]);
    expect(prepared(driver, statementStep(final, "stamp.create"))).toEqual({
      sql: 'INSERT INTO "public"."e4u3_stamps" ("name") VALUES ($1) RETURNING "id" AS "id"',
      params: ["stamp"],
    });
    expect(effects(statementStep(final, "stamp.create"))).toEqual({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(prepared(driver, statementStep(final, "note.create"))).toEqual({
      sql: 'INSERT INTO "public"."e4u3_notes" ("id", "body", "stampId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: ["n1", "deep", reference("stamp.create", "id")],
    });
    // The junction skip's conflict target — AMENDED by the polymorphic
    // cardinality plan's §1.7, and it moves the bytes of every junction pin in
    // this file. The clause now names the complete membership key instead of
    // arbitrating on any unique constraint. UNIFORM across ordinary pair tables
    // too (§9.4 open question 1): a pair table's PK is its only unique
    // constraint, so exactly the same rows are skipped, while a
    // cardinality-shaped branch inside the SQL builder would be a second answer
    // to one question. What the target buys is elsewhere — a polymorphic member
    // table with a SINGULAR inverse also carries a target-side UNIQUE, and an
    // occupied slot has to raise there rather than be silently swallowed.
    expect(
      prepared(driver, statementStep(final, "stamp.junction.insert"))
    ).toEqual({
      sql: 'INSERT  INTO "public"."post_stamp" ("postId", "stampId") VALUES ($1, CAST($2 AS INTEGER)) ON CONFLICT ("postId", "stampId") DO NOTHING',
      params: ["p1", reference("stamp.create", "id")],
    });
    expect(statementStep(final, "post.select").expects).toEqual(
      terminalExpectation("create")
    );
    expect(outputContract(final)).toEqual({
      result: reference("post.select", "result"),
    });
  });

  test("connect-or-create duplicates reuse the first generated record", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      junctionIdentitySchema,
      junctionIdentitySchema.post,
      {
        where: { id: "p1" },
        data: {
          stamps: {
            connectOrCreate: [
              {
                where: { name: "dup" },
                create: {
                  name: "dup",
                  notes: { create: { id: "n-first", body: "first" } },
                },
              },
              {
                where: { name: "dup" },
                create: {
                  name: "dup",
                  notes: { create: { id: "n-second", body: "second" } },
                },
              },
            ],
          },
        },
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual([
      "post.locate",
      "stamp.find",
      "stamp.find#1",
    ]);
    expect(outputContract(operation.planning())).toEqual({
      "post.locate.rows": reference("post.locate", "rows"),
      "post.locate.id": reference("post.locate", "id"),
      "stamp.find.rows": reference("stamp.find", "rows"),
      "stamp.find#1.rows": reference("stamp.find#1", "rows"),
    });
    const final = operation.compile({
      "post.locate.rows": [{ id: "p1" }],
      "stamp.find.rows": [],
      "stamp.find#1.rows": [],
    });
    expect(ids(final)).toEqual([
      "stamp.create",
      "note.create",
      "stamp.junction.insert",
      "stamp.junction.insert#1",
      "post.select",
    ]);
    expect(statementStep(final, "stamp.create")).toMatchObject({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      racePin: { fields: ["name"], table: "e4u3_stamps" },
    });
    expect(prepared(driver, statementStep(final, "note.create"))).toEqual({
      sql: 'INSERT INTO "public"."e4u3_notes" ("id", "body", "stampId") VALUES ($1, $2, CAST($3 AS INTEGER))',
      params: ["n-first", "first", reference("stamp.create", "id")],
    });
    const firstJoin = prepared(
      driver,
      statementStep(final, "stamp.junction.insert")
    );
    expect(
      prepared(driver, statementStep(final, "stamp.junction.insert#1"))
    ).toEqual(firstJoin);
    expect(firstJoin).toEqual({
      sql: 'INSERT  INTO "public"."post_stamp" ("postId", "stampId") VALUES ($1, CAST($2 AS INTEGER)) ON CONFLICT ("postId", "stampId") DO NOTHING',
      params: ["p1", reference("stamp.create", "id")],
    });
    expect(JSON.stringify(fragmentContract(driver, final))).not.toContain(
      "n-second"
    );
    expect(outputContract(final)).toEqual({
      result: reference("post.select", "result"),
    });
  });

  test("junction upsert preserves both selected-arm orders", () => {
    const driver = new PGliteDriver();
    const operation = new CreateOperation(
      engineFor(driver, createJunctionUpsertSchema),
      createJunctionUpsertSchema.article,
      {
        data: {
          title: "fresh",
          topics: {
            upsert: {
              where: { name: "topic" },
              create: { name: "topic", weight: 1 },
              update: { weight: 2 },
            },
          },
        },
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual(["topic.find"]);
    expect(
      prepared(driver, statementStep(operation.planning(), "topic.find"))
    ).toEqual({
      sql: 'SELECT "t0"."id" AS "id" FROM "public"."e5u1_topics" AS "t0" WHERE "t0"."name" = $1 LIMIT 1 FOR UPDATE',
      params: ["topic"],
    });
    expect(outputContract(operation.planning())).toEqual({
      "topic.find.rows": reference("topic.find", "rows"),
      "topic.find.id": reference("topic.find", "id"),
    });

    const missing = operation.compile({ "topic.find.rows": [] });
    const found = operation.compile({ "topic.find.rows": [{ id: 11 }] });
    expect(ids(missing)).toEqual([
      "article.create",
      "topic.create",
      "topic.junction.insert",
      "article.select",
    ]);
    expect(ids(found)).toEqual([
      "article.create",
      "topic.update",
      "topic.junction.insert",
      "article.select",
    ]);
    expect(prepared(driver, statementStep(missing, "topic.create"))).toEqual({
      sql: 'INSERT INTO "public"."e5u1_topics" ("name", "weight", "authorId") VALUES ($1, $2, NULL) RETURNING "id" AS "id"',
      params: ["topic", 1],
    });
    expect(statementStep(missing, "topic.create")).toMatchObject({
      outputs: { id: { kind: "firstRowField", field: "id" } },
      racePin: { fields: ["name"], table: "e5u1_topics" },
    });
    expect(
      prepared(driver, statementStep(missing, "topic.junction.insert"))
    ).toEqual({
      sql: 'INSERT  INTO "public"."article_topic" ("articleId", "topicId") VALUES (CAST($1 AS INTEGER), CAST($2 AS INTEGER)) ON CONFLICT ("articleId", "topicId") DO NOTHING',
      params: [
        reference("article.create", "id"),
        reference("topic.create", "id"),
      ],
    });
    expect(prepared(driver, statementStep(found, "topic.update"))).toEqual({
      sql: 'UPDATE "public"."e5u1_topics" SET "weight" = $1 WHERE "e5u1_topics"."id" = $2 RETURNING "id" AS "id"',
      params: [2, 11],
    });
    expect(
      prepared(driver, statementStep(found, "topic.junction.insert"))
    ).toEqual({
      sql: 'INSERT  INTO "public"."article_topic" ("articleId", "topicId") VALUES (CAST($1 AS INTEGER), $2) ON CONFLICT ("articleId", "topicId") DO NOTHING',
      params: [reference("article.create", "id"), 11],
    });
    expect(outputContract(missing)).toEqual({
      result: reference("article.select", "result"),
    });
    expect(outputContract(found)).toEqual({
      result: reference("article.select", "result"),
    });
  });

  test("a root upsert create arm keeps generated identity and race provenance", () => {
    const driver = new PGliteDriver();
    const operation = new UpsertOperation(
      engineFor(driver, updateSliceSchema),
      updateSliceSchema.user,
      {
        where: { email: "new@x" },
        create: {
          email: "new@x",
          count: 0,
          posts: {
            create: { id: 7, title: "child", slug: "child" },
          },
        },
        update: { count: 1 },
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual(["user.locate"]);
    expect(outputContract(operation.planning())).toEqual({
      "user.locate.rows": reference("user.locate", "rows"),
    });
    const final = operation.compile({ "user.locate.rows": [] });
    expect(ids(final)).toEqual(["user.create#1"]);
    const folded = prepared(driver, statementStep(final, "user.create#1"));
    expect(folded.sql).toMatch(MUTATION_CTE_PREFIX);
    expect(folded.sql).toContain('INSERT INTO "public"."update_slice_users"');
    expect(folded.sql).toContain('INSERT INTO "public"."update_slice_posts"');
    expect(folded.params).toEqual(["new@x", 0, 7, "child", "child"]);
    expect(statementStep(final, "user.create#1")).toMatchObject({
      outputs: { result: { kind: "rows" } },
      racePin: { fields: ["email"], table: "update_slice_users" },
    });
    expect(statementStep(final, "user.create#1").expects).toEqual(
      terminalExpectation("create")
    );
    expect(outputContract(final)).toEqual({
      result: reference("user.create#1", "result"),
    });
    expect(() => operation.compile({})).toThrowError(
      "query-engine-v2 upsert planning did not expose the locate rows."
    );
  });

  test("a relation-shaped no-op update arm keeps optional locate outputs", () => {
    const driver = new PGliteDriver();
    const operation = new UpsertOperation(
      engineFor(driver, updateSliceSchema),
      updateSliceSchema.user,
      {
        where: { email: "noop@x" },
        create: { email: "noop@x", count: 0 },
        update: { posts: {} },
        select: { id: true },
      }
    );

    expect(ids(operation.planning())).toEqual(["user.locate"]);
    expect(effects(statementStep(operation.planning(), "user.locate"))).toEqual(
      {
        outputs: {
          rows: { kind: "rows" },
          id: { kind: "firstRowField", field: "id", optional: true },
        },
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      }
    );
    expect(outputContract(operation.planning())).toEqual({
      "user.locate.rows": reference("user.locate", "rows"),
      "user.locate.id": reference("user.locate", "id"),
    });
  });

  test("batch found arms retain their guards and executor effects", () => {
    const driver = new BatchOnlyPGliteDriver();
    const operation = updateFor(
      driver,
      updateSliceSchema,
      updateSliceSchema.user,
      {
        ...correlatedUpsertArgs({
          email: "z@x",
          childId: 5,
          title: "fresh",
          slug: "s5",
        }),
        select: { id: true },
      }
    );
    expect(ids(operation.planning())).toEqual(["user.locate", "post.find"]);
    const final = operation.compile({
      "user.locate.rows": [{ id: 42 }],
      "post.find.rows": [{ id: 5, userId: 42 }],
    });
    expect(ids(final)).toEqual([
      "user.guard.exists",
      "post.guard.exists",
      "user.update",
      "post.update",
      "user.select",
    ]);
    expect(guardContract(driver, step(final, "user.guard.exists"))).toEqual({
      id: "user.guard.exists",
      premise: {
        kind: "exists",
        sql: 'SELECT "t0"."id" AS "id" FROM "public"."update_slice_users" AS "t0" WHERE ("t0"."email" = $1 AND "t0"."id" = $2) ORDER BY "t0"."id" ASC LIMIT $3',
        params: ["z@x", 42, 1],
      },
      failure: {
        kind: "notFound",
        message:
          "query-engine-v2 update located no 'user' row for its unique where.",
        raceable: false,
      },
    });
    expect(guardContract(driver, step(final, "post.guard.exists"))).toEqual({
      id: "post.guard.exists",
      premise: {
        kind: "exists",
        sql: 'SELECT "t0"."id" AS "id", "t0"."userId" AS "userId" FROM "public"."update_slice_posts" AS "t0" WHERE ("t0"."id" = $1 AND "t0"."id" = $2 AND "t0"."userId" = $3) ORDER BY "t0"."id" ASC LIMIT $4',
        params: [5, 5, 42, 1],
      },
      failure: {
        kind: "nestedWrite",
        message: "Nested upsert premise changed for relation 'posts'.",
        relation: "posts",
        raceable: false,
      },
    });
    for (const id of ["user.update", "post.update"]) {
      expect(effects(statementStep(final, id))).toEqual({
        outputs: {},
        expects: null,
        racePin: null,
        onUniqueConflict: null,
      });
    }
    expect(effects(statementStep(final, "user.select"))).toEqual({
      outputs: { result: { kind: "rows" } },
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(outputContract(final)).toEqual({
      result: reference("user.select", "result"),
    });
  });

  test("createMany remains the specialized bulk boundary", () => {
    const driver = new PGliteDriver();
    const operation = updateFor(
      driver,
      locatedParentRefSchema,
      locatedParentRefSchema.account,
      {
        where: { email: "target@x" },
        data: {
          notes: {
            createMany: {
              data: [
                { id: 10, body: "first" },
                { id: 11, body: "second" },
              ],
            },
          },
        },
        select: { id: true },
      }
    );
    const final = operation.compile({ "account.locate.rows": [{ id: 2 }] });
    expect(ids(final)).toEqual(["note.createMany", "account.select"]);
    expect(prepared(driver, statementStep(final, "note.createMany"))).toEqual({
      sql: 'INSERT INTO "public"."n1_ref_notes" ("id", "body", "accountId") VALUES ($1, $2, CAST($3 AS INTEGER)), ($4, $5, CAST($6 AS INTEGER))',
      params: [10, "first", 2, 11, "second", 2],
    });
    expect(effects(statementStep(final, "note.createMany"))).toEqual({
      outputs: {},
      expects: null,
      racePin: null,
      onUniqueConflict: null,
    });
    expect(outputContract(final)).toEqual({
      result: reference("account.select", "result"),
    });
    expect(() =>
      updateFor(
        driver,
        locatedParentRefSchema,
        locatedParentRefSchema.account,
        {
          where: { id: 2 },
          data: {
            notes: {
              create: { id: 10, body: "invalid", accountId: 99 },
            },
          },
        }
      )
    ).toThrowError(
      "Validation failed for update: Value did not match any union member: Unknown key: accountId, Expected array"
    );
  });
});
