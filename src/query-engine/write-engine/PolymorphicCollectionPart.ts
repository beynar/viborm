// biome-ignore-all lint/style/useFilenamingConvention: PolymorphicCollectionPart is the architecture name.
import { UnsupportedOperationError } from "@errors";
import { bindPolymorphicCollectionMember } from "../builders/polymorphic-collection-mutation";
import type {
  PolymorphicCollectionArm,
  RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import type { JunctionTargetRelationsBuilder } from "./nested-target-parts";
import {
  bucketOperationSteps,
  type OperationStep,
  type StatementStep,
} from "./OperationFragment";
import type { Part } from "./Part";
import type { RecordCompilerSeam } from "./RecordUpdateCompiler";
import {
  buildJunctionParts,
  createResolvedJunctionMembershipRegistry,
  createSharedAdoptCreatedRegistry,
} from "./RelationJunctionPart";
import type { FinalReferenceSources } from "./relation-membership";
import type { StepScope } from "./StepScope";

export interface PolymorphicCollectionPartInput {
  readonly scope: StepScope;
  readonly engine: QueryEngine;
  readonly parentScope: QueryScope;
  readonly arm: PolymorphicCollectionArm;
  /** ONE owner-row publication, shared by every leaf of every variant. */
  readonly parentId: FinalReferenceSources;
  readonly membershipReadSource: FinalReferenceSources;
  readonly freshParent?: boolean;
  readonly txMode: boolean;
  readonly recordCompilers: RecordCompilerSeam;
  readonly nestedBuilder: JunctionTargetRelationsBuilder;
}

/**
 * THE DIRECT POLYMORPHIC COLLECTION COORDINATOR (plan §1.5).
 *
 * It returns **ONE `Part`**, not a list, and that is the whole reason it exists.
 * `CreateOperation.emitRecord` and `RecordUpdateCompiler` concatenate sibling
 * Parts' statements IN LIST ORDER, so N independent variant Parts could not
 * express a clear-once barrier: each would clear its own member table wherever it
 * happened to sit, and the `set` semantics — "clear every configured variant
 * exactly once, THEN insert the desired rows" — would depend on emission order.
 *
 * It owns exactly FIVE relation-wide facts and nothing else:
 *
 *  1. the `set` clear-all barrier,
 *  2. cross-verb / cross-variant ordering,
 *  3. the single owner-row publication every leaf correlates on,
 *  4. the cache footprint — **which is empty, as a measured fact**. Invalidation
 *     lives ABOVE the engine: `client.ts` wraps the pending operation with
 *     `withMutationCacheInvalidation`, whose closure fires on the ROOT model name
 *     and public operation, and `$transaction([...])` runs the same closure. No
 *     `Part` anywhere in the estate invokes a cache callback. Adding target-model
 *     invalidation here would be exactly the "private dependency-invalidation
 *     system that ordinary relations do not have" §10.6 forbids.
 *  5. one compile-local singular-target coordination state shared by its leaves:
 *     resolved membership targets and missing-arm first creates.
 *
 * Everything else is a LEAF's: one `buildJunctionParts` call per entry, against
 * that entry's pre-bound member junction, with the same `parentId` and
 * `membershipReadSource` for all of them. The precedent is
 * `orderedJunctionCreateManyParts` — a plain `Part` that flat-maps child Parts
 * over one shared map.
 */
export function buildPolymorphicCollectionPart(
  input: PolymorphicCollectionPartInput
): Part {
  assertClearIsIndivisible(input);
  const leaves = input.arm.entries.flatMap((entry) =>
    buildJunctionParts({
      scope: input.scope,
      engine: input.engine,
      parentScope: input.parentScope,
      relation: entry.junction,
      program: loweredProgram(entry.program),
      parentId: input.parentId,
      membershipReadSource: input.membershipReadSource,
      ...(input.freshParent ? { freshParent: true } : {}),
      txMode: input.txMode,
      recordCompilers: input.recordCompilers,
      // A run lowered from `set` must NOT take the idempotent-reconnect
      // shortcut: the barrier below has already removed this owner's row, so
      // "it is already there" is false by the time the write runs.
      ...(spellsSet(entry.program)
        ? { membershipAddMode: "reinsertAfterOwnerClear" as const }
        : {}),
      nestedBuilder: input.nestedBuilder,
    })
  );
  const barrier = input.arm.clearsAll ? buildClearAllBarrier(input) : [];

  return {
    planning: (scope) => {
      const steps: StatementStep[] = [];
      for (const leaf of leaves) steps.push(...leaf.planning(scope));
      for (const clear of barrier) steps.push(...clear.planning(scope));
      return steps;
    },
    compile: (scope, known) => {
      // Each execution re-captures ownership, so these registries must begin
      // empty for every compile and only coordinate this fragment's leaves.
      const resolvedMemberships = createResolvedJunctionMembershipRegistry();
      const sharedAdoptCreated = createSharedAdoptCreatedRegistry();
      // THE ORDER IS THE CONTRACT (§4): every leaf's captured-fact GUARDS, then
      // the one clear-all barrier, then every leaf's WRITES.
      //
      // `bucketOperationSteps` hoists guards to the fragment front anyway, so the
      // barrier would land correctly even if this concatenated naively — which is
      // exactly why the order is spelled here: the property must not depend
      // silently on someone else's bucketing.
      const guards: OperationStep[] = [];
      const writes: OperationStep[] = [];
      for (const leaf of leaves) {
        bucketOperationSteps(
          leaf.compile(scope, known, sharedAdoptCreated, resolvedMemberships),
          guards,
          writes
        );
      }
      const clears: OperationStep[] = [];
      for (const clear of barrier) clears.push(...clear.compile(scope, known));
      return [...guards, ...clears, ...writes];
    },
  };
}

/** Does this entry's program spell `set`? Exactly one entry per program. */
function spellsSet(program: RelationMutationProgram): boolean {
  return program.entries.some((entry) => entry.kind === "set");
}

/**
 * Lower a `set` run into a CONNECT-shaped insert run.
 *
 * `RelationJunctionPart.compileSet` emits its clear INSIDE its own Part, which is
 * right for an ordinary junction (one Part, one member table) and wrong here: N
 * variant leaves would clear N times, each in its own position, and the barrier
 * would sit wherever the last leaf happened to be. So the parser keeps emitting
 * `set` entries — the payload said `set` and the parse must say so too — and the
 * coordinator rewrites each into the insert half while owning the clear half
 * itself. `compileSet` is untouched, and ordinary junction `set` stays
 * byte-identical.
 */
function loweredProgram(
  program: RelationMutationProgram
): RelationMutationProgram {
  if (!spellsSet(program)) return program;
  return {
    relationInfo: program.relationInfo,
    entries: program.entries.map((entry) =>
      entry.kind === "set" ? { kind: "connect", targets: entry.targets } : entry
    ),
  };
}

/**
 * ONE `junctionDelete` per CONFIGURED member table, in `storage.members`
 * declaration order — including variants this payload never mentioned.
 *
 * That inclusion is the whole meaning of "`set` clears unmentioned variants":
 * `set: [{type:"post", …}]` on a three-variant collection must empty the video
 * and note member tables too, and `set: []` must empty all three while deleting
 * no target row.
 *
 * Built as `RelationJunctionPart` with `kind: "set"` and NO targets rather than
 * as a hand-rolled statement: that plan compiles to exactly one
 * `junctionDelete` correlated on the owner, with no guards and no inserts, and
 * reusing it keeps the owner-row plumbing (`parentLiteral`'s literal / planned /
 * produced-ref cases) in the one place that already gets it right.
 */
function buildClearAllBarrier(input: PolymorphicCollectionPartInput): Part[] {
  const parts: Part[] = [];
  for (const member of input.arm.relation.storage.members.values()) {
    const junction = bindPolymorphicCollectionMember(
      input.parentScope,
      input.arm.relation,
      member
    );
    parts.push(
      ...buildJunctionParts({
        scope: input.scope,
        engine: input.engine,
        parentScope: input.parentScope,
        relation: junction,
        program: {
          relationInfo: junction.relationInfo,
          entries: [{ kind: "set", targets: [] }],
        },
        parentId: input.parentId,
        membershipReadSource: input.membershipReadSource,
        ...(input.freshParent ? { freshParent: true } : {}),
        txMode: input.txMode,
        recordCompilers: input.recordCompilers,
        nestedBuilder: input.nestedBuilder,
      })
    );
  }
  return parts;
}

/**
 * REFUSE AT CONSTRUCTION, before any effect (§9.2's "refuses before clearing",
 * §10.2's "construction refuses before effects").
 *
 * `set` is one indivisible unit: the clear and the refill must commit together or
 * not at all. On a native atomic batch they normally do — `generatedOutputSegments`
 * is the only splitter of a non-series atomic batch, and bind-budget chunking
 * stays inside one batch. But nothing in the executor marks a GROUP of steps
 * indivisible, so when the owner's own row key arrives as a produced output
 * reference the batch may legally be segmented BETWEEN the clear and the refill,
 * committing an emptied collection.
 *
 * The predicate is therefore the three facts that make that reachable, and no
 * executor-side indivisible-group marker is added: one guard per invariant, and
 * §13.4 explicitly admits "refuses before the clear" as a satisfying answer.
 */
function assertClearIsIndivisible(input: PolymorphicCollectionPartInput): void {
  if (!input.arm.clearsAll) return;
  if (input.txMode) return;
  const produced = Object.values(input.parentId).some(
    (source) => source?.kind === "finalRef"
  );
  if (!produced) return;
  throw new UnsupportedOperationError(
    `Polymorphic collection '${input.arm.name}' set requires one atomic unit; this driver would commit the clear separately from the refill.`
  );
}
