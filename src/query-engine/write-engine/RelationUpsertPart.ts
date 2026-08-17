// biome-ignore-all lint/style/useFilenamingConvention: RelationUpsertPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { directPolymorphicMembership } from "../builders/polymorphic-relation";
import {
  bindRelation,
  membershipReferencedFields,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ConnectOrCreateInput,
  type NormalizedRelationUpsert,
  type ParsedRecordPrograms,
  type ParsedRelationMutation,
  type RecordMutationData,
} from "../builders/relation-mutation-parser";
import { createQueryScope } from "../context/query-scope";
import { buildFind, buildFindUnique, buildUpdate } from "../operations";
import { assertPortablePrimaryKeyUpdateInput } from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  getMembershipScope,
  getRelationMembershipScope,
  relationMembershipScopesEqual,
} from "../RelationMembership";
import { assertRelationKeyUpdatesAreCompilable } from "../relation-key-legality";
import {
  classifyTargetConstraintOverlap,
  getCreatedWhereUniqueTarget,
  normalizeWhereUniqueTargetConstraint,
  type TargetConstraint,
} from "../TargetConstraint";
import type { QueryScope } from "../types";
import { createRacePin } from "./create-race-pin";
import {
  affectedRows,
  existsGuard,
  nestedWriteFailure,
  presenceGuard,
} from "./fragment-builders";
import {
  nestedReplacement,
  upsertTargetNotFoundForParent,
  upsertTargetVanished,
} from "./messages";
import type {
  GuardStep,
  OperationStep,
  ReadStep,
  StatementStep,
  WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import type {
  RecordCompilerSeam,
  RecordUpdateCompiler,
  SelectedIncomingParentContinuity,
} from "./RecordUpdateCompiler";
import {
  type CorrelatedRelationMembershipBinding,
  finalMembershipCondition,
  lowerMembershipWrite,
  membershipProjection,
  type RelationMembershipBinding,
  recordHasMembership,
} from "./relation-membership";
import type { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  pinnedTargetValues,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";
import {
  buildTargetProjection,
  capturedTargetColumnPredicate,
  capturedTargetFilters,
  capturedTargetWhere,
  type TargetProjection,
  targetProjectionColumns,
  targetProjectionOutputs,
} from "./target-projection";

/**
 * Where the parent id the child FK points at comes from — a first-class value,
 * never the parent object.
 * - `ref`: the parent write produces it in the same final fragment (create
 *   context); a Ref materialized later.
 * - `planned`: it was located by a planning read and is inlined as a literal at
 *   compile (update-by-unique context; a final-fragment step may not ref a
 *   planning step — ATOM “Proof obligations”).
 * - `literal`: it is a compile-time constant — the located-by-PK parent's own
 *   primary key. This is the base case of a first-class value, and it is what a
 *   depth-composed grandchild receives: its parent (a middle upsert located by
 *   its PK, emitted only on the found+correlated arm) has a known PK, so no
 *   probe/insert produces it.
 * - `transitioned`: it was located by a planning read AND the root SET rewrites
 *   it, so the value the child must reference is the located one with that SET's operand
 *   APPLIED — a derivation that cannot run before the locate has, and therefore runs at
 *   compile.
 *
 * Read and write sources are separate members of each foreign-key edge. A transition
 * therefore reads the pre-transition field and writes the transformed value without a
 * caller recovering either source by field name.
 */
/**
 * How the found branch reads the probe (ATOM “Relation-owner boundary”):
 * - `global-adopt`: nested upsert under `create` — the parent is fresh, no
 *   correlation is possible, so any globally-matched row is adopted and updated
 *   (the create-input superset).
 * - `correlated`: nested upsert under `update` — a found row is legal only if
 *   it already belongs to this parent; a found-uncorrelated row is the typed
 *   V7001 error (V1's message verbatim). Never `ON CONFLICT` (ATOM “SQL ownership”).
 */
export type UpsertCorrelation = "global-adopt" | "correlated";

/**
 * The parent source and the correlation mode as ONE value, because which
 * sources are legal depends on the mode.
 *
 * A `correlated` part compares the located row's foreign key against the parent, per
 * referenced column, at compile — so it needs a source every reader can resolve to a
 * value: the three whole-value kinds. A `global-adopt` part compares nothing (its parent
 * is fresh, so no row can already belong to it), so it also takes the per-referenced-
 * field source a compound create-root edge builds.
 *
 * The union is the proof: `{ correlation: "correlated", parentId: { kind: "per-field" …
 * } }` does not type-check, so no caller — present or future — can hand a tuple to a
 * correlated probe and have it silently correlate on one member.
 */
/**
 * Which member of the adopt family this part expresses (ATOM “Branch premises and pins” — connectOrCreate
 * is the simplest member, upsert-under-create/update adds the update payload):
 * - `upsert`: found → reparent-and-update (or update, correlated); the found
 *   premise carries the V2 extension `Nested upsert premise changed` wording.
 * - `connectOrCreate`: found → pure connect (reparent, no update data); the found
 *   premise carries V1's verbatim `Record was replaced …` replacement wording.
 * Both share one probe, one create arm (constraint + `racePin`), one found guard
 * (`raceable: false`) — the leaf differs, never the vocabulary.
 */
export type UpsertFamily = "connectOrCreate" | "upsert";

/**
 * Everything the part needs. Correlated members add a planning source to the same
 * foreign/referenced pair that owns the final write source.
 */
interface RelationUpsertConfigCore {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  /**
   * This part's own locate-probe step id, allocated by the builder BEFORE the arms
   * fold — the update arm's grandchildren may address it as a `planned`
   * parent source, and a final reference source is a value, so the id has to exist first.
   */
  readonly probeId: string;
  readonly where: Record<string, unknown>;
  readonly updateData: Readonly<Record<string, unknown>>;
  readonly updateCompiler?: RecordUpdateCompiler;
  readonly updateLegality?: () => void;
  /**
   * What this part's probe publishes about the target. The update arm's record
   * compiler owns the wider projection when there is one; this is the
   * compiler-less shape, and its complete row key is what the found arm's write
   * and the found pin address.
   */
  readonly targetProjection: TargetProjection;
  readonly txMode: boolean;
  /** Adopt-family member (default `upsert`); `connectOrCreate` omits update data. */
  readonly family?: UpsertFamily;
  /**
   * First-create-wins dedup across sibling parts (`connectOrCreate` only): an
   * EARLIER connectOrCreate item of the same relation, in this one operation,
   * created a row proven to satisfy this exact selector. V1 processes the array
   * sequentially — "merge input N before deciding input N+1" — so that duplicate
   * adopts the just-created row instead of inserting it again.
   */
  readonly duplicateOfEarlier?: boolean;
  /**
   * Depth: nested upsert parts contributed by this child's UPDATE payload. They
   * are emitted only on this part's found+correlated (update) arm — the same
   * linear fragment, one level deeper (README “Three independent facts,” ATOM
   * “Relation-owner boundary”). This part holds its
   * children (by FK direction), never its parent. Empty at depth 1.
   */
  /**
   * The absent → CREATE arm inserts a FRESH row, which is exactly what a
   * `create` root builds. The whole arm is therefore a create subtree for scalar and
   * relation-bearing payloads alike. It
   * owns the arm's INSERT (carrying this part's raceable missing-premise pin as its
   * root record's `racePin`), its own identity — a spelled primary key OR one the
   * database generates and its grandchildren `Ref` — and every relation below at any
   * depth.
   */
  readonly createSubtree: Part;
}

export type RelationUpsertConfig = RelationUpsertConfigCore &
  (
    | {
        readonly correlation: "global-adopt";
        readonly membership: RelationMembershipBinding;
      }
    | {
        readonly correlation: "correlated";
        readonly membership: CorrelatedRelationMembershipBinding;
      }
  );

/**
 * The to-many nested-upsert child part (README “Three independent facts”)
 * module — two operations now compose it, recursively). It contributes one
 * widened probe at planning (ATOM “Planning fragments”: one unconditional child read
 * including its FK) plus its update-arm children's probes, and, at compile,
 * constructs exactly one taken arm:
 *
 * - absent → CREATE arm (fk = parent, unique-constraint + `racePin`, no guard). A
 *   relation-carrying arm is the whole create SUBTREE: its row is PRODUCED, so
 *   its identity and every relation below it come from the create root, and the `racePin`
 *   rides the subtree's own root INSERT;
 * - found + adopt/correlated → UPDATE arm (reparent-and-update / update), then
 *   its update-arm child parts compile one level deeper;
 * - found + uncorrelated (correlated mode only) → typed V7001 throw.
 *
 * It holds no parent — only field-bound FK members and its
 * own children.
 */
export class RelationUpsertPart implements Part {
  private readonly config: RelationUpsertConfig;
  private readonly probeId: string;
  private readonly updateId: string;
  private readonly guardId: string;
  private readonly find: ReadStep;
  private readonly foundPin: GuardStep | undefined;
  private readonly updateCompiler?: RecordUpdateCompiler;
  private readonly createSubtree: Part;
  private readonly family: UpsertFamily;
  private readonly duplicateOfEarlier: boolean;

  private get relationName(): string {
    return this.config.membership.relation.relationInfo.name;
  }

  constructor(scope: StepScope, config: RelationUpsertConfig) {
    this.config = config;
    this.family = config.family ?? "upsert";
    this.updateCompiler = config.updateCompiler;
    this.createSubtree = config.createSubtree;
    this.duplicateOfEarlier = config.duplicateOfEarlier ?? false;
    const { childScope, childName, where, txMode } = config;
    const relationName = config.membership.relation.relationInfo.name;
    this.probeId = config.probeId;
    this.updateId =
      this.updateCompiler?.writeId ?? scope.allocate(`${childName}.update`);
    this.guardId = scope.allocate(`${childName}.guard.exists`);

    // Widened probe (ATOM “Planning fragments”): read the child by its own unique key,
    // including every FK column, so compile can decide the three-way. Locked in
    // tx mode.
    this.find = {
      id: this.probeId,
      kind: "read",
      statement: buildFindUnique(
        childScope,
        {
          where,
          select: this.identitySelect(),
          forUpdate: txMode,
        },
        {
          ...(this.probeAdditionalColumns().length > 0
            ? { additionalColumns: this.probeAdditionalColumns() }
            : {}),
        }
      ),
      // When the update arm's descendants take values from this probe's captured
      // row, the probe must PUBLISH them so their planning probes can `Ref` them in SQL.
      // The target projection names exactly those fields, so the compiler's presence is
      // the whole condition — a payload with no update arm has no consumer. Every output
      // is OPTIONAL because an empty probe is this part's legitimate CREATE decision, on
      // which no update-arm descendant compiles (the same superset tolerance an upsert
      // root's locate already declares).
      outputs: this.updateCompiler
        ? {
            rows: { kind: "rows" },
            ...targetProjectionOutputs(
              this.updateCompiler.targetProjection,
              true
            ),
          }
        : { rows: { kind: "rows" } },
    };

    // The probe pairs its read with the premise its decision creates (ATOM “Branch premises and pins”).
    // Found premise: pinned by the exists guard in batch mode (raceable: false),
    // by the lock in tx mode. Missing premise: enforced by the child's unique
    // constraint (the racePin on the create write), never a notExists guard.
    //
    // The found pin is DECLARED here — its id, its premise class and its failure
    // wording are facts about the shape, validated before any I/O — and its statement
    // is NARROWED at compile to the row the probe actually located
    // ({@link foundGuardStatement}). Compile emits this declared pin, never a second
    // one, so the Pin Rule stays machine-checkable through the narrowing.
    const foundPin = txMode
      ? ("none" as const)
      : this.family === "connectOrCreate"
        ? presenceGuard(
            this.guardId,
            this.foundGuardStatement(undefined, undefined),
            nestedWriteFailure(
              nestedReplacement("connectOrCreate"),
              relationName
            )
          )
        : existsGuard(
            this.guardId,
            this.foundGuardStatement(undefined, undefined),
            relationName
          );
    this.foundPin = foundPin === "none" ? undefined : foundPin;
  }

  /** The probe's (and the found pin's, and the update arm's) projection: this child's
   *  complete row key and every FK column — how the arm addresses it and who its
   *  current parent is, the two things every arm's decision is made from — plus every
   *  field the update arm's own compiler declared it consumes. That third group is what
   *  lets a deeper edge referencing a compound or non-primary-key key of this child
   *  resolve each referenced column BY NAME from the located row instead of from one
   *  broadcast value.
   *
   *  The row key arrives inside {@link targetProjection}, never as a field beside it:
   *  one projection owns which target values exist here. */
  private identitySelect(): Record<string, boolean> {
    const select: Record<string, boolean> = {};
    for (const field of this.targetProjection.identityFields) {
      select[field] = true;
    }
    for (const field of this.boundProjection().fields) select[field] = true;
    for (const field of this.targetProjection.fields) select[field] = true;
    return select;
  }

  /** The update arm's compiler publishes the wider projection when it exists; both
   *  open with the same complete row key. */
  private get targetProjection(): TargetProjection {
    return (
      this.updateCompiler?.targetProjection ?? this.config.targetProjection
    );
  }

  private boundProjection() {
    return membershipProjection(this.config.childScope, this.config.membership);
  }

  private probeAdditionalColumns(): readonly Sql[] {
    return [
      ...this.boundProjection().additionalColumns,
      ...targetProjectionColumns(
        this.config.childScope,
        this.targetProjection
      ).map((column) => column.sql),
    ];
  }

  /** The address consumers read this part's probe rows from in `known`. */
  probeRowsKey(): string {
    return planningKey(this.probeId, "rows");
  }

  planning(scope: StepScope): readonly StatementStep[] {
    // Planning is unconditional: this part's probe plus every arm's child probes
    // run before any write, so `compile` has all three-way inputs in `known`
    // regardless of which arm each level later takes. Both the update-arm and
    // the create-arm children plan here (technique #2's widened superset); only
    // the taken arm's children later compile.
    const steps: StatementStep[] = [this.find];
    if (this.updateCompiler) {
      steps.push(...conditionalArmPlanning(this.updateCompiler.planning()));
    }
    steps.push(...this.createSubtree.planning(scope));
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const rows = known[this.probeRowsKey()];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.relationName}' did not expose rows.`,
        this.relationName
      );
    }
    const arm = this.decide(rows, known);
    if (arm === "create" && this.duplicateOfEarlier) {
      // First-create-wins: an earlier connectOrCreate item of this relation in the
      // same operation already created this exact target, so this duplicate adopts
      // it (idempotent reparent) instead of re-inserting its PK. No found guard —
      // presence is guaranteed by our own earlier create, not a pre-existing row
      // (a batch hoists guards ahead of writes, so a guard here would precede that
      // create). The connectOrCreate update payload is empty, so the adopt arm is a
      // pure reparent SET, landing the same FK the terminal read expects.
      //
      // This is the ONE arm that cannot address a located row: the probe found
      // nothing, and the row it adopts does not exist yet — the earlier sibling's
      // INSERT makes it, inside this same fragment, under the very selector this
      // arm names. So the selector is not a second provenance here; it is the only
      // identity in existence, and the row it will name is one this operation wrote.
      return [this.buildUpdateArm(known, this.config.where)];
    }
    if (arm === "create") {
      // Create arm: this child is fresh. Its update-arm children do not run — nested
      // writes in an UPDATE payload apply only when the row is found, and this is the
      // one place that stays true, so the found-arm depth never leaks onto a row that
      // did not exist. A relation-carrying arm is the whole create SUBTREE:
      // the subtree owns the INSERT (with this part's racePin on its root record), its
      // own identity, and every relation below, under the fresh-parent elision
      // (ATOM “Relation-owner boundary”) that makes any correlation beneath it statically empty.
      return this.createSubtree.compile(scope, known);
    }
    // Found: adopt-and-update (global) or update the correlated child. In batch
    // mode the found premise is pinned first by the exists guard, narrowed to the
    // located row. The update-arm children then compile one level deeper,
    // correlated to this child's PK.
    //
    // Every write this arm emits addresses THE ROW THE PROBE LOCATED, by its captured
    // row key — every member of it — the wrong-row doctrine, and the same addressing
    // `RelationWritePart.compileTargeted` and `RelationJunctionPart.compileUpdate`
    // spend at their own seams. The selector once had to name the primary key, so
    // "the selector's row" and "the located row" were one literal; now that any unique
    // may name the target they are two provenances, and the update-arm grandchildren
    // already take the located one (`plannedParentId(probeId)`).
    // Addressing the selector here would let the halves of one nested write land on
    // two different rows.
    const captured = locatedRow(rows);
    const steps: OperationStep[] = [];
    if (this.foundPin) {
      steps.push(this.pinLocatedRow(this.foundPin, captured, known));
    }
    if (this.updateCompiler) {
      this.config.updateLegality?.();
      steps.push(...this.compileRecordUpdate(known));
      return steps;
    }
    if (this.config.correlation === "correlated") {
      // Correlation proves which existing member the found arm may observe. It is
      // not an instruction to restore that membership. Keep the already-built pin,
      // but emit no SET for an empty correlated upsert/connect-or-create arm.
      return steps;
    }
    // A probe row with no readable shape publishes no row-key member, and the
    // shared extractor names the missing one. That replaces the unique-`where`
    // builder's refusal of an undefined discriminator as the place this fails
    // closed; it does not add a second check, because the extractor is now the
    // one owner of "read the row key out of this captured record".
    steps.push(
      this.buildUpdateArm(
        known,
        capturedTargetWhere(
          this.config.childScope.model,
          this.targetProjection,
          captured ?? {}
        )
      )
    );
    return steps;
  }

  /**
   * The declared found pin, narrowed to the located row. Only the premise's STATEMENT
   * changes — the id, the premise class and the failure wording are the constructor's,
   * which keeps it the same declared pin rather than a second guard for the premise.
   */
  private pinLocatedRow(
    pin: GuardStep,
    captured: Record<string, unknown> | undefined,
    known: PlanningKnown
  ): GuardStep {
    return {
      ...pin,
      premise: {
        ...pin.premise,
        statement: this.foundGuardStatement(captured, known),
      },
    };
  }

  /**
   * The found premise's statement, and its one home — the shape
   * `RelationWritePart.correlatedProbeStatement` already uses for both its planning
   * probe and its batch guard. Called with no located row at construction (the premise
   * the probe DECLARES: "a row matching the selector exists"), and with the located row
   * at compile, which narrows it to that row:
   *
   *  · `<row key> = <captured>`, every member — the selector and the row the decision
   *    was made about must
   *    still COINCIDE. Without it, a concurrent writer that moves the unique to a
   *    DIFFERENT row between planning and the atomic batch leaves the selector-alone
   *    premise true of a REPLACEMENT: the guard passes, the update arm writes that
   *    replacement (reparenting it, since the arm also sets the FK) and the arm's
   *    grandchildren still land on the located row — one nested write, two rows.
   *  · `fk = <parent>` in `correlated` mode only — the row must still be OURS, the
   *    other half of what {@link decide} read. `global-adopt` read no FK at all (it
   *    adopts the row from wherever it is, so pinning its current parent would fail
   *    every ordinary connectOrCreate). Without it, a row concurrently reparented away
   *    is silently stolen back by this arm's own FK assignment.
   *
   * The selector's conjuncts join in one `AND`, which is `RelationWritePart`'s guard
   * verbatim — the two seams emit the same statement shape rather than one carrying a
   * bespoke merge. A widened selector pays BOTH seams the filter half:
   * {@link uniqueSelectorConjuncts} is that one place. The probe already honoured it (it compiles the whole selector through
   * `buildFindUnique`); without the same half here the guard would re-assert a WEAKER
   * premise than the probe established, and a concurrent write to a filtered column
   * would pass a guard the locate had excluded. No `forUpdate`: this statement exists
   * only on the batch substrate, which is the only substrate that emits a found pin at
   * all.
   */
  private foundGuardStatement(
    capturedTarget: Record<string, unknown> | undefined,
    known: PlanningKnown | undefined
  ): Sql {
    const config = this.config;
    const { childScope, where } = config;
    const membership =
      known && config.correlation === "correlated"
        ? finalMembershipCondition(
            config.engine,
            childScope,
            config.membership,
            childScope.rootAlias,
            known,
            "upsert"
          )
        : { filters: [], predicate: undefined };
    const rows = known?.[planningKey(this.probeId, "rows")];
    const captured = Array.isArray(rows) ? locatedRow(rows) : undefined;
    const capturedColumns = captured
      ? capturedTargetColumnPredicate(
          childScope,
          this.targetProjection,
          captured
        )
      : undefined;
    const predicates = [membership.predicate, capturedColumns].filter(
      (predicate): predicate is Sql => predicate !== undefined
    );
    return buildFind(
      childScope,
      {
        where: {
          AND: [
            ...uniqueSelectorConjuncts(childScope, where),
            ...(capturedTarget
              ? capturedTargetFilters(
                  childScope.model,
                  this.targetProjection,
                  capturedTarget
                )
              : []),
            ...membership.filters,
          ],
        },
        select: this.identitySelect(),
      },
      {
        limit: 1,
        ...(predicates.length
          ? {
              predicate:
                predicates.length === 1
                  ? predicates[0]
                  : childScope.adapter.operators.and(...predicates),
            }
          : {}),
      }
    );
  }

  /**
   * The compile-time three-way (ATOM “Planning fragments”). `global-adopt` collapses
   * to two arms (found → adopt); `correlated` throws V1's verbatim V7001 on a
   * found-uncorrelated row.
   */
  private decide(
    rows: readonly unknown[],
    known: PlanningKnown
  ): "create" | "found" {
    if (rows.length === 0) return "create";
    const config = this.config;
    if (config.correlation === "global-adopt") return "found";
    if (
      recordHasMembership(config.membership, locatedRow(rows), known, "upsert")
    ) {
      return "found";
    }
    throw new NestedWriteError(
      upsertTargetNotFoundForParent(this.relationName),
      this.relationName
    );
  }

  /** The found/adopt arm. `address` is the row it writes: the located row's captured
   *  primary key on the found arm, and — only for the first-create-wins duplicate,
   *  whose row this operation has not inserted yet — the selector. */
  private buildUpdateArm(
    known: PlanningKnown,
    address: Record<string, unknown>
  ): WriteStep {
    const { childScope, txMode } = this.config;
    const relationName = this.relationName;
    const membership =
      this.config.correlation === "global-adopt"
        ? lowerMembershipWrite(
            this.config.engine,
            childScope,
            this.config.membership,
            known,
            this.family
          )
        : { data: {}, polymorphicStorage: [] };
    const step: WriteStep = {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(childScope, {
        where: address,
        data: {
          ...this.config.updateData,
          // A global adopt writes the demanded membership. Correlation is only a
          // locate/guard premise and therefore contributes no SET.
          ...membership.data,
        },
        ...(membership.polymorphicStorage.length > 0
          ? { polymorphicStorage: membership.polymorphicStorage }
          : {}),
        select: this.identitySelect(),
      }),
      outputs: {},
    };
    if (!txMode) return step;
    // The found premise is pinned (locked probe / exists guard); an
    // affected-row miss here is a not-found, never a race. connectOrCreate's pure
    // connect carries V1's replacement wording; upsert its extension wording.
    return {
      ...step,
      expects: affectedRows(1, {
        kind: "notFound",
        message:
          this.family === "connectOrCreate"
            ? nestedReplacement("connectOrCreate")
            : upsertTargetVanished(relationName),
        relation: relationName,
        raceable: false,
      }),
    };
  }

  private compileRecordUpdate(known: PlanningKnown): readonly OperationStep[] {
    const steps = this.updateCompiler?.compile(known) ?? [];
    if (!this.config.txMode) return steps;
    return steps.map((step) =>
      step.kind === "write" && step.id === this.updateId
        ? {
            ...step,
            expects: affectedRows(1, {
              kind: "notFound",
              message: upsertTargetVanished(this.relationName),
              relation: this.relationName,
              raceable: false,
            }),
          }
        : step
    );
  }
}

