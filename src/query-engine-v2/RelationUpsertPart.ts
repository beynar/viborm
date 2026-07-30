// biome-ignore-all lint/style/useFilenamingConvention: RelationUpsertPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { getPrimaryKeyFields } from "../query-engine/builders/correlation-utils";
import {
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import { assertPortablePrimaryKeyUpdateInput } from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import { validateProbe } from "./FragmentValidator";
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
  upsertTargetNotFoundForParent,
  upsertTargetVanished,
} from "./messages";
import type { FreshArmBuilder } from "./nested-target-parts";
import type {
  GuardStep,
  OperationStep,
  OperationValueReference,
  Probe,
  StatementStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { referencedFieldValue } from "./parent-reference";
import type { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
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
 */
export type ParentIdSource =
  | { readonly kind: "ref"; readonly ref: OperationValueReference }
  | {
      readonly kind: "planned";
      readonly readStep: string;
      readonly field: string;
    }
  | { readonly kind: "literal"; readonly value: unknown };

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

export interface RelationUpsertConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  /**
   * This part's own locate-probe step id, allocated by the builder BEFORE the arms
   * fold (N4-U1) — the update arm's grandchildren may address it as a `planned`
   * parent source, and a `ParentIdSource` is a value, so the id has to exist first.
   */
  readonly probeId: string;
  /** Whether the probe publishes its captured primary key as a `firstRowField`
   *  output (set exactly when the update arm's grandchildren `planned`-read it). */
  readonly publishesLocatedPk?: boolean;
  readonly relationName: string;
  readonly where: Record<string, unknown>;
  readonly createData: Readonly<Record<string, unknown>>;
  readonly updateData: Readonly<Record<string, unknown>>;
  /**
   * The child-held foreign-key columns and the parent columns they reference,
   * index-aligned (compound keys are per-field, ATOM §1). A single-column edge is
   * the length-1 case — and the only one the `ref`/`literal` parent-id kinds
   * (create context / depth) support.
   */
  readonly fkFields: readonly string[];
  readonly referencedFields: readonly string[];
  readonly childPrimaryKey: string;
  readonly parentId: ParentIdSource;
  readonly correlation: UpsertCorrelation;
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
  readonly updateChildParts?: readonly Part[];
  /**
   * N4-U2 — depth on the CREATE arm. The absent → CREATE arm inserts a FRESH row,
   * which is exactly what a `create` root builds, so when the arm's payload carries
   * relations the WHOLE arm is a create SUBTREE ({@link FreshArmBuilder}) rather than
   * this part's own one-statement leaf plus a hand-rolled list of deeper writes. It
   * owns the arm's INSERT (carrying this part's raceable missing-premise pin as its
   * root record's `racePin`), its own identity — a spelled primary key OR one the
   * database generates and its grandchildren `Ref` — and every relation below at any
   * depth. Absent when the create payload is scalar-only; then {@link buildCreateArm}
   * emits the single INSERT it always did, byte-identically.
   */
  readonly createSubtree?: Part;
}

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
 * It holds no parent — only a `ParentIdSource` value, its FK metadata, and its
 * own children.
 */
export class RelationUpsertPart implements Part {
  readonly probe: Probe;
  private readonly config: RelationUpsertConfig;
  private readonly probeId: string;
  private readonly createId: string;
  private readonly updateId: string;
  private readonly guardId: string;
  private readonly find: StatementStep;
  private readonly updateChildParts: readonly Part[];
  private readonly createSubtree: Part | undefined;
  private readonly family: UpsertFamily;
  private readonly duplicateOfEarlier: boolean;

  constructor(scope: StepScope, config: RelationUpsertConfig) {
    this.config = config;
    this.family = config.family ?? "upsert";
    this.updateChildParts = config.updateChildParts ?? [];
    this.createSubtree = config.createSubtree;
    this.duplicateOfEarlier = config.duplicateOfEarlier ?? false;
    const { childScope, childName, where, txMode, relationName } = config;
    this.probeId = config.probeId;
    this.createId = scope.allocate(`${childName}.create`);
    this.updateId = scope.allocate(`${childName}.update`);
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
      outputs: config.publishesLocatedPk
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
    this.probe = {
      read: this.find,
      pin: { whenFound: foundPin, whenMissing: "constraint" },
    };
    validateProbe(this.probe);
  }

  /** The probe's (and the found pin's, and the update arm's) projection: this child's
   *  primary key plus every FK column — its identity and its current parent, the two
   *  things every arm's decision is made from. */
  private identitySelect(): Record<string, boolean> {
    const select: Record<string, boolean> = {
      [this.config.childPrimaryKey]: true,
    };
    for (const fkField of this.config.fkFields) select[fkField] = true;
    return select;
  }

  /** The address consumers read this part's probe rows from in `known`. */
  probeRowsKey(): string {
    return planningKey(this.probeId, "rows");
  }

  planning(scope: StepScope): readonly OperationStep[] {
    // Planning is unconditional: this part's probe plus every arm's child probes
    // run before any write, so `compile` has all three-way inputs in `known`
    // regardless of which arm each level later takes. Both the update-arm and
    // the create-arm children plan here (technique #2's widened superset); only
    // the taken arm's children later compile.
    const steps: OperationStep[] = [this.find];
    for (const child of this.updateChildParts) {
      steps.push(...child.planning(scope));
    }
    if (this.createSubtree) steps.push(...this.createSubtree.planning(scope));
    return steps;
  }

  compile(scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const rows = known[this.probeRowsKey()];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.config.relationName}' did not expose rows.`,
        this.config.relationName
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
      return this.createSubtree
        ? this.createSubtree.compile(scope, known)
        : [this.buildCreateArm(known)];
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
    if (this.probe.pin.whenFound !== "none") {
      steps.push(
        this.pinLocatedRow(this.probe.pin.whenFound, capturedPk, known)
      );
    }
    steps.push(
      this.buildUpdateArm(known, { [this.config.childPrimaryKey]: capturedPk })
    );
    for (const child of this.updateChildParts) {
      steps.push(...child.compile(scope, known));
    }
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
    const { childScope, where, childPrimaryKey, fkFields, correlation } =
      this.config;
    return buildFind(
      childScope,
      {
        where: {
          AND: [
            ...uniqueSelectorConjuncts(childScope, where),
            ...(capturedPk === undefined
              ? []
              : [{ [childPrimaryKey]: { equals: capturedPk } }]),
            ...(known && correlation === "correlated"
              ? fkFields.map((fkField, index) => ({
                  [fkField]: {
                    equals: this.parentReferenced(known, index),
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
    if (this.config.correlation === "global-adopt") return "found";
    const record = locatedRow(rows);
    // Correlated: found only if EVERY child FK column already equals its
    // referenced parent column (a compound edge correlates per-field). A partial
    // or foreign match is the found-uncorrelated V7001 (V1's verbatim message).
    const correlated = this.config.fkFields.every((fkField, index) =>
      fkEquals(record?.[fkField], this.parentReferenced(known, index))
    );
    if (correlated) return "found";
    throw new NestedWriteError(
      upsertTargetNotFoundForParent(this.config.relationName),
      this.config.relationName
    );
  }

  private buildCreateArm(known: PlanningKnown): StatementStep {
    const { childScope, where } = this.config;
    return {
      id: this.createId,
      kind: "write",
      statement: buildInsert(childScope, getTableName(childScope.model), {
        ...this.config.createData,
        ...this.fkAssignData(known),
      }),
      outputs: {},
      // The missing premise is enforced by the child's unique constraint; its
      // violation is the raceable signal, matched against this pinned target.
      racePin: childRacePin(childScope, where),
    };
  }

  /** The found/adopt arm. `address` is the row it writes: the located row's captured
   *  primary key on the found arm, and — only for the first-create-wins duplicate,
   *  whose row this operation has not inserted yet — the selector. */
  private buildUpdateArm(
    known: PlanningKnown,
    address: Record<string, unknown>
  ): StatementStep {
    const { childScope, txMode, relationName } = this.config;
    const step: StatementStep = {
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

  private fkAssignData(known: PlanningKnown): Record<string, unknown> {
    return fkAssignData(
      this.config.engine,
      this.config.childScope,
      this.config.fkFields,
      this.config.referencedFields,
      {
        parentId: this.config.parentId,
        relationName: this.config.relationName,
        known,
      }
    );
  }

  /** The concrete value of the parent column the FK field `index` references
   *  (literal/planned; never a `ref`). */
  private parentReferenced(known: PlanningKnown, index: number): unknown {
    return referencedFieldValue(
      this.config.parentId,
      this.config.referencedFields[index]!,
      known,
      this.config.relationName,
      "upsert"
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
 * fresh SUBTREE — the `rootFkInject` that subtree's root INSERT folds. A second copy
 * is how a create arm and an update arm would come to disagree about which parent a
 * row belongs to.
 */
function fkAssignData(
  engine: QueryEngine,
  childScope: QueryScope,
  fkFields: readonly string[],
  referencedFields: readonly string[],
  context: {
    readonly parentId: ParentIdSource;
    readonly relationName: string;
    readonly known: PlanningKnown;
  }
): Record<string, unknown> {
  const { parentId, relationName, known } = context;
  const data: Record<string, unknown> = {};
  for (let index = 0; index < fkFields.length; index += 1) {
    const fkField = fkFields[index]!;
    data[fkField] = referenceSql(
      engine,
      childScope.model,
      fkField,
      parentId.kind === "ref"
        ? parentId.ref
        : referencedFieldValue(
            parentId,
            referencedFields[index]!,
            known,
            relationName,
            "upsert"
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

function fkEquals(childFk: unknown, parentId: unknown): boolean {
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
export function refParentId(
  reference: OperationValueReference
): ParentIdSource {
  return { kind: "ref", ref: reference };
}

export function plannedParentId(
  readStep: string,
  field: string
): ParentIdSource {
  return { kind: "planned", readStep, field };
}

export function literalParentId(value: unknown): ParentIdSource {
  return { kind: "literal", value };
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
  parentScope: QueryScope,
  engine: QueryEngine,
  relationName: string,
  relationInfo: RelationInfo,
  items: readonly Record<string, unknown>[],
  parentId: ParentIdSource,
  correlation: UpsertCorrelation,
  txMode: boolean,
  freshArm: FreshArmBuilder,
  family: UpsertFamily = "upsert"
): RelationUpsertPart[] {
  if (relationInfo.type !== "oneToMany") {
    // The **inverse-side one-to-one** (child-held FK) is the arity-1 case of this
    // child-held path (TO-ONE.md §7.0.1): `connectOrCreate` adopts it globally,
    // exactly as the to-many arity does (found → reparent; absent → create with the
    // parent FK injected, constraint + racePin). Its nested-relation **upsert** arm
    // is deferred to T3, so only the connectOrCreate family widens here. A
    // many-to-many nested target stays V1's, and an FK-holder-side (parent-held)
    // to-one is a same-row change, not this child-held Part.
    const inverseToOne =
      relationInfo.isToOne &&
      !getFkDirection(parentScope, relationInfo).holdsFK;
    if (!(inverseToOne && family === "connectOrCreate")) {
      // N7-U-A MEASURED this and did NOT convert it. The audit filed it (c-i) — "no
      // reachable payload identified" — and that is false for exactly one caller.
      //
      // At the update ROOT and at the create root the direction IS dispatched before this
      // builder, and the inverse-side to-one's `upsert` goes to
      // `buildInverseToOneUpsertPart` (T3-r2) while under `create` the parse boundary
      // answers first (`toOneCreateFactory` has no `upsert` arm). But `buildUpdateArmParts`
      // — the GRANDCHILD fold on an upsert's update arm, one seam below — dispatches on the
      // KIND alone and hands any `connectOrCreate` straight to `buildConnectOrCreateParts`,
      // direction unexamined. A PARENT-HELD to-one grandchild therefore lands here:
      // `user.update({ posts: { upsert: [{ …, update: { author: { connectOrCreate } } }] } })`
      // reaches it with `type === "manyToOne"`, and `upsert-family.test.ts`'s "depth-2
      // to-one grandchild refusal" has been standing in front of it all along.
      //
      // So it is a REACHABLE refusal, in the same family as :1079 (a parent-held to-one
      // grandchild `create` on the same arm): the target's own SET fold is what it needs,
      // and X1c's whole-target delegation owns that fold. Audit disposition (c-ii) — a
      // mechanism that exists, unwired — NOT a defensive guard.
      throw new UnsupportedOperationError(
        `query-engine-v2 does not support a nested ${family} on the '${relationInfo.type}' relation '${relationName}' here; only a child-held one-to-many (or an inverse-side to-one connectOrCreate) is expressible at this seam.`
      );
    }
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
  return items.map((item) => {
    let duplicateOfEarlier = false;
    if (seenTargets && childPk !== undefined) {
      const key = connectOrCreateTargetKey(item, childPk);
      duplicateOfEarlier = seenTargets.has(key);
      seenTargets.add(key);
    }
    return buildOneUpsertPart(
      scope,
      parentScope,
      engine,
      relationName,
      relationInfo,
      item,
      parentId,
      correlation,
      txMode,
      freshArm,
      family,
      duplicateOfEarlier
    );
  });
}

/** The stable target-PK key of a connectOrCreate item (its create data's child
 *  PK, falling back to the `where` unique) — the ledger key for first-create-wins. */
function connectOrCreateTargetKey(
  item: Record<string, unknown>,
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
  parentScope: QueryScope,
  engine: QueryEngine,
  relationName: string,
  relationInfo: RelationInfo,
  items: readonly Record<string, unknown>[],
  parentId: ParentIdSource,
  txMode: boolean,
  freshArm: FreshArmBuilder
): RelationUpsertPart[] {
  return buildToManyUpsertParts(
    scope,
    parentScope,
    engine,
    relationName,
    relationInfo,
    items,
    parentId,
    "global-adopt",
    txMode,
    freshArm,
    "connectOrCreate"
  );
}

function buildOneUpsertPart(
  scope: StepScope,
  parentScope: QueryScope,
  engine: QueryEngine,
  relationName: string,
  relationInfo: RelationInfo,
  item: Record<string, unknown>,
  parentId: ParentIdSource,
  correlation: UpsertCorrelation,
  txMode: boolean,
  freshArm: FreshArmBuilder,
  family: UpsertFamily,
  duplicateOfEarlier = false
): RelationUpsertPart {
  const fk = getFkDirection(parentScope, relationInfo);
  if (fk.holdsFK || fk.fkFields.length !== fk.pkFields.length) {
    // The child must hold the foreign key referencing the parent (one column, or an
    // index-aligned compound key — ATOM §1's per-field precedent).
    //
    // Unreachable by construction (N7-U-A, the X1c disposition), both halves measured.
    // `holdsFK`: the parent-held direction is dispatched by every caller before this
    // private builder is entered. Arity mismatch: a `.fields("a","b").references("c")`
    // edge is rejected UPSTREAM by the relation-mutation legality walk
    // (`NestedWriteError: Relation '<name>' has mismatched foreign-key metadata.`), which
    // runs before any Part is built — so no payload arrives with a mismatched arity here.
    throw new QueryEngineError(
      `query-engine-v2 internal: relation '${relationName}' reached the upsert part without an index-aligned child-held foreign key referencing the parent.`
    );
  }
  const fkFields = fk.fkFields;
  const referencedFields = fk.pkFields;
  const child = createQueryScope(engine.adapter, relationInfo.targetModel);
  const where = requireRecord(item.where, `${relationName}.${family}.where`);
  const create = requireRecord(item.create, `${relationName}.${family}.create`);
  const childCreate = separateData(child, create);
  // connectOrCreate has no update payload; its found arm is a pure connect.
  const childUpdate =
    family === "connectOrCreate"
      ? { scalarData: {}, relations: {} }
      : separateData(
          child,
          requireRecord(item.update, `${relationName}.upsert.update`)
        );
  if (family === "upsert") {
    // V1's PK-arithmetic portability check on the nested upsert update arm
    // (float/decimal non-portability, divide-by-zero, one-op) — a construction-
    // time payload legality gate reusing V1's verbatim messages.
    assertPortablePrimaryKeyUpdateInput(child.model, "update", {
      data: item.update,
    });
  }
  if (
    fkFields.some(
      (fkField) =>
        Object.hasOwn(childCreate.scalarData, fkField) ||
        Object.hasOwn(childUpdate.scalarData, fkField)
    )
  ) {
    throw new UnsupportedOperationError(
      `Relation '${relationName}' owns '${fkFields.join(", ")}'; omit it from nested create and update data.`
    );
  }
  const childPrimaryKeys = getPrimaryKeyFields(child.model);
  if (childPrimaryKeys.length !== 1) {
    throw new UnsupportedOperationError(
      `Relation '${relationName}' requires a child with one primary key.`
    );
  }
  const childPrimaryKey = childPrimaryKeys[0]!;
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  // N4-U1 — the probe id is allocated HERE, before the arms fold, because the update
  // arm's grandchildren may take this probe's captured primary key as their parent
  // value. The constructor consumes it instead of allocating its own, so the id
  // strings are unchanged for every shape that does not use the located key.
  const probeId = scope.allocate(`${childName}.find`);

  // Depth on the found+update arm (correlated grandchildren) and on the fresh create
  // arm (the create SUBTREE, ATOM §4's elision). Both fold into the same linear
  // fragment. What the two arms KNOW about this child differs, and that is the whole
  // difference between them:
  //
  //  · the UPDATE arm acts on the row the probe FOUND, so — N4-U1 — the primary key
  //    is either the `where`'s own literal or a `planned` read of that probe. A
  //    non-primary-key unique (`where: { slug }`) no longer refuses: it locates.
  //  · the CREATE arm PRODUCES its row, so — N4-U2 — it needs no parent-id source at
  //    all: the fresh subtree owns its own identity, spelled in the create data or
  //    generated by the INSERT and handed to its grandchildren as a backward `Ref`.
  //    That is why the create arm's `where`-versus-create-data identity reconciliation
  //    is gone: nothing below it correlates through the selector any more.
  const wherePk = getWhereUniqueEntries(child, where).find(
    (entry) => entry.fieldName === childPrimaryKey
  );
  const updateArmParentId =
    wherePk === undefined
      ? plannedParentId(probeId, childPrimaryKey)
      : literalParentId(wherePk.value);
  const updateChildParts = buildArmChildParts(
    scope,
    child,
    engine,
    updateArmParentId,
    childUpdate.relations,
    "correlated",
    txMode,
    freshArm
  );
  const createSubtree =
    Object.keys(childCreate.relations).length > 0
      ? freshArm({
          childScope: child,
          data: create,
          rootFkInject: (known) =>
            fkAssignData(engine, child, fkFields, referencedFields, {
              parentId,
              relationName,
              known,
            }),
          racePin: childRacePin(child, where),
        })
      : undefined;

  return new RelationUpsertPart(scope, {
    engine,
    childScope: child,
    childName,
    probeId,
    publishesLocatedPk:
      updateArmParentId.kind === "planned" && updateChildParts.length > 0,
    relationName,
    where,
    createData: childCreate.scalarData,
    updateData: childUpdate.scalarData,
    fkFields,
    referencedFields,
    childPrimaryKey,
    parentId,
    correlation,
    txMode,
    family,
    duplicateOfEarlier,
    updateChildParts,
    ...(createSubtree ? { createSubtree } : {}),
  });
}

/**
 * Fold the UPDATE arm's payload relation mutations into deeper parts, against the
 * parent-id value N4-U1 resolved for it: the `where`'s own primary-key literal, or a
 * `planned` read of this child's locate probe when some other unique named the row.
 *
 * The CREATE arm no longer comes here at all (N4-U2). Its row is PRODUCED, not located,
 * so its whole payload — scalars and relations together, at any depth — is a create
 * SUBTREE built through {@link FreshArmBuilder}; a fresh row's relations are the create
 * root's surface, and this builder only ever knew a slice of it. What is left here is
 * the located-target surface, which is bounded by what a part built from THIS module can
 * correlate to a located row: the adopt family (`upsert`, `connectOrCreate`) and a fresh
 * child-held `create` one level deeper. The rest — an m2m edge, a parent-held to-one
 * whose identity folds into the located row's own SET, and the bulk/link/delete
 * families — needs machinery this module cannot import without a cycle
 * (`buildNestedTargetChildParts`, reached through the `nestedBuilder` seam elsewhere),
 * so it stays a typed refusal named for the update arm.
 */
function buildArmChildParts(
  scope: StepScope,
  child: QueryScope,
  engine: QueryEngine,
  parentId: ParentIdSource,
  relations: Record<string, RelationMutation>,
  correlation: UpsertCorrelation,
  txMode: boolean,
  freshArm: FreshArmBuilder
): readonly Part[] {
  const entries = Object.entries(relations);
  if (entries.length === 0) return [];
  const parts: Part[] = [];
  for (const [childRelationName, mutation] of entries) {
    const kinds = getRelationMutationKinds(mutation).join(",");
    if (kinds === "upsert") {
      parts.push(
        ...buildToManyUpsertParts(
          scope,
          child,
          engine,
          childRelationName,
          mutation.relationInfo,
          normalizeUpsertItems(mutation.upsert, childRelationName),
          parentId,
          correlation,
          txMode,
          freshArm,
          "upsert"
        )
      );
      continue;
    }
    if (kinds === "connectOrCreate") {
      parts.push(
        ...buildConnectOrCreateParts(
          scope,
          child,
          engine,
          childRelationName,
          mutation.relationInfo,
          normalizeUpsertItems(mutation.connectOrCreate, childRelationName),
          parentId,
          txMode,
          freshArm
        )
      );
      continue;
    }
    // T3b-2 (family G) / T4a (CLASS VI): a child-held `create` one level deeper is a
    // grandchild INSERT under the row this arm located — its foreign key that row's
    // primary key (a `where` literal, or the probe's captured value under a `planned`
    // source). The INSERT is unconditional: its compile splices onto the taken arm, so
    // it fires only when the row was found.
    if (kinds === "create") {
      parts.push(
        ...buildUpdateArmChildCreateParts(
          scope,
          child,
          engine,
          childRelationName,
          mutation,
          parentId,
          freshArm
        )
      );
      continue;
    }
    throw new UnsupportedOperationError(
      `query-engine-v2 supports only nested upsert/connectOrCreate/create one level deeper on the update arm; relation '${childRelationName}' uses '${kinds}'.`
    );
  }
  return parts;
}

/** An unconditional set of write steps (no planning read, no probe) — a fresh
 *  child-held grandchild INSERT. Its ids and its whole payload shape are fixed at
 *  construction; only the parent foreign key's value is resolved at compile, which is
 *  a literal read-through for a `literal` parent and the located row's column for a
 *  `planned` one (N4-U1). */
class ArmChildCreateParts implements Part {
  private readonly build: (known: PlanningKnown) => readonly OperationStep[];
  constructor(build: (known: PlanningKnown) => readonly OperationStep[]) {
    this.build = build;
  }
  planning(): readonly OperationStep[] {
    return [];
  }
  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    return this.build(known);
  }
}

/**
 * A child-held `create` one level deeper on the UPDATE arm of a connectOrCreate/upsert
 * (T3b-2 mechanism 3, family G; T4a CLASS VI). The enclosing child is the row this arm
 * LOCATED, so the grandchild's foreign key is that row's primary key — a `where`
 * literal, or the probe's captured value under a `planned` source (N4-U1) — and the
 * INSERT is unconditional: its compile splices onto the taken arm.
 *
 * A scalar-only grandchild is one INSERT statement, built at construction with only the
 * parent foreign key's VALUE deferred to compile. A RELATION-CARRYING grandchild is a
 * create SUBTREE (N4-U2), the same {@link FreshArmBuilder} the create arm itself now is:
 * its own parent-held to-one arms, generated primary key, adopt family and m2m all come
 * from the create root instead of the single to-one `connect` this leaf used to tolerate.
 *
 * Two shapes still refuse, and both are about the LOCATED row rather than the fresh one:
 * an m2m grandchild needs a junction correlated to the located target, and a parent-held
 * to-one grandchild needs its identity folded into that target's own SET (child-SET
 * folding). Both live behind builders this module cannot import without a cycle.
 */
function buildUpdateArmChildCreateParts(
  scope: StepScope,
  parentScope: QueryScope,
  engine: QueryEngine,
  relationName: string,
  mutation: RelationMutation,
  parentId: ParentIdSource,
  freshArm: FreshArmBuilder
): readonly Part[] {
  const relationInfo = mutation.relationInfo;
  if (relationInfo.type === "manyToMany") {
    throw new UnsupportedOperationError(
      `query-engine-v2 does not support a nested many-to-many create one level deeper on the update arm of relation '${relationName}'.`
    );
  }
  const fk = getFkDirection(parentScope, relationInfo);
  if (fk.holdsFK) {
    throw new UnsupportedOperationError(
      `query-engine-v2 does not support a parent-held to-one create one level deeper on the update arm of relation '${relationName}'.`
    );
  }
  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  const fkInject = (known: PlanningKnown): Record<string, unknown> =>
    fkAssignData(engine, childScope, fk.fkFields, fk.pkFields, {
      parentId,
      relationName,
      known,
    });
  const scalarItems: { id: string; scalarData: Record<string, unknown> }[] = [];
  const subtrees: Part[] = [];
  for (const create of normalizeUpsertItems(mutation.create, relationName)) {
    const { relations } = separateData(childScope, create);
    if (Object.keys(relations).length > 0) {
      subtrees.push(
        freshArm({ childScope, data: create, rootFkInject: fkInject })
      );
      continue;
    }
    scalarItems.push({
      id: scope.allocate(`${childName}.create`),
      scalarData: separateData(childScope, create).scalarData,
    });
  }
  const parts: Part[] = [];
  if (scalarItems.length > 0) {
    parts.push(
      new ArmChildCreateParts((known) => {
        const inject = fkInject(known);
        return scalarItems.map((item) => ({
          id: item.id,
          kind: "write" as const,
          statement: buildInsert(childScope, getTableName(childScope.model), {
            ...item.scalarData,
            ...inject,
          }),
          outputs: {},
        }));
      })
    );
  }
  parts.push(...subtrees);
  return parts;
}

/** `unknown -> Record` narrowings, NOT shape checks (N7-U-A). The upsert / connectOrCreate
 *  arms and their `where` / `create` / `update` slots are validated by the enclosing
 *  whole-args parse (`ValidationError: Expected object`) before any Part is built; a
 *  non-record reaching either narrowing is an engine invariant break — the X1c
 *  disposition, not a route. */
function normalizeUpsertItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
        `query-engine-v2 internal: an upsert item for relation '${relation}' must be an object after the parse boundary validated the payload.`
      );
    }
    return item;
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(
    `query-engine-v2 internal: '${label}' must be an object after the parse boundary validated the payload.`
  );
}
