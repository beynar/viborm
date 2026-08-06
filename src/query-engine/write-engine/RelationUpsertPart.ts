// biome-ignore-all lint/style/useFilenamingConvention: RelationUpsertPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import {
  bindRelation,
  type ChildHeldToMany,
  type ChildHeldToOne,
} from "../builders/relation-data-builder";
import {
  buildParsedRelationPrograms,
  type ConnectOrCreateInput,
  type NormalizedRelationUpsert,
  type RelationMutationProgram,
} from "../builders/relation-mutation-parser";
import { getWhereUniqueEntries } from "../builders/where-unique-builder";
import { createQueryScope } from "../context/query-scope";
import { buildFind, buildFindUnique, buildUpdate } from "../operations";
import {
  assertPortablePrimaryKeyUpdateInput,
  getUpdatedPrimaryKeyValue,
} from "../operations/mutation-identity";
import type { QueryEngine } from "../query-engine";
import {
  assertPinnedTransitionIsCompilable,
  assertRelationKeyUpdatesAreCompilable,
  assertSelectedUpdateManyDataIsScalar,
} from "../relation-key-legality";
import type { QueryScope } from "../types";
import {
  type CorrelatedForeignKeyMember,
  type FinalReferenceSource,
  type ForeignKeyMember,
  foreignKeyResolvedReadValue,
  foreignKeyWriteValueWith,
  literalReferenceValue,
} from "./foreign-key-reference";
import {
  affectedRows,
  childRacePin,
  existsGuard,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import {
  nestedReplacement,
  relationOwnsForeignKey,
  upsertTargetNotFoundForParent,
  upsertTargetVanished,
} from "./messages";
import type { FreshArmBuilder } from "./nested-target-parts";
import type {
  GuardStep,
  OperationStep,
  ReadStep,
  StatementOutputSource,
  StatementStep,
  WriteStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { conditionalArmPlanning, planningKey } from "./Part";
import type {
  RecordUpdateCompiler,
  UpdateRecordBuilder,
} from "./RecordUpdateCompiler";
import type { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  pinnedTargetValues,
  sameScalarValue,
  UnsupportedOperationError,
  uniqueSelectorConjuncts,
} from "./shared";

/**
 * Where the parent id the child FK points at comes from — a first-class value,
 * never the parent object (WHY §4.2).
 * - `ref`: the parent write produces it in the same final fragment (create
 *   context); a Ref materialized later.
 * - `planned`: it was located by a planning read and is inlined as a literal at
 *   compile (update-by-unique context; a final-fragment step may not ref a
 *   planning step — ATOM §9 inv. 2).
 * - `literal`: it is a compile-time constant — the located-by-PK parent's own
 *   primary key. This is the base case of a first-class value, and it is what a
 *   depth-composed grandchild receives: its parent (a middle upsert located by
 *   its PK, emitted only on the found+correlated arm) has a known PK, so no
 *   probe/insert produces it.
 * - `transitioned` (E6.7): it was located by a planning read AND the root SET rewrites
 *   it, so the value the child must reference is the located one with that SET's operand
 *   APPLIED — a derivation that cannot run before the locate has, and therefore runs at
 *   compile.
 *
 * Read and write sources are separate members of each foreign-key edge. A transition
 * therefore reads the pre-transition field and writes the transformed value without a
 * caller recovering either source by field name.
 */
/**
 * How the found branch reads the probe (ATOM §4):
 * - `global-adopt`: nested upsert under `create` — the parent is fresh, no
 *   correlation is possible, so any globally-matched row is adopted and updated
 *   (the create-input superset, PLAN P−1.2).
 * - `correlated`: nested upsert under `update` — a found row is legal only if
 *   it already belongs to this parent; a found-uncorrelated row is the typed
 *   V7001 error (V1's message verbatim). Never `ON CONFLICT` (ATOM §4).
 */
export type UpsertCorrelation = "global-adopt" | "correlated";

/**
 * E4-U2 — the parent source and the correlation mode as ONE value, because which
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
 * Which member of the adopt family this part expresses (ATOM §6 — connectOrCreate
 * is the simplest member, upsert-under-create/update adds the update payload):
 * - `upsert`: found → reparent-and-update (or update, correlated); the found
 *   premise carries the V2 extension `Nested upsert premise changed` wording.
 * - `connectOrCreate`: found → pure connect (reparent, no update data); the found
 *   premise carries V1's verbatim `Record was replaced …` replacement wording.
 * Both share one probe, one create arm (constraint + `racePin`), one found guard
 * (`raceable: false`) — the leaf differs, never the vocabulary (WHY §4.1).
 */
export type UpsertFamily = "connectOrCreate" | "upsert";

/**
 * The two builders an adopt part reaches through injection rather than through an
 * import — `nested-target-parts` imports THIS module, so a runtime import back would
 * be a cycle. The caller threads the fresh-record function value.
 *
 * - {@link ArmSeam.freshArm} builds the absent → CREATE arm's whole create SUBTREE
 *   (N4-U2).
 * - {@link ArmSeam.nestedChild} builds the found → UPDATE arm's deeper Parts (E3):
 *   the arm's row is LOCATED, which is exactly what a nested `update` target is, so
 *   the arm reuses the located-target child-Part builder instead of a second dispatch
 *   of its own.
 *
 * One seam, not two parameters, because a caller that supplied one and forgot the
 * other would silently narrow what an arm can express.
 */
export interface ArmSeam {
  readonly freshArm: FreshArmBuilder;
  readonly updateRecord: UpdateRecordBuilder;
}

type ChildHeldRelation = ChildHeldToOne | ChildHeldToMany;

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
   * fold (N4-U1) — the update arm's grandchildren may address it as a `planned`
   * parent source, and a final reference source is a value, so the id has to exist first.
   */
  readonly probeId: string;
  /** Whether the probe publishes its captured primary key as a `firstRowField`
   *  output (set exactly when the update arm's grandchildren `planned`-read it). */
  readonly publishesLocatedPk?: boolean;
  readonly relation: ChildHeldRelation;
  readonly where: Record<string, unknown>;
  readonly updateData: Readonly<Record<string, unknown>>;
  readonly updateCompiler?: RecordUpdateCompiler;
  readonly updateLegality?: () => void;
  /**
   * The child-held foreign-key columns and the parent columns they reference,
   * index-aligned (compound keys are per-field, ATOM §1). A single-column edge is
   * the length-1 case — and the only one the `ref`/`literal` parent-id kinds
   * (create context / depth) support.
   */
  readonly childPrimaryKey: string;
  readonly txMode: boolean;
  /** Adopt-family member (default `upsert`); `connectOrCreate` omits update data. */
  readonly family?: UpsertFamily;
  /**
   * First-create-wins dedup across sibling parts (`connectOrCreate` only): an
   * EARLIER connectOrCreate item of the same relation, in this one operation,
   * already names this exact target (same child PK). V1 processes the array
   * sequentially — "merge input N before deciding input N+1" — so the duplicate
   * adopts the just-created row instead of re-inserting its PK. The M2M junction
   * tracks this with a runtime `created` set within one Part; the child-held
   * one-to-many is one Part per item, so the flag is computed at construction from
   * the fixed item order (the target PKs are compile-time literals).
   */
  readonly duplicateOfEarlier?: boolean;
  /**
   * Depth: nested upsert parts contributed by this child's UPDATE payload. They
   * are emitted only on this part's found+correlated (update) arm — the same
   * linear fragment, one level deeper (README §5, ATOM §6). This part holds its
   * children (by FK direction), never its parent (WHY §4.2). Empty at depth 1.
   */
  /**
   * N4-U2 — the absent → CREATE arm inserts a FRESH row, which is exactly what a
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
        readonly members: readonly ForeignKeyMember[];
      }
    | {
        readonly correlation: "correlated";
        readonly members: readonly CorrelatedForeignKeyMember[];
      }
  );

/**
 * The to-many nested-upsert child part (README §5's earned `RelationUpsert`
 * module — two operations now compose it, recursively). It contributes one
 * widened probe at planning (ATOM §3 technique 2: one unconditional child read
 * including its FK) plus its update-arm children's probes, and, at compile,
 * constructs exactly one taken arm:
 *
 * - absent → CREATE arm (fk = parent, unique-constraint + `racePin`, no guard). A
 *   relation-carrying arm is the whole create SUBTREE (N4-U2): its row is PRODUCED, so
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
    return this.config.relation.relationInfo.name;
  }

  constructor(scope: StepScope, config: RelationUpsertConfig) {
    this.config = config;
    this.family = config.family ?? "upsert";
    this.updateCompiler = config.updateCompiler;
    this.createSubtree = config.createSubtree;
    this.duplicateOfEarlier = config.duplicateOfEarlier ?? false;
    const { childScope, childName, where, txMode } = config;
    const relationName = config.relation.relationInfo.name;
    this.probeId = config.probeId;
    this.updateId =
      this.updateCompiler?.writeId ?? scope.allocate(`${childName}.update`);
    this.guardId = scope.allocate(`${childName}.guard.exists`);

    // Widened probe (ATOM §3 technique 2): read the child by its own unique key,
    // including every FK column, so compile can decide the three-way. Locked in
    // tx mode.
    this.find = {
      id: this.probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where,
        select: this.identitySelect(),
        forUpdate: txMode,
      }),
      // N4-U1: when the update arm's grandchildren take this probe's captured primary
      // key as their parent value, the probe must PUBLISH it so their planning probes
      // can `Ref` it in SQL. The output is OPTIONAL because an empty probe is this
      // part's legitimate CREATE decision — and on that decision no update-arm
      // grandchild ever compiles, so the value has no consumer (the same superset
      // tolerance an upsert root's locate already declares).
      outputs: this.updateCompiler
        ? {
            rows: { kind: "rows" },
            ...Object.fromEntries(
              this.updateCompiler.requiredTargetFields.map(
                (field): [string, StatementOutputSource] => [
                  field,
                  { kind: "firstRowField", field, optional: true },
                ]
              )
            ),
          }
        : config.publishesLocatedPk
          ? {
              rows: { kind: "rows" },
              [config.childPrimaryKey]: {
                kind: "firstRowField",
                field: config.childPrimaryKey,
                optional: true,
              },
            }
          : { rows: { kind: "rows" } },
    };

    // The probe pairs its read with the premise its decision creates (ATOM §2).
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
   *  primary key plus every FK column — its identity and its current parent, the two
   *  things every arm's decision is made from. */
  private identitySelect(): Record<string, boolean> {
    const select: Record<string, boolean> = {
      [this.config.childPrimaryKey]: true,
    };
    for (const member of this.config.members) {
      select[member.foreignField] = true;
    }
    for (const field of this.updateCompiler?.requiredTargetFields ?? []) {
      select[field] = true;
    }
    return select;
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
      // did not exist. A relation-carrying arm is the whole create SUBTREE (N4-U2):
      // the subtree owns the INSERT (with this part's racePin on its root record), its
      // own identity, and every relation below, under the fresh-parent elision
      // (ATOM §4) that makes any correlation beneath it statically empty.
      return this.createSubtree.compile(scope, known);
    }
    // Found: adopt-and-update (global) or update the correlated child. In batch
    // mode the found premise is pinned first by the exists guard, narrowed to the
    // located row. The update-arm children then compile one level deeper,
    // correlated to this child's PK.
    //
    // Every write this arm emits addresses THE ROW THE PROBE LOCATED, by its captured
    // primary key — the wrong-row doctrine, and the same identity
    // `RelationWritePart.compileTargeted` and `RelationJunctionPart.compileUpdate`
    // spend at their own seams. Before N4-U1 the selector had to name the primary key,
    // so "the selector's row" and "the located row" were one literal; once any unique
    // may name the target they are two provenances, and the update-arm grandchildren
    // already take the located one (`plannedParentId(probeId, childPrimaryKey)`).
    // Addressing the selector here would let the halves of one nested write land on
    // two different rows.
    const capturedPk = this.capturedPk(rows);
    const steps: OperationStep[] = [];
    if (this.foundPin) {
      steps.push(this.pinLocatedRow(this.foundPin, capturedPk, known));
    }
    if (this.updateCompiler) {
      this.config.updateLegality?.();
      steps.push(...this.compileRecordUpdate(known));
      return steps;
    }
    steps.push(
      this.buildUpdateArm(known, { [this.config.childPrimaryKey]: capturedPk })
    );
    return steps;
  }

  /**
   * The primary key of the row the probe located — the identity every found-arm write
   * addresses, read from the row the probe ACTED ON (`forUpdate` in tx mode) and never
   * re-derived from the selector. The same {@link locatedRow} the correlation decision
   * reads its foreign key from, so one arm cannot be deciding about a different row than
   * the other is writing.
   *
   * A row that carries no primary key is not guarded here: it makes the pin and the
   * write address `pk = <undefined>`, which the unique-`where` builder refuses outright
   * and which no substrate can silently satisfy — the operation already fails closed on
   * both, so a check here would be redundant defense (one guard per invariant).
   */
  private capturedPk(rows: readonly unknown[]): unknown {
    return locatedRow(rows)?.[this.config.childPrimaryKey];
  }

  /**
   * The declared found pin, narrowed to the located row. Only the premise's STATEMENT
   * changes — the id, the premise class and the failure wording are the constructor's,
   * which is what makes this the same pin the {@link Probe} declares rather than a
   * second guard for the same premise.
   */
  private pinLocatedRow(
    pin: GuardStep,
    capturedPk: unknown,
    known: PlanningKnown
  ): GuardStep {
    return {
      ...pin,
      premise: {
        ...pin.premise,
        statement: this.foundGuardStatement(capturedPk, known),
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
   *  · `pk = <captured>` — the selector and the row the decision was made about must
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
   * bespoke merge. N6-U1 widened these selectors and, as the note that stood here
   * promised, paid BOTH seams the filter half: {@link uniqueSelectorConjuncts} is that
   * one place. The probe already honoured it (it compiles the whole selector through
   * `buildFindUnique`); without the same half here the guard would re-assert a WEAKER
   * premise than the probe established, and a concurrent write to a filtered column
   * would pass a guard the locate had excluded. No `forUpdate`: this statement exists
   * only on the batch substrate, which is the only substrate that emits a found pin at
   * all.
   */
  private foundGuardStatement(
    capturedPk: unknown,
    known: PlanningKnown | undefined
  ): Sql {
    const config = this.config;
    const { childScope, where, childPrimaryKey } = config;
    return buildFind(
      childScope,
      {
        where: {
          AND: [
            ...uniqueSelectorConjuncts(childScope, where),
            ...(capturedPk === undefined
              ? []
              : [{ [childPrimaryKey]: { equals: capturedPk } }]),
            ...(known && config.correlation === "correlated"
              ? config.members.map((member) => ({
                  [member.foreignField]: {
                    equals: foreignKeyResolvedReadValue(
                      member,
                      known,
                      this.relationName,
                      "upsert"
                    ),
                  },
                }))
              : []),
          ],
        },
        select: this.identitySelect(),
      },
      { limit: 1 }
    );
  }

  /**
   * The compile-time three-way (ATOM §3 technique 2). `global-adopt` collapses
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
    const record = locatedRow(rows);
    // Correlated: found only if EVERY child FK column already equals its
    // referenced parent column (a compound edge correlates per-field). A partial
    // or foreign match is the found-uncorrelated V7001 (V1's verbatim message).
    const correlated = config.members.every((member) =>
      fkEquals(
        record?.[member.foreignField],
        foreignKeyResolvedReadValue(member, known, this.relationName, "upsert")
      )
    );
    if (correlated) return "found";
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
    const step: WriteStep = {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(childScope, {
        where: address,
        data: {
          ...this.config.updateData,
          // global-adopt reparents to the new parent; correlated re-sets the
          // same value (idempotent). Both land the FK the terminal read expects.
          ...this.fkAssignData(known),
        },
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

  private fkAssignData(known: PlanningKnown): Record<string, unknown> {
    return fkAssignData(
      this.config.engine,
      this.config.childScope,
      this.config.members,
      {
        relationName: this.relationName,
        known,
      }
    );
  }
}

/**
 * The FK columns an adopt arm writes, each a cast SQL expression: a `Ref` to the
 * parent create (create context, single-field), the located parent id inlined as a
 * literal (update-by-unique context), or a compile-time literal (depth-composed
 * grandchild). All ride in `Sql.values`, so the create INSERT and the update SET
 * consume them identically. One entry per compound-key field (ATOM §1).
 *
 * One home, two askers (N4-U2): the part's own arms, and — when the create arm is a
 * fresh SUBTREE — the incoming members that subtree's root INSERT folds. A second copy
 * is how a create arm and an update arm would come to disagree about which parent a
 * row belongs to.
 */
function fkAssignData(
  engine: QueryEngine,
  childScope: QueryScope,
  members: readonly ForeignKeyMember[],
  context: {
    readonly relationName: string;
    readonly known: PlanningKnown;
  }
): Record<string, unknown> {
  const { relationName, known } = context;
  const data: Record<string, unknown> = {};
  for (const member of members) {
    data[member.foreignField] = referenceSql(
      engine,
      childScope.model,
      member.foreignField,
      foreignKeyWriteValueWith(
        member,
        known,
        relationName,
        "upsert",
        (reference) => reference
      )
    );
  }
  return data;
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

/**
 * E5-U2 — the owned foreign key spelled in a nested create/update payload, when the
 * value AGREES with the one the engine's fold is about to write.
 *
 * D4 made this family ONE refusal with ONE message: the engine derives the column from
 * the row the enclosing step acted on, and a spelled value is a SECOND provenance for
 * it. That is true of a value that DISAGREES. A value that agrees is not a second
 * provenance — it is the same value, said twice — so the rule it breaks is a rule about
 * nothing. This drops it and lets the fold speak; every other spelling keeps D4's
 * message, byte for byte, from the one construction site.
 *
 * WHAT IT COMPARES (M6 measured the domain ALL-CANONICAL: the parse boundary normalizes
 * every referenced scalar type — int, bigInt, string, dateTime, decimal — to a canonical
 * primitive before either operand reaches here, so no `Date` or `Decimal` INSTANCE
 * arrives and `fkEquals` is the whole comparator, bigint normalization included):
 *
 *  · `{ set: v }` is unwrapped first, and unwrapping is MANDATORY, not a convenience —
 *    an update payload's scalar assignment arrives wrapped in the general case, and the
 *    two spellings must decide identically.
 *  · an ARITHMETIC envelope (`{ increment: n }`, …) is not unwrapped and cannot equal a
 *    literal, so it refuses — correctly: the engine's fold writes an absolute key, and
 *    an operand relative to the row's current one is a different value by construction.
 *  · `null` refuses. An FK equal to NULL references no row, so it contradicts the
 *    membership the enclosing relation is establishing, whatever the parent's key is.
 *
 * WHAT STAYS REFUSED, and why the refusal is the honest answer rather than a gap:
 *
 *  · a COMPOUND edge, fully or partially spelled. The comparison would have to be
 *    per-column against a per-column source, and a partial spelling has no agreement to
 *    test at all.
 *  · a `planned` or `ref` parent source — the update root's located row, and the create
 *    root's DB-generated key. There is NO VALUE at construction to compare against: one
 *    is read at planning, the other produced by an INSERT that has not run. This widens
 *    the recorded boundary from "Ref-only" to both, measured.
 *
 * COLLATION, deliberately: construction-time equality IS `fkEquals` equality, i.e. exact
 * value identity. A `citext` (or any case-insensitive) referenced column would make the
 * DATABASE call `'A'` and `'a'` the same key while this comparator calls them different,
 * so such a spelling refuses instead of being absorbed. That direction fails CLOSED —
 * the caller is told to omit a key the engine already owns — which is the only direction
 * this seam may err in.
 */
function withoutAgreeingOwnedFk(
  payload: Record<string, unknown>,
  context: {
    readonly members: readonly ForeignKeyMember[];
    readonly relationName: string;
  }
): Record<string, unknown> {
  const { members, relationName } = context;
  const fkFields = members.map((member) => member.foreignField);
  const spelled = fkFields.filter((fkField) => Object.hasOwn(payload, fkField));
  if (spelled.length === 0) return payload;
  const refusal = new UnsupportedOperationError(
    relationOwnsForeignKey(relationName, fkFields)
  );
  const fkField = fkFields.length === 1 ? fkFields[0] : undefined;
  const parentId =
    members.length === 1
      ? literalReferenceValue(members[0]!.writeSource)
      : undefined;
  if (fkField === undefined || parentId === undefined) throw refusal;
  const value = unwrapSetOperand(payload[fkField]);
  if (value === null || value === undefined) throw refusal;
  if (!fkEquals(value, parentId)) throw refusal;
  const { [fkField]: _agreed, ...rest } = payload;
  return rest;
}

/** `{ set: v }` → `v`; anything else (a bare value, an arithmetic envelope) verbatim. */
function unwrapSetOperand(value: unknown): unknown {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "set")
    ? value.set
    : value;
}

export function fkEquals(childFk: unknown, parentId: unknown): boolean {
  if (Object.is(childFk, parentId)) return true;
  // Cross-driver numeric normalization (bigint vs number ids).
  if (
    (typeof childFk === "number" || typeof childFk === "bigint") &&
    (typeof parentId === "number" || typeof parentId === "bigint")
  ) {
    return BigInt(childFk) === BigInt(parentId);
  }
  return false;
}

/** The parent id a child edge takes from a value the enclosing fragment PRODUCES —
 *  the create context's backward `Ref` (N4-U4 widened its source from "this record's own
 *  generated key" to any produced referenced value, so the ref arrives already built). */
export function plannedParentId(readStep: string): FinalReferenceSource {
  return { kind: "planningField", step: readStep };
}

export function literalParentId(value: unknown): FinalReferenceSource {
  return { kind: "literal", value };
}

/** E6.7 — the located value with the root SET's operand applied, per referenced column,
 *  at compile. `readStep` and `field` are `planned`'s, because the READ is identical; only
 *  the phase at which the value becomes knowable differs. */
export function transitionedParentId(
  readStep: string,
  field: string,
  transition: (before: unknown, field: string) => unknown
): FinalReferenceSource {
  return {
    kind: "transitionedPlanningField",
    step: readStep,
    apply: (before) => transition(before, field),
  };
}

// ---------------------------------------------------------------------------
// Recursive to-many upsert composition (PLAN P1.3). One shared builder folds a
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
  relation: ChildHeldRelation,
  items: readonly NormalizedRelationUpsert[],
  members: readonly ForeignKeyMember[],
  correlationMembers: readonly CorrelatedForeignKeyMember[] | undefined,
  txMode: boolean,
  seam: ArmSeam,
  family: UpsertFamily = "upsert"
): RelationUpsertPart[] {
  const { relationInfo } = relation;
  const relationName = relationInfo.name;
  if (
    relation.kind !== "childHeldToMany" &&
    !(relation.kind === "childHeldToOne" && family === "connectOrCreate")
  ) {
    // The inverse-side one-to-one (child-held FK) is the arity-1 case of this
    // child-held path: `connectOrCreate` adopts it globally,
    // exactly as the to-many arity does (found → reparent; absent → create with the
    // parent FK injected, constraint + racePin). A many-to-many target is the
    // junction's, and an FK-holder-side (parent-held) to-one is a same-row change,
    // not this child-held Part.
    // E3-U4 — UNREACHABLE BY CONSTRUCTION since the arm dispatch was replaced.
    //
    // This was a REACHABLE typed refusal until E3: `buildArmChildParts` dispatched an
    // upsert's UPDATE-arm grandchildren on the KIND alone and handed any
    // `connectOrCreate`/`upsert` straight to this builder, direction unexamined — so a
    // PARENT-HELD to-one or a many-to-many grandchild landed here with the wrong
    // `relationInfo.type`. The arm now routes by DIRECTION first, through the same
    // located-target seam every other located-target caller uses
    // ({@link ArmSeam.nestedChild}), which sends many-to-many to the junction and stops
    // the parent-held direction with its own wording
    // ({@link assertArmEdgeIsChildHeld}) — so the wrong type no longer arrives.
    //
    // Every remaining caller had already dispatched the direction before entering:
    // `UpdateOperation.interpretChildHeld` and `CreateOperation.interpretChildHeld`
    // (both reached only for the child-held direction, the inverse-side to-one `upsert`
    // pre-routed to `buildInverseToOneUpsertPart` and absent from `toOneCreateFactory`
    // under create), and the junction target relation fold (many-to-many
    // dispatched above it, parent-held stopped above it, `isInverseToOne` split inside
    // the `upsert` case). The X1c disposition applies: an engine invariant, not a route.
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationName}' reached the child-held adopt builder as '${relationInfo.type}' for a nested ${family}; every caller dispatches the relation direction before this builder.`
    );
  }
  // First-create-wins dedup is a connectOrCreate-only, fixed-order ledger over the
  // sibling items' target PKs (compile-time literals) — the child-held analogue of
  // the M2M junction's runtime `created` set. `upsert` is not deduped here (its
  // array semantics differ; V1 merges each input's write before the next).
  const child =
    family === "connectOrCreate"
      ? createQueryScope(engine.adapter, relationInfo.targetModel)
      : undefined;
  const childPk = child ? getPrimaryKeyFields(child.model)[0] : undefined;
  const seenTargets = child ? new Set<string>() : undefined;
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
    if (seenTargets && childPk !== undefined) {
      const key = connectOrCreateTargetKey(item, childPk);
      duplicateOfEarlier = seenTargets.has(key);
      seenTargets.add(key);
    }
    return buildOneUpsertPart(
      scope,
      engine,
      relation,
      item,
      members,
      correlationMembers,
      txMode,
      seam,
      family,
      duplicateOfEarlier
    );
  });
}