/**
 * The row this part's probe located, as a readable record — the ONE place the located
 * row's columns are read from, by both things that need them: the correlation decision
 * (its foreign key) and the identity the found arm writes (its primary key). A result
 * with no readable first row yields `undefined`, and every caller's own path then fails
 * closed on the missing value.
 */
function locatedRow(
  rows: readonly unknown[]
): Record<string, unknown> | undefined {
  const row = rows[0];
  return row && typeof row === "object"
    ? (row as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Recursive to-many upsert composition. One shared builder folds a
// nested upsert relation into a `RelationUpsertPart`; when that child's UPDATE
// payload carries its own upsert relations, the builder recurses, so depth adds
// list entries and one parent-id value, never vocabulary or a Part method.
// A part holds only its children and a parent-id value — never its parent.
// ---------------------------------------------------------------------------

/**
 * Build one `RelationUpsertPart` per upsert item of one to-many relation. The
 * items are already schema-validated (the caller parsed them through the
 * relation's update/create schema, which validates the whole nested tree).
 */
export function buildToManyUpsertParts(
  scope: StepScope,
  engine: QueryEngine,
  items: readonly NormalizedRelationUpsert[],
  membership: RelationMembershipBinding,
  txMode: boolean,
  seam: RecordCompilerSeam,
  family: UpsertFamily = "upsert"
): RelationUpsertPart[] {
  return buildUpsertParts(
    scope,
    engine,
    items,
    { correlation: "global-adopt", membership },
    txMode,
    seam,
    family
  );
}

export function buildCorrelatedToManyUpsertParts(
  scope: StepScope,
  engine: QueryEngine,
  items: readonly NormalizedRelationUpsert[],
  membership: CorrelatedRelationMembershipBinding,
  txMode: boolean,
  seam: RecordCompilerSeam,
  incomingParentContinuity?: SelectedIncomingParentContinuity
): RelationUpsertPart[] {
  return buildUpsertParts(
    scope,
    engine,
    items,
    { correlation: "correlated", membership, incomingParentContinuity },
    txMode,
    seam,
    "upsert"
  );
}

function buildUpsertParts(
  scope: StepScope,
  engine: QueryEngine,
  items: readonly NormalizedRelationUpsert[],
  parent:
    | {
        readonly correlation: "global-adopt";
        readonly membership: RelationMembershipBinding;
      }
    | {
        readonly correlation: "correlated";
        readonly membership: CorrelatedRelationMembershipBinding;
        readonly incomingParentContinuity?: SelectedIncomingParentContinuity;
      },
  txMode: boolean,
  seam: RecordCompilerSeam,
  family: UpsertFamily
): RelationUpsertPart[] {
  const relation = parent.membership.relation;
  const { relationInfo } = relation;
  const relationName = relationInfo.name;
  if (relation.cardinality === "one" && family !== "connectOrCreate") {
    // Callers bind and dispatch topology before this builder. Only a child-held to-many,
    // or the child-held to-one `connectOrCreate` case, can reach this point.
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationName}' reached the child-held adopt builder as '${relationInfo.type}' for a nested ${family}; every caller dispatches the relation direction before this builder.`
    );
  }
  // First-create-wins is a connectOrCreate-only ledger of selectors that an
  // earlier missing arm is proven to create. `upsert` is not deduped here (its
  // array semantics differ; V1 merges each input's write before the next).
  const child =
    family === "connectOrCreate"
      ? createQueryScope(engine.adapter, relationInfo.targetModel)
      : undefined;
  const createdSelectors: TargetConstraint[] | undefined = child
    ? []
    : undefined;
  return items.map((normalizedItem) => {
    if (normalizedItem.target.kind !== "unique") {
      throw new QueryEngineError(
        `query-engine-v2 internal: to-many upsert for relation '${relationName}' requires a unique target.`
      );
    }
    const item: AdoptMutationItem = {
      where: normalizedItem.target.where,
      create: normalizedItem.create,
      update: normalizedItem.update,
    };
    let duplicateOfEarlier = false;
    if (createdSelectors && child) {
      duplicateOfEarlier = isSameOperationConnectOrCreateDuplicate(
        child,
        item,
        createdSelectors
      );
    }
    return buildOneUpsertPart(
      scope,
      engine,
      item,
      parent,
      txMode,
      seam,
      family,
      duplicateOfEarlier
    );
  });
}

