import type { Operations } from "@client/types";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import {
  constructRoutedOperation,
  ROUTED_OPERATIONS,
} from "../../src/query-engine-v2/routing";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { compoundKeyBehaviorSchema } from "../fixtures/compound-key-behavior-schema";
import { manyToManySchema } from "../fixtures/many-to-many-schema";

/**
 * The route inventory (PLAN P6 needs this pinned, not prose). Every write shape
 * the P3/P4 reports recorded as routed to V1 is exercised here through V2's
 * CONSTRUCTION path (an {@link UnsupportedOperationError} at construction is what
 * the per-tree router hands to V1 — no I/O is needed to observe the route). The
 * absorbed shapes (M2M create/connectOrCreate/upsert; compound-FK
 * set/update/delete/upsert; a compound FK referencing a non-PK unique) must now
 * construct on V2; the ONE inexpressible sub-shape (`createMany` asking for its
 * rows back — `select` — together with `skipDuplicates`, on a non-returning
 * driver) must still route.
 *
 * The assertion is the whole point: the set of corpus shapes that still route is
 * EXACTLY the one documented boundary. It is the P4 `routedToV1StillRemaining`
 * list minus the two P4.5 absorbs.
 *
 * Scope note (CORRECTED, P6-prerequisite 2): this file pins the *tracked* route
 * inventory (the P3/P4 report set) and the throw-SITE COUNT. It does NOT, on its
 * own, prove those throws carry no reachable behavior — and the earlier framing
 * that the untracked throws were "outside the P6 deletion accounting" was the
 * exact blind spot both blocked P6 attempts hit. A throw site is a route to V1;
 * many of the untracked ones (parent-held to-one `create`/`connectOrCreate`,
 * inverse-side to-one ops, nested-relation upsert arms) route ACCEPT-AND-EXECUTE
 * shapes V1 runs correctly today, so they ARE part of the deletion accounting.
 * The genuine per-SHAPE accounting — which declines carry reachable behavior and
 * which are truly refusable/degenerate — lives in the decline-surface gate
 * ({@link file://./decline-surface-gate.test.ts}), which runs shapes with the V1
 * fallback DISABLED. This file remains the count tripwire; that gate is the
 * behavior-reachability invariant. P6 may delete V1 only when that gate's census
 * (`FALLBACK_OFF_RESIDUAL`, tests/query-engine-v2/fallback-off-residual.ts) is
 * empty.
 *
 * **T3c — THE FINAL TRUTH: the census is ZERO.** Every conformance scenario runs
 * natively on V2 under `VIBORM_FALLBACK_OFF=1` (172 scenarios, both substrates,
 * byte-identical to V1) — including the two create-root parent-held-FK shapes T1
 * deferred (a non-referenced-unique connect, a shared-primary-key edge), now
 * absorbed and given census coverage ("create-root FK declines"). With the census
 * empty, the 86 remaining `new UnsupportedOperationError` throw sites fall into
 * exactly three categories, none of which is reachable accept-and-execute behavior:
 *   (i)   PARITY REFUSAL — V1 ALSO rejects the shape; the whole tree routes to V1 for
 *         V1's byte-identical typed message (a nested `update`/`delete`/`set` in a
 *         create payload; an m2m upsert/disconnect/set under create; a to-one
 *         `delete`/`update` under create that mutates the referenced row; etc.).
 *   (ii)  THE ONE DELIBERATE REFUSAL — {@link REMAINING_ROUTE} (`createMany` with
 *         both `select` and `skipDuplicates`, on a non-returning driver):
 *         inexpressible (no portable ON CONFLICT DO NOTHING that reports WHICH
 *         rows it inserted), maintainer-authorized. The `{ count }` arm of the
 *         same payload is fully supported everywhere.
 *   (iii) DOCUMENTED-DEGENERATE / NARROWER BOUNDARY — a shape one level DEEPER than an
 *         absorbed family's proven surface, whose fold value is not a compile-time
 *         literal (a deeper parent-held-FK to-one needing child-SET folding; a
 *         compound-PK child at depth; a create-context grandchild under a planned
 *         parent-held id; a shared-PK edge whose fold is a subquery / generated id /
 *         connectOrCreate). Each routes the whole tree to V1; NO conformance scenario
 *         reaches any of them (that is why the census is zero) — they are the finer
 *         boundaries every absorption from T1 onward drew, tracked in the count
 *         evolution below. A future test that DOES reach one surfaces there, not here.
 * No throw site is an accept-and-execute shape a conformance scenario reaches: the
 * census gate is the proof. P6 may delete the V1 runtime.
 */

const REMAINING_ROUTE =
  "createMany with select + skipDuplicates on non-returning drivers";

class BatchlessNonReturningMySQL2 extends MySQL2Driver {
  // Transaction-capable + non-returning: the skipDuplicates route decision is
  // reached (the ATOM §7 batch-only refusal would otherwise pre-empt it).
  override readonly supportsTransactions = true;
}

interface Case {
  readonly label: string;
  readonly construct: () => void;
}

function pgEngine(schema: Record<string, Model<any>>): QueryEngine {
  hydrateSchemaNames(schema);
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(
    new PGliteDriver({ client: new PGlite() }),
    createModelRegistry(schema, schemas)
  );
}

function mysqlEngine(schema: Record<string, Model<any>>): QueryEngine {
  hydrateSchemaNames(schema);
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(
    new BatchlessNonReturningMySQL2(),
    createModelRegistry(schema, schemas)
  );
}