/** The stable target-PK key of a connectOrCreate item (its create data's child
 *  PK, falling back to the `where` unique) — the ledger key for first-create-wins. */
function connectOrCreateTargetKey(
  item: AdoptMutationItem,
  childPk: string
): string {
  const create = isRecord(item.create) ? item.create : undefined;
  const where = isRecord(item.where) ? item.where : undefined;
  const value = create?.[childPk] ?? where?.[childPk];
  return typeof value === "bigint" ? value.toString() : JSON.stringify(value);
}

/**
 * Build one `RelationUpsertPart` per `connectOrCreate` item — the update-less
 * member of the adopt family (ATOM §6's worked trace). It is always global-adopt
 * (`connect` performs a global lookup-and-adopt in both the create and update
 * contexts, PLAN P−1.2), so it takes no correlation: found → connect (reparent),
 * absent → create (constraint + `racePin`).
 */
export function buildConnectOrCreateParts(
  scope: StepScope,
  engine: QueryEngine,
  relation: ChildHeldRelation,
  items: readonly ConnectOrCreateInput[],
  members: readonly ForeignKeyMember[],
  txMode: boolean,
  seam: ArmSeam
): RelationUpsertPart[] {
  return buildAdoptParts(scope, engine, relation, items, members, txMode, seam);
}