/** Record a missing arm only when its create data proves that it will satisfy
 * the selector a later sibling would use. `where` and `create` are independent
 * public contracts, so equal selectors alone do not prove same-operation
 * visibility. Extended filters stay outside this ledger because arbitrary
 * filter satisfaction cannot be derived from create data here. */
function isSameOperationConnectOrCreateDuplicate(
  child: QueryScope,
  item: AdoptMutationItem,
  createdSelectors: TargetConstraint[]
): boolean {
  const selector = normalizeWhereUniqueTargetConstraint(
    child.model,
    item.where
  );
  const duplicate = createdSelectors.some(
    (createdSelector) =>
      classifyTargetConstraintOverlap(createdSelector, selector) === "equal"
  );
  if (duplicate) return true;

  const create = item.create.parsed;
  const createdSelector = create
    ? getCreatedWhereUniqueTarget(child.model, item.where, create)
    : undefined;
  if (createdSelector) createdSelectors.push(createdSelector);
  return false;
}

/**
 * Build one `RelationUpsertPart` per `connectOrCreate` item — the update-less
 * member of the adopt family (ATOM “Branch premises and pins”). It is always global-adopt
 * (`connect` performs a global lookup-and-adopt in both the create and update
 * contexts), so it takes no correlation: found → connect (reparent),
 * absent → create (constraint + `racePin`).
 */
