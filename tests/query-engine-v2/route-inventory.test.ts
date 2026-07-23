import type { Operations } from "@client/types";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import { ManyAndReturnOperation } from "../../src/query-engine-v2/ManyAndReturnOperation";
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
 * construct on V2; the ONE inexpressible sub-shape (createManyAndReturn
 * skipDuplicates on a non-returning driver) must still route.
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
 *   (ii)  THE ONE DELIBERATE REFUSAL — {@link REMAINING_ROUTE} (createManyAndReturn
 *         skipDuplicates on a non-returning driver): inexpressible (no portable
 *         ON CONFLICT DO NOTHING that reports a skipped-row count), maintainer-
 *         authorized.
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
  "createManyAndReturn skipDuplicates on non-returning drivers";

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
      {
        label: REMAINING_ROUTE,
        construct: () =>
          new ManyAndReturnOperation(
            nonReturning,
            refusalSchema.gadget,
            "createManyAndReturn",
            {
              data: [
                { id: "t1", name: "a" },
                { id: "t2", name: "b" },
              ],
              skipDuplicates: true,
            }
          ),
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
  test("no UnsupportedOperationError throw site exists outside the reviewed set", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(__dirname, "../../src/query-engine-v2");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    let sites = 0;
    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8");
      sites += source.split("new UnsupportedOperationError(").length - 1;
    }
    expect(sites).toBe(90);
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

// The authoritative 18-family client operation surface (`Operations` in
// @client/types). `satisfies` rejects a typo or a name that is not a real
// operation; `MissingFromSurface` (below) rejects a NEW operation added to the
// union but not listed here — together they force this list to track the union.
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
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
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
    expect(CLIENT_OPERATION_SURFACE).toHaveLength(18);
  });

  test("every client operation family routes to V2 except the documented V1 fallbacks", () => {
    const fellBackByOmission = CLIENT_OPERATION_SURFACE.filter(
      (operation) => !ROUTED_OPERATIONS.has(operation)
    );
    // The falsifiable positive assertion the P6 reviewers demanded: with the
    // fallback set now empty, EVERY one of the 18 families must be in
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