function buildAdoptParts(
  scope: StepScope,
  engine: QueryEngine,
  relation: ChildHeldRelation,
  items: readonly AdoptMutationItem[],
  members: readonly ForeignKeyMember[],
  txMode: boolean,
  seam: ArmSeam
): RelationUpsertPart[] {
  const { relationInfo } = relation;
  const child = createQueryScope(engine.adapter, relationInfo.targetModel);
  const childPk = getPrimaryKeyFields(child.model)[0];
  const seenTargets = new Set<string>();
  return items.map((item) => {
    const key = childPk ? connectOrCreateTargetKey(item, childPk) : undefined;
    const duplicateOfEarlier = key !== undefined && seenTargets.has(key);
    if (key !== undefined) seenTargets.add(key);
    return buildOneUpsertPart(
      scope,
      engine,
      relation,
      item,
      members,
      undefined,
      txMode,
      seam,
      "connectOrCreate",
      duplicateOfEarlier
    );
  });
}

interface AdoptMutationItem {
  readonly where: Record<string, unknown>;
  readonly create: Record<string, unknown>;
  readonly update?: Record<string, unknown>;
}

function buildOneUpsertPart(
  scope: StepScope,
  engine: QueryEngine,
  relation: ChildHeldRelation,
  item: AdoptMutationItem,
  members: readonly ForeignKeyMember[],
  correlationMembers: readonly CorrelatedForeignKeyMember[] | undefined,
  txMode: boolean,
  seam: ArmSeam,
  family: UpsertFamily,
  duplicateOfEarlier = false
): RelationUpsertPart {
  const { relationInfo } = relation;
  const relationName = relationInfo.name;
  if (relation.foreignFields.length !== relation.referencedFields.length) {
    // The child must hold the foreign key referencing the parent (one column, or an
    // index-aligned compound key — ATOM §1's per-field precedent).
    //
    // Unreachable by construction (N7-U-A, the X1c disposition). A
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
  // E5-U2 — the owned foreign key, spelled beside the relation that owns it, decided
  // ONCE for both arms and BEFORE either is separated: the agreeing spelling is dropped
  // here, so the engine's fold stays the single provenance everywhere downstream — the
  // create arm's scalar data, the update arm's SET, the primary-key stability check, and
  // the fresh create SUBTREE, which is handed this same `create` object and whose root
  // INSERT folds the parent key through its incoming members. A kept key would meet that fold
  // there and write the column twice.
  const ownedFk = { members, relationName };
  const create = withoutAgreeingOwnedFk(
    requireRecord(item.create, `${relationName}.${family}.create`),
    ownedFk
  );
  // connectOrCreate has no update payload; its found arm is a pure connect.
  const update =
    family === "connectOrCreate"
      ? undefined
      : withoutAgreeingOwnedFk(
          requireRecord(item.update, `${relationName}.upsert.update`),
          ownedFk
        );
  const childUpdate =
    update === undefined
      ? { scalarData: {}, relations: {} }
      : buildParsedRelationPrograms(child, update);
  const childPrimaryKeys = getPrimaryKeyFields(child.model);
  if (childPrimaryKeys.length !== 1) {
    throw new UnsupportedOperationError(
      `Relation '${relationName}' requires a child with one primary key.`
    );
  }
  const childPrimaryKey = childPrimaryKeys[0]!;
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const wherePk = getWhereUniqueEntries(child, where).find(
    (entry) => entry.fieldName === childPrimaryKey
  );
  assertArmPkStable(
    child,
    childPrimaryKey,
    relationName,
    wherePk,
    childUpdate.scalarData,
    childUpdate.relations
  );
  for (const [childRelationName, program] of Object.entries(
    childUpdate.relations
  )) {
    assertArmEdgeIsChildHeld(child, childRelationName, program);
    assertArmEdgeReferencesLocatedPk(
      child,
      childPrimaryKey,
      childRelationName,
      program
    );
  }
  const parentId = members[0]?.writeSource;
  if (!parentId) {
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationName}' reached the upsert part with no foreign-key member.`
    );
  }
  const pinnedTarget = pinnedTargetValues(child, where);
  if (update) {
    assertPinnedTransitionIsCompilable(
      child,
      childUpdate.scalarData,
      childUpdate.relations,
      relationName,
      pinnedTarget
    );
  }
  const updateCompiler = update
    ? seam.updateRecord({
        scope,
        engine,
        targetScope: child,
        scalarData: childUpdate.scalarData,
        relations: childUpdate.relations,
        targetRead: { label: `${childName}.find` },
        rootWrite: { label: `${childName}.update` },
        incomingForeignKey: members,
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
        assertSelectedUpdateManyDataIsScalar(child, childUpdate.relations);
      }
    : undefined;
  const probeId =
    updateCompiler?.targetReadId ?? scope.allocate(`${childName}.find`);
  const createSubtree = seam.freshArm({
    childScope: child,
    data: create,
    incomingForeignKey: members,
    relationName,
    racePin: childRacePin(child, where),
  });

  return new RelationUpsertPart(scope, {
    engine,
    childScope: child,
    childName,
    probeId,
    relation,
    where,
    updateData: childUpdate.scalarData,
    childPrimaryKey,
    ...(correlationMembers
      ? { correlation: "correlated" as const, members: correlationMembers }
      : { correlation: "global-adopt" as const, members }),
    txMode,
    family,
    duplicateOfEarlier,
    updateCompiler,
    updateLegality,
    createSubtree,
  });
}