export function buildConnectOrCreateParts(
  scope: StepScope,
  engine: QueryEngine,
  items: readonly ConnectOrCreateInput[],
  membership: RelationMembershipBinding,
  txMode: boolean,
  seam: RecordCompilerSeam
): RelationUpsertPart[] {
  return buildAdoptParts(scope, engine, items, membership, txMode, seam);
}

function buildAdoptParts(
  scope: StepScope,
  engine: QueryEngine,
  items: readonly AdoptMutationItem[],
  membership: RelationMembershipBinding,
  txMode: boolean,
  seam: RecordCompilerSeam
): RelationUpsertPart[] {
  const relation = membership.relation;
  const { relationInfo } = relation;
  const child = createQueryScope(engine.adapter, relationInfo.targetModel);
  const createdSelectors: TargetConstraint[] = [];
  return items.map((item) => {
    const duplicateOfEarlier = isSameOperationConnectOrCreateDuplicate(
      child,
      item,
      createdSelectors
    );
    return buildOneUpsertPart(
      scope,
      engine,
      item,
      { correlation: "global-adopt", membership },
      txMode,
      seam,
      "connectOrCreate",
      duplicateOfEarlier
    );
  });
}

interface AdoptMutationItem {
  readonly where: Record<string, unknown>;
  readonly create: RecordMutationData;
  readonly update?: RecordMutationData;
}