describe("query-engine-v2 route inventory (P6 accounting)", () => {
  let cases: Case[];

  beforeAll(() => {
    const m2m = pgEngine(manyToManySchema);
    const compound = pgEngine(compoundKeyBehaviorSchema);
    const refusalSchema = {
      gadget: manyToManySchema.tag, // any model with a unique; only the driver matters
    };
    const nonReturning = mysqlEngine(manyToManySchema);

    const authorWhere = { tenantId_id: { tenantId: "t1", id: "a1" } };
    const accountWhere = { id: "acc-1" };

    cases = [
      // --- Absorbed in P4.5: must construct on V2 (no route). ---
      {
        label: "M2M nested create",
        construct: () =>
          new UpdateOperation(m2m, manyToManySchema.post, {
            where: { id: "p1" },
            data: { tags: { create: { id: "t1", name: "x" } } },
          }),
      },
      {
        label: "M2M nested connectOrCreate",
        construct: () =>
          new UpdateOperation(m2m, manyToManySchema.post, {
            where: { id: "p1" },
            data: {
              tags: {
                connectOrCreate: {
                  where: { id: "t1" },
                  create: { id: "t1", name: "x" },
                },
              },
            },
          }),
      },
      {
        label: "M2M nested upsert",
        construct: () =>
          new UpdateOperation(m2m, manyToManySchema.post, {
            where: { id: "p1" },
            data: {
              tags: {
                upsert: {
                  where: { id: "t1" },
                  create: { id: "t1", name: "x" },
                  update: { name: "y" },
                },
              },
            },
          }),
      },
      {
        label: "compound-FK nested update",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.author, {
            where: authorWhere,
            data: {
              posts: { update: { where: { id: "p1" }, data: { title: "x" } } },
            },
          }),
      },
      {
        label: "compound-FK nested delete",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.author, {
            where: authorWhere,
            data: { posts: { delete: { id: "p1" } } },
          }),
      },
      {
        label: "compound-FK nested set",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.author, {
            where: authorWhere,
            data: { posts: { set: { id: "p1" } } },
          }),
      },
      {
        label: "compound-FK nested upsert",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.author, {
            where: authorWhere,
            data: {
              posts: {
                upsert: {
                  where: { id: "p1" },
                  create: { id: "p1", title: "x" },
                  update: { title: "y" },
                },
              },
            },
          }),
      },
      {
        label: "compound-FK nested connectOrCreate",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.author, {
            where: authorWhere,
            data: {
              posts: {
                connectOrCreate: {
                  where: { id: "p1" },
                  create: { id: "p1", title: "x" },
                },
              },
            },
          }),
      },
      {
        label: "D4 FK referencing a non-PK unique (connect)",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.account, {
            where: accountWhere,
            data: { memberships: { connect: { id: "m1" } } },
          }),
      },
      {
        label: "D4 FK referencing a non-PK unique (update)",
        construct: () =>
          new UpdateOperation(compound, compoundKeyBehaviorSchema.account, {
            where: accountWhere,
            data: {
              memberships: {
                update: { where: { id: "m1" }, data: { role: "x" } },
              },
            },
          }),
      },
      // --- The one remaining route: must still throw UnsupportedOperationError. ---
      // Spelled through the PUBLIC routing seam, in the implicit form that is now
      // the only way to reach it (`createManyAndReturn` was removed — D-1).
      {
        label: REMAINING_ROUTE,
        construct: () => {
          constructRoutedOperation(
            nonReturning,
            refusalSchema.gadget,
            "createMany",
            {
              data: [
                { id: "t1", name: "a" },
                { id: "t2", name: "b" },
              ],
              skipDuplicates: true,
              select: { id: true },
            }
          );
        },
      },
    ];
  });

  test("exactly one tracked write shape still routes to V1", () => {
    const routed: string[] = [];
    for (const c of cases) {
      try {
        c.construct();
      } catch (error) {
        if (error instanceof UnsupportedOperationError) {
          routed.push(c.label);
        } else {
          throw error;
        }
      }
    }
    expect(routed).toEqual([REMAINING_ROUTE]);
  });

  // The corpus above exercises the *tracked* shapes; this tripwire catches the
  // untracked ones. Any new `throw new UnsupportedOperationError` site in the
  // V2 source is a new route to V1 and must be added to the corpus (and to the
  // P6 deletion accounting) — update the count only alongside that.
  //
  // 36 → 49: the create family (PLAN P6-prerequisite) added 13 sub-shape routes in
  // CreateOperation.ts.
  //
  // 49 → 51 (T1, TO-ONE.md): the parent-held to-one `create` family under create
  // roots is ABSORBED — the single "supports only 'connect' on the to-one relation"
  // decline is GONE (parent-held `create`/`connectOrCreate`, and a sibling `connect`
  // covered by a before-parent create, now construct on V2). What remains is the
  // FINER-GRAINED boundary surface of the same family, each a documented route: a
  // to-one arm with more than one kind; an unsupported kind (update/delete/…) on a
  // to-one under create; a SHARED-PRIMARY-KEY parent-held edge (the PK is supplied
  // by the fold, so the terminal read has no scalar identity); a to-one `connect`
  // by a NON-REFERENCED unique (needs a lookup subquery); and an unresolvable
  // before-parent referenced field. Net −1 (removed) +3 (finer guards) = +2. The
  // rest of the create-fold boundaries (nested update/…-kind in a create payload,
  // `createMany skipDuplicates`, compound child edge, M2M upsert/disconnect/set/
  // delete, non-record arg/where, arg-key guard) are unchanged.
  //
  // 51 → 59 (T2, TO-ONE.md §7): the to-one family under UPDATE roots is ABSORBED,
  // adding 8 FINER-GRAINED boundary routes in UpdateOperation.ts (each a documented
  // shape whose whole tree still hands to V1). The absorption removed no route (the
  // old inverse-side "supports only one-to-many child-held" decline is REPHRASED to
  // "one-to-many or inverse-side one-to-one", still one throw). The 8 new routes:
  //   inverse side — a non-boolean `disconnect`; a non-boolean `delete`; an
  //     unsupported inverse-side kind (upsert [T3] / create / set / …);
  //   parent-held (FK-holder) side — an unsupported kind (`update`/`delete`, which
  //     mutate the referenced row: V1's staged recursion); a SHARED-PRIMARY-KEY
  //     create/connectOrCreate (would rewrite the parent PK); a nested-relation
  //     target create (V1's appendCreate recursion); an unresolvable before-root
  //     referenced field; a connectOrCreate by a NON-REFERENCED unique.
  // These are the SAME finer-boundary classes T1 drew under create roots, now under
  // update. The T3 measurement (FALLBACK_OFF_RESIDUAL) showed these throw sites
  // carried 43 reachable decline scenarios across eight families — NOT the single
  // inverse-side upsert arm the pre-T3 census claimed.
  //
  // 59 → 62 (T3-r2, TO-ONE.md §7.2): family F (the inverse-side to-one `upsert`) is
  // ABSORBED, adding 3 FINER-GRAINED boundary routes (each a documented narrower
  // shape whose whole tree still hands to V1), exactly as T1/T2 added finer routes
  // when they absorbed a family:
  //   RelationWritePart.ts (+2) — the absorbed correlated upsert's create arm rejects
  //     a nested-relation create payload, and rejects a create payload that spells
  //     the owned FK (both route the whole tree to V1: V1's surface).
  //   UpdateOperation.ts (+1) — a nested inverse-side upsert while the SAME root
  //     update transitions a referenced key (the referential-action legality path
  //     V1 owns; §7.2's narrower boundary).
  // The census dropped 43 → 42 in lockstep (family F's one scenario now runs
  // natively). No route was removed; nothing was faked green.
  //
  // 62 → 65 (T3a, TO-ONE.md §7.2, family A): the FK-holder-side (parent-held) to-one
  // `update`/`delete`/`upsert` under an update root are ABSORBED (11 of family A's 13
  // scenarios now run natively). The single default throw that carried them is
  // repurposed (set/other kinds still route to V1 — unchanged count), and 3 FINER
  // boundary routes are added in UpdateOperation.ts, exactly as T1/T2/T3-r2 added
  // finer routes when they absorbed a family:
  //   (+1) a parent-held to-one arm whose FK is compound or references a non-PK
  //        unique (needs V1's staged mutation-identity resolution);
  //   (+1) a parent-held `delete` that is not the boolean `delete: true` (V1's
  //        captured targeted-delete path);
  //   (+1) a parent-held `update`/`upsert` whose located TARGET data carries a nested
  //        relation write (`author: { update: { posts: … } }`) — the parent-held
  //        projection of family B's nested-relation-in-update boundary; the 2
  //        unabsorbed family-A scenarios (the `container` shapes) live here.
  // The census dropped 42 → 31 in lockstep (11 family-A scenarios now run natively).
  // No route was removed; nothing was faked green.
  //
  // 65 → 73 (T3b-1, TO-ONE.md §7.7, family B — mechanism 1): a nested to-many
  // `update`'s located target now builds its OWN child Parts (update-arm literal-
  // parent recursion). Absorbing the 6 child-held family-B shapes adds 8 FINER
  // boundary routes, exactly as every prior absorption did:
  //   nested-target-parts.ts (+7) — the depth builder's documented narrower shapes,
  //     each routing the whole tree to V1: a deeper parent-held-FK to-one (needs
  //     child-SET folding); a non-child-held/non-inverse relation one level deeper;
  //     a compound-PK child at depth; a non-boolean inverse-to-one delete at depth;
  //     an unenumerated nested kind at depth; a relation-carrying create arm at depth
  //     (create-context depth, a later mechanism); createMany skipDuplicates at depth.
  //   RelationWritePart.ts (+1 net) — `interpretChildParts` replaces the old two-throw
  //     `scalarData` gate with three: the empty-scalar and the still-declined
  //     relation-in-update shapes (no unique `where` / bulk updateMany / no seam), plus
  //     the new "must locate the target by its primary key" boundary for a nested
  //     relation payload that does not.
  // The census dropped 31 → 25 in lockstep (6 family-B scenarios now run natively).
  // No route was removed; nothing was faked green.
  //
  // 73 → 74 (T3b-1, TO-ONE.md §7.7, family A-remainder): mechanism 1 extended to the
  // parent-held to-one `update` arm (its located target builds its own child Parts,
  // correlated to the captured PK by a `planned` source). This absorbs family B's 2
  // membership-root shapes + family A-remainder's 2, and adds 1 FINER boundary route
  // in nested-target-parts.ts — a nested create/createMany under a parent-held
  // (`planned`) target, whose FK is not a construction-time literal, routes to V1.
  // The census dropped 25 → 21 in lockstep. No route was removed; nothing was faked.
  //
  // 74 → 75 (T3b-1 fixer round 1, finding #1 — a REGRESSION re-narrowing, NOT a family
  // absorption): mechanism 1's reorder path (a nested `update` whose target rewrites its
  // own PK, its self-UPDATE emitted AFTER the child edges, the deeper FK carried old→new
  // by ON UPDATE CASCADE) over-widened the native surface. It is sound only when the
  // deeper edge cascades on update — the implicit m2m junction FK (the ONLY PK-transition
  // shape in the absorbed census). A CHILD-HELD one-to-many / inverse-side one-to-one FK
  // defaults to NO ACTION: writing the edge against the pre-transition id then rewriting
  // the PK strands it (a ForeignKeyError V1 never raises — V1 orders the edge against the
  // POST-transition id). That shape routed to V1 before mechanism 1; the new
  // `pkTransitionCascadeSafe` guard in RelationWritePart.ts (+1) routes it back to V1.
  // The census count is UNCHANGED at 21 — no conformance scenario exercises the child-
  // held PK-transition shape (that is why the gate stayed green while the divergence went
  // unmeasured); the m2m PK-transition census witnesses stay native (cascade-safe).
  // Witness: nested-update-pk-transition-cascade.test.ts. No census key moved.
  //
  // 75 → 78 (T3b-2, TO-ONE.md §7.7, family C): `RelationJunctionPart.buildJunctionParts`
  // lifts the m2m scalarOnly boundary — a junction create/update/upsert target whose
  // data carries its own relations folds them one level deeper (mechanism 2 create-arm
  // / mechanism 1 update-arm reuse). This adds THREE FINER boundary routes in
  // RelationJunctionPart.ts, each narrower than the one scalarOnly throw it replaces
  // for those arms: (a) `requireWherePk` — a relation-carrying update/upsert target NOT
  // located by its PK routes to V1 (the deeper FK must be a construction-time literal);
  // (b) `requireCreatePkValue` — a relation-carrying create arm without an explicit PK
  // (a generated identity) routes to V1; (c) `foldTarget`'s no-`nestedBuilder` guard — a
  // defensive seam documenting that a caller which does not thread the recursion
  // builder keeps the pre-T3b-2 scalar-only boundary (all three current callers thread
  // it). The 10 family-C census keys dropped in lockstep (21 → 11). `scalarOnly` stays
  // for updateMany (filter target, no literal PK) and the connectOrCreate adopt arm.
  //
  // 78 -> 81 (T3b-2, family E): `UpdateOperation.interpretChildHeldCreate` routes a
  // nested `create`/`createMany` under the update root to the literal-parent create leaf
  // (mechanism 2 create-arm). `resolveLiteralCreateParent` adds THREE finer boundary
  // routes, each narrower than the one create/createMany decline it replaces: a compound
  // referenced key, a non-literal (arithmetic) rewrite of the referenced column, and a
  // referenced column resolvable only from the located row (a planned FK) each route to
  // V1. The 2 family-E census keys dropped in lockstep (11 -> 9).
  //
  // 81 -> 86 (T3b-2, family G): `RelationUpsertPart.buildArmChildParts` accepts a
  // child-held `create` one level deeper on the connectOrCreate CREATE arm (mechanism 3
  // depth-guard relaxation). `buildCreateArmChildCreateParts` (m2m grandchild, parent-
  // held-to-one grandchild create) and `foldParentHeldConnect` (a non-connect grandchild
  // relation, a non-object connect input, a connect not locating by its referenced key)
  // add FIVE finer boundary routes — each narrower than V1's accepted one-level-deeper
  // create surface. The 1 family-G census key dropped in lockstep (9 -> 8).
  //
  // 86 -> 87 (T3b-2, named reorder obligation): `buildNestedTargetChildParts` routes a
  // deeper child-held edge whose FK references a NON-PK column of the located target to
  // V1 (the literal/planned parent id carries only the target's PK per-field, so a
  // D4-style deep non-PK reference cannot be injected — nor would it be caught by the
  // PK-only depth reorder). No census key moved (every absorbed deeper edge references
  // the target PK). Witness: nested-update-d4-deep-nonpk-reference.test.ts.
  //
  // 87 -> 88 (T3b-2, family E ordering fix): `resolveLiteralCreateParent` routes a nested
  // create whose referenced column is the parent's PRIMARY KEY that the same update
  // TRANSITIONS to V1. The fresh insert references the new PK (requires the root UPDATE
  // first), but the PK is always in `locateFields`, forcing the reorder AFTER the children
  // — which strands the insert (ForeignKeyError). This mirrors the `{ set }` PK rewrite,
  // which already routes to V1 as a non-literal. No census key (a routing regression the
  // batch-only PK-dataflow drivers surfaced). A NON-PK rewritten reference (D4) stays
  // native (not in `locateFields`, reorder stays FALSE).
  //
  // 88 -> 87 (T3c, family D): the `UpsertOperation` scalar-arms-only guard is DELETED —
  // the top-level upsert's create/update arms now compose the create-root / update-root
  // machinery (a scalar arm inline, a relation-bearing arm delegated to CreateOperation /
  // UpdateOperation sharing the upsert's scope). No new upsert route is added: a shape
  // neither root owns throws inside the delegated sub-op (the already-audited create/update
  // route surface), never a new upsert-specific site. The family D ×7 census keys dropped
  // in lockstep (8 -> 1). Family H (nested to-many upsert create-identity) added no route:
  // `assertMatchingCreateIdentity` is now GATED on the create arm carrying grandchildren
  // (its `new UnsupportedOperationError` site stays; the census key dropped 1 -> 0).
  //
  // 87 -> 86 (T3c, the two create-root declines): the parent-held to-one `connect` by a
  // NON-REFERENCED unique is ABSORBED — `toOneFkAssign` resolves it through V1's verbatim
  // `buildConnectSubqueryForField` lookup subquery, so its "must reference … directly"
  // throw is DELETED (-1). The SHARED-PRIMARY-KEY parent-held edge is absorbed for the
  // COMPILE-TIME-LITERAL sub-cases (a direct-referenced connect / a literal-id create,
  // threaded into the record identity by `resolveSharedPkIdentity`); its throw stays,
  // REWORDED to fire only when the fold value is not a literal (a non-referenced connect
  // subquery, a generated create id, a connectOrCreate) — a documented finer boundary of
  // the same "no compile-time-literal identity" class (route-inventory category iii). New
  // conformance coverage ("create-root FK declines (tx vs batch)") runs all three natively
  // fallback-off, byte-identical to V1 (dual-run confirmed).
  //
  // 86 -> 87 (T3c, family D narrower boundary): the upsert's update arm declines a
  // PARENT-HELD to-one relation (`author: { update/connect/… }`). Its probe correlates to
  // the located parent's produced FK (a `firstRowField` of the update sub-op's locate),
  // which the upsert's superset planning cannot resolve when the CREATE arm is taken (the
  // parent is absent — V1 simply never validates the untaken update branch). Routes the
  // whole tree to V1 (category iii); no census key reaches it — every family-D update arm
  // is child-held / m2m, whose planning probe reads the child by its own `where`.
  //
  // 87 -> 87 (T4a CLASS VI, a swap that nets to zero): the three CLASS VI blast-radius
  // keys are absorbed (deep create-context grandchildren under a PLANNED / create-context
  // parent id). `nested-target-parts.ts` gained the planned-parent `create` leaf
  // (`buildPlannedParentCreatePart`) whose FK inlines the located target's captured PK at
  // compile — key 1; its dead `literalFkInject` non-literal throw was DELETED (both literal
  // leaves are dispatched only for a literal parent) and a `createMany` one step past that
  // leaf (still a documented finer boundary, measured-not-curated) throws at dispatch: net
  // +1 in this file. `CreateOperation.foldCreateMany` DELETED its `nested createMany
  // skipDuplicates` decline (it now composes `buildCreateManyPlan`'s skip leaf / recoverable
  // `onUniqueConflict` effect — keys 3): net -1. `RelationUpsertPart` accepts a child-held
  // `create` on BOTH upsert arms now (key 2) — a widened condition, no throw added/removed.
  // The two deltas cancel; the surface changed, the count did not. The three keys drop from
  // BLAST_RADIUS_RESIDUAL in lockstep (43 -> 40).
  //
  // 87 -> 87 (T4c-fix, the relation-level occupied guard, a swap that nets to zero): T4c
  // wired V1's occupied guard only into the inverse-to-one `upsert`
  // (`interpretTransitionedChildUpsert`, 2 throw sites: non-single-PK, unpinned). V1's
  // guard is kind- AND cardinality-agnostic (`compileRelationKeyGuards` loops all non-M2M
  // relations), so update/delete/disconnect/create and the whole to-many family under a
  // non-cascade referenced-PK transition reached NO guard and diverged (accept-where-V1-
  // rejects — corruption / data-loss). The guard moved to the relation-level
  // `interpretReferencedKeyTransition`: the correlated / literal-parent-create kinds now
  // execute native behind it. The 2 upsert throws were DELETED; the compound / non-PK /
  // unpinned reference became a `pastSurface` regime (no throw — nested `create`/`createMany`
  // still absorb it via `resolveLiteralCreateParent`, incl. the D4 non-PK rewrite). Two new
  // throws replace them: an ADOPT decline (connect/connectOrCreate/set + to-many upsert,
  // whose empty-slot fresh FK would be orphaned by the transition — their post-transition
  // adopt is V1's) in the classifier, and a `pastSurface` non-create decline in
  // `interpretRelation`. Net -2 + 2 = 0. No new BLAST_RADIUS_RESIDUAL entry: both declines
  // are category-iii narrower boundaries reached by no estate test.
  //
  // 87 -> 90 (X1, THE DEPTH LIFT — the first genuinely new capability, not an absorption):
  // a nested `create` under a LOCATED target may now carry its own create-context
  // grandchildren to ARBITRARY depth. The fresh child's own primary key is a
  // construction-time literal, so it is a `literalParentId` for its grandchildren — the
  // SAME `buildNestedTargetChildParts` seam, one level deeper, no counter (level N and
  // N+1 run identical code; a create chain of any depth folds into a plain INSERT list).
  // This is a DEPTH-ONLY lift: the two `does not support nested relation writes in the
  // create data ... one level deeper` throws (the literal- AND planned-parent leaves,
  // category-iii "narrower boundary" for exactly this shape) are DELETED (-2). Five FINER
  // boundary throws replace them in `nested-target-parts.ts`, each a REAL seam difference
  // (not a depth cap), reached by no create-context chain of pure creates:
  //   `buildFreshCreateGrandchildParts` (+2) — a compound-PK fresh child (not a single-
  //     field literal parent), and a database-generated (auto-increment) fresh child (no
  //     construction-time PK literal; its grandchild FK would need a backward Ref, the
  //     root create-tree's mechanism this fresh-parent leaf does not thread);
  //   `assertFreshCreateContext` (+3) — an m2m, a parent-held-FK, or an adopt-family kind
  //     (connect/connectOrCreate/upsert/set) grandchild under a fresh create, each needing
  //     CreateOperation's GLOBAL fresh-parent elision, not the correlated probe this seam
  //     builds. Net -2 + 5 = +3. SEMANTIC refusals are untouched: every parity/own-write/
  //     referential-action/atomic-resolution/skipDuplicates throw fires byte-identically at
  //     every depth (X1 semantic-stability witnesses pin this). See PLAN "X1 — the depth
  //     lift" and ATOM §8.1.
  //
  // 90 -> 89 (X2 deliverable 1, THE TYPED PARSE BOUNDARY): the five local parse seams
  // (`parseRecord`/`validateCreateArgs`/`validateUpdateArgs`) collapse into the single
  // `parseValidated` (parse-boundary.ts). Each seam's post-validate `isRecord(result.value)`
  // re-check is a DEAD branch — `object.ts:392` already fails a non-object with a
  // `ValidationError` before the guard could fire — so the boundary makes it unreachable by
  // construction and returns the schema's inferred output type instead of erasing it. Only
  // ONE of those five posts threw `UnsupportedOperationError` (CreateManyOperation's "requires
  // an object argument"); the other four threw `QueryEngineError` (never in this census). Net
  // -1. No route removed. See PLAN "X2 — one home for validation" and ATOM §8.1.
  //
  // 89 -> 84 (X2 deliverable 2, THE DELETION — dead guards that throw
  // `UnsupportedOperationError`): net -5, and NO route was removed — every deleted site is a
  // re-validation branch the schema layer already shadows, or a capability guard the type
  // system now makes structurally impossible. Each is unreachable at RUNTIME, so its
  // disposition (a route to V1, in the pre-P6 world) is moot: no conformance shape reaches
  // it. The five:
  //   (1-3) THREE PRE-VALIDATE KEY GATES — `assertCreateKeys`, `assertDeleteKeys`,
  //         `assertUpdateKeys` — each shadowed by the whole-args `parseValidated` that runs
  //         right after it: strict mode + `atLeast` reject the SAME unknown-key / missing-
  //         required-key payloads, with a precise per-key `ValidationError` instead of the
  //         gate's coarse `UnsupportedOperationError`. Authorized error-class change: a
  //         malformed top-level create/update/delete payload now raises the schema's
  //         `ValidationError`, not the gate's `UnsupportedOperationError`. No test pinned the
  //         old class (the estate never fed a malformed top-level payload).
  //   (4)   `DeleteOperation.requireRecord` — the local `'... must be an object'` shape
  //         helper, dead once the whole-args `args.delete` parse guarantees the object shape.
  //   (5)   THE DEAD-CAPABILITY GUARD — `RelationJunctionPart`'s `!input.nestedBuilder`
  //         throw. T3b-2 threads `nestedBuilder` at all three `buildJunctionParts` callers;
  //         X2 made its type non-optional, so `!input.nestedBuilder` is unconstructible and
  //         tsc proves no caller can fall back to the scalar-only boundary. The `foldKind`
  //         param that fed only this throw was removed too.
  // `assertUpsertKeys` + `UpsertOperation.requireRecord` are the FOURTH-key-gate exception,
  // KEPT deliberately (X2 conflict): upsert has no whole-args parse — its create/update arms
  // are delegated to CreateOperation/UpdateOperation sub-ops that re-parse the RAW payload
  // fresh, so a whole-args `parseValidated(args.upsert)` both (a) feeds the arms a transformed
  // OUTPUT the sub-op then re-parses (regressed `nested-create-many`: "Expected string" on a
  // non-idempotent transform) AND (b) validates the UNTAKEN update arm's structure upfront,
  // which `deferArmLegality` deliberately forbids. Kept; see PLAN "X2".
  // The remaining requireRecord / normalizeSingle / normalizeItems / isRecord narrowings on
  // payload paths are runtime-unreachable too, but they are `unknown -> Record` TYPE
  // narrowings (dynamic `data[relationName]` / `spec.create` widen to `unknown`); removing
  // them needs precise per-relation types threaded through `interpretRelation` and every
  // Part builder — a large type refactor deferred past X2, not a mechanical deletion. They
  // throw `QueryEngineError`, never `UnsupportedOperationError`, so they are outside this
  // census. See PLAN "X2 — one home for validation" and ATOM §8.1.
  //
  // 84 -> 83 (X1b mechanism 3, createMany skipDuplicates AT DEPTH — a depth-only lift, no new
  // boundary): `buildLiteralParentCreateManyPart` (nested-target-parts.ts) DELETED its `does not
  // support nested createMany skipDuplicates ... one level deeper` throw (-1). It now composes
  // `buildCreateManyPlan`'s skip leaf (SQL `ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`) plus the
  // pre-injection portability guard + the `recoverableUniqueError` (MySQL) per-row
  // `onUniqueConflict: skip` effect — byte-identical to `CreateOperation.foldCreateMany` (T4a
  // CLASS VI), one level past the create root. The default-only-row parity refusal
  // (`assertPortableCreateManySkip`) STILL fires at depth. No FINER boundary is introduced (the
  // composed skip is total for the createMany leaf). See PLAN "X1b" and ATOM §8.1.
  //
  // 83 -> 78 (X1b mechanisms 1 (fresh) + 2 + 4, THE FRESH-CREATE-SUBTREE REUSE — a depth lift
  // that CONSOLIDATES two create-tree implementations into one): a relation-carrying fresh
  // `create` at depth is now a create SUBTREE delegated to the create-ROOT machinery
  // (`CreateOperation` `nestedFresh` mode — a shared scope, no re-parse, no terminal, the located
  // parent's FK folded into the root INSERT). Every mechanism the create root already carries
  // falls out at any depth: a database-generated / compound PK (produced id threaded as a backward
  // `Ref` / per-field identity — mechanism 2), a parent-held-FK to-one grandchild (a before-parent
  // create — mechanism 1 fresh projection), and the fresh-parent adopt family + M2M (the GLOBAL
  // elision, ATOM §4 — mechanism 4). The FIVE bespoke fresh-context throws are DELETED (-5):
  // `buildFreshCreateGrandchildParts` (compound-PK + generated-PK) and `assertFreshCreateContext`
  // (m2m + parent-held-FK + non-create-kind) — both functions removed, their duty subsumed by the
  // create root. No new throw site: the shapes those five declined now either EXECUTE natively or
  // raise the create root's OWN already-counted refusal (an M2M `upsert` under create, a compound
  // child edge, …) — one home for the create tree, the SEMANTIC refusals byte-identical at depth.
  // See PLAN "X1b" and ATOM §8.1.
  //
  // 78 -> 76 (X1c — NO ENGINE DEPTH LIMIT, the FINAL boundary: the located-UPDATE-target
  // projection of mechanisms 1/2 LIFTED). The two retained `nested-target-parts.ts`
  // throws — a nested UPDATE target whose data carries a parent-held to-one write
  // (child-SET folding: the deeper target's identity folded into the located target's OWN
  // update SET) or a non-PK / compound referenced edge (D4) — are DELETED (-2). The whole
  // located target's update now delegates to an `UpdateOperation` `nestedTarget` sub-op
  // (the update-root analogue of X1b's `nestedFresh` create-root reuse): a shared
  // `StepScope`, no whole-args re-parse, no terminal read, and a CORRELATED locate
  // (`child.<fk> = parent.<referenced>`, technique #1, the cross-parent membership check
  // the located-target leaf enforced) so a wrong-parent selector still yields V1's verbatim
  // `Cannot update relation … for this parent`. Every mechanism the update root already
  // carries falls out at any depth: a parent-held to-one before-root write folded into the
  // SET, a generated / D4 referenced identity threaded from the located row, the
  // PK-transition reorder. Delegated at ALL THREE callers — the child-held leaf
  // (`buildToManyUpdateParts` / `buildToOneUpdatePart`), the parent-held A-remainder
  // (`tryDelegateParentHeldUpdate`), and the m2m junction (`buildJunctionParts`'
  // update / create / upsert arms, the fresh create arm reusing `CreateOperation`
  // `nestedFresh`) — so the two `foldOneNestedRelation` branches are unreachable by
  // construction and become fail-closed `QueryEngineError` internal invariants (NOT
  // `UnsupportedOperationError` routes; they carry no reachable behavior). No new route
  // site: the delegated sub-ops raise the update/create ROOT's OWN already-counted
  // refusals at depth. See PLAN "X1c" and ATOM §8.1.
  //
  // 76 -> 77 (M2M generated-PK junction create, the P6 regression fix): create /
  // connectOrCreate through the junction now support a DB-generated (auto-increment)
  // target primary key — the child INSERT *produces* the identity (firstRowField /
  // insertId) and the join row references it by a backward Ref — so the shared
  // `requireCreatePk` site NARROWED into two: `resolveCreatePk` (create/connectOrCreate;
  // still refuses an explicit-null / non-increment absent PK) and `requireCreatePk`
  // (the upsert create arm ONLY, whose compile-time dedup ledger and duplicate-item
  // UPDATE address the target by a literal — an honest typed refusal, never silent
  // wrongness). Net +1 site; the absorbed accept-and-execute shape is covered by the
  // shared M2M behavior suite (generated-PK fixture) on every driver leg.
  //
  // 77 -> 78 (upsert create-arm read-back addresses the WRITE, review rounds U1 + U1b): the
  // scalar create arm no longer reads its created row back through the `where`'s unique
  // discriminator. `create` is under no obligation to satisfy `where`, so the discriminator
  // could name a DIFFERENT live row — with an extended `where` (unique key matches, filter
  // excludes → create arm) it named exactly the row the filter had excluded, and the upsert
  // returned a record it never wrote. `UpsertOperation.createArmIdentity` now decides from the
  // CREATE DATA, in this order: a literal primary key; a COMPLETE unique constraint of the
  // model the create data carries (a single `.unique()` column, or every column of one compound
  // unique — that constraint names exactly the row this INSERT wrote, and like the literal PK
  // it never consults the `where`); or — for a single DB-generated `increment` PK — the identity
  // the INSERT captures (firstRowField / insertId), the same capture `CreateOperation`'s root
  // INSERT performs. Its `else` is the NEW site (+1): a create payload spelling NONE of the
  // three names no row to read back, so it is an honest typed refusal raised only when the
  // create arm is actually TAKEN — never a silently wrong row.
  //
  // WHAT THE REFUSAL ACTUALLY COSTS (corrected in review round U1b; the first cut of this
  // paragraph claimed "no shape that previously ANSWERED is refused", which was FALSE). U1's
  // first cut accepted only the first and third sources, and that DID refuse a shape that had
  // answered at ea1f637^: a compound PK with one `increment` member, whose `create` carries some
  // other complete unique — e.g. `.id(["tenantId","seq"])` with `seq` generated and a unique
  // `email` in the create data. It had answered only because the old read-back went through the
  // `where`, i.e. by the very mechanism that returned wrong rows; the second source restores it
  // on an identity derived from the create data instead, so it answers again and answers
  // CORRECTLY (witness: "compound PK with a generated member reads back by the create-data
  // unique", extended-where-unique.test.ts). What remains refused is a create payload with no
  // complete identity of any kind — chiefly a generated COMPOUND PK with no other unique. The
  // mitigating context, verified live: a root `create` on that same model is ALREADY refused
  // upstream by mutation-identity.ts:44 ("Nested create cannot propagate generated compound
  // primary keys"), and `createMany` / `findMany` on it work — so the refusal narrows a model
  // that was never fully writable through the single-row create path either. See PLAN
  // "W4-U1 — Correction (review round U1)".
  //
  // 78 -> 77 (N1-U1, the located-parent Ref): DELETED —
  // `UpdateOperation.resolveCreateParent` (was `resolveLiteralCreateParent`), "nested
  // create on relation '…' requires the referenced parent column '…' to be pinned by the
  // unique where or rewritten by the update". Its stated cause was literal-only
  // propagation, verbatim: the value WAS knowable — the update's own locate reads the
  // row — but the create leaf accepted only a compile-time literal, so
  // `update({ where: { email }, data: { posts: { create } } })` refused while the
  // `where: { id }` spelling worked. The site is gone, not narrowed: when the
  // discriminator does not name the referenced column, the column joins the locate's
  // select + `firstRowField` outputs and the create/createMany leaf resolves its foreign
  // key from THE LOCATED ROW at compile (`plannedParentId` → `referencedFieldValue`),
  // never by re-consulting the `where` (the W4 wrong-row doctrine).
  //
  // What the absorption is measured against: `located-parent-ref-behavior.ts` on every
  // driver leg and both substrates (state parity between the two spellings, the wrong-row
  // decoy, the D4 non-PK referenced column, createMany, the X1b create subtree);
  // `located-parent-ref.test.ts` for PLAN parity (same statement count, same write SQL)
  // and staleness injection (the foreign key follows the locate's returned value; a value
  // corrupted to a non-existent key fails closed; an absent declared output fails closed
  // at planning); `staleness-injection.test.ts` for the race story (a concurrent parent
  // delete aborts the batch typed, no orphan written).
  //
  // Two tests were RETARGETED by this edit, both deliberately and both from a decline to
  // an accept-and-execute assertion on the SAME payload:
  //   · `nested-update-d4-deep-nonpk-reference.test.ts` — the X1c depth-2 case (a nested
  //     update target whose grandchild FK references a non-PK unique of that target). Its
  //     decline WAS this same site raised by the delegated update root; it now asserts the
  //     persisted grandchild carries the located target's `code`, with a second org whose
  //     code differs so "any row's code" cannot pass.
  //   · `extended-where-unique-behavior.ts` — "a filter naming the referenced column pins
  //     NOTHING". CORRECTED in the N1 fix round: this entry first claimed the Pin Rule
  //     content was "unchanged and still witnessed" by the two retargeted AND cases. It
  //     was not. The deleted `UnsupportedOperationError` assertion had been the estate's
  //     only behavioral falsification of the filter half, and neither AND case can
  //     replace it — with the filter ANDed into the locate, an AND branch either names
  //     the located row's own value (both provenances coincide) or names another row's
  //     and the locate finds nothing (no write, whatever the provenance). Measured: a
  //     `locatedCreateParent` mutated to read `where.AND` as a pin passed all 68. The
  //     falsification is restored by a THIRD case — an OR filter half carrying another
  //     row's referenced value, in both branch orderings, where the locate still succeeds
  //     and a filter-as-pin writes a live-but-wrong foreign key (that mutation fails it on
  //     both substrates: `accountId: 2` for `accountId: 1`).
  //
  // 77 -> 77 (N1-U2, compound referenced keys): NARROWED, not deleted.
  // `resolveCreateParent`'s compound throw fired for EVERY compound reference; it now
  // fires only when the root SET also REWRITES a member, and says so. No mechanism was
  // added: a compound foreign key is per-field (ATOM §1's multi-field produces), the
  // leaf's inject already loops the foreign-key columns index-aligned with the referenced
  // ones, and `referencedFieldValue` resolves each BY NAME from the one located row — so
  // U1's `plannedParentId` covers arity ≥ 2 by construction. What N1-U2 changed is the
  // gate in front of it: every referenced column is registered in `locateFields`, and the
  // compound refusal moved BEHIND the rewrite test instead of in front of it.
  //
  // The surviving cause is ordering, not dataflow: the located row carries the
  // PRE-transition members, and referencing the post-transition tuple means ordering the
  // fresh INSERT against the root UPDATE per member — N5's unit. Witnessed by the compound
  // block of `located-parent-ref-behavior.ts` (compound PK by its own where-unique; the
  // same PK located by a `handle` unique naming NEITHER member, with a sibling sharing
  // `tenantId`; a compound NON-PK referenced unique with a sibling sharing `region`) and
  // by the compound staleness probe (corrupting ONE member moves the whole tuple — the
  // proof that every member travels from the same located row).
  //
  // MERGE NOTE (N2 and N3 were built in parallel on N1's tip and cherry-picked onto this
  // branch, N2 first). Each lane started from 77 and each wrote its entries where its own
  // author placed them relative to N1-U4's sweep — N3's here, ABOVE the sweep; N2's after
  // it. That is why the file order (N3 then N2) is the reverse of the commit order (N2 then
  // N3). Nothing about the chain depends on which order you read it in: the two lanes touch
  // DISJOINT sites, so their deltas commute. Read in file order the chain is
  // 77 -1 +1 +0 (N3) = 77, then -1 (N2) = 76; read in commit order it is 77 -1 (N2) = 76,
  // then -1 +1 +0 (N3) = 76. Either way the pin below is 76, and the pin is measured by
  // counting the sites, never derived from this arithmetic.
  //
  // 77 -> 76 (N3-U1, `createMany` through a junction): DELETED — `buildJunctionParts`'
  // `default:` arm, "query-engine-v2 does not support nested 'createMany' on many-to-many
  // relation '…'". `createMany` was the LAST `RelationMutationKind` with no junction arm,
  // so the arm that refused it was a catch-all standing in for exactly one kind. It is
  // absorbed with no new mechanism: `createMany` reuses the `create` slot (per-row child
  // INSERT then join row, the produced-identity backward `Ref` when the target key is
  // DB-generated, the same one-level-deeper fold), plus `skipDuplicates` riding each
  // row's INSERT through `buildCreateMany` — the SAME builder the root and child-held
  // `createMany` families use, so the per-dialect split (`ON CONFLICT DO NOTHING` /
  // `INSERT OR IGNORE` as a SQL leaf, the savepoint-wrapped `onUniqueConflict: "skip"`
  // effect on MySQL) is decided in one place. Under the CREATE root the same shape opens
  // by adding `createMany` to `assertCreateTreeKinds`' allowlist (that site NARROWS, it
  // does not disappear: upsert / disconnect / set / delete / update / updateMany /
  // deleteMany address a PRE-EXISTING membership a fresh parent cannot have). With every
  // kind now handled the `default:` becomes an exhaustiveness `never` check — a
  // `QueryEngineError` internal invariant no payload reaches, NOT a route.
  //
  // Semantics pinned deliberately (Prisma has no M2M `createMany` to match): a
  // `skipDuplicates` skip drops the CHILD ROW's insert; the JOIN ROW is a different row,
  // never itself a duplicate of what the data spells, and is written for every item. So a
  // duplicate item leaves the pre-existing target untouched AND still links it. Both
  // halves are asserted on one call in `junction-create-many-behavior.ts`. The rejected
  // alternative — skip the join too — is not decidable at compile without a probe, and
  // would make a duplicate item silently do nothing.
  //
  // Falsified: re-adding the refusal to the `createMany` arm fails 14 of the suite's 24
  // witnesses (both substrates).
  //
  // 76 -> 77 (N3-U1, the new refusal the absorption REQUIRES): `resolveCreatePk` now
  // refuses `skipDuplicates` when the target primary key is DB-generated. This is the one
  // shape the produced-identity `Ref` genuinely cannot express: a skipped INSERT writes no
  // row, so it produces no identity, and every dialect degrades differently — PostgreSQL's
  // `ON CONFLICT DO NOTHING … RETURNING` yields zero rows, while SQLite's `INSERT OR
  // IGNORE` and MySQL's rolled-back savepoint leave `insertId` at the PREVIOUS insert's
  // value, a LIVE key belonging to an unrelated row.
  //
  // MEASURED, not argued (the refusal deleted, SQLite3 batch-only, `n3_labels` seeded
  // `other`=1 then `existing`=2, article=1): `labels: { createMany: { data: [{ slug:
  // 'existing' }], skipDuplicates: true } }` RESOLVED SUCCESSFULLY and joined the article
  // to label 1 (`other`) — not label 2, the row the data named. No error, no constraint
  // violation, no guard able to see it: the junction's foreign key was satisfied by the
  // stale id. The same mutation on the RETURNING transaction path fails loudly
  // (`TransactionError: Step 'label.create' did not produce row field 'id'`), which is why
  // this has to be a CONSTRUCTION-time refusal rather than a lowering the executor catches.
  // Supplying the primary key in the createMany data, or dropping `skipDuplicates`, both
  // execute — so the refusal is a boundary on one combination, not on a feature.
  //
  // 77 -> 77 (N3-U2, a generated create-arm key in upsert-through-junction): NARROWED.
  // `requireCreatePk` — "upsert-through-junction … requires the target primary key '…' in
  // the create data" — refused EVERY create arm whose data omitted the target primary key.
  // Its stated cause was that the arm's same-operation dedup ledger and its duplicate-item
  // UPDATE address the target by that literal. W4's closure gave the plain `upsert` a
  // SECOND identity source — a create payload spelling a COMPLETE unique constraint names
  // the row it is about to insert — and the junction arm now takes the same one
  // (`createDataUniqueWhere`, lifted to `shared.ts` so both askers ask once). The join row
  // rides the produced `Ref` the create / connectOrCreate arms already build; the ledger
  // key and the duplicate's UPDATE `where` ride the create-data unique, so no `Ref` ever
  // reaches a `where`, and the identity derives from the row the INSERT ACTED ON (its own
  // data) rather than from re-reading the item's `where` (the W4 wrong-row doctrine).
  // The site survives, with its message naming exactly what is missing: neither the target
  // primary key nor any complete unique constraint of the target model.
  //
  // HONEST QUALIFICATION, measured while doing this. The ledger justification the old
  // refusal rested on is currently VACUOUS: the own-write preflight rejects any SECOND
  // `upsert` item on one many-to-many relation — even two items with disjoint explicit
  // primary keys — because a junction upsert reads membership and an earlier item writes
  // it (A14). So `compileUpsert`'s duplicate branch is unreachable from the client and
  // operation surfaces, and the refusal it justified was stricter than any reachable
  // behavior required. The ledger is nonetheless keyed correctly here rather than left to
  // mis-key if the preflight ever relaxes, and the unreachability itself is now pinned by
  // a witness ("TWO upsert items on one M2M relation are the own-write preflight's, not
  // the ledger's") that fails the moment the preflight changes.
  //
  // Falsified: reinstating the literal-primary-key-only requirement fails 4 of the 24
  // witnesses (both substrates). One estate test was RETARGETED from a decline to an
  // accept-and-execute assertion on the SAME payload — `many-to-many-behavior.ts`'s
  // "upsert through the junction with a generated create-arm PK is an explicit typed
  // refusal", now "… creates a target whose PK the database generates", asserting the join
  // row carries the id THIS INSERT produced and not a decoy label's.
  //
  // N3-U3 (compound-PK M2M) changed NOTHING here, deliberately, and neither of its two
  // refusals is an `UnsupportedOperationError` (a `QueryEngineError` on the query side,
  // a plain `Error` in the migrations serializer), so neither was ever in this count. The
  // measurement is in the N3 delivery record: the junction's whole vocabulary is scalar to
  // its root — including the PUBLIC `.A()` / `.B()` schema API, which names exactly one
  // junction column per side — so a compound side cannot even be SPELLED, let alone
  // queried or migrated. Both sides refuse identically, at construction / DDL, before any
  // I/O. Re-justified, not absorbed; the follow-up is named in the plan.
  //
  // N1-U4 — THE SWEEP. Every surviving site whose stated reason cites a PIN, a
  // COMPILE-TIME LITERAL, or "must locate by its primary key … so the value is known",
  // with the located-parent Ref explicitly considered. Two verdicts only: absorbed (above),
  // or kept with the reason the Ref does not close it AND the wave that owns it.
  //
  // (a) `UpdateOperation.resolveCreateParent`, compound-key throw — NARROWED by N1-U2; the
  //     surviving cause is a REWRITTEN member. Ref reaches the value; the post-transition
  //     tuple is an ORDERING question against the root UPDATE. Owner: N5.
  // (b) `UpdateOperation.resolveCreateParent`, "transitions primary key … pre-transition
  //     value is not pinned by the unique where" — the Ref DOES reach the pre-transition
  //     value (the locate row carries it), so this is not a dataflow gap; the absorption
  //     needs the post-transition derivation ordered against the root UPDATE. Owner: N5-U2,
  //     which the plan names "located-only pre-transition PK".
  // (c) `UpdateOperation.resolveCreateParent`, "references a non-literal rewritten column"
  //     — Ref does NOT help: the value comes from the root SET, not from the located row.
  //     What would close it is `{ set: v }` unwrapping (`classifyRelationKeyScalarUpdate`
  //     already calls that shape "resolved"), a normalization question, not a Ref one.
  // (d) `UpdateOperation.interpretRelation`, "nested '<kind>' … while the root update
  //     transitions a compound / non-PK / unpinned referenced column" — the "unpinned"
  //     third of its cause is now reachable by the Ref, but the site guards V1's OCCUPIED
  //     GUARD (a correlated read of the pre-transition slot), not a create's FK. Owner: N5.
  // (e) `RelationWritePart` / `RelationUpsertPart` / `RelationJunctionPart`, the "must
  //     locate the target by its primary key so the deeper foreign key is a known value"
  //     family (3 sites) — the Ref generalizes there exactly as it does here: the target's
  //     own locate can RETURN its primary key. That is N4-U1's unit verbatim; kept so the
  //     wave that owns it does the measurement rather than this one guessing.
  //     SETTLED by N4-U1: two of the three DELETED, the third NARROWED — see the
  //     74 -> 72 and the junction entries below.
  // (f) `nested-target-parts.ts`, "createMany … under a parent-held target one level
  //     deeper" — N1 built the planned-parent createMany leaf this site would consume, but
  //     the site guards the PARENT-HELD probe provenance (a probe on the target, not the
  //     root locate), and it is the decline-surface gate's live tripwire. Owner: N4-U3.
  //     SETTLED by N4-U3: DELETED — see the 74 -> 72 entry below.
  // (g) `CreateOperation`'s "cannot resolve referenced field / the parent id" (3 sites) and
  //     "shared-primary-key … not a compile-time literal" — the Ref is structurally
  //     unavailable: a CREATE root has no locate step, its parent is FRESH, and referenced
  //     values come from the record's own identity (a literal, or a backward Ref to its own
  //     INSERT). What these need is a wider notion of a fresh record's identity, or the
  //     shared-PK fold N4-U4 owns — not a located-parent read.
  // (h) `RelationJunctionPart`'s "requires the target primary key in the create data"
  //     (3 sites) — the target of an M2M create is FRESH; there is no located row to read.
  //     Owner: N3 (the junction's produced-identity path). SETTLED by N3-U2 for the
  //     upsert site (narrowed to the create-data-unique identity source, see the
  //     77 -> 77 entry ABOVE — N3's entries sit before this sweep, see the MERGE NOTE);
  //     the other two are unchanged, and both are honest: one
  //     refuses an explicit-`null` / non-increment absent PK (`resolveCreatePk`), the
  //     other a RELATION-CARRYING create arm whose deeper child Parts fold against a
  //     compile-time `literalParentId` (`requireCreatePkValue`) — the latter is the
  //     literal-parent precondition N4 owns, not a produced-identity question.
  // (i) "requires a child with one primary key" (`UpdateOperation`, `nested-target-parts`,
  //     `RelationUpsertPart` — 3 sites) — NOT a literal-propagation cause at all: these
  //     read the CHILD's own primary-key arity to address a targeted mutation, which no
  //     parent-side dataflow supplies. Listed so the sweep is complete, not because the Ref
  //     was ever a candidate.
  // (j) `UpsertOperation`'s create-arm read-back identity — the create arm writes a FRESH
  //     row; there is no located parent. Its identity comes from the create data or the
  //     INSERT's own capture (W4-U1 above), which is the correct mechanism already.
  //
  // 77 -> 76 (N2-U1, the inverse-side to-one `create`): DELETED —
  // `UpdateOperation.interpretInverseToOneKind`'s `default`, "does not support nested
  // '<kind>' on the inverse-side to-one relation". It named create / createMany / set /
  // updateMany / deleteMany, and `create` was the only one of the five the parse boundary
  // could ever deliver (see the U2 measurement below) — so what the site actually refused
  // was `user.update({ where, data: { profile: { create: { bio } } } })`, the mainstream
  // Prisma shape and the last declining write kind on this relation.
  //
  // It needed no mechanism. An inverse-side to-one create is the ARITY-1 case of the
  // child-held create the update root already builds, so the `create` case now enters
  // `interpretChildHeldCreate` unchanged and inherits BOTH N1 provenances: the
  // construction literal when the unique `where` pins the referenced column, the
  // located-parent Ref when it does not. What made the site look special was the
  // OCCUPIED-SLOT rule, and that needs no engine guard either: the 1:1 foreign key always
  // carries a UNIQUE constraint (`FK008` refuses to DEFINE a 1:1 without one; the DDL
  // serializer adds it if a schema ever arrives without it), so a create into an occupied
  // slot raises `UniqueConstraintError` with nothing written — Prisma's observable. A
  // pre-check SELECT would be a SECOND guard on that one invariant (the AGENTS.md ban) and
  // a racy one besides, so there is none, and `inverse-to-one-create.test.ts` measures its
  // absence in the statement stream rather than asserting it.
  //
  // The race attribution is part of the contract and is pinned, not assumed: the leaf
  // carries no `racePin`, so `race-retry.ts` reads the violation as matching no pin and
  // not `meta.raceable` — a genuine conflict, NOT a retryable race. Measured through the
  // ROUTED client (the layer that owns the retry): exactly ONE INSERT reaches the
  // database, and zero SELECTs against the child table.
  //
  // A detail that makes the site's disappearance the removal of an INCONSISTENCY rather
  // than a new capability: `nested-target-parts.ts`'s `create` case has no
  // `isInverseToOne` branch at all — one level deeper, an inverse-to-one create already
  // built the same child-held leaf. Only the ROOT dispatch refused it.
  //
  // The `default` did not become a route with a narrower message — it became a
  // `QueryEngineError`, which is why the count drops by a whole site. The dispatch is now
  // TOTAL over the parse boundary's inverse-to-one surface, so reaching `default` would
  // mean the schema emitted a key it does not define: an engine invariant break, not a
  // shape we decline. Same disposition X1c gave `foldOneNestedRelation`'s two branches.
  //
  // Witnessed by `inverse-to-one-create-behavior.ts` on every driver leg and both
  // substrates (the pinned and Ref spellings persisting the same shape; the wrong-row
  // decoy staying empty; a D4 non-PK referenced column threaded from the located row; the
  // created child carrying its own nested writes one level deeper; the occupied slot
  // rejecting under BOTH provenances with the root's own scalar write rolled back too;
  // and a no-matching-row abort). Falsified: restoring the refusal fails 19 of the file's
  // 22 tests, and the 3 survivors are exactly the parse-boundary surface pins, which do
  // not depend on the absorption.
  //
  // N2-U2 — MEASURED, and the answer was "nothing to build". Prisma 7.9.1 (`prisma
  // generate`, `prisma-client` generator, `User.profile: Profile?` beside
  // `User.posts: Post[]`) types the inverse-to-one nested update as
  // `{ create?, connectOrCreate?, upsert?, disconnect?, delete?, connect?, update? }` and
  // puts `createMany` / `deleteMany` / `updateMany` / `set` ONLY on the to-many input. So
  // Prisma does not offer nested createMany/deleteMany on a to-one — and neither does
  // viborm: `toOneUpdateFactory` emits exactly those seven keys. There was no engine arm
  // owed AND no validation key to remove; the surface already matched. The unit's
  // deliverable is therefore a PIN (`inverse-to-one-create.test.ts`: the offered key set
  // equals Prisma's, and each to-many-only key is refused on the to-one while `create` is
  // accepted beside it), so neither direction can drift silently.
  //
  // N2-U3 — the plan's premise was FALSIFIED, and the surviving refusals are re-justified
  // rather than kept as written. The plan carried the object-form `disconnect` / `delete`
  // declines as "believed Prisma-parity (booleans only on to-one)". The generated types
  // say the opposite: Prisma 7.9.1 types BOTH as `ProfileWhereInput | boolean` — a filter
  // narrowing which connected record is disconnected/deleted, the to-one analogue of
  // W4-U3's `update: { where, data }` wrapper viborm already has. Two corrections follow.
  //   · The object form is NOT a Prisma-parity refusal. It is a genuine viborm surface
  //     gap, and it is a VALIDATION one: `toOneUpdateFactory` types both keys
  //     `v.boolean()`, so the object form is refused at the PARSE boundary and never
  //     reaches these throws. Closing it is a schema widening (`boolean | where`) plus a
  //     filtered disconnect write — an absorption, not a re-audit, and deliberately not
  //     smuggled into this wave. NAMED GAP, owner: a follow-on unit.
  //   · What these two sites DO refuse, and all they refuse, is the literal `false`. That
  //     is their whole reachable surface, and it is now pinned in both directions
  //     (`false` throws, `true` does not) so the message cannot outlive its cause.
  //
  // ---------------------------------------------------------------------------
  // MERGE NOTE (N4 + N5 landed from two parallel lanes off the same base).
  // ---------------------------------------------------------------------------
  // Both lanes measured their delta from census 76 — the count at
  // `f49047b`, the base each lane branched from — so each lane's own record
  // opens "76 -> …". They are sequenced here in the order they were merged, N4
  // first, and the SECOND lane's arithmetic is restated against the count the
  // first one left rather than against 76. No entry's reasoning changed; only
  // the running number in the N5 headings, and the final pin, were re-based.
  // The pin below is not arithmetic: it is the number this file MEASURES by
  // counting `new UnsupportedOperationError(` across the engine directory, and
  // it was re-derived by running the test after both lanes were applied.
  //
  // The merge is NOT net-zero, and its own entry is the last one below: the two
  // absorptions INTERSECT inside `RelationWritePart.interpretChildParts`, and
  // their intersection wants a value neither lane's mechanism can produce. One
  // site was added for it, so the sequence is 76 -> 74 (N4) -> 73 (N5) -> 74
  // (merge). A lane's own certification cannot catch that shape — it is green
  // in each worktree separately — which is why it is recorded here as a merge
  // finding rather than folded into either lane's entry.
  //
  // The two lanes touch DISJOINT sites. N4 edits the depth seams
  // (`RelationWritePart.interpretChildParts`, `RelationUpsertPart`'s arm split,
  // `RelationJunctionPart`'s located-target wall, `nested-target-parts`' planned
  // createMany); N5 edits the ORDERING boundaries
  // (`UpdateOperation.interpretReferencedKeyTransition`'s A15 adopt throw,
  // `RelationWritePart`'s non-cascade deeper-edge throw, and the two
  // `resolveCreateParent` messages). The one FILE both lanes changed is
  // `RelationWritePart.ts`, and even there the two edits are in different
  // methods — N4 in `interpretChildParts`' parent-id provenance, N5 in the
  // transition ordering and the new `RelationKeyOccupiedPart`.
  //
  // ---------------------------------------------------------------------------
  // N4 — the depth seams. 76 -> 74, in three edits and one net-zero replacement.
  // ---------------------------------------------------------------------------
  //
  // 76 -> 75 (N4-U3, sweep entry (f)): DELETED — `nested-target-parts.ts`'s
  // "does not support a nested createMany on relation '…' under a parent-held target one
  // level deeper". The site's own comment called itself "measured-not-curated", and the
  // measurement, done here, says it was guarding NOTHING: N1-U1 had already built
  // `buildPlannedParentCreateManyPart` for the update ROOT's bulk arm, and the `create`
  // case two lines above already dispatched literal-vs-planned. This one caller had simply
  // not been handed the planned builder. The edit is that dispatch, verbatim.
  //
  //   The N3-U1 wall does NOT recur here, and the difference is worth stating because the
  //   plan flagged it: N3's junction createMany could not express `skipDuplicates` with a
  //   DB-generated TARGET key, because the join row needs an identity the INSERT produces
  //   and a skipped INSERT produces none. Here the identity in question is the PARENT's,
  //   and it is not produced at all — it is READ, by a probe that has already run. So the
  //   skip disposition is exactly the literal leaf's: a SQL leaf where the dialect has one,
  //   the savepoint-wrapped executor effect where it does not (and there, unchanged, no
  //   lowering into a single atomic batch — asserted per leg, declared not sniffed).
  //
  // 75 -> 74 (N4-U1, sweep entry (e), site 1 of 3): DELETED —
  // `RelationWritePart.interpretChildParts`, "update for relation '…' carries nested
  // relation writes; it must locate the target by its primary key '…'". The deeper edges
  // reference the target's primary key and only the `where` could supply it, so
  // `projects: { update: { where: { code }, data: { …, tasks: { create } } } }` refused
  // while the `where: { id }` spelling ran. But this part ALREADY locates the row: its
  // correlated probe selects that primary key, and `capturedPk` is the identity the
  // self-UPDATE addresses. The child Parts now take a `planned` source into that same
  // probe when the `where` does not name the key, and the probe publishes it as a
  // `firstRowField` output (plus this family's own verbatim target-not-found
  // postcondition, since the extraction is eager) — the shape
  // `UpdateOperation.buildParentHeldUpdate` already used for the same reason.
  //
  // 74 -> 74 (N4-U1, site 2 of 3): REPLACED, one site out, one site in —
  // `RelationUpsertPart.buildArmChildParts`'s "its upsert must locate the child by its
  // primary key '…' so the deeper foreign key is a known value" is gone, and
  // `createArmParentId` stands where part of it stood. The two ARMS were never the same
  // question, and collapsing them was the bug:
  //   · the UPDATE arm acts on the row the probe FOUND, so the key is readable — a
  //     `planned` source into this part's own probe, published as an OPTIONAL
  //     `firstRowField` (an empty probe is the legitimate CREATE decision, and on that
  //     decision no update-arm grandchild compiles, so the value has no consumer);
  //   · the CREATE arm inserts a FRESH row, so the key must be SPELLED — by the `where`,
  //     or by the create data (`assertMatchingCreateIdentity` has already reconciled the
  //     two). A DATABASE-GENERATED key with grandchildren is the one shape left, and the
  //     new site refuses exactly it, naming both places the key could have come from.
  //   The count is unchanged and that is the honest number: a real capability was added
  //   and a real, narrower wall was named. Both directions are witnessed on both
  //   substrates — the generated-key refusal, and the SAME payload succeeding once the
  //   create arm spells the key.
  //
  // 74 -> 74 (N4-U1, site 3 of 3): NARROWED, not deleted —
  // `RelationJunctionPart`'s "nested '<kind>' on many-to-many relation '…' carries nested
  // relation writes; it must locate the target by its primary key '…'". The `update` kind
  // is absorbed: the target slot's membership read already selects the target primary key
  // and `requireTarget` already spends it on the join-row write, so the deeper edges take
  // a `planned` source into it (the slot's probe id is allocated by the builder, before
  // the payload folds, because a `ParentIdSource` is a value and the id must exist first).
  // The `upsert` arms keep the refusal, with the measurement: an upsert's update arm is
  // also reachable by the created-earlier branch, whose global probe ran BEFORE this
  // operation's own INSERT and located nothing — there is no row for a `planned` source to
  // read. (N3-U2 recorded that this branch is currently unreachable from the client
  // because the own-write preflight rejects two upsert items on one m2m relation; the
  // refusal is kept keyed to the branch rather than to that unreachability, so it cannot
  // silently become wrong if the preflight ever relaxes.)
  //
  // Witnessed by `depth-seam-behavior.ts` on every driver leg and both substrates: the
  // absorbed shape end-to-end for each of the four sites, a WRONG-ROW decoy for each
  // (seeded first, lower primary key, identical non-unique scalars — the assertions name
  // the id), the two abort paths (a unique naming another parent's row / a non-member),
  // and both surviving walls asserted as construction-time refusals with nothing written.
  // Falsified by locally restoring each refusal, one at a time: RelationWritePart fails
  // 6 of 28, the planned createMany 8 of 28, the upsert update arm 2 of 28, the junction
  // update 4 of 28 — and the suite is 28/28 with all four in place.
  //
  // NOT absorbed here, and named so the sweep stays complete: a COMPOUND-primary-key
  // target at any of these seams. It never reaches the located-key question — every one of
  // these paths refuses earlier, on the child's own key ARITY ("requires a child with one
  // primary key", sweep entry (i)), which no parent-side dataflow supplies. The
  // single/compound split N4-U1 owns is therefore about the target's own PK arity, and it
  // is entry (i)'s, not this unit's.
  //
  // ---------------------------------------------------------------------------
  // N5 — the ordering boundaries. Measured in its own lane as 76 -> 75; re-based
  // here onto the count N4 left, so the running number reads 74 -> 73. The lane's
  // later two commits are net-zero and keep it at 73.
  // ---------------------------------------------------------------------------
  //
  // 74 -> 73 (N5-U1, the ADOPT family under a non-cascade referenced-PK transition):
  // DELETED — `UpdateOperation.interpretReferencedKeyTransition`'s A15 throw, "does not
  // support a nested adopt (connect / connectOrCreate / set / to-many upsert) on the
  // child-held relation '…' while the root update transitions its non-cascade referenced
  // primary key", together with the `isAdoptKindUnderTransition` predicate that fed it.
  //
  // Its stated cause was that an adopt "writes a fresh FK on the pre-transition value,
  // orphaned by the referential action". That was a true statement about the ORDER the
  // parts were emitted in — every child Part of an update root was written BEFORE the
  // root UPDATE, so an adopt could only ever bind the id the transition was about to
  // vacate — and it was a statement about nothing else. Two facts the same code path
  // already had in hand make the shape ordinary:
  //   1. the OLD slot is proven EMPTY by the occupied guard this very method emits three
  //      lines later (CLASS IV / T4c), so nothing is being moved off the dying id; and
  //   2. the POST-transition value is a COMPILE-TIME LITERAL here — the `after` the
  //      method already computes with `getUpdatedPrimaryKeyValue`, and already hands to
  //      the to-one upsert's create-arm reroute (T4c) and, by the same derivation, to the
  //      T4b transitioned-PK create leaf.
  // So the four adopt kinds now take `after` as their parent value and are ordered AFTER
  // the root UPDATE, on `afterRootParts` — the T4b list, generalized from "transitioned-PK
  // create leaves" to "every child write whose FK is the post-transition value", with
  // GUARD steps still hoisted to the front (a batch pins premises first; every premise
  // these Parts assert is about rows the root UPDATE does not touch). ORDERING was the
  // whole fix. Nothing became newly expressible; a plan the engine could already spell
  // was being emitted in the one order that made it illegal.
  //
  // One mechanism was genuinely missing and is now built, because `set` is the one adopt
  // member that READS existing membership as well as writing it: its departing half asks
  // "which rows carry my key today" (a correlated planning read, and on a REQUIRED child
  // FK the orphan rejection) while its target half writes "carry my key from now on".
  // Those coincide everywhere except here. `RelationSetConfig.correlationParentId` (N5-U1)
  // splits them — departing on the located row's PRE-transition value, targets on `after`
  // — and defaults to `parentId`, so every other caller is byte-identical.
  //
  // The occupied guard is untouched and still rejects (the accept-shape moved, the
  // legality did not), and the to-many `upsert`'s uncorrelated verdict under a transition
  // was MEASURED to equal its verdict with no transition in the payload, rather than
  // assumed: an empty old slot means a globally-found target is never this parent's, so
  // both spellings give `target record was not found for this parent` and write nothing.
  //
  // Witnessed by `post-transition-adopt-behavior.ts` on every driver leg and both
  // substrates (10 final-state witnesses: connect, an ARITHMETIC `increment` transition,
  // connectOrCreate's found and absent arms, `set` on a nullable and on a required child
  // FK, the to-many upsert's create arm and its uncorrelated rejection, the occupied-slot
  // rejection, an absent connect target, and the inverse-side one-to-one), plus
  // `post-transition-adopt.test.ts` for the claim only the statement stream carries: the
  // root UPDATE PRECEDES the reparent, and the reparent binds the post-transition key.
  // Falsified three ways: emitting the post-transition writes before the root UPDATE
  // fails 15 of 22; handing the adopt family the located planned source instead of
  // `after` fails 15 of 22; dropping `correlationParentId` turns the required-FK `set`
  // into `requires a planned parent id to correlate its probe` (2 of 22).
  // 73 -> 73 (N5-U1b, the same ordering AT DEPTH; the lane measured this as 75 -> 75
  // — see the MERGE NOTE above): one site DELETED, one ADDED — a
  // strictly narrower refusal in the same place, so the count holds while the surface
  // shrinks. `RelationWritePart.interpretChildParts`' "transitions the target primary
  // key '…' while writing a child-held edge whose foreign key does not cascade on
  // update" is gone; "… while writing BOTH a many-to-many edge and a child-held edge
  // whose foreign key does not cascade on update" takes its place.
  //
  // Same refusal, same cause, one level down: a nested update TARGET rewriting its own
  // primary key while carrying a deeper edge. T3b1 gave it the cascade ordering (write
  // the edge against the PRE-transition literal, let `ON UPDATE CASCADE` carry it) and
  // refused everything else, its own comment naming the alternative: "V1 orders the edge
  // against the POST-transition id instead". That is now what happens — the target's
  // post-transition key is `getUpdatedPrimaryKeyValue` over the where-pinned locator and
  // its own SET (compile-known exactly as at the root), the deeper edges are built
  // against it, and `reorderAfterChildren` goes FALSE so the self-UPDATE runs first.
  //
  // The absorption needed the LEGALITY as well as the ordering, or depth would have
  // diverged from the root: an OCCUPIED old slot, which the root rejects with V1's
  // `Cannot update relation '…' with onUpdate('…') while the current relation is
  // occupied.`, would instead have let the referential action silently null those
  // children (setNull) or raise a bare ForeignKeyError (restrict). So CLASS IV's
  // read+verdict pair became a Part (`RelationKeyOccupiedPart`) — which is what Parts are
  // for; the root's version rides the operation's own `relationKeyGuards` list because
  // the root HAS one. One rule, two depths, one message (`relationKeyOccupiedMessage`,
  // lifted to `messages.ts` so both askers say it identically).
  //
  // THE NEW SITE IS NARROWER, and its reason is measured, not assumed: a junction reads
  // MEMBERSHIP at PLANNING, correlated to the parent key, and planning runs before the
  // self-UPDATE writes the new one. Post-transition ordering would have the junction read
  // a key no row carries yet; pre-transition ordering strands the non-cascade edge.
  // Neither order serves both edges, so a payload carrying BOTH on one transitioning
  // target refuses. A junction ALONE is untouched (still the cascade ordering, still
  // executing), and a non-cascade edge alone is now absorbed — so what the old site
  // refused and this one does not is every single-family shape. Closing the mix needs the
  // junction's membership read on the pre-transition key while its writes use the
  // post-transition one: the two-source split N5-U1 built for `set`
  // (`RelationSetConfig.correlationParentId`), carried into `RelationJunctionPart`. Named
  // for a follow-up, not smuggled in here.
  //
  // Witnessed in `nested-update-pk-transition-cascade.test.ts`, both substrates, on the
  // SELF-relation schema that already bracketed this boundary. Its child-held arm was
  // RETARGETED from a decline assertion to an accept-and-execute one on the SAME payload
  // (authorized, with the reasoning in the file header); two arms were added — the
  // occupied-slot rejection, and the mixed-edge refusal. Falsified: restoring the
  // pre-transition ordering fails the 2 child-held arms; removing the depth occupied
  // guard fails the 2 occupied arms (they silently null the occupant instead).
  //
  // 73 -> 73 (N5-U2, the B10 residue — sweep entries (a), (b), (d); the lane measured
  // this as 75 -> 75 — see the MERGE NOTE above): both
  // `resolveCreateParent` sites NARROWED by an ordering that derives nothing, and the
  // third RE-JUSTIFIED with a measured reason. No count change: narrowing a message is
  // not deleting a site.
  //
  // (a) + (b), THE ABSORPTION. Both refusals existed to protect a derivation — the
  // POST-transition value a fresh child must reference when the root SET rewrites the
  // column its foreign key points at. (a) refused a compound reference because the tuple
  // is per member; (b) refused an unpinned single key because the pre-value was not a
  // construction literal. Neither reason applies when the edge carries ON UPDATE CASCADE,
  // because then NO post-transition value is needed at all: write the fresh row against
  // the LOCATED pre-transition values, before the root UPDATE, and the cascade carries the
  // row's foreign key forward. That is the ordering `reorderRootUpdateAfterChildren` has
  // applied to a REPARENT since T3b1, applied to an INSERT, and `locatedCreateParent` — N1's
  // per-field located-parent source — is entered unchanged, so arity and pinning both stop
  // mattering. The cascade test now runs BEFORE the arity and pinned-value branches, which
  // is the whole diff.
  //
  // Both messages gained the word NON-CASCADING, so each says what it now refuses.
  // Witnessed in `post-transition-adopt-behavior.ts` on every driver leg and both
  // substrates: a cascading single key transitioned under a `where` that names a DIFFERENT
  // unique (exactly (b)'s shape), and a cascading COMPOUND key with BOTH members rewritten
  // (exactly (a)'s). Falsified: removing the cascade branch fails those 4 tests.
  //
  // (a) + (b), THE SURVIVORS, measured. What is left is a NON-cascading rewrite whose
  // pre-transition value the `where` does not pin (single key), or any non-cascading
  // rewrite of a compound reference. A NO-ACTION foreign key does not follow the parent,
  // so the fresh row must carry the POST-transition value, and that is
  // `getUpdatedPrimaryKeyValue(before, operand)` — computable only once `before` is known,
  // i.e. at COMPILE, after the locate has run. The gap is NOT SQL and not ordering: the
  // statement is a plain `INSERT … VALUES (<new key>)` and its place in the ladder is
  // already decided (`afterRoot: true`). The gap is that no PARENT-ID SOURCE can name that
  // value. All three kinds are fixed at construction — `literal` (a value), `planned` (a
  // column of the located row, verbatim), `ref` (a SQL reference) — and none applies a
  // transform. One field closes both: a `planned` source carrying the SET operand,
  // resolved through the same derivation in `referencedFieldValue`. Owner: a follow-on
  // unit; it is also what (d)'s unpinned third needs.
  //
  // (d) `UpdateOperation.interpretRelation`, "nested '<kind>' … while the root update
  // transitions a compound / non-PK / unpinned referenced column" — RE-JUSTIFIED, not
  // absorbed, and the sweep's own framing was incomplete. It named "a correlated read of
  // the pre-transition slot ordered BEFORE the self-UPDATE" as the fix, and that half is
  // right and cheap: the occupied guard's probe is a PLANNING step, so it may carry a SQL
  // `Ref` to the locate (technique #1) instead of the literal `before` it uses today.
  // MEASURED, the half that is neither: `interpretReferencedKeyTransition` also decides
  // two things that same literal feeds.
  //   · THE NO-OP TEST. `sameScalarValue(before, after)` is what makes `increment: 0` /
  //     `set` to the current value keep the ordinary parts and emit NO guard (pinned by
  //     "allows same-value set on an occupied setNull relation" and "allows increment zero
  //     …" in `relation-key-update-legality.test.ts`). With `before` unknown at
  //     construction, a Ref-correlated guard would fire on a no-op and reject an occupied
  //     slot the current engine deliberately accepts — a REGRESSION, not a boundary. The
  //     decision has to move to compile, where the located row is in hand.
  //   · `after` FOR THE ADOPT ORDERING. N5-U1's adopt family and the to-one upsert
  //     create-arm reroute both take `after` as a construction literal. For the non-PK
  //     (D4) third of this site that is fine — the SET holds a literal and non-PK
  //     referenced arithmetic is already refused upstream — but the unpinned-PK third
  //     needs the same transforming source (a) and (b) name above.
  // So (d) splits into a cheap non-PK part and an unpinned part sharing the one missing
  // mechanism, and BOTH need the no-op verdict moved to compile first. Kept as one site
  // rather than pre-split, because splitting it before that move would multiply messages
  // without changing what executes. Owner: the same follow-on unit.
  //
  // 73 -> 74 (MERGE, N4-U1 × N5-U1b): one site ADDED, and it exists ONLY because the two
  // lanes met. Neither lane could see it: each was green in its own worktree, and the
  // shape it refuses declined in BOTH lanes for each lane's own reason.
  //
  // `RelationWritePart.interpretChildParts` now answers two questions that used to be
  // one. N4-U1 answers "where does the deeper edge's parent value COME from" — the
  // `where`'s literal when it names the target's primary key, else a `planned` source
  // into this part's own probe. N5-U1b answers "WHEN is that edge written, and against
  // WHICH side of a primary-key transition" — before the self-UPDATE on the
  // pre-transition value when the deeper FK cascades, after it on the post-transition
  // value when it does not. Their intersection — a target named by a NON-primary-key
  // unique whose SET also rewrites its primary key, carrying a non-cascade deeper edge —
  // needs a value NEITHER mechanism produces: the probe runs before the self-UPDATE, so
  // the `planned` source reads the key the transition is about to vacate, and no
  // `ParentIdSource` transforms (`literal`, `planned`, `ref` each carry a value
  // verbatim). The CLASS IV occupied guard has the same want: it needs the
  // pre-transition literal to name the slot it checks.
  //
  // Not a regression in either direction, and that is checkable rather than argued: at
  // the shared base `f49047b` this payload declined on N4's site (it did not locate by
  // the primary key) AND on N5's (a non-cascade deeper edge under a transition). Both of
  // those sites are gone; this one stands where they overlapped, and it is strictly
  // narrower than either — it requires all three of a non-PK locator, a PK-rewriting
  // SET, and a non-cascading deeper FK, where each old site required one.
  //
  // Closing it is the SAME follow-on unit N5's record already names for its three
  // survivors (sweep (a)/(b)/(d)): a `planned` parent-id source that applies the SET's
  // operand to the located value at COMPILE, resolved through `getUpdatedPrimaryKeyValue`
  // in `referencedFieldValue`. This site is therefore the FOURTH claim on that one
  // mechanism, not a new mechanism of its own.
  //
  // Witnessed in `nested-update-pk-transition-cascade.test.ts` (the file that already
  // brackets this boundary): the merge refusal is asserted as a CONSTRUCTION-time decline
  // with nothing written, beside the two shapes it is narrower than — the same payload
  // located BY the primary key executes (N5-U1b's absorption), and the same non-PK
  // locator with no PK transition executes (N4-U1's absorption). Falsified, with the
  // failure MEASURED rather than predicted: dropping the refusal and letting the
  // `planned` source through writes the deeper edge against the VACATED key — on that
  // schema the FK constraint catches it and a bare `ForeignKeyError` replaces the typed
  // construction decline (2 of the file's 12 fail), and where another row already holds
  // the vacated key nothing catches it at all.
  //
  // 74 -> 74 (FIX ROUND, no site added or removed, recorded because it changes what
  // REACHES one of them). `interpretChildParts` asks a question BEFORE the two above:
  // does the SET move the primary key at all? It used to answer `Object.hasOwn` and
  // nothing else, so `id: { set: <current> }` / `id: { increment: 0 }` counted as a
  // transition and an occupied old slot became a rejection at depth for a payload the
  // ROOT accepts (the two `sameScalarValue` no-op cases pinned in
  // `relation-key-update-legality.test.ts` — the very regression THIS log's sweep-(d)
  // entry names as disqualifying, shipped one level down). The root's no-op verdict now
  // runs here too, from `shared.ts` so there is one function rather than two copies
  // drifting. The merge refusal above and the occupied guard are untouched in reach for
  // every payload that actually moves a key; only no-ops stopped arriving. Witnessed by
  // two arms in `nested-update-pk-transition-cascade.test.ts` on both substrates (4 of
  // that file's 16 fail without the verdict).
  test("no UnsupportedOperationError throw site exists outside the reviewed set", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "../../src/query-engine-v2");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    let sites = 0;
    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8");
      sites += source.split("new UnsupportedOperationError(").length - 1;
    }
    expect(sites).toBe(74);
  });
});