/**
 * E3 — WHICH DIRECTION a deeper edge on this arm may take.
 *
 * A child-held edge (the deeper row holds a foreign key referencing this arm's row) is a
 * write to the DEEPER table, correlated to the value this arm's parent source carries —
 * which is what every Part below the seam is built from. A PARENT-HELD edge is not: the
 * arm's OWN row holds the foreign key, so `create`/`connect`/`connectOrCreate` there is
 * a change to the arm's own UPDATE SET (child-SET folding), landing beside the reparent
 * {@link RelationUpsertPart.buildUpdateArm} already writes.
 *
 * The mechanism that folds a located row's SET is the update ROOT's before-target
 * machinery, reached by delegating the WHOLE located target to `UpdateOperation`
 * through the selected-record compiler. This arm cannot take that route as it stands: its
 * UPDATE is one statement carrying the reparent, the upsert-premise `expects` wording
 * and the found pin, and a delegated sub-op would emit a SECOND UPDATE of the same row —
 * forking the premise this part pins. Re-deriving the before-target primitives here
 * instead would fork them a different way (they are private to `UpdateOperation`, and
 * ATOM §4.1 exists to keep one linearization). Measured, named, and left refused rather
 * than smuggled in: the shape stays a typed boundary, not an internal invariant break.
 *
 * A many-to-many edge needs no fold: its membership is a join row the junction writes,
 * correlated to this arm's parent value like any child-held edge.
 */