function buildOneUpsertPart(
  scope: StepScope,
  engine: QueryEngine,
  item: AdoptMutationItem,
  parent:
    | {
        readonly correlation: "global-adopt";
        readonly membership: RelationMembershipBinding;
      }
    | {
        readonly correlation: "correlated";
        readonly membership: CorrelatedRelationMembershipBinding;
        readonly incomingParentContinuity?: SelectedIncomingParentContinuity;
      },
  txMode: boolean,
  seam: RecordCompilerSeam,
  family: UpsertFamily,
  duplicateOfEarlier = false
): RelationUpsertPart {
  const relation = parent.membership.relation;
  const { relationInfo } = relation;
  const relationName = relationInfo.name;
  const { foreignFields } = relation.membership;
  if (
    foreignFields.length !==
    membershipReferencedFields(relation.membership).length
  ) {
    // The child must hold the foreign key referencing the parent (one column, or an
    // index-aligned compound key — ATOM “Field-bound foreign-key provenance”).
    //
    // Unreachable by construction. A
    // `.fields("a","b").references("c")` edge is rejected UPSTREAM by the
    // relation-mutation legality walk
    // (`NestedWriteError: Relation '<name>' has mismatched foreign-key metadata.`), which
    // runs before any Part is built — so no payload arrives with a mismatched arity here.
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationName}' reached the upsert part without an index-aligned child-held foreign key referencing the parent.`
    );
  }
  const child = createQueryScope(engine.adapter, relationInfo.targetModel);
  const where = requireRecord(item.where, `${relationName}.${family}.where`);
  const rawCreate = requireRecord(
    item.create.parsed,
    `${relationName}.${family}.create`
  );
  const create: RecordMutationData = {
    parsed: rawCreate,
    source: item.create.source,
  };
  // connectOrCreate has no update payload; its found arm is a pure connect.
  const update =
    family === "connectOrCreate"
      ? undefined
      : (() => {
          const rawUpdate = requireRecord(
            item.update?.parsed,
            `${relationName}.upsert.update`
          );
          return {
            parsed: rawUpdate,
            source: item.update?.source,
          } satisfies RecordMutationData;
        })();
  const childUpdate: ParsedRecordPrograms =
    update === undefined
      ? { scalarData: {}, relations: [] }
      : buildParsedRelationPrograms(child, update.parsed, update.source);
  // The probe publishes the child's complete row key and every found-arm write
  // addresses all of it, so an adopt target keys on however many members it has.
  const targetProjection = buildTargetProjection(child.model);
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  for (const parsed of childUpdate.relations) {
    assertNoIncomingTargetMutationOverlap(
      child,
      parent.membership,
      parent.correlation,
      parent.correlation === "correlated" &&
        parent.incomingParentContinuity !== undefined,
      parsed
    );
  }
  const parentId =
    parent.membership.kind === "foreignKey"
      ? parent.membership.members[0]?.writeSource
      : parent.membership.writeSource;
  if (!parentId) {
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationName}' reached the upsert part with no foreign-key member.`
    );
  }
  const pinnedTarget = pinnedTargetValues(child, where);
  const incomingMembership = parent.membership;
  const correlatedMembership: CorrelatedRelationMembershipBinding | undefined =
    parent.correlation === "correlated" ? parent.membership : undefined;
  const updateCompiler = update
    ? seam.updateSelected({
        scope,
        engine,
        targetScope: child,
        scalarData: childUpdate.scalarData,
        relations: childUpdate.relations,
        targetRead: { label: `${childName}.find` },
        rootWrite: { label: `${childName}.update` },
        ...(parent.correlation === "global-adopt"
          ? { incomingMembership }
          : parent.incomingParentContinuity
            ? { incomingParentContinuity: parent.incomingParentContinuity }
            : {}),
        relationName,
        pinnedTarget,
      })
    : undefined;
  const updateLegality = updateCompiler
    ? () => {
        assertPortablePrimaryKeyUpdateInput(child.model, "update", {
          data: childUpdate.scalarData,
        });
        assertRelationKeyUpdatesAreCompilable(
          child,
          childUpdate.scalarData,
          childUpdate.relations
        );
        updateCompiler.assertSelectedIncomingParentLegality();
      }
    : undefined;
  const probeId =
    updateCompiler?.targetReadId ?? scope.allocate(`${childName}.find`);
  const createSubtree = seam.createFresh(scope, {
    childScope: child,
    data: create,
    incomingMembership,
    relationName,
    racePin: createRacePin(child, where),
  });

  const common = {
    engine,
    childScope: child,
    childName,
    probeId,
    where,
    updateData: childUpdate.scalarData,
    targetProjection,
    txMode,
    family,
    duplicateOfEarlier,
    updateCompiler,
    updateLegality,
    createSubtree,
  };
  return new RelationUpsertPart(
    scope,
    correlatedMembership
      ? {
          ...common,
          correlation: "correlated",
          membership: correlatedMembership,
        }
      : {
          ...common,
          correlation: "global-adopt",
          membership: incomingMembership,
        }
  );
}