/**
 * Full-client-surface inventory (P6 precondition).
 *
 * The route inventory above pins the *tracked* write-shape routes: shapes a
 * V2-owned operation DECLINES with {@link UnsupportedOperationError} at
 * construction. By construction it cannot see an operation family that falls
 * back to V1 by OMISSION from {@link ROUTED_OPERATIONS} — such a family produces
 * no throw and is invisible to a throw-site census. That blind spot is exactly
 * what let a P6 work order assert "exactly ONE route to V1 remains" while the
 * entire `create` family was, and is, dispatched to V1's frozen OperationRuntime
 * (via `pending-operation.ts`, a P6 KEEP file, when `resolveV2()` returns
 * undefined). This block closes the hole: it enumerates the ENTIRE client
 * operation surface and asserts each family either constructs on V2 or is a
 * listed, deliberate V1 fallback — so the fallback set can never again be
 * silent.
 *
 * P6 implication (the reason this is a *precondition*, not decoration): a family
 * in {@link DOCUMENTED_V1_FALLBACK} means V1's operation/execution root is still
 * reachable and therefore NOT deletable. P6 ("bulk-delete V1's operation/
 * execution root once unreachable") may proceed only when this set is empty —
 * or when a family in it is a recorded maintainer decision to keep it on V1
 * permanently (which would itself change P6's "runtimes 2→1" premise and must be
 * recorded, not silent). This assertion is decision-neutral: it neither migrates
 * `create` nor blesses it as permanent; it only makes the true state a pinned,
 * reviewable fact. The day the set changes, both this file and that decision
 * must move together.
 */

