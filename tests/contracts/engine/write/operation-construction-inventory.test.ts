import type { Operations } from "@client/types";
import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema/hydration";
import type { Model } from "@schema/model";
import {
  constructRoutedOperation,
  ROUTED_OPERATIONS,
} from "@src/query-engine/write-engine/routing";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import { compoundKeyBehaviorSchema } from "@tests/fixtures/compound-key-behavior-schema";
import { manyToManySchema } from "@tests/fixtures/many-to-many-schema";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

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
 * (the `FALLBACK_OFF_RESIDUAL` measurement) is
 * empty.
 *
 * **THE HEADER ABOVE IS THE P6-ERA FRAMING, AND THREE OF ITS CLAIMS WERE FALSE**
 * by the time Package N3 read them (2026-08-11), so they are stated here and
 * corrected rather than quietly deleted:
 *
 *   · "THE FINAL TRUTH: the census is ZERO" — the census pinned by this file is
 *     21, and has been non-empty since Package J deliberately made it so.
 *   · "the 86 remaining `new UnsupportedOperationError` throw sites" — there are
 *     26 in the whole of `src`, 24 in `src/query-engine`, 21 under
 *     `src/query-engine/write-engine`.
 *   · "P6 may delete the V1 runtime" — V1 is frozen awaiting that deletion; this
 *     file is not the authority that releases it.
 *
 * WHAT THIS FILE IS, at HEAD. Two things, and it is worth being exact because the
 * P6 framing conflated them:
 *
 *   1. **The executable census owner.** The tripwire at the end of the route
 *      inventory counts `new UnsupportedOperationError(` under
 *      `src/query-engine/write-engine` and pins it. That number moves only
 *      alongside an entry in the count evolution below saying which site moved and
 *      why. It is a TRIPWIRE, not a target: a site is a construction position, and
 *      several positions can express one invariant.
 *   2. **The tracked route corpus**, which exercises named write shapes and asserts
 *      that exactly the documented ones refuse. Package J made that list non-empty
 *      on purpose — a boundary a lift draws deliberately belongs in the list, not
 *      in silence.
 *
 * The per-SHAPE classification — which of the surviving refusals is a semantic
 * contradiction, which is a missing stable identity, which is the substrate, which
 * is a deferred product contract and which is unimplemented future work — is the
 * CLOSING SECTION of this file (Package N3), and it is mirrored shape-by-shape in
 * `docs/architecture/forbidden-shapes-reference.md`. A number without that mapping
 * is what let this header claim zero.
 */

const REMAINING_ROUTE =
  "createMany with select + skipDuplicates on non-returning drivers";

/** PACKAGE J's one new route: `skipDuplicates` beside a general nested effect. */
const J_SKIP_WITH_RELATIONS =
  "createMany with skipDuplicates + relation-bearing rows";

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