function assertArmEdgeIsChildHeld(
  child: QueryScope,
  relationName: string,
  mutation: RelationMutationProgram
): void {
  const relation = bindRelation(child, mutation.relationInfo);
  if (relation.kind !== "parentHeldToOne") return;
  throw new UnsupportedOperationError(
    `query-engine-v2 does not support a parent-held to-one write on relation '${relationName}' one level deeper on the update arm; the arm's row holds that foreign key, so the write belongs in the arm's own UPDATE SET, which already carries this relation's reparent.`
  );
}

/**
 * E3 — the arm's own primary key may not MOVE while the arm carries deeper edges.
 *
 * Every deeper edge on this arm is correlated to the arm row's primary key — as the
 * `where`'s literal, or as a `planned` read of this part's probe, which runs BEFORE the
 * arm's UPDATE. A SET that moves that key therefore leaves every deeper write bound to
 * the value the transition vacates: a junction row correlating on a key no row carries,
 * a child INSERT whose foreign key names a row that no longer exists, a targeted update
 * that finds nothing. The root answers this with an ordering regime
 * (`RelationWritePart.interpretChildParts`: the cascade/non-cascade split, the
 * post-transition literal, the occupied guards), which is module-private to that class
 * and is not ported here — so the composition fails closed instead of binding a stale
 * key.
 *
 * A SET that NAMES the key is not automatically a MOVE, and the same two literals the
 * root uses decide it: the `where`-pinned pre-value and `getUpdatedPrimaryKeyValue` over
 * the operand. `id: <the value it already has>` and `increment: 0` write the key without
 * moving it, and the root accepts those beside deeper edges — asking `Object.hasOwn`
 * alone would refuse at this arm a payload the root runs. When some OTHER unique named
 * the arm's row there is no compile-time pre-value to compare, so a no-op is
 * indistinguishable from a move and takes the refusing path — the same place the root's
 * unpinned pre-value leaves it.
 *
 * Scoped to `relations` being non-empty: a scalar-only arm transitions its key freely
 * (nothing below it references the key), which is the shipped behaviour this must not
 * narrow.
 */