// The authoritative 16-family client operation surface (`Operations` in
// @client/types). `satisfies` rejects a typo or a name that is not a real
// operation; `MissingFromSurface` (below) rejects a NEW operation added to the
// union but not listed here — together they force this list to track the union.
//
// DELIBERATE EDIT (W3-B, maintainer decision D-1): 18 -> 16. `createManyAndReturn`
// and `updateManyAndReturn` were REMOVED from the client surface — no alias, no
// deprecation shim — and replaced by implicit returning: `createMany` /
// `updateMany` take an optional `select`, whose presence makes the SAME family
// return rows instead of `{ count }`. The removal shrinks the operation surface
// without shrinking capability, so this pin drops by exactly two while the
// row-returning machinery stays reachable (see the REMAINING_ROUTE case above,
// now spelled `createMany` + `select` + `skipDuplicates`).
const CLIENT_OPERATION_SURFACE = [
  "findFirst",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "exist",
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const satisfies readonly Operations[];

// Compile-time completeness: any `Operations` member absent from the list above
// makes this alias a non-`never` type, and the annotated `true` assignment fails
// to type-check. Adding a new client operation forces an update here.
type MissingFromSurface = Exclude<
  Operations,
  (typeof CLIENT_OPERATION_SURFACE)[number]
>;
const _surfaceIsComplete: [MissingFromSurface] extends [never] ? true : false =
  true;

// Families dispatched to V1 by omission from ROUTED_OPERATIONS. NOW EMPTY: the
// create family (the last un-migrated family, the P6 blocker) was migrated to V2
// in the P6-prerequisite phase — `create` is in ROUTED_OPERATIONS and
// constructs on V2 (CreateOperation is generalized far beyond the P0/P1 proof
// slice; see below). The P6 deletion precondition this pin guards is therefore
// MET: no client operation family falls back to V1 by omission. Growing this set
// again would be a new un-migrated family; either edit is a decision.
const DOCUMENTED_V1_FALLBACK: ReadonlySet<string> = new Set([]);

describe("query-engine-v2 full client operation surface (P6 precondition)", () => {
  test("_surfaceIsComplete type-guard holds (list covers the Operations union)", () => {
    expect(_surfaceIsComplete).toBe(true);
    // 16 since W3-B (was 18): see the DELIBERATE EDIT note on the list above.
    expect(CLIENT_OPERATION_SURFACE).toHaveLength(16);
  });

  test("every client operation family routes to V2 except the documented V1 fallbacks", () => {
    const fellBackByOmission = CLIENT_OPERATION_SURFACE.filter(
      (operation) => !ROUTED_OPERATIONS.has(operation)
    );
    // The falsifiable positive assertion the P6 reviewers demanded: with the
    // fallback set now empty, EVERY one of the 16 families must be in
    // ROUTED_OPERATIONS. Removing `create` from ROUTED_OPERATIONS (re-opening the
    // by-omission hole) makes fellBackByOmission = ['create'] ≠ ∅ and fails here.
    expect(new Set(fellBackByOmission)).toEqual(DOCUMENTED_V1_FALLBACK);
    expect(fellBackByOmission).toHaveLength(0);
  });

  test("the migrated `create` family constructs on V2 (proven by construction, not by listing)", () => {
    // Item 4's "proven by construction": `create` is not merely listed in
    // ROUTED_OPERATIONS — a representative create payload resolves to a real V2
    // operation (never undefined, i.e. never dispatched to V1 by omission). This
    // is the family whose absence blocked the first P6 attempt.
    const engine = pgEngine(manyToManySchema);
    const routed = constructRoutedOperation(
      engine,
      manyToManySchema.tag,
      "create",
      { data: { id: "t1", name: "x" } }
    );
    expect(routed).toBeDefined();
    expect(routed?.constructor.name).toBe("CreateOperation");
  });

  test("each documented V1 fallback (if any) constructs to undefined (dispatched to V1)", () => {
    // Guards the invariant should the set ever regrow: a fallback family must
    // resolve to undefined (V1 by omission). Empty today — a no-op that documents
    // the meaning of membership.
    const engine = pgEngine(manyToManySchema);
    for (const operation of DOCUMENTED_V1_FALLBACK) {
      const routed = constructRoutedOperation(
        engine,
        manyToManySchema.tag,
        operation,
        { data: { id: "t1", name: "x" }, select: { id: true } }
      );
      expect(routed).toBeUndefined();
    }
  });
});