describe("write engine route inventory (P6 accounting)", () => {
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
      // --- PACKAGE J (2026-08-10): the one refusal the lift ADDS. ---
      // Plan §5.1 keeps `skipDuplicates` + general nested effects refused because the
      // PRODUCT meaning is undecided (does a skipped root suppress its nested effects,
      // or adopt the existing row and apply them?), and says not to guess it. Tracked
      // here on purpose: it is a live route, not a historical label.
      {
        label: J_SKIP_WITH_RELATIONS,
        construct: () => {
          constructRoutedOperation(m2m, manyToManySchema.post, "createMany", {
            data: [{ id: "p1", title: "a", tags: { connect: { id: "t1" } } }],
            skipDuplicates: true,
          });
        },
      },
    ];
  });

  // RETARGETED BY E6.9 (authorized test change): the maintainer authorized wiring the
  // tx-mode savepoint mechanism, and the census's one deliberate refusal was ABSORBED —
  // the shape constructs and executes (per-row skippable writes + captured-identity
  // refetch; witnesses in skip-select-capture-behavior.ts). REMAINING_ROUTE survives as
  // the corpus label only.
  //
  // AMENDED BY PACKAGE J: the tracked-refusal list is no longer empty, and being
  // non-empty is the point. J lifted the relation-bearing `createMany` refusal and, in
  // the same move, drew ONE narrower boundary the plan asked for by name — so the list
  // says exactly which shape that is, rather than going quiet again.
  test("exactly one tracked write shape refuses at construction", () => {
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
    expect(routed).toEqual([J_SKIP_WITH_RELATIONS]);
  });

  // The corpus above exercises the *tracked* shapes; this tripwire catches the
  // untracked ones. Any new `throw new UnsupportedOperationError` site in the
  // V2 source is a new route to V1 and must be added to the corpus (and to the
  // P6 deletion accounting) — update the count only alongside that.
  //
  // ---------------------------------------------------------------------------
  // COUNT EVOLUTION.
  //
  // The 1,860 lines that used to stand here recorded the census walking 86 → 76 →
  // 75 → 74 → 68 → 45 → 40 → 39 → 43 → 38 → 36 → 31 → 30 → 29 across the P6/T3/
  // N-wave/E-wave/TH era. Package N3 DELETED them. Not because the reasoning was
  // poor — it was the opposite — but because every coordinate, message and file
  // name in it described a tree that no longer exists, and a reader arriving at
  // this test needs to know what the number IS and why it moves, not how a frozen
  // V1 runtime was accounted for. The one rule that era learned and that still
  // binds every future change is kept verbatim below; the git history holds the
  // rest, which is the correct place for a migration.
  //
  //   CENSUS DISCIPLINE, learned the hard way. This is the ONE delta class the
  //   tripwire below cannot police: turning an `UnsupportedOperationError` into a
  //   `QueryEngineError` removes the site from the grep whether or not the shape it
  //   used to refuse now executes. It happened once, and for one round NOTHING
  //   exercised the absorbed shape: forcing `buildInverseToOneUpsertPart`'s subtree
  //   to `undefined` passed 2,698 tests while converting a working user-facing
  //   payload into an internal throw. So a conversion owes a BEHAVIORAL WITNESS of
  //   the shape, not just a reachability argument.
  //
  // The limitation lift's own entries begin here and are current. They are kept in
  // full: their coordinates were re-resolved against the tree on 2026-08-11, and
  // the shapes they describe are the ones a reader can still construct.
  // ---------------------------------------------------------------------------
  //
  // 31 -> 29 (LIMITATION LIFT, PACKAGE B — "trust the selected-record compiler"). TWO of
  // the three attempted deletions from `RelationUpsertPart` shipped; the third was
  // FALSIFIED AT THE PACKAGE GATE and its guard is restored. No site was added and no
  // narrowed residual kept. Each of the two that shipped was an arm-local restatement of
  // an invariant the found arm's delegate, `RecordUpdateCompiler`, already owns; each was
  // falsified by a behavior witness on both substrates BEFORE its deletion, and each
  // deletion was kept only because that witness then passed with the ordering and the
  // wrong-row protection intact. The third is recorded below with the measurement that
  // stopped it — the delegate owns the MECHANISM but not the whole INVARIANT.
  //   · **-1, `assertArmPkStable`** (B1) — "an update arm may not move its own primary key
  //     while it carries deeper relation writes". The compiler has owned primary-key
  //     transitions since T4b/T4c/N5-U1: it derives the post-transition value from the
  //     where-pinned pre-value and the root SET, defers every write that must reference it
  //     until after the root UPDATE, and rejects an occupied old slot with V1's
  //     referential-action message. Retargeted witness (`nested-arm-dispatch.test.ts`): the
  //     arm's row moves while a deeper `create` and a deeper `connect` both land the
  //     POST-transition key, with the statement order pinned (arm UPDATE, then the two
  //     writes) — and the payload that used to meet the deleted guard now meets the
  //     CLASS IV occupied guard instead, which is the half of the invariant that was ever
  //     real. RESIDUE, measured not guarded: a junction edge is classified before the
  //     transition is, so a pair that opts out of the implicit `ON UPDATE CASCADE` has no
  //     engine owner — and the update ROOT has none either. Both fail closed at the
  //     constraint with identical statements and no partial effect, so the constraint is
  //     the owner and a refusal at the arm alone would be an asymmetric duplicate. Pinned
  //     three ways in the same file's "B1 RESIDUE" block.
  //   · **-1, `assertArmEdgeReferencesLocatedPk`** (B2) — the M11 entry above, discharged.
  //     Its recorded reason named the exact mechanism it was waiting for ("widen
  //     `identitySelect` with the deeper edge's referenced columns and hand the leaf a
  //     per-column source"), and the delegation to the record compiler IS that mechanism:
  //     every consumed referenced field joins `locateFields`, the arm's probe publishes
  //     the target projection, and each member resolves BY NAME. The defect the site was
  //     created for cannot be constructed any more, which is why deleting it does not
  //     restore it: `upsert-arm-referenced-edge.test.ts` keeps the same decoy — whose
  //     `(region, code)` IS the cross-match of the arm's key and whose `slug` IS that key —
  //     and measures that the compound edge correlates per field, both create paths file
  //     the located tuple, and the arity-1 non-PK edge writes the slug.
  //   · **±0, `assertArmEdgeIsChildHeld`** (B3) — ATTEMPTED, FALSIFIED, RESTORED. The
  //     guard says "a parent-held to-one write belongs in the arm's own UPDATE SET", and
  //     `interpretParentHeldToOne` really does put it there: for a parent-held relation
  //     the arm did NOT arrive through, `connect` / `create` / both `connectOrCreate`
  //     arms / `disconnect` all fold into the ONE UPDATE the arm already emits. The
  //     invariant the guard owns is bigger than that mechanism. This seam also hands the
  //     compiler an `incomingMembership` — the reparent onto the enclosing row — and
  //     `compileLocatedRecord` applies it with `Object.assign` AFTER the fold, over the
  //     same column. So on the relation the arm ARRIVED THROUGH, which is the one the
  //     refusal's own message names, the deletion made the engine accept-and-discard:
  //     `connect` resolved with the target's probe run and the membership unchanged,
  //     `create` committed an unreferenced row, `disconnect` was ignored, the same
  //     payload resolved to opposite memberships on the two arms, and `delete` removed
  //     the enclosing operation's own root row and failed the terminal read with a bare
  //     `TransactionError`. The nested targeted-update seam passes no
  //     `incomingMembership` and lands the same `connect` correctly, so this was not
  //     parity — it was a new silent-write path unique to this seam. CARRIED FORWARD as
  //     a Package D case: reconcile the fold and the incoming reparent in one owner,
  //     with a refusal when they disagree per column.
  // FALSIFIED, in the order the deletions happened: each unit's witnesses were run
  // against the tree with that guard still in place and went red at construction with
  // that guard's own message, on both substrates, before it was removed. Both shipped
  // messages are quoted verbatim in the witness that replaced them, so restoring a guard
  // is a one-line diff away from being measured again — and B3 is the case that proves
  // the discipline works, because its witness was written, run, and then thrown away
  // when the payload it did NOT cover turned out to be the one that mattered.
  // SWEPT while in the file: the `publishesLocatedPk` config channel (declared, read, and
  // never supplied once the compiler's projection took over publication) and the stale
  // `{@link fkAssignData}` reference in the deleted M11 docblock, whose symbol no longer
  // exists in `src`.
  // 29 -> 24 (LIMITATION LIFT, PACKAGE C — "capture complete selected record keys").
  // FIVE sites deleted, none added, no narrowed residual kept. All five asked the SAME
  // question — "does this child have exactly one primary key?" — and all five asked it
  // because a selected-target consumer carried ONE scalar `childPrimaryKey` beside (or
  // instead of) the `TargetProjection` that already described what its probe published.
  // The projection now carries `identityFields`, the target's complete ROW KEY in schema
  // order, and every probe select, captured selector, guard conjunct and targeted
  // UPDATE/DELETE is built from every member of it. With the arity no longer load-bearing,
  // there was nothing left for these to assert.
  //   · **-1, `nested-target-parts`** — "query-engine-v2 update requires a child with one
  //     primary key for relation '<r>' one level deeper." Its deeper link probe now reads
  //     and addresses both members; pinned positively in `parity-c-selected-identity`
  //     (the whole planning fragment of a compound-keyed `connect` under a fresh junction
  //     target).
  //   · **-1, `RelationUpsertPart`** — "Relation '<r>' requires a child with one primary
  //     key." (the one text in the family with no `query-engine-v2` prefix; reachable only
  //     under a FRESH parent, since under a selected parent the record compiler answered
  //     first). Its adopt probe's compound SQL is pinned in the same file.
  //   · **-1, `RecordUpdateCompiler.interpretRelation`** and **-1,
  //     `interpretPolymorphicChildHeld`** — "query-engine-v2 update requires a child with
  //     one primary key for relation '<r>'.", emitted VERBATIM at both, which is why the
  //     witness that used to assert it could not say which guard answered. The ordinary
  //     child-held half is now pinned on both substrates in `parity-c-selected-identity`
  //     (a targeted `update` and an adopt `upsert`, each addressing the captured pair
  //     while the batch guard re-asserts the written pair beside it). The polymorphic
  //     INVERSE half was the hole Package A named as unpinned — no polymorphic witness
  //     schema had a compound-keyed target anywhere in the estate — and it now has a
  //     dedicated dual-substrate contract, `polymorphic-compound-target.test.ts`, whose
  //     decoys separate the two facts the site conflated: a row key narrowed to one
  //     member hits a one-member twin, and a membership predicate that drops the
  //     discriminator adopts a row held by the OTHER polymorphic member with the same
  //     stored id.
  //   · **-1, `RecordUpdateCompiler.parentHeldCorrelation`** — "query-engine-v2 update
  //     requires a child with one primary key for '<kind>' on the parent-held to-one
  //     relation '<r>'." Its own docblock had already recorded that only the CHILD-KEY
  //     half of E6.4 survived there; the refusal test at
  //     `parent-held-compound-edge-behavior.ts` is inverted into the accept it became,
  //     with one-member berth twins so a narrowed row key writes a different ROW.
  // TWO MORE deletions are invisible to this census because they were `QueryEngineError`,
  // not `UnsupportedOperationError`: `buildPolymorphicSelectedTarget` and
  // `buildPolymorphicUpsert` both threw "query-engine update requires a target with one
  // primary key for polymorphic relation '<r>'." on the DIRECT polymorphic edge. Recorded
  // here because a raw-count reader would otherwise see 5 where 7 guards went — and
  // recorded with their true reason, which is NOT the lift the other five got: a DIRECT
  // polymorphic target cannot have a compound row key in the first place. Its referenced
  // field is `target.primaryKey.field`, resolved by `singlePrimaryKey`
  // (src/schema/validation/rules/polymorphic.ts), which returns undefined for any model
  // with a compound id — so schema validation refuses the SCHEMA with P009 ("requires one
  // scalar primary key") and `setPolymorphicStorage` never runs, leaving no payload that
  // could reach either site. They were unreachable redundant defense behind a validation
  // rule that already owns the invariant, and they are deleted as such. Nothing about the
  // direct polymorphic path was widened, and no witness can exist for these two.
  // FALSIFIED. The first measurement found the complete row key had TWO owners on these
  // paths — `TargetProjection.identityFields` (what a probe publishes and every captured
  // selector, guard conjunct and DELETE/set address is built from) and
  // `RecordUpdateCompiler`'s own `parentPrimaryKeys` (what a SELECTED record's root UPDATE
  // addresses) — because narrowing each to `.slice(0, 1)` reddened 11 and 12 tests in
  // almost disjoint sets. Two independently mutable answers to one question is the shape
  // this package exists to remove, so the second was DELETED rather than documented: the
  // three addressing readers (`writeWhere`, `pkSelect`, `parentPrimaryKeyWhere`) read
  // `this.targetProjection.identityFields`, and the two construction-time predicates that
  // run before any projection exists ask `getPrimaryKeyFields(this.model)` at the site,
  // which is a topological question about the SCHEMA, not about what a probe captured.
  //   · `identityFields` narrowed to `.slice(0, 1)` now reddens BOTH former sets at once —
  //     23 tests: `parity-c` 6, `polymorphic-compound-target` 8, `parent-held-compound-edge`
  //     4 (the inverted berth witnesses, which the old projection mutation could not reach),
  //     and 5 `target-projection.core` units.
  //   · `identityFields` widened to `[...primaryKey, ...requiredFields]` reddens both legs
  //     of the C4 separation witness at the anchor's own root UPDATE. Under two owners that
  //     mutation left the transaction leg GREEN, so C4's "putting reference-key fields into
  //     identityFields would add them here" was decorative; it is now measured.
  // An ARITY narrowing still cannot reach C4 on its own — its target's row key is `[id]`,
  // one member — which is correct: its job is the row-key/reference-key SEPARATION, and it
  // fails when the two keys are confused for each other, as the widening shows.
  // ONE DOWNSTREAM NARROWING THESE DELETIONS EXPOSED, generalized in the same commit:
  // `assertPinnedTransitionIsCompilable` (src/query-engine/relation-key-legality.ts) read
  // `getPrimaryKeyFields(model)[0]` and early-returned unless the data rewrote THAT member.
  // Every caller sits behind a refusal deleted above, so a compound-keyed target could not
  // reach it before; afterwards a payload transitioning a NON-FIRST member walked past a
  // legality gate that a first-member payload is refused by. It now asks every member —
  // identical question, identical message, identical behaviour for a one-member row key —
  // and refuses the compound case in the same fail-closed direction. Lifting that refusal
  // is Package D's transition-provenance work, not a hole left open here.
  // PACKAGE D DID LIFT IT (26 → 24 → 22 in this scan set). Two sites left
  // `RecordUpdateCompiler.ts`, and only ONE of them is a lift:
  //   · LIFT — the `pastSurface` refusal ("does not support a nested '<kind>' … while the
  //     root update transitions a compound / non-PK / unpinned referenced column"). The
  //     regime it belonged to is gone: a compound, non-PK, or unpinned reference now
  //     compiles through per-member sources, pinned in `parity-d-transition` and in four
  //     behavioral families.
  //   · DEDUPLICATION — `transitionedCreateParent` and `resolvePolymorphicParent` each
  //     carried their own copy of the "references a non-literal rewritten column" refusal
  //     (the second differing only by a missing `-v2` prefix, so no caller could tell them
  //     apart). One owner, `postTransitionReference`, now emits it with a `position`
  //     argument. Nothing became legal; one site stopped being two.
  // AND THE LIFT IS NOT PURELY ADDITIVE, which a census of refusal SITES cannot show,
  // so it is written here where §O4 will read it: `pastSurface` returned before the
  // relation-level occupied guard could be emitted, and let nested `create` /
  // `createMany` through untouched. Those two kinds, on a compound / non-PK / unpinned
  // reference over an OCCUPIED old slot, used to execute and now raise the occupied
  // `NestedWriteError` — the verdict their pinned single-member twin always got. It is
  // a §3.1 change on an accepted payload and needs the coordinator's ratification, not
  // a package's. Behavior on every driver leg in `compiled-key-transition-behavior.ts`;
  // ledger entry in `docs/architecture/forbidden-shapes-reference.md`.
  // PACKAGE G MOVED THIS NUMBER NOT AT ALL, and that is the entry, not an omission.
  // G lifted the inverse-side to-one upsert's scalar-only found arm — measured at
  // a8349793 as `UnsupportedOperationError: query-engine-v2 upsert for relation
  // 'profile' does not support nested relation writes in its data.`, thrown at
  // construction with an empty statement log — by routing that arm through
  // `RecordCompilerSeam.updateSelected` with the complete parsed record. But the throw
  // it retired is a BRANCH of a SHARED site: `RelationWritePart.parseScalarUpdateData`
  // serves nested `updateMany` too, and that half stays (ATOM §17 — a set-based UPDATE
  // has no per-row captured identity for a descendant write to correlate to; lifting it
  // is Package K/L2, not G). So the site survives, worded for `updateMany` alone, the
  // dead `kind === "inverseUpsert" ? "upsert" : kind` ternary that spelled the other
  // half is gone, and the count is 22 before and after. A census of SITES cannot show a
  // half-site retiring, which is exactly why this paragraph exists.
  //   The absorbed shape carries behavioral witnesses rather than a reachability
  //   argument, per the CENSUS DISCIPLINE note above: `inverse-to-one-update-depth`
  //   drives the found arm's depth, the missing arm's inertness, deferred found-arm
  //   legality and the empty found arm on both substrates; `record-compiler-contract`
  //   pins that the found arm and the sibling nested `update` kind now emit the same
  //   steps, SQL and parameters, that a compound captured row key is addressed in full,
  //   and that a direct polymorphic mutation with no relation program is forwarded (it
  //   was silently DISCARDED before G — the arm compiled to zero steps and the call
  //   succeeded having written nothing); `polymorphic-write-family` drives the singular
  //   polymorphic inverse, which rides the same Parts.
  //   ONE TIMING CHANGE THIS SITE'S DISAPPEARANCE HIDES, recorded for §O4: the found
  //   arm's PK-portability and relation-key legality used to run at CONSTRUCTION for
  //   this seam, so `profile.upsert.update` payloads that fail them threw with an empty
  //   statement log whether or not the found arm was taken. They are now a deferred
  //   closure invoked after the planning probe and only on the found arm — the same
  //   retarget class Package D already had ratified, and what ATOM §13 always said.
  //   Exactly ONE of the three asserts in that closure changed timing for a payload
  //   class this seam used to ACCEPT in shape: `assertPortablePrimaryKeyUpdateInput`.
  //   The other two need relations in the arm, and a relation-bearing arm was refused
  //   outright before G, so their refusals could not previously fire here at all. That
  //   one is pinned by `record-compiler-contract`'s "defers primary-key portability to
  //   the found arm" on both substrates — construct, plan, MISSING creates, FOUND
  //   refuses — and deleting only that assert from the closure reddens that test and
  //   nothing else in the estate, which is how the closure satisfies one-guard-per-
  //   invariant for each of its three members rather than as a block.
  // SCOPE, stated because the arithmetic does not add up otherwise: this scan reads
  // `query-engine/write-engine/*.ts` ONLY. D also deleted a third site, the compound-target
  // fail-closed refusal in `src/query-engine/relation-key-legality.ts` (3 → 2 there), and
  // that deletion moves this number not at all. Package O's §O4 census must pick a scope
  // and say which; the repo-wide count today is 22 here + 2 in relation-key-legality.ts +
  // 1 in builders/decimal-portability.ts.
  // WHAT DID NOT MOVE, deliberately: `RelationJunctionPart`'s three sites. A junction side
  // is one column today and `getManyToManyJoinInfo` resolves it through
  // `getRequiredSinglePrimaryKeyField`, which throws before the Part is constructed — so
  // its `targetPkField` is the junction's STORED REFERENCE, not a second answer to "what
  // is the row key", and it keeps that name with the carve-out documented at its owner
  // (plan N2 / §7.4: compound M2M is an unimplemented capability, not a seal).
  //
  // 22 -> 22 (PACKAGE F, demand-driven fresh-record field publication) — ONE SITE ADDED,
  // ONE DELETED, and the two are unrelated, so the unchanged total is arithmetic and not
  // an absence of work. Both halves are stated because a census of SITES cannot show a
  // substitution.
  //
  // MEASURED FIRST, at `5bf1893f`, on a schema no existing witness carried — a NON-primary
  // key `.unique().increment()` column that a relation `.references()`:
  //   `depot.create({ data: { …, crates: { create: { … } } } })`, `crate.depotSerial ->
  //   depot.serial` →
  //   UnsupportedOperationError: query-engine-v2 create cannot resolve referenced field
  //   'serial' for relation 'crates': …
  // and the same value state reached four more sites: `referencedParentSource` (the adopt
  // family's parent id), `targetReferencedValue` (a before-parent target under a create
  // root), `RecordUpdateCompiler.beforeTargetReferencedValue` (the same under an update
  // root), and `assertSharedPkResolved` (a shared primary key referencing that column).
  //
  // THE POPULATION IS EXACTLY ONE SHAPE, which is why the lift is this narrow.
  // `autoGenerate` is the only generation knob the schema language has, and
  // uuid/ulid/nanoid/cuid/now/updatedAt all carry an application default FACTORY the parse
  // boundary materializes into the create data (`assertApplicationGeneratedValues` refuses
  // an omitted one). So "database-produced" means an absent `increment` column and nothing
  // else — int or bigint by construction, which is also why its parameter round trip is
  // exact and no scalar-domain gate is needed. Everything ELSE that reached those sites is
  // the maintainer's 2026-08-06 KEEP row: `.nullable()` sets `hasDefault: true, default:
  // null`, so an OMITTED nullable unique arrives as an explicit `null`, a value no row
  // holds. All five payloads `parity-f-fresh-field` pins are that row, and they still
  // refuse, verbatim.
  //
  // THE ADDED SITE: `CreateOperation.producedReference`'s batch-substrate refusal. §4.3
  // rule 4 offers the adapter's `batchRefs` as a carrier, and it cannot be one here: only
  // `storeLastInsertId` is wired into the executor, an atomic batch's statement rows are
  // not addressable at all, and widening scratch use also widens the set of operations
  // `prepareSharedBatch` excludes from `$transaction([…])` merging — the trade
  // `UpsertOperation.createArmIdentity` already records as a reason to prefer capture-free
  // identities. That is the F4 table's "batch-only substrate cannot carry/refetch" row, and
  // it is a DIFFERENT fact from "no row holds this value", so it gets its own sentence
  // rather than degrading into the K1 one. Pinned in `fresh-produced-field`.
  //
  // THE DELETED SITE: `RelationJunctionPart`'s "create-through-junction … requires the
  // target primary key '…' in the create data", measured UNREACHABLE and converted to a
  // `QueryEngineError` naming an internal invariant — the disposition `assertCreateTreeKinds`
  // already carries for the same situation. `targetPkField` is
  // `getRequiredSinglePrimaryKeyField`, and `planNestedCreateIdentity` is TOTAL over a
  // single-member primary key: a spelled value enters the record's identity, an absent
  // auto-increment becomes its `generatedField`, and an absent key that is neither throws
  // `NestedWriteError` one line EARLIER, inside the `createFresh` call that builds the
  // subtree. The two remaining candidates die further upstream — an `Sql` primary key is
  // parse-unreachable in write data (E6.6), and a `null` one is refused by the target's own
  // create schema, measured: `ValidationError: … Expected integer`. So `rootReferenced`
  // cannot answer `undefined` for a junction target, before Package F or after.
  //
  // SWEEP ENTRY (h) IS THEREFORE HALF-SETTLED: of its three `RelationJunctionPart` sites,
  // this is the one it described as "a RELATION-CARRYING create arm whose deeper child
  // Parts fold against a compile-time `literalParentId`". E4-U3 had already stopped folding
  // that arm — it became a whole delegated subtree — and what the entry did not notice is
  // that the refusal beyond the fold had no payload left. The other two are unchanged.
  //
  // SWEEP ENTRY (g)'s SHARED-PRIMARY-KEY HALF IS RE-MEASURED, and the N4-U4 entry above is
  // WRONG on two points that this unit had to correct rather than inherit. It claims the
  // site "is reachable only when the foreign-key column is itself declared `.increment()`
  // (any other spelling hits `planNestedCreateIdentity` first)" and that it lives in
  // `interpretParentHeld`. Neither holds: `resolveSharedPkIdentity` runs BEFORE
  // `planNestedCreateIdentity` in `buildRecord` and raises from inside itself, so the
  // `UnsupportedOperationError` precedes the `NestedWriteError` for every spelling —
  // measured with `seal.depotSerial: s.int().id()` (no `.increment()`), which refuses here
  // and not there. What Package F changed is one value state: a `create` arm whose target's
  // REFERENCED column is database-produced now resolves, because the consumer needs a
  // construction-time REFERENCE and not a construction-time value, and pre-allocating the
  // target INSERT's step id supplies one — the N4-U1 allocation-order precedent this site
  // already used for a produced primary key, now asked about any produced column through
  // the same owner. E6.3's measured obstacle is untouched and both its causes SURVIVE: a
  // `connect` by a NON-referenced unique resolves through a lookup SUBQUERY (re-evaluating
  // it is a second provenance of one row), and a `connectOrCreate` chooses its arm at
  // COMPILE while the identity is consumed at CONSTRUCTION. Pinned as "K2 SURVIVORS" in
  // `fresh-produced-field`.
  //
  // ONE REFUSAL RETARGETED BY THAT CHANGE, recorded because a site census cannot show a
  // move between error CLASSES and Package O's ledger needs it. The predicate the shared-
  // primary-key branch consults widened from `targetGeneratesReferencedKey` (single-member
  // primary key AND increment) to `targetProducesKey` (increment), so a shared-PK edge
  // whose TARGET has a COMPOUND primary key one of whose members is an absent increment
  // column now populates the identity with a produced reference, passes
  // `assertSharedPkResolved`, and is refused a few steps later by `planNestedCreateIdentity`
  // instead. Measured: `target { region, code: s.int().increment(), id([region, code]) }`
  // with `child.targetCode -> target.code`, `child.create({ data: { target: { create: {
  // region: "eu" } } } })` — `UnsupportedOperationError` at `5bf1893f`, and
  // `NestedWriteError: Nested create cannot propagate generated compound primary keys.` at
  // this tree. Refused before and refused after, so §3.1 (which speaks of payloads
  // ACCEPTED before) is not engaged; it is the same class as Package D's two recorded
  // retargets and Package G's deferred found-arm legality, and it is listed here for the
  // same reason those were.
  // PACKAGE E (2026-08-10) — 22 → 22, ONE SITE NARROWED, nothing added or removed.
  //
  // `RecordUpdateCompiler.assertNotSharedPk` refused a SHAPE: any `create` /
  // `connectOrCreate` / `upsert` on a parent-held edge whose foreign key is the selected
  // record's own row key, whatever the payload said. §6 E's rule 6 is "reject only if the
  // exact final value cannot be captured or derived", so the site is now
  // `recordSharedKeyFold`, in the same file, refusing an ARM THAT NAMES NO ONE VALUE for a
  // row-key member. Same class, same construction timing, one sentence, and the shape it
  // used to cover compiles: `parity-e-shared-pk` pins the folds byte-for-byte on both
  // substrates, and the four surviving payload classes verbatim.
  //
  // TWO REFUSALS RETARGETED, recorded because a site census cannot show a move between
  // owners and Package O's ledger needs both:
  //   · a shared-primary-key `connect` was answered at COMPILE by
  //     `getUpdatedPrimaryKeyValue`'s `Sql` branch ("Cannot determine the updated primary
  //     key for model 'card' because field 'accountId' uses an unsupported operation."),
  //     AFTER the planning locate had been issued — the one refusal in this family with a
  //     non-empty statement log. It is now the narrowed sentence at CONSTRUCTION with an
  //     empty log, and only for the sub-shape that genuinely has no value (a foreign key
  //     resolved by a correlated lookup subquery). A `connect` naming the referenced
  //     column executes. That branch of `getUpdatedPrimaryKeyValue` keeps every operand it
  //     was really about: the fold's members are withheld from the scalar derivation, so
  //     the two owners no longer answer the same question;
  //   · a shared-primary-key `create` beside a root SET that spells the same column used
  //     to be covered by the shape refusal; it now reaches the narrowed sentence as "two
  //     writers, one column", and the AGREEING spelling compiles. Neither direction was
  //     ever an accepted payload, so §3.1 is not engaged.
  //
  // A THIRD RETARGET, found at the Package E gate rather than by the lift, and the one
  // §3.1 deviation in the package: the refusal that was replaced was scope-blind, so the
  // fold is too — a NESTED selected record moves its own row key as well, where §6 E says
  // "at an update root". Measured on both substrates: under an enclosing ON UPDATE
  // RESTRICT edge the typed construction refusal (zero statements) became the database's
  // `ForeignKeyError` at execution with nothing written, and under ON UPDATE CASCADE it
  // became a success. Kept, because at that position the relation spelling and the SCALAR
  // spelling now AGREE on both edges, and a root-only gate would have made the relation
  // spelling refuse where the scalar one succeeds. Not a census site either way: no
  // `UnsupportedOperationError` is constructed on that path any more.
  //
  // ONE DISJUNCT DELETED from the narrowed sentence, which changes no site count and is
  // recorded because the write-up it corrects was already in the tree: `isSql(value)` had
  // no producer on any of the four resolvers, and the falsification note that claimed a
  // witness for it had mis-read which branch fired (the row in question refuses on
  // `value === undefined`). `value === null` was audited the same way and KEPT — its
  // producer is a nullable referenced unique named NULL, which now has its own witness.
  //
  // ONE SITE THIS PACKAGE DELIBERATELY DID NOT ADD. Feeding the fold into the transition
  // machinery (`sharedKeyMembers`) makes an occupied old slot refuse a shared-PK fold that
  // coexists with a child-held edge on the same column — with `relationKeyOccupiedMessage`,
  // Package D's existing owner, not a new sentence. The alternative considered and
  // rejected was a fresh "a shared fold may not coexist with a child-held edge" guard,
  // which would have been a second owner for an invariant that already has one.
  // PACKAGE J (2026-08-10) — 22 → 23, ONE SITE ADDED, in a package that mostly REMOVES a
  // refusal. Root `createMany` rows now take the ordinary create data shape and any row
  // carrying a general relation program routes the whole operation to
  // `CreateManyRecordSeries`. The site added is the boundary plan §5.1 draws by name:
  // `skipDuplicates` beside a general nested effect, refused typed at construction
  // (`CreateManyRecordSeries.ts`), tracked in the corpus above as
  // {@link J_SKIP_WITH_RELATIONS}.
  //
  // WHY IT IS AN UnsupportedOperationError AND NOT A TransactionError. The two substrate
  // refusals it sits beside (`ManyAndReturnOperation`'s `select`-in-forced-batch, and its
  // polymorphic-connect twin) are facts about a DRIVER: a returning driver answers them.
  // This one is a fact about the PRODUCT — §5.1 lists two incompatible meanings for a
  // skipped root's nested effects and says not to guess between them — so no capability
  // changes the answer, and calling it a transaction problem would be a lie.
  //
  // WHY IT IS THE ONLY SITE THE PACKAGE ADDS, given three candidates were available:
  //   · the "does this row carry a general relation program" predicate is the ROUTER's
  //     shell choice, not a refusal — the wrong rows route, they do not throw;
  //   · the batch-only `select` refusal is REUSED, not copied: `routing.ts` skips the
  //     series when that owner would refuse, so the specific sentence still answers
  //     (Package I brief, item 3) and no second copy of it exists;
  //   · the member-identity narrowing in `CreateManyRecordSeries` is a `QueryEngineError`
  //     — a member that answered with something other than its row key is an engine fault,
  //     never a payload, and the family it would otherwise join is user-facing.
  //
  // ONE REACHABILITY CAVEAT, so the ledger does not over-claim: the J site is reachable
  // on a transaction-capable substrate (the case above, and the behavior suites on
  // PGlite / PG / MySQL), but a payload that ALSO carries `select` on a batch-only
  // NON-returning driver never reaches it — routing hands that shape to the row-returning
  // owner first, whose substrate refusal fires inside the constructor. Both refuse, so
  // nothing is wrong; the site is simply not substrate-independent for select payloads.
  //
  // NOT A CENSUS SITE, recorded so a later reader does not go looking: J also added one
  // EXECUTION-time refusal, `FinalRootRead`'s `exactlyOneRow` postcondition (a
  // `TransactionError` through the ordinary `Failure` channel, no `new
  // UnsupportedOperationError`). It answers when a later row moved an earlier row's
  // primary key so the returning arm can no longer address it — the alternative was
  // silently returning fewer rows than the payload created.
  // PACKAGE H (2026-08-10) — 23 → 20. FOUR SITES DELETED, ONE ADDED, per-site below.
  //
  // The four deleted are §1.1-§1.4 of forbidden-shapes-reference.md, the to-one ARITY
  // guards. Each said "this relation supports one operation/mutation kind"; H's lattice
  // says a to-one relation supports one COMPOSITION — (vacate?, supplier, modify?) — so
  // an arity count is no longer the question any of them was asking. They are replaced by
  // TOTAL dispatches, not by other refusals: `composeToOneEntries` (child-held and
  // polymorphic-inverse) and `interpretParentHeldComposition` (parent-held) enumerate the
  // lattice and fall through to a `QueryEngineError`, which is an engine fault (the
  // schema and the dispatch disagreeing) and therefore NOT a census site — the X1c
  // precedent Package F used for the junction-target site.
  //
  //   · `CreateOperation.interpretParentHeld` (`entries.length !== 1`) and
  //     `CreateOperation.interpretChildHeld` (`> 1`) — DELETED as refusals, converted in
  //     place to engine-fault assertions. Under the CREATE root the to-one input owns
  //     neither `update` nor a vacate key, so the only multi-entry payload the parse can
  //     deliver is supplier + supplier, which `to-one-mutation-schema.ts` refuses first
  //     (`parity-h-to-one-lattice` pins that sentence on both directions of this root).
  //     Neither had a reachable payload before H either — the census recorded them as
  //     unpinnable for exactly that reason;
  //   · `RecordUpdateCompiler.interpretRelation`'s parent-held `kinds.length !== 1` —
  //     DELETED outright, replaced by `interpretParentHeldComposition`;
  //   · `assertToOneMutationArity` — DELETED outright, replaced by
  //     `composeToOneEntries`, which owns the ORDER as well as the membership question.
  //
  // THE ONE SITE ADDED is inside `composeToOneEntries`: a `create` or `connectOrCreate`
  // supplier composed with `update`. It is NOT the arity guard renamed. The arity guard
  // refused a payload for having two kinds; this one accepts the shape as meaningful and
  // names the engine's missing channel — a selected-record compiler locates its record
  // with a PLANNING read, planning precedes every write, so a row this fragment is about
  // to INSERT cannot be read by the step that would address it. `connect` composes with
  // `update` precisely because its unique selector is an identity that exists before the
  // first write. When the produced-identity selector channel lands, this site goes.
  //
  // THREE SHAPES THE LATTICE ADMITS AND ANOTHER OWNER STILL REFUSES — recorded because a
  // site census cannot show them and Package O's ledger needs them. All three are
  // `OwnWriteLedger.assertIndependent` (`NestedWriteError`, not a census site):
  //   · parent-held `delete` + `connect` — the connect's target read against the delete's
  //     target write. `delete: true` names the CURRENT member, whose identity is unknown
  //     at construction, so the analyzer cannot rule out that it is the row the connect
  //     names; if it were, the root would end pointing at a deleted row;
  //   · child-held `delete` + supplier + `update` — same overlap, on the modify's read;
  //   · child-held `create`/`connectOrCreate` + `update` reach the new site above first.
  //   `disconnect` + `connect` + `update` DOES execute: H moved the composed modify's
  //   decision read off membership and onto the supplier's selector in `OwnWriteSteps`,
  //   because that is literally the locator the engine compiles for it — leaving it on
  //   membership would have named the pair's own sibling vacate as the modify's premise,
  //   a dependency the compiled plan does not have.
  //
  // H GATE (2026-08-10) — measured, and recorded here because none of it is a site.
  //   · THE COUNT STANDS AT 20 DELIBERATELY. Every shape the lattice admits and the
  //     engine refuses was re-measured through the public client, one payload each: two
  //     reach the added site, five reach the own-write ledger. Narrowing them back into
  //     `to-one-mutation-schema.ts` was considered and REJECTED. For the five, the ledger
  //     already owns the invariant and a schema copy would have no coverage of its own —
  //     the house rule forbids a second owner. For the two, the added site's sentence
  //     names the obstacle and expires with it, while the schema's sentence would list
  //     kinds and read like the arity guard H just deleted. A coherent shape refused by a
  //     census-tracked engine site is this estate's normal way of carrying a limitation;
  //     a shape refused by the lattice means "this can never be meaningful".
  //   · ONE INVARIANT, TWO WRITERS: `composeToOneEntries` decides which payloads compose,
  //     and `OwnWriteRelation`'s `resolveComposedSupplierSelector` re-derives the same
  //     rule so the analyzer's decision read matches the compiled locator. They agree by
  //     construction today and nothing enforces it; widening one without the other makes
  //     the analyzer report a dependency the plan does not have. Both docblocks say so.
  //   · A BRANCH WITH NO REACHABLE PAYLOAD: `interpretParentHeldDelete`'s `rebound` arm
  //     takes `delete` beside any of the three suppliers, but `delete` + `connectOrCreate`
  //     is lattice-refused and `delete` + `connect` is ledger-refused, so `create` is the
  //     only supplier that reaches it — and a create's assignment is always a before-root
  //     INSERT reference. The `connect` spelling, whose assignment can instead be a lookup
  //     SUBQUERY, is unexercised. If the ledger's `delete`-target-write refusal is ever
  //     narrowed, this elision goes live on a value shape no witness covers.
  //
  // K GATE (2026-08-10) — 20 -> 21. ONE SITE ADDED, in `UpdateManyRecordSeries`:
  //   · `assertMembershipAppliesToEveryRoot` — a CHILD-HELD `connect`,
  //     `connectOrCreate` or `set` NAMING AT LEAST ONE EXISTING TARGET in root
  //     `updateMany` data when the capture found MORE THAN ONE root. The membership
  //     is stored on the target row and a target can hold one parent, so applying it
  //     to N roots in sequence ends with the last root owning the child and the rest
  //     silently not — which is not what "apply this update to every selected row"
  //     can mean. It is N-DEPENDENT, so no schema can own it (the count is only known
  //     after the capture), and it fires inside `compileMembers`, before any member
  //     is built and therefore before the first write. Junction and parent-held
  //     equivalents are deliberately NOT refused, and neither is `create`: those mean
  //     one thing per root. The same payload at N = 1 builds its member and runs.
  //     WHICH SHAPES qualify is `relation-key-legality.findSingleTargetMembershipMove`'s
  //     (the relation legality owner's); the shell owns the count and the sentence.
  //     Its DEPTH is the root's own relation keys: a membership move a fresh
  //     descendant carries is applied per root and is not refused, because at that
  //     depth the series does what N ordinary `update` calls do (pinned in
  //     `update-many-relation-series.test.ts`).
  //
  // NOT A SITE, recorded so Package O does not hunt for one:
  //   · the K1 widening RETIRED a refusal without adding one. Root `updateMany` data
  //     used to reject a relation key at the parse boundary as an UNKNOWN KEY (a
  //     `ValidationError`, never a census site) because it bound to the scalar-only
  //     schema. It now binds to `core.update` and the diagnostic is simply gone.
  //   · a relation-bearing `{ count }` updateMany on a batch-only driver inherits
  //     `withTransaction`'s generic substrate refusal (a `TransactionError`), exactly
  //     as J's `createMany` series does. The typed `with 'select'` sentence is kept by
  //     routing to the existing owner first, not by a second copy of the message.
  //   · the missing-final-read refusal on the `select` arm is a step POSTCONDITION
  //     (`exactlyOneRow`, `raceable: false`), which rides the existing failure
  //     channel and is not an `UnsupportedOperationError`.
  //   · the G polymorphic blind spot at the nested `updateMany` leaf was FIXED by
  //     routing three readers through one shared predicate (`relationWriteKeys`) into
  //     the EXISTING refusal. No message and no site changed; a shape that used to be
  //     silently dropped now reaches the wall that was always meant for it.
  //   · a relation-bearing `updateMany` on a model with no declared `.id()` refuses
  //     NOTHING of its own. `getPrimaryKeyFields` is total (it answers `["id"]` for
  //     such a model), so the guard the K lane drafted for this was unreachable and
  //     was deleted at the gate rather than kept as a check whose coverage cannot be
  //     named. `ManyAndReturnOperation.pkSelect` and `RecordUpdateCompiler`'s
  //     `parentPrimaryKeys.length === 0` are the same dead shape, pre-existing — a
  //     Package O item, not a K one.
  //   · `limit: 0` with relation-bearing data is not a series at all: the router
  //     keeps it on the existing owner, which already compiles a zero cap to the
  //     empty plan. So the `{ count: 0 }` answer needs no transaction and stays
  //     available on batch-only drivers.
  //
  // 21 -> 15 (LIMITATION LIFT, PACKAGE O — "give every surviving guard one owner").
  // SIX sites left the write engine and NOT ONE limitation left with them: every shape
  // below is still refused, still at construction, still typed, and now says so in one
  // place. The full ownership analysis — first-knowable boundary, unique reachable
  // failure, falsifier and §O3 answers for every survivor — is
  // `docs/architecture/guard-ownership-ledger.md`; what follows is the delta.
  //   · **-3, cluster 2** (`RelationJunctionPart.scalarOnly`,
  //     `RelationWritePart.parseScalarUpdateData`, and the ordinary arm of
  //     `relation-key-legality.assertSelectedUpdateManyDataIsScalar`) — ONE invariant,
  //     "nested bulk data carries relation writes", had FOUR expressions. The junction
  //     and ordinary wordings were two throw tokens of one decision and are now one
  //     construction site choosing its noun from `invalid.isJunction`; both sentences
  //     survive byte-identically. The two Part-level copies were dominated on every
  //     measured route — `RecordUpdateCompiler`'s two positions do not even BUILD the
  //     Part when `updateManyCarriesRelations`, and the third producer,
  //     `nested-target-parts.buildJunctionTargetRelationParts`, now calls the owner at
  //     its seam — a CALL POSITION of the one owner, not a second guard, and one with
  //     no measured live route (that fold's only producer is create-context data, whose
  //     schema has no `updateMany` key). It is kept for the reason the Package N gate
  //     recorded at the bottom of this file: on a bulk arm, "no measured live route" is
  //     not licence, because the arm N's implementer note had called dead was the one
  //     silently reparenting rows. The junction copy was also the FOURTH reader of `Object.keys(relations)`
  //     alone — the map-only question Package K proved is a measured silent wrong answer
  //     for a direct polymorphic key — so deleting it removed a blind spot rather than
  //     teaching a duplicate to see.
  //   · **-3, cluster 1** (`interpretPolymorphicRelation`, `targetReferencedValue`,
  //     `referencedValue`, `referencedParentSource`) — ONE invariant, "a fresh record
  //     cannot publish the referenced column this edge needs", asked
  //     `recordReferenced` the same question four times and differed only in the noun
  //     for the position. `CreateOperation.requireRecordReferenced` is now the owner
  //     (§O2 row 2's "CreateOperation demand publication"); it takes a position and
  //     builds the sentence, and every pinned message is byte-identical
  //     (`parity-f-fresh-field` :813/:819/:830/:842, `fresh-produced-field` :481,
  //     `compound-relation-adoption-behavior` :318 all pass unchanged). The one text
  //     that moved is the direct-polymorphic one, which said `query-engine` where its
  //     three siblings said `query-engine-v2` and which nothing pinned. Its
  //     `connectOrCreate` twin keeps its `QueryEngineError` class — one sentence in two
  //     classes, the estate's oldest instance — but now shares the owner's message
  //     builder so the two cannot drift; converting it owes a behavioral witness of the
  //     shape and MEASUREMENT SAYS NO PAYLOAD REACHES EITHER: a direct polymorphic
  //     edge's referenced field is always the target's PRIMARY KEY, and the three
  //     spellings that would make it unresolvable (absent, `null`, an `Sql` operand) are
  //     all refused by the parse boundary first.
  //   · **-1, site 17 CONVERTED, not absorbed** (`CreateOperation.edgeParentId`) — its
  //     docblock claimed it reached the compound-primary-key m2m fact "one statement
  //     earlier" than `getRequiredSinglePrimaryKeyField`. MEASURED FALSE: a junction
  //     program on a compound-PK model is answered by `OwnWriteAnalyzer` ->
  //     `getRelationMembershipScope` -> `getManyToManyJoinInfo` -> that function, at the
  //     record-program boundary, BEFORE any relation is interpreted. The shape is still
  //     refused in the ENGINE (plan §7.4 / §6 N2 forbid sealing it in validation, and
  //     nothing has), by an owner whose message names the surrogate-key remedy. The
  //     conversion's behavioral witness is in `operation-construction-witnesses.test.ts`,
  //     which pins the answering owner, its stack, and the fact that the parse boundary
  //     does NOT answer.
  //
  // NOT A SITE, but deleted by Package O and recorded here:
  //   · `ManyAndReturnOperation.pkSelect` and `RecordUpdateCompiler`'s
  //     `parentPrimaryKeys.length === 0` — the two pre-existing dead PK guards Package K
  //     handed on (K's own handoff names exactly these two). `getPrimaryKeyFields` is
  //     total, deleting them turns nothing red, and that IS the falsification for this
  //     class.
  //     THE CLASS HAS FIVE MEMBERS, NOT TWO, and the first version of this entry read
  //     as though it were exhaustive. The other three — `DeleteOperation.ts:105`,
  //     `UpdateOperation.ts:259`, `UpsertOperation.ts:223` — are the same dead
  //     predicate and they STAY, because they are not the same thing doctrinally:
  //     each is a member of the N7-U-A converted family, each names the boundary that
  //     answers instead (the where-unique parse), and each is PINNED by a behavioral
  //     witness in `operation-construction-witnesses.test.ts` (`:344` for the update
  //     root, `:796` for upsert and delete) asserting that the parse boundary answers
  //     FIRST. That is the estate's disposition for an unreachable-by-construction
  //     branch — convert, name the owner, pin it — and deleting a pinned member of it
  //     would delete its witness too. The two that went had no witness and named no
  //     owner. If a future package retires the family, it retires all five together.
  //   · `target-projection.capturedTargetConstraint` — ZERO production consumers.
  //     Package C kept it under the plan's mandate with the rule "if Package D lands
  //     without consuming it, Package O deletes it"; Package D refused it on SHAPE and
  //     recorded why at its owner. Deleted with its unit test, which was its only caller
  //     in the repository.
  //
  // 15 -> 14 (DISTINCT-TRUTH COMPRESSION, PHASE 2 — "give inverse resolution a schema
  // owner"). ONE SITE DELETED, none added, and no limitation left with it, because the
  // invalid program it refused can no longer be CONSTRUCTED — which is this estate's only
  // licence to delete a guard rather than convert it.
  //   · **-1, site 11** (`RelationWritePart.assertOwnedFkAbsentFromUpdateData`, together
  //     with all FOUR of its call positions) — "a second provenance for the relation-owned
  //     foreign key". Package N1 moved that family to the parse boundary and RETAINED this
  //     site for ONE reason, the one the closing narrative below states: the two runtime
  //     scanners that answer "which column does this relation own" read `.fields()`
  //     differently, so a relation spelled `.fields()` with ZERO arguments answered `[]`
  //     from the validation scanner (`[]` is truthy, the omission removed nothing) and was
  //     DROPPED by the engine scanner (`fields && fields.length > 0`, so the engine knew a
  //     foreign key the parse had admitted). PHASE 2 ALIGNED THEM on the engine's reading
  //     and gave candidate discovery one owner — `src/schema/relation/inverse.ts`, with
  //     `getInverseRelationMap` as its FK-OMISSION VIEW and `bindRelation` as its
  //     query-time consumer (which also took over the two error translations the deleted
  //     `findInverseRelationState` used to raise). The parse now omits the owned FK on
  //     EVERY schema, so the guard's only route stopped existing.
  //   · THE FALSIFIERS ARE RE-AUTHORED, not deleted, which is what makes this a deletion
  //     and not a hole: `nested-update-owned-fk.test.ts` keeps BOTH degenerate schemas —
  //     the zero-argument `.fields()` to-one and the ghost-candidate to-many — and all
  //     four payloads, and pins their new answers (`ValidationError: … Unknown key:
  //     userId` at the parse, zero statements recorded, the child still under its own
  //     parent). Restore either truthiness reading and the bulk `updateMany` arm reparents
  //     the row again, with no engine guard behind it any more.
  //   · THE INVARIANT SURVIVES with one site: `RelationUpsertPart.withoutAgreeingOwnedFk`
  //     (site 12) still owns "a second provenance for the owned FK" on the upsert seam,
  //     where the engine ABSORBS an agreeing spelling instead of refusing it. So the
  //     distinct-invariant count does not move; only the position count does.
  test("no UnsupportedOperationError throw site exists outside the reviewed set", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(SOURCE_ROOT, "query-engine/write-engine");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    let sites = 0;
    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8");
      sites += source.split("new UnsupportedOperationError(").length - 1;
    }
    expect(sites).toBe(14);
  });

  /**
   * The classification names 18 throw coordinates and 17 owner declarations. Package N3
   * deleted the previous generation of line-number claims because they had decayed — 18
   * of 22 doc coordinates no longer resolved — and then wrote fresh ones, which decay
   * exactly the same way unless something executes them. This is that something: it
   * re-resolves every coordinate against the tree, so a move that shifts a line turns
   * this red instead of quietly making the narrative false again.
   *
   * SITE NUMBERS ARE N3's AND ARE NOT RENUMBERED. Package O compressed the census and
   * seven numbers left it; keeping the survivors' numbers is what lets this file, the
   * closing narrative, and `docs/architecture/guard-ownership-ledger.md` be read side by
   * side. The gaps are the record:
   *
   *   · 9, 10, 23 — cluster 2, "nested bulk data carries relation writes". FOUR
   *     expressions became ONE owner (site 22).
   *   · 14, 16, 18 — cluster 1, "a fresh record cannot publish the referenced column
   *     this edge needs". FOUR construction sites became ONE owner (site 15,
   *     `requireRecordReferenced`), which names its position.
   *   · 17 — the compound many-to-many refusal, CONVERTED to a `QueryEngineError`
   *     naming a structural invariant, with the behavioral witness this file's
   *     conversion law demands (`operation-construction-witnesses.test.ts`, "a compound
   *     primary key carrying a many-to-many relation"): the OwnWrite analyzer's m2m
   *     resolution answers that payload first, so the site refused nothing.
   *   · 11 — the owned-FK guard, DELETED by Phase 2 of the distinct-truth compression
   *     (the count-evolution block's last entry). Not folded into another owner and not
   *     converted: aligning the two inverse scanners made its only route unconstructible,
   *     and its falsifiers were re-authored against the parse boundary that now answers.
   *
   * Sites 25 and 26 build the error and `return` it to a thrower, so the assertion is
   * on the CONSTRUCTION token, which is what the census counts.
   */
  test("every classified coordinate still resolves", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");

    /** `[site, path under src, throw line, owner declaration line, owner symbol]`.
     *  A `null` owner symbol means the site's owner is not a named declaration
     *  (site 7 is the constructor). */
    const CLASSIFIED: readonly [
      number,
      string,
      number,
      number | null,
      string | null,
    ][] = [
      [
        1,
        "query-engine/write-engine/UpdateManyRecordSeries.ts",
        // Shifted -1 when unit 9.6 deleted the series' unread `mode` line.
        347,
        336,
        "assertMembershipAppliesToEveryRoot",
      ],
      [
        2,
        "query-engine/write-engine/RecordUpdateCompiler.ts",
        1800,
        1772,
        "postTransitionReference",
      ],
      [
        3,
        "query-engine/write-engine/RecordUpdateCompiler.ts",
        2017,
        1911,
        "resolveCreateParent",
      ],
      [
        4,
        "query-engine/write-engine/RecordUpdateCompiler.ts",
        3533,
        3513,
        "recordSharedKeyFold",
      ],
      [
        5,
        "query-engine/write-engine/RecordUpdateCompiler.ts",
        3612,
        3604,
        "beforeTargetReferencedValue",
      ],
      [
        6,
        "query-engine/write-engine/RecordUpdateCompiler.ts",
        4767,
        4728,
        "composeToOneEntries",
      ],
      [
        7,
        "query-engine/write-engine/CreateManyRecordSeries.ts",
        // Shifted -1 by unit 9.6 (mode deletion).
        125,
        null,
        null,
      ],
      [
        8,
        "query-engine/write-engine/RelationJunctionPart.ts",
        1374,
        1362,
        "resolveCreatePk",
      ],
      [
        12,
        "query-engine/write-engine/RelationUpsertPart.ts",
        754,
        743,
        "withoutAgreeingOwnedFk",
      ],
      [
        13,
        "query-engine/write-engine/RelationUpsertPart.ts",
        1211,
        1204,
        "assertArmEdgeIsChildHeld",
      ],
      [
        15,
        "query-engine/write-engine/CreateOperation.ts",
        2772,
        2764,
        "requireRecordReferenced",
      ],
      [
        19,
        "query-engine/write-engine/CreateOperation.ts",
        2850,
        2839,
        "producedReference",
      ],
      [
        20,
        "query-engine/write-engine/CreateOperation.ts",
        3154,
        3140,
        "assertSharedPkResolved",
      ],
      [
        21,
        "query-engine/write-engine/UpsertOperation.ts",
        1147,
        1103,
        "createArmIdentity",
      ],
      [
        22,
        "query-engine/relation-key-legality.ts",
        173,
        167,
        "assertSelectedUpdateManyDataIsScalar",
      ],
      [
        24,
        "query-engine/builders/decimal-portability.ts",
        56,
        48,
        "assertExactDecimalOperation",
      ],
      [
        25,
        "drivers/shared/transaction-options.ts",
        144,
        139,
        "refuseTransactionOption",
      ],
      [26, "client/raw.ts", 129, 128, "rawOperationInBatchError"],
    ];

    const cache = new Map<string, string[]>();
    const linesOf = async (relative: string) => {
      const cached = cache.get(relative);
      if (cached) return cached;
      const lines = (await readFile(join(SOURCE_ROOT, relative), "utf8")).split(
        "\n"
      );
      cache.set(relative, lines);
      return lines;
    };

    const misses: string[] = [];
    for (const [site, relative, throwLine, ownerLine, owner] of CLASSIFIED) {
      const lines = await linesOf(relative);
      const at = lines[throwLine - 1] ?? "";
      if (!at.includes("new UnsupportedOperationError(")) {
        misses.push(
          `site ${site}: ${relative}:${throwLine} is not a construction — ${at.trim()}`
        );
      }
      if (ownerLine === null || owner === null) continue;
      const declaration = lines[ownerLine - 1] ?? "";
      if (!declaration.includes(owner)) {
        misses.push(
          `site ${site}: ${relative}:${ownerLine} does not declare '${owner}' — ${declaration.trim()}`
        );
      }
    }
    expect(misses).toEqual([]);
    // The list itself must stay complete, or a site could be dropped to keep it green.
    expect(CLASSIFIED.length).toBe(18);
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

describe("write engine full client operation surface (P6 precondition)", () => {
  test("_surfaceIsComplete type-guard holds (list covers the Operations union)", () => {
    expect(_surfaceIsComplete).toBe(true);
    // 16 since W3-B (was 18): see the DELIBERATE EDIT note on the list above.
    expect(CLIENT_OPERATION_SURFACE).toHaveLength(16);
  });

  test("every client operation family routes to production engine except the documented direct client fallbacks", () => {
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

  test("the migrated `create` family constructs on production engine (proven by construction, not by listing)", () => {
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

  test("each documented direct client fallback (if any) constructs to undefined (dispatched to direct client)", () => {
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

/**
 * ===========================================================================
 * THE CLASSIFICATION (Package N3, 2026-08-11) — what the census NUMBER means
 * ===========================================================================
 *
 * The tripwire above counts construction POSITIONS. This section says what each
 * position is, in exactly one of the five buckets the limitation-lift plan's §6 N3
 * names. "Exactly one" is the discipline: a site whose reason splits across two
 * buckets is a site expressing two invariants, which is a finding for the guard-
 * ownership ledger rather than a classification. One such site is flagged below.
 *
 *   SC   semantic contradiction        — the payload asks for two incompatible things.
 *   MSI  missing stable identity       — no value, when the decision must be made,
 *                                        names the row the operation must address.
 *   PSI  provider/substrate impossible — another provider or transaction mode answers
 *                                        the same payload.
 *   DPC  deliberately deferred product contract — implementable; refused because the
 *                                        public meaning has not been chosen.
 *   UFF  unimplemented future feature   — coherent and wanted; every UFF row states
 *                                        the work it waits on.
 *
 * THE WRITE-ENGINE SITES (the number this file pins: 21 when N3 wrote this section,
 * 15 after Package O, 14 after Phase 2 of the distinct-truth compression deleted site 11
 * — the per-site rows below keep N3's numbering, and the eight numbers those two rounds
 * retired are named in the count-evolution block)
 *
 * TWO COORDINATE COLUMNS, because one of them is history. "N3" is where the site stood
 * when this section was written; "HEAD" is where it stands now, and is what the
 * executable `CLASSIFIED` table below re-resolves. A row marked RETIRED has no HEAD
 * coordinate — Package O folded it into another owner or converted its class — and is
 * kept because a coordinate that vanishes teaches nothing.
 *
 *  #  site (throw) — N3               owner (declaration) — N3          bucket  HEAD
 *  1  UpdateManyRecordSeries.ts:348   assertMembershipAppliesToEveryRoot:337  SC   :348 / :337
 *  2  RecordUpdateCompiler.ts:1800    postTransitionReference:1772            MSI  :1800 / :1772
 *  3  RecordUpdateCompiler.ts:2017    resolveCreateParent:1911                MSI  :2017 / :1911
 *  4  RecordUpdateCompiler.ts:3533    recordSharedKeyFold:3513                MSI* :3533 / :3513
 *  5  RecordUpdateCompiler.ts:3612    beforeTargetReferencedValue:3604        MSI  :3612 / :3604
 *  6  RecordUpdateCompiler.ts:4767    composeToOneEntries:4728                UFF  :4767 / :4728
 *  7  CreateManyRecordSeries.ts:126   the constructor                         DPC  :126
 *  8  RelationJunctionPart.ts:1374    resolveCreatePk:1362                    MSI  :1374 / :1362
 *  9  RelationJunctionPart.ts:2354    scalarOnly:2343                         MSI  RETIRED → 22
 * 10  RelationWritePart.ts:691        parseScalarUpdateData:676               MSI  RETIRED → 22
 * 11  RelationWritePart.ts:1244       assertOwnedFkAbsentFromUpdateData:1234  SC   RETIRED (deleted)
 * 12  RelationUpsertPart.ts:754       withoutAgreeingOwnedFk:743              SC   :754 / :743
 * 13  RelationUpsertPart.ts:1211      assertArmEdgeIsChildHeld:1204           SC   :1211 / :1204
 * 14  CreateOperation.ts:991          interpretPolymorphicRelation:961        MSI  RETIRED → 15
 * 15  CreateOperation.ts:1789         targetReferencedValue:1781              MSI  :2772 / :2764
 *                                     (HEAD owner: requireRecordReferenced)
 * 16  CreateOperation.ts:2109         referencedValue:2101                    MSI  RETIRED → 15
 * 17  CreateOperation.ts:2139         edgeParentId:2133                       UFF  RETIRED (converted)
 * 18  CreateOperation.ts:2193         referencedParentSource:2186             MSI  RETIRED → 15
 * 19  CreateOperation.ts:2788         producedReference:2777                  PSI  :2850 / :2839
 * 20  CreateOperation.ts:3091         assertSharedPkResolved:3077             MSI  :3154 / :3140
 * 21  UpsertOperation.ts:1147         createArmIdentity:1103                  MSI  :1147 / :1103
 *
 * (*) Site 4 is ONE sentence over TWO invariants: "no value" and "NULL" are MSI, but
 *     "a root SET spells the same member the arm folds, DISAGREEING" is SC. Recorded,
 *     not split — Package O sustained the flag and DECLINED the split: splitting one
 *     shipped sentence would create a second owner for one fact seen from two sides.
 *
 * THE QUERY-ENGINE SITES OUTSIDE THIS DIRECTORY (invisible to the tripwire, which
 * reads only `write-engine/`, and therefore worth naming here). THREE when N3 wrote
 * this; TWO after Package O merged 22 and 23 into one construction site.
 *
 * 22  relation-key-legality.ts:162    assertSelectedUpdateManyDataIsScalar:155  MSI  :173 / :167
 * 23  relation-key-legality.ts:166    the same function, ordinary arm           MSI  RETIRED → 22
 * 24  builders/decimal-portability.ts:56  assertExactDecimalOperation:48        PSI  :56 / :48
 *
 * THE 2 `src` SITES OUTSIDE THE QUERY ENGINE
 *
 * 25  drivers/shared/transaction-options.ts:144  refuseTransactionOption:139         PSI
 * 26  client/raw.ts:129                          rawOperationInBatchError:128        SC
 *
 * DISTINCT INVARIANTS — the measure §O4 calls the more important one.
 *
 * The 24 query-engine sites collapsed to TWELVE cluster HEADINGS — and to THIRTEEN
 * invariants, because cluster 4 is one phrase over two of them. N3 wrote both numbers
 * and left the choice open; PACKAGE O RESOLVED IT ON THE EVIDENCE IN CLUSTER 4's OWN
 * ROW (two different invalid states, two different first-knowable boundaries, two
 * different buckets — DPC and MSI — and two falsifiers that do not answer each other),
 * so 13 is the base number and the "12" this paragraph used to headline was an
 * undercount. The same correction applies to `guard-ownership-ledger.md`, which had
 * carried it through as 11/13, and to `forbidden-shapes-reference.md` §12.
 *
 *   #  invariant                                   N3 sites            after O
 *   1. an unresolvable referenced value            8 (2,3,5,14,15,      4 (2,3,5,15)
 *                                                     16,18,20)
 *   2. nested bulk data carries relation writes    4 (9,10,22,23)      1 (22)
 *   3. a second provenance for the owned FK        2 (11,12)           2 (11,12),
 *      then 1 (12) after Phase 2 of the distinct-truth compression deleted site 11. The
 *      invariant is UNCHANGED — the upsert seam still owns it, and the nested-update
 *      family is owned by the parse boundary on every schema.
 *   4. skipDuplicates without an identity          2 (7,8) — TWO       2 (7,8) — TWO
 *      contracts: 7 is DPC (the public meaning is unchosen) and 8 is MSI (a skipped
 *      row produces no identity). One PHRASE, two invariants; counted as two.
 *   5. an upsert create arm with no readable-back row .. 21             21
 *   6. a shared primary key with no one final value .... 4 (+20, which  4, 20
 *      N3 filed under cluster 1 and the ledger moves here: same invariant, create
 *      root instead of update root, a genuinely different trust boundary)
 *   7. a single-target membership move across N>1 roots  1              1
 *   8. a composed producing supplier + modify .......... 6              6
 *   9. a compound child edge into a junction ........... 17             NONE — the
 *      site was CONVERTED (see the count-evolution block); the invariant is still
 *      engine-owned, by `getRequiredSinglePrimaryKeyField`, and still refused before
 *      any I/O, but a census grep can no longer see it
 *  10. depth on an upsert's update arm ................. 13             13
 *  11. publication on a batch substrate ................ 19             19
 *  12. decimal portability ............................. 24             24
 *
 * So: SITES 24 → 17 in the query-engine scope, INVARIANTS 13 → 12 as an
 * `UnsupportedOperationError` and 13 still engine-owned. Nothing became legal; one
 * invariant changed error class. By scope, as §O4 asks them to be reported:
 * write-engine 15 sites / 10 invariants · query-engine 17 / 12 · whole `src` 19 / 14.
 *
 * AFTER PHASE 2 of the distinct-truth compression (site 11 deleted, an SC row whose
 * invariant keeps site 12): write-engine 14 sites / 10 invariants · query-engine 16 / 12 ·
 * whole `src` 18 / 14. Sites move, invariants do not — which is the shape §O4 asks for.
 *
 * WHAT THAT DOES AND DOES NOT SETTLE, stated exactly, because the first version of
 * this paragraph got it wrong. §O4's 8–12 band is a gate on CONSTRUCTION SITES
 * ("Expected result: 8–12 construction sites"; "A result above 12 blocks finalization
 * until an architecture review examines every survivor"). 24 is double the ceiling, so
 * Package O's architecture review is MANDATORY, not optional, and it must examine every
 * survivor and approve each extra site's distinct trust boundary and unique falsifier.
 * The invariant count is what §O4 asks to be REPORTED beside the raw count ("Report both
 * the raw site count and the number of distinct invariants"), not a second gate that can
 * be met instead — 12 is a good number to walk in with, not a pass.
 *
 * Cluster 1 alone was eight sites saying one thing, and it is exactly §O2's "fresh
 * referenced field publication" group: the largest single compression opportunity in
 * Package O, and arithmetic rather than judgement. IT IS NOW FOUR — sites 14, 16 and 18
 * fold into 15, and 20 belongs to cluster 6. It is also measured over ONE error class:
 * `CreateOperation.ts:1027` (N3 read it at `:1015`) states site 14's sentence
 * BYTE-IDENTICALLY as a `QueryEngineError`, and `RecordUpdateCompiler.ts:939`, `:964`
 * and `:1164` express the same invariant in that class too. Package F recorded the
 * first pair as a For-O item; all four are named here because the header above warns
 * that changing the class removes a site from the grep, and cluster 1 is where that
 * warning actually bites. Package O made the twin share the owner's MESSAGE BUILDER so
 * the two sentences cannot drift, and did NOT convert its class: the conversion law
 * ("a conversion owes a behavioral witness of the shape") cannot be paid when no
 * payload reaches either polymorphic position — a direct polymorphic edge's referenced
 * field is always the target's primary key, and the three spellings that would make it
 * unresolvable are refused by the parse boundary first.
 *
 * Bucket distribution, N3's (before Package O):
 *   over all 26: MSI 15 · SC 5 · PSI 3 · UFF 2 · DPC 1 (= 26).
 *   over the 24 query-engine sites: MSI 15 · SC 4 · PSI 2 · UFF 2 · DPC 1 (= 24).
 *   over the 21 write-engine sites: MSI 13 · SC 4 · PSI 1 · UFF 2 · DPC 1 (= 21).
 * AFTER PACKAGE O:
 *   over all 19: MSI 9 · SC 5 · PSI 3 · UFF 1 · DPC 1 (= 19).
 *   over the 17 query-engine sites: MSI 9 · SC 4 · PSI 2 · UFF 1 · DPC 1 (= 17).
 *   over the 15 write-engine sites: MSI 8 · SC 4 · PSI 1 · UFF 1 · DPC 1 (= 15).
 * AFTER DISTINCT-TRUTH PHASE 2 (one SC row, site 11, deleted):
 *   over all 18: MSI 9 · SC 4 · PSI 3 · UFF 1 · DPC 1 (= 18).
 *   over the 16 query-engine sites: MSI 9 · SC 3 · PSI 2 · UFF 1 · DPC 1 (= 16).
 *   over the 14 write-engine sites: MSI 8 · SC 3 · PSI 1 · UFF 1 · DPC 1 (= 14).
 * Six MSI positions left (9, 10, 14, 16, 18, 23) and one UFF changed class (17).
 * Each line is stated with its total because the first version of the first line summed
 * to 25 and nobody noticed until it was added up.
 *
 * RESIDUES WITH A STATED EXPIRY — and the one that may not have one.
 *
 *   · Site 6 waits on a produced-identity selector channel for `RecordUpdateCompiler`
 *     (a final reference into an earlier INSERT's outputs, consumed by `writeWhere`,
 *     the captured-key guards and the terminal read). Package H named it.
 *   · Site 17 waits on the `JunctionSide` topology (limitation-lift plan §6 N2), whose
 *     schema, migration, join-SQL, OwnWrite and engine work that section enumerates.
 *     Package N2 re-verified that NOTHING has sealed it: no rule in `src/validation`
 *     or `src/schema/validation` reads a junction's compound primary key, the two
 *     carve-outs in `RelationJunctionPart` still name `JunctionSide` by name, and
 *     `JunctionRelation` still carries none of the two-sides topology.
 *   · Sites 9, 10, 22 and 23 get NO expiry. Package L prototyped both lifts and BOTH
 *     were REJECTED, so nothing in this lift lifts the nested-bulk wall and a comment
 *     promising otherwise would be promising unscheduled work. L's boundary, verbatim:
 *     "the fragment atom's single planning phase is the wall; a record series is
 *     operation-level, so a nested capture has no home." The truthful future path is
 *     not a series at all — it is the DESUGAR already standing on the junction leg
 *     (`RelationJunctionPart`'s `case createMany` folds one fresh target per row,
 *     identically to its `case create`) and at `nested-target-parts.ts` (`createFresh`
 *     + `bindRelationMembership`). Extending that to the other three legs is a NEW
 *     capability outside this lift.
 *
 * FOUR THINGS THAT ARE NOT SITES, recorded so Package O does not hunt for them.
 *
 *   · `relation-key-legality.ts:61` (`assertUpdateManyRelationsAreCompilable`) throws
 *     `NestedWriteError`. Package L's outcome brief listed it among "4 census sites
 *     unchanged"; it has never been one.
 *   · The compound-M2M fact has TWO owners across layers and NEITHER is a census site:
 *     `builders/correlation-utils.ts:154` (`getRequiredSinglePrimaryKeyField`, a
 *     `QueryEngineError`) and `migrations/serializer.ts:661` (a raw `Error`). Their
 *     sentences are near-identical but not byte-identical — "uses a compound primary
 *     key" against "uses compound primary key". N3 wrote here that site 17 reached the
 *     same fact "one statement earlier" and was the only one a census grep could see;
 *     PACKAGE O MEASURED THAT FALSE — site 17 never reached the fact at all, the first
 *     of the two answers every public payload, and site 17 is now a `QueryEngineError`
 *     itself. So the grep sees none of the three, which is the honest state of it.
 *   · Package K's PK-less-model refusal was DEAD (`getPrimaryKeyFields` is total) and
 *     was deleted at its gate rather than becoming a 22nd site.
 *   · Package J's gate fix rides the existing Failure/TransactionError channel.
 *
 * TWO NON-REFUSAL FACTS a truthful record owes the reader.
 *
 *   · `ValidationError` path prefixes are asymmetric across the bulk arms:
 *     `CreateManyRecordSeries` parses with the prefix `createMany`, while
 *     `ManyAndReturnOperation` and `UpdateManyRecordSeries` validate unprefixed. So
 *     one payload's issue path depends on which arm read it. Pre-existing; now on
 *     both accepted shapes, which is why it is worth writing down.
 *   · `sortCapturedRowKeys` (`target-projection.ts`) orders `updateMany` series
 *     members deterministically PER DEPLOYMENT but not identically ACROSS providers:
 *     node-postgres decodes an int8 row key as the string "9", PGlite as the number 9,
 *     better-sqlite3 as 9n, which rank differently. Visible in the `select` arm's row
 *     order. A documented determinism boundary, not a refusal.
 *
 * WHAT PACKAGE O DID TO THIS NUMBER: 21 → 15, and the classification above is now
 * READ THROUGH `docs/architecture/guard-ownership-ledger.md`, which is this census's
 * companion document. That ledger carries, for every surviving construction site, the
 * §6 O1 columns (first-knowable boundary, unique reachable failure, falsifier, bucket,
 * disposition) plus the §O3 five-question audit and the non-census near-guards the
 * packages found. THIS file stays the executable owner — it counts the positions and
 * re-resolves every coordinate; the ledger stays the reasoning owner. When they
 * disagree, this file is right about WHAT IS THERE and the ledger is right about WHY.
 *
 * The six deltas are itemised in the count-evolution block above. What the buckets
 * below lose: cluster 2's MSI sites 9, 10 and 23 fold into site 22; cluster 1's MSI
 * sites 14, 16 and 18 fold into site 15; and site 17, the ONE UFF row that failed §O3
 * clause 1 and was kept by plan mandate, turned out to fail clause 3 as well and became
 * a `QueryEngineError`. The honest distinct-invariant arithmetic, which §O4 calls the
 * more important measure: twelve of the thirteen are untouched, and the thirteenth —
 * the compound many-to-many topology — is still refused by the engine before any I/O,
 * just not by an `UnsupportedOperationError` any more. So this census now covers 12
 * distinct invariants in the query-engine scope; the engine owns 13. Nothing became
 * legal. (The base was 13, not 12: cluster 4 is one phrase over two invariants, which
 * N3's own row argued and Package O settled — see the DISTINCT INVARIANTS block above.
 * An earlier Package O draft carried the undercount forward as 11/12.)
 *
 * WHAT PACKAGE N ITSELF DID TO THIS NUMBER: nothing. N1 moved the owned-FK refusal to
 * the parse boundary at five nested positions (one of which — nested `updateMany` —
 * had no engine guard at all and was silently reparenting rows), and RETAINED site 11,
 * because a schema spelled `.fields()` with zero arguments still gets a spelled owned
 * FK past the omission: the validation scanner tests that array for truthiness and the
 * engine scanner tests its length. Census 21 → 21.
 *
 * WHAT THE PACKAGE N GATE ADDED, and why it is not a 22nd site: site 11's guard had
 * THREE call positions and the invariant had FOUR arms. The gate measured the missing
 * arm through the public client — on the divergent schema, `posts.updateMany.data.userId`
 * returned success and left the row under `thief`, so N1's parse closure did not reach
 * it and no engine guard ever had — and wired `buildToManyUpdateManyParts` to the SAME
 * guard function. One invariant, one owner, one message, four call positions
 * (`RelationWritePart.ts` :1268, :1310, :1339, :1365); no new `UnsupportedOperationError`
 * is constructed, so the number this file pins is untouched. THREE of the four are now
 * reachable and pinned in `nested-update-owned-fk.test.ts`, each falsifiable with a
 * reparented row. The dead one is `buildToManyUpdateParts` (:1268): the targeted arm
 * binds the target's relations, so the divergent schema's unbindable zero-argument side
 * raises `Cannot determine FK fields …` from the engine's scanner first, while the bulk
 * arm binds nothing and therefore arrives. Package O must re-measure an arm's binding
 * behaviour before reading "no live route" as licence to delete a call position.
 *
 * WHAT PHASE 2 OF THE DISTINCT-TRUTH COMPRESSION DID TO BOTH PARAGRAPHS ABOVE: it
 * discharged the retention condition they state. N1's reason for keeping site 11 was the
 * `.fields()` disagreement itself, so aligning the two scanners on `fields.length > 0` —
 * and giving candidate discovery ONE owner in `src/schema/relation/inverse.ts` — removed
 * the guard's only route, and the site is DELETED with all four call positions. Census
 * 15 → 14. The gate's warning survives its own subject and is the reason this was allowed:
 * the four positions were not deleted for having "no live route", they were deleted
 * because the parse now omits the owned FK on EVERY schema, and each position's payload
 * was re-measured through the public client and re-pinned at the boundary that answers it
 * (`nested-update-owned-fk.test.ts`, both degenerate schemas kept as the falsifiers).
 */