function assertArmPkStable(
  child: QueryScope,
  childPrimaryKey: string,
  relationName: string,
  wherePk: { readonly value: unknown } | undefined,
  updateScalarData: Record<string, unknown>,
  relations: Record<string, RelationMutationProgram>
): void {
  if (Object.keys(relations).length === 0) return;
  if (!Object.hasOwn(updateScalarData, childPrimaryKey)) return;
  if (wherePk !== undefined) {
    const after = getUpdatedPrimaryKeyValue(
      child.model,
      childPrimaryKey,
      wherePk.value,
      updateScalarData[childPrimaryKey],
      getStepModelName(child.model, relationName)
    );
    if (sameScalarValue(wherePk.value, after)) return;
  }
  throw new UnsupportedOperationError(
    `query-engine-v2 does not support an update arm that moves the primary key '${childPrimaryKey}' of relation '${relationName}' while it carries deeper relation writes; those writes correlate on the key the arm vacates.`
  );
}

/**
 * M11 — the update arm's parent value speaks for exactly ONE column of the located row:
 * this child's primary key. It is that key's `where` literal, or a `planned` read of this
 * part's own probe, whose projection ({@link RelationUpsertPart.identitySelect}) is the
 * child's primary key plus the child's OWN foreign key columns and nothing else. But
 * {@link fkAssignData} writes EVERY foreign-key column of a deeper edge from that one
 * value, so an edge referencing a compound tuple — or a single NON-primary-key column —
 * of this child receives the primary key in all of them. Measured through the public
 * client: a grandchild silently adopted by whichever row happens to hold the
 * cross-matched tuple, a grandchild silently reparented away, and a bare
 * `ForeignKeyError` when no row holds it. No wrong value is representable once this
 * refuses at construction, before a statement exists.
 *
 * What such an edge needs is a PER-FIELD parent source — one value per referenced column,
 * which is exactly what {@link referencedFieldValue} already gives the update ROOT, whose
 * locate read unions every referenced column into its own projection. Building that source
 * for this seam is E4's unit; until it exists this is a refusal, not a repair.
 *
 * Its unique coverage is the parent source {@link buildOneUpsertPart} MANUFACTURES for its
 * own update arm — no other caller reaches it, and none changes. Every other source handed
 * to that builder is already whole: the update root's locate-backed `planned` one resolves
 * each referenced column per-field, `CreateOperation.edgeParentId` refuses a compound edge
 * before building a source at all, the adopt classifier refuses past its single-PK surface,
 * and the nested-target builders pin the same condition twice
 * (the whole-record classifier / `referencesTargetPk`).
 */