/** Target mutations on the exact incoming membership still address the enclosing
 * selected row. Membership writers are ordinary final assignments and are reconciled
 * by RecordUpdateCompiler. A connect followed by update is different: the supplier's
 * selector addresses the update target. */
function assertNoIncomingTargetMutationOverlap(
  child: QueryScope,
  incoming: RelationMembershipBinding,
  correlation: UpsertCorrelation,
  hasSelectedContinuity: boolean,
  parsed: ParsedRelationMutation
): void {
  if (parsed.kind === "polymorphicDisconnect") return;
  const relation = bindRelation(child, parsed.program.relationInfo);
  if (relation.position !== "parentHeld") return;
  const mutationScope =
    parsed.kind === "polymorphicTarget"
      ? getMembershipScope(directPolymorphicMembership(parsed.edge))
      : getRelationMembershipScope(relation);
  if (
    !relationMembershipScopesEqual(
      getRelationMembershipScope(incoming.relation),
      mutationScope
    )
  ) {
    return;
  }

  const hasSupplier = parsed.program.entries.some(
    (entry) =>
      entry.kind === "connect" ||
      entry.kind === "create" ||
      entry.kind === "connectOrCreate"
  );
  const overlaps = parsed.program.entries.some((entry) => {
    if (entry.kind === "delete") return true;
    if (correlation === "correlated" && hasSelectedContinuity) return false;
    return entry.kind === "upsert" || (entry.kind === "update" && !hasSupplier);
  });
  if (!overlaps) return;
  refuseIncomingParentMutation(parsed.program.relationInfo.name);
}

/** One typed owner for the retained incoming-parent boundary. The general arm is
 * delete/global-adopt; the field arm is a correlated loopback that would need to
 * publish another final tuple back to its enclosing compiler. */
export function refuseIncomingParentMutation(
  relationName: string,
  rowKeyField?: string
): never {
  throw new UnsupportedOperationError(
    rowKeyField
      ? `query-engine-v2 does not support a selected incoming-parent re-entry that changes row-key field '${rowKeyField}' on relation '${relationName}'.`
      : `query-engine-v2 does not support a target mutation on relation '${relationName}' when it addresses the same incoming membership as the selected upsert arm.`
  );
}

/** Narrow a schema-validated arm object. A non-record here is an engine fault, not a
 * second user-input validation boundary. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: '${label}' must be an object after the parse boundary validated the payload.`
  );
}
