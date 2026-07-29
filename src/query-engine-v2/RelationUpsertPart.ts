// biome-ignore-all lint/style/useFilenamingConvention: RelationUpsertPart is the architecture name.
import { NestedWriteError } from "@errors";
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
import { buildFindUnique, buildUpdate } from "../query-engine/operations";
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
import {
  type OperationStep,
  type OperationValueReference,
  type Probe,
  ref,
  type StatementStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import { referencedFieldValue } from "./parent-reference";
import type { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  UnsupportedOperationError,
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
   * Depth on the CREATE arm (ATOM §8.1's P1 deferral, come due in P2b): nested
   * parts contributed by this child's CREATE payload, emitted only when the
   * absent → CREATE arm fires. The child is then fresh, so — the elision rule of
   * ATOM §4 — a correlated probe under it is statically empty; these parts adopt
   * globally, and their parent id is this child's own (compile-time literal) PK.
   * Empty unless the create payload carries FK-edge relation mutations.
   */
  readonly createChildParts?: readonly Part[];
}

/**
 * The to-many nested-upsert child part (README §5's earned `RelationUpsert`
 * module — two operations now compose it, recursively). It contributes one
 * widened probe at planning (ATOM §3 technique 2: one unconditional child read
 * including its FK) plus its update-arm children's probes, and, at compile,
 * constructs exactly one taken arm:
 *
 * - absent → CREATE arm (fk = parent, unique-constraint + `racePin`, no guard);
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
  private readonly createChildParts: readonly Part[];
  private readonly family: UpsertFamily;
  private readonly duplicateOfEarlier: boolean;

  constructor(scope: StepScope, config: RelationUpsertConfig) {
    this.config = config;
    this.family = config.family ?? "upsert";
    this.updateChildParts = config.updateChildParts ?? [];
    this.createChildParts = config.createChildParts ?? [];
    this.duplicateOfEarlier = config.duplicateOfEarlier ?? false;
    const { childScope, childName, where, txMode, relationName } = config;
    this.probeId = config.probeId;
    this.createId = scope.allocate(`${childName}.create`);
    this.updateId = scope.allocate(`${childName}.update`);
    this.guardId = scope.allocate(`${childName}.guard.exists`);

    // Widened probe (ATOM §3 technique 2): read the child by its own unique key,
    // including every FK column, so compile can decide the three-way. Locked in
    // tx mode.
    const identitySelect: Record<string, boolean> = {
      [config.childPrimaryKey]: true,
    };
    for (const fkField of config.fkFields) identitySelect[fkField] = true;
    this.find = {
      id: this.probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where,
        select: identitySelect,
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
    const foundGuardStatement = buildFindUnique(childScope, {
      where,
      select: identitySelect,
    });
    const foundPin = txMode
      ? ("none" as const)
      : this.family === "connectOrCreate"
        ? presenceGuard(
            this.guardId,
            foundGuardStatement,
            nestedWriteFailure(
              nestedReplacement("connectOrCreate"),
              relationName
            )
          )
        : existsGuard(this.guardId, foundGuardStatement, relationName);
    this.probe = {
      read: this.find,
      pin: { whenFound: foundPin, whenMissing: "constraint" },
    };
    validateProbe(this.probe);
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
    for (const child of this.createChildParts) {
      steps.push(...child.planning(scope));
    }
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
      return [this.buildUpdateArm(known)];
    }
    if (arm === "create") {
      // Create arm: this child is fresh. Its update-arm children do not run
      // (nested writes in an UPDATE payload apply only when the row is found);
      // its create-arm children DO — spliced after the insert, adopting globally
      // and correlated to this fresh child's (compile-time literal) PK. The
      // fresh-parent elision (ATOM §4) makes any correlation under it empty, so
      // they never need a produced value from the insert.
      const createSteps: OperationStep[] = [this.buildCreateArm(known)];
      for (const child of this.createChildParts) {
        createSteps.push(...child.compile(scope, known));
      }
      return createSteps;
    }
    // Found: adopt-and-update (global) or update the correlated child. In batch
    // mode the found premise is pinned first by the exists guard. The update-arm
    // children then compile one level deeper, correlated to this child's PK.
    const steps: OperationStep[] = [];
    if (this.probe.pin.whenFound !== "none") {
      steps.push(this.probe.pin.whenFound);
    }
    steps.push(this.buildUpdateArm(known));
    for (const child of this.updateChildParts) {
      steps.push(...child.compile(scope, known));
    }
    return steps;
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
    const row = rows[0];
    const record =
      row && typeof row === "object"
        ? (row as Record<string, unknown>)
        : undefined;
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

  private buildUpdateArm(known: PlanningKnown): StatementStep {
    const { childScope, where, txMode, relationName } = this.config;
    const identitySelect: Record<string, boolean> = {
      [this.config.childPrimaryKey]: true,
    };
    for (const fkField of this.config.fkFields) identitySelect[fkField] = true;
    const step: StatementStep = {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(childScope, {
        where,
        data: {
          ...this.config.updateData,
          // global-adopt reparents to the new parent; correlated re-sets the
          // same value (idempotent). Both land the FK the terminal read expects.
          ...this.fkAssignData(known),
        },
        select: identitySelect,
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

  /**
   * The FK columns the child arms write, each a cast SQL expression: a `Ref` to
   * the parent create (create context, single-field), the located parent id
   * inlined as a literal (update-by-unique context), or a compile-time literal
   * (depth-composed grandchild). All ride in `Sql.values`, so the create INSERT
   * and the update SET consume them identically. One entry per compound-key
   * field (ATOM §1).
   */
  private fkAssignData(known: PlanningKnown): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (let index = 0; index < this.config.fkFields.length; index += 1) {
      const fkField = this.config.fkFields[index]!;
      data[fkField] = referenceSql(
        this.config.engine,
        this.config.childScope.model,
        fkField,
        this.fkValueAt(index, known)
      );
    }
    return data;
  }

  /** The value the child FK column at `index` is assigned: a symbolic `Ref` in
   *  the create context (single-field), else the referenced parent column value
   *  inlined at compile. */
  private fkValueAt(index: number, known: PlanningKnown): unknown {
    const source = this.config.parentId;
    if (source.kind === "ref") return source.ref;
    return this.parentReferenced(known, index);
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

export function refParentId(step: string): ParentIdSource {
  return { kind: "ref", ref: ref(step, "id") };
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
      // Outside V2's narrow door but within V1's — an UnsupportedOperationError so
      // the whole tree routes to V1 (shared.ts routing contract), never a bare
      // QueryEngineError that hard-fails a shape V1 supports.
      throw new UnsupportedOperationError(
        `query-engine-v2 supports only one-to-many nested ${family}; received '${relationName}'.`
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
  txMode: boolean
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
  family: UpsertFamily,
  duplicateOfEarlier = false
): RelationUpsertPart {
  const fk = getFkDirection(parentScope, relationInfo);
  if (fk.holdsFK || fk.fkFields.length !== fk.pkFields.length) {
    // The child must hold the foreign key referencing the parent (one column, or
    // an index-aligned compound key — ATOM §1's per-field precedent). A
    // parent-held FK is a same-row change, V1's surface: route the tree. The
    // referenced parent columns are exposed by the caller's locate read (the
    // `planned` parent id), which is what makes the compile-time literal read
    // resolve; that contract is UpdateOperation's, enforced there.
    throw new UnsupportedOperationError(
      `Relation '${relationName}' must expose a child-held foreign key referencing the parent.`
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
  // T3c (family H): V1 does NOT require the nested create's identity to match the
  // `where` — its absent arm inserts `input.create` verbatim and pins the missing
  // premise on `input.where` (RelationBranches.compileOneUpsert), so a found arm
  // (the row exists) never touches `create` and a `create.id ≠ where.id` is legal.
  // V2's create arm inserts `create` too; the ONLY place the created row's identity
  // must equal the `where` PK is when the create arm folds GRANDCHILDREN — they
  // correlate to the fresh row through `where`'s PK entry (buildArmChildParts), so a
  // mismatch would strand them. Gate the check on that: a scalar (grandchild-free)
  // create arm with a divergent identity now runs natively, matching V1.
  if (Object.keys(childCreate.relations).length > 0) {
    assertMatchingCreateIdentity(
      child,
      where,
      childCreate.scalarData,
      relationName
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

  // Depth on the found+update arm (correlated grandchildren) and on the fresh
  // create arm (globally-adopting grandchildren, ATOM §4's elision). Both fold into
  // the same linear fragment. Where the grandchild foreign key's value comes from
  // differs by ARM, because what the two arms know about this child differs:
  //
  //  · the UPDATE arm acts on the row the probe FOUND, so — N4-U1 — the primary key
  //    is either the `where`'s own literal or a `planned` read of that probe. A
  //    non-primary-key unique (`where: { slug }`) no longer refuses: it locates.
  //  · the CREATE arm inserts a FRESH row; there is no located row to read, so the
  //    identity must be in the payload — the `where`'s primary key, or (when some
  //    other unique named the row) the create data's own primary key, which
  //    `assertMatchingCreateIdentity` has already reconciled with the `where`. A
  //    DATABASE-GENERATED key on a relation-carrying create arm stays a typed
  //    refusal: nothing in the plan knows it before the INSERT runs.
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
    "update"
  );
  const createChildParts = buildArmChildParts(
    scope,
    child,
    engine,
    createArmParentId(
      child,
      where,
      childCreate.scalarData,
      childPrimaryKey,
      relationName,
      Object.keys(childCreate.relations).length > 0
    ),
    childCreate.relations,
    "global-adopt",
    txMode,
    "create"
  );

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
    createChildParts,
  });
}

/**
 * The CREATE arm's parent-id source for its grandchildren (N4-U1). The row this arm
 * inserts is fresh, so its identity has to be spelled in the payload: the `where`'s
 * own primary key when it names one, otherwise the create data's — which
 * {@link assertMatchingCreateIdentity} has already forced to agree with whatever
 * unique the `where` did name. A relation-free create arm needs no identity at all
 * (nothing folds under it), so the refusal fires only when grandchildren exist.
 */
function createArmParentId(
  child: QueryScope,
  where: Record<string, unknown>,
  createScalarData: Record<string, unknown>,
  childPrimaryKey: string,
  relationName: string,
  hasGrandchildren: boolean
): ParentIdSource {
  const wherePk = getWhereUniqueEntries(child, where).find(
    (entry) => entry.fieldName === childPrimaryKey
  );
  if (wherePk !== undefined) return literalParentId(wherePk.value);
  const createPk = createScalarData[childPrimaryKey];
  if (createPk !== undefined && createPk !== null) {
    return literalParentId(createPk);
  }
  if (!hasGrandchildren) return literalParentId(undefined);
  throw new UnsupportedOperationError(
    `Relation '${relationName}' carries nested relation mutations in its upsert create arm; the fresh target's primary key '${childPrimaryKey}' must be in the where or the create data (a database-generated key is not known before the insert runs).`
  );
}

/**
 * Fold one arm's payload relation mutations into deeper parts, against the parent-id
 * value the caller resolved for that arm ({@link createArmParentId} for the create
 * arm; the `where` literal or a `planned` read of this child's own locate probe for
 * the update arm — N4-U1). The `arm` bounds what is legal one level deeper: the
 * update arm takes the correlated adopt family (`upsert`, `connectOrCreate`); the
 * create arm — a fresh child, ATOM §4's elision — takes only `connectOrCreate`
 * (V1's runtime rejects a nested `upsert` under a create payload as
 * found-uncorrelated, so V2 does not silently diverge by adopting there).
 * `connectOrCreate` is always `global-adopt`; a nested `upsert` uses `correlation`.
 */
function buildArmChildParts(
  scope: StepScope,
  child: QueryScope,
  engine: QueryEngine,
  parentId: ParentIdSource,
  relations: Record<string, RelationMutation>,
  correlation: UpsertCorrelation,
  txMode: boolean,
  arm: "create" | "update"
): readonly Part[] {
  const entries = Object.entries(relations);
  if (entries.length === 0) return [];
  const parts: Part[] = [];
  for (const [childRelationName, mutation] of entries) {
    const kinds = getRelationMutationKinds(mutation).join(",");
    if (kinds === "upsert" && arm === "update") {
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
          txMode
        )
      );
      continue;
    }
    // T3b-2 (family G) / T4a (CLASS VI): a child-held `create` one level deeper is a
    // grandchild INSERT under this child, correlated to the child's compile-time literal
    // PK. It is direction-based, not arm-dependent: on the CREATE arm the child is fresh
    // (ATOM §4 elision), on the UPDATE arm it is the found+correlated row — either way the
    // grandchild FK is that literal PK and the INSERT is unconditional (its compile splices
    // onto the taken arm, so the update-arm grandchild fires only when the row is found).
    // Mirrors V1's accepted depth exactly: the grandchild's own data may fold a parent-held
    // to-one `connect` (its FK a compile-time literal), nothing more; anything deeper routes
    // to V1.
    if (kinds === "create") {
      parts.push(
        ...buildCreateArmChildCreateParts(
          scope,
          child,
          engine,
          childRelationName,
          mutation,
          parentId
        )
      );
      continue;
    }
    // NB: a child-held `create` is accepted on BOTH arms (handled above); this message —
    // surfaced only for a still-unsupported kind — keeps its pre-T3b-2 wording
    // byte-identical (the "connectOrCreate" list is the leading accepted kind, not an
    // exhaustive enumeration).
    throw new UnsupportedOperationError(
      `query-engine-v2 supports only nested ${arm === "create" ? "connectOrCreate" : "upsert/connectOrCreate"} one level deeper on the ${arm} arm; relation '${childRelationName}' uses '${kinds}'.`
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
 * A child-held `create` one level deeper on either arm of a connectOrCreate/upsert
 * (T3b-2 mechanism 3, family G, CREATE arm; T4a CLASS VI, UPDATE arm). The enclosing
 * child is located by its PK — a compile-time literal `parentId` (a fresh row's own PK on
 * the create arm, the found+correlated row's PK on the update arm) — so the grandchild is
 * an unconditional INSERT: its parent FK is that literal, and its own data may fold a
 * parent-held to-one `connect` (its FK the connect's literal referenced value). A m2m
 * grandchild, a parent-held-to-one grandchild create, or any deeper nested write beyond a
 * single to-one connect routes to V1.
 */
function buildCreateArmChildCreateParts(
  scope: StepScope,
  parentScope: QueryScope,
  engine: QueryEngine,
  relationName: string,
  mutation: RelationMutation,
  parentId: ParentIdSource
): readonly Part[] {
  const relationInfo = mutation.relationInfo;
  if (relationInfo.type === "manyToMany") {
    throw new UnsupportedOperationError(
      `query-engine-v2 does not support a nested many-to-many create one level deeper on the create arm of relation '${relationName}'.`
    );
  }
  const fk = getFkDirection(parentScope, relationInfo);
  if (fk.holdsFK) {
    throw new UnsupportedOperationError(
      `query-engine-v2 does not support a parent-held to-one create one level deeper on the create arm of relation '${relationName}'.`
    );
  }
  const childScope = createQueryScope(engine.adapter, relationInfo.targetModel);
  const childName = getStepModelName(relationInfo.targetModel, relationName);
  // Every payload decision — the scalar/relation split, the single parent-held to-one
  // connect this leaf tolerates, the step ids — is made at CONSTRUCTION, before any
  // I/O, exactly as before. Only the parent FK's VALUE is resolved later, because
  // under a `planned` source (N4-U1: an update arm whose target some NON-primary-key
  // unique named) it lives in the row this part's own probe located, which planning
  // has not run yet. A `literal` source ignores `known` and yields the same statement
  // it always did.
  const items = normalizeUpsertItems(mutation.create, relationName).map(
    (create) => {
      const { scalarData, relations } = separateData(childScope, create);
      const connectInject: Record<string, unknown> = {};
      for (const [childRelation, childMutation] of Object.entries(relations)) {
        foldParentHeldConnect(
          engine,
          childScope,
          childRelation,
          childMutation,
          connectInject
        );
      }
      return {
        id: scope.allocate(`${childName}.create`),
        scalarData,
        connectInject,
      };
    }
  );
  return [
    new ArmChildCreateParts((known) =>
      items.map((item) => {
        const inject: Record<string, unknown> = {};
        for (let index = 0; index < fk.fkFields.length; index += 1) {
          inject[fk.fkFields[index]!] = referenceSql(
            engine,
            childScope.model,
            fk.fkFields[index]!,
            referencedFieldValue(
              parentId,
              fk.pkFields[index]!,
              known,
              relationName,
              "create"
            )
          );
        }
        return {
          id: item.id,
          kind: "write" as const,
          statement: buildInsert(childScope, getTableName(childScope.model), {
            ...item.scalarData,
            ...inject,
            ...item.connectInject,
          }),
          outputs: {},
        };
      })
    ),
  ];
}

/** Fold a single parent-held to-one `connect` into a grandchild INSERT's columns —
 *  its FK is the connect's referenced value (a compile-time literal). Any other kind,
 *  a child-held relation, or a non-literal locator routes the whole tree to V1. */
function foldParentHeldConnect(
  engine: QueryEngine,
  childScope: QueryScope,
  relationName: string,
  mutation: RelationMutation,
  inject: Record<string, unknown>
): void {
  const relationInfo = mutation.relationInfo;
  const fk = getFkDirection(childScope, relationInfo);
  const kinds = getRelationMutationKinds(mutation);
  if (!(fk.holdsFK && kinds.length === 1 && kinds[0] === "connect")) {
    throw new UnsupportedOperationError(
      `query-engine-v2 supports only a nested parent-held to-one connect one level deeper on a create-arm nested create; relation '${relationName}' uses '${kinds.join(", ") || "none"}'.`
    );
  }
  const raw = (mutation as unknown as { connect: unknown }).connect;
  const where = Array.isArray(raw) ? raw[0] : raw;
  if (!(where && typeof where === "object")) {
    throw new UnsupportedOperationError(
      `query-engine-v2 nested connect on relation '${relationName}' requires a where object one level deeper.`
    );
  }
  const targetScope = createQueryScope(
    engine.adapter,
    relationInfo.targetModel
  );
  const entries = getWhereUniqueEntries(
    targetScope,
    where as Record<string, unknown>
  );
  for (let index = 0; index < fk.fkFields.length; index += 1) {
    const entry = entries.find(
      (candidate) => candidate.fieldName === fk.pkFields[index]!
    );
    if (entry === undefined) {
      throw new UnsupportedOperationError(
        `query-engine-v2 nested connect on relation '${relationName}' must locate the target by its referenced key '${fk.pkFields[index]!}' one level deeper.`
      );
    }
    inject[fk.fkFields[index]!] = referenceSql(
      engine,
      childScope.model,
      fk.fkFields[index]!,
      entry.value
    );
  }
}

function normalizeUpsertItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new UnsupportedOperationError(
        `Relation '${relation}' upsert item must be an object.`
      );
    }
    return item;
  });
}

function assertMatchingCreateIdentity(
  child: QueryScope,
  where: Record<string, unknown>,
  create: Record<string, unknown>,
  relation: string
): void {
  for (const { fieldName, value } of getWhereUniqueEntries(child, where)) {
    if (
      !(Object.hasOwn(create, fieldName) && Object.is(create[fieldName], value))
    ) {
      throw new UnsupportedOperationError(
        `Relation '${relation}' requires nested create field '${fieldName}' to match its unique where value.`
      );
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}