function assertArmEdgeReferencesLocatedPk(
  child: QueryScope,
  childPrimaryKey: string,
  relationName: string,
  mutation: RelationMutationProgram
): void {
  const relation = bindRelation(child, mutation.relationInfo);
  // A junction's membership is correlated to the arm's parent value as a whole — never
  // a per-column FK write, so there is no cross-match to make. A parent-held relation's
  // referenced fields belong to the TARGET rather than this child, so it is not fed from
  // the arm's parent value either; {@link assertArmEdgeIsChildHeld} stops it first.
  if (relation.kind === "junction" || relation.kind === "parentHeldToOne")
    return;
  if (
    relation.referencedFields.length === 1 &&
    relation.referencedFields[0] === childPrimaryKey
  ) {
    return;
  }
  throw new UnsupportedOperationError(
    `query-engine-v2 does not support a compound or non-primary-key referenced edge one level deeper on the update arm of relation '${relationName}'; the arm's parent value is the located row's primary key '${childPrimaryKey}' alone, and each referenced column needs a per-field parent source.`
  );
}

/** An `unknown -> Record` narrowing, NOT a shape check (N7-U-A). An upsert /
 *  connectOrCreate item's `where` / `create` / `update` slots are validated by the
 *  enclosing whole-args parse (`ValidationError: Expected object`) before any Part is
 *  built; a non-record reaching it is an engine invariant break — the X1c disposition,
 *  not a route.
 *
 *  Its item-list sibling (`normalizeUpsertItems`) went with E3's arm dispatch: the arm no
 *  longer unwraps a deeper relation's item array itself, so the only remaining caller of
 *  that narrowing is `nested-target-parts.normalizeItems`, which already owns it. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: '${label}' must be an object after the parse boundary validated the payload.`
  );
}
