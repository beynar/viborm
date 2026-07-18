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
import { buildFindUnique, buildUpdate } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import { validateProbe } from "./FragmentValidator";
import {
  affectedRows,
  childRacePin,
  existsGuard,
  referenceSql,
} from "./fragment-builders";
import {
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
import type { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";

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

export interface RelationUpsertConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly where: Record<string, unknown>;
  readonly createData: Readonly<Record<string, unknown>>;
  readonly updateData: Readonly<Record<string, unknown>>;
  readonly childForeignKey: string;
  readonly childPrimaryKey: string;
  readonly parentId: ParentIdSource;
  readonly correlation: UpsertCorrelation;
  readonly txMode: boolean;
  /**
   * Depth: nested upsert parts contributed by this child's UPDATE payload. They
   * are emitted only on this part's found+correlated (update) arm — the same
   * linear fragment, one level deeper (README §5, ATOM §6). This part holds its
   * children (by FK direction), never its parent (WHY §4.2). Empty at depth 1.
   */
  readonly updateChildParts?: readonly Part[];
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

  constructor(scope: StepScope, config: RelationUpsertConfig) {
    this.config = config;
    this.updateChildParts = config.updateChildParts ?? [];
    const { childScope, childName, where, txMode, relationName } = config;
    this.probeId = scope.allocate(`${childName}.find`);
    this.createId = scope.allocate(`${childName}.create`);
    this.updateId = scope.allocate(`${childName}.update`);
    this.guardId = scope.allocate(`${childName}.guard.exists`);

    // Widened probe (ATOM §3 technique 2): read the child by its own unique key,
    // including its FK, so compile can decide the three-way. Locked in tx mode.
    const identitySelect = {
      [config.childPrimaryKey]: true,
      [config.childForeignKey]: true,
    };
    this.find = {
      id: this.probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where,
        select: identitySelect,
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };

    // The probe pairs its read with the premise its decision creates (ATOM §2).
    // Found premise: pinned by the exists guard in batch mode (raceable: false),
    // by the lock in tx mode. Missing premise: enforced by the child's unique
    // constraint (the racePin on the create write), never a notExists guard.
    const foundPin = txMode
      ? ("none" as const)
      : existsGuard(
          this.guardId,
          buildFindUnique(childScope, { where, select: identitySelect }),
          relationName
        );
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
    // Planning is unconditional: this part's probe plus every update-arm child's
    // probe run before any write, so `compile` has all three-way inputs in
    // `known` regardless of which arm each level later takes.
    const steps: OperationStep[] = [this.find];
    for (const child of this.updateChildParts) {
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
    if (arm === "create") {
      // Create arm: this child is fresh, so its update-arm children do not run
      // (nested writes in an UPDATE payload apply only when the row is found).
      return [this.buildCreateArm(known)];
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
    const parentId = this.resolveParentId(known);
    const row = rows[0];
    const childFk =
      row && typeof row === "object"
        ? (row as Record<string, unknown>)[this.config.childForeignKey]
        : undefined;
    if (fkEquals(childFk, parentId)) return "found";
    throw new NestedWriteError(
      upsertTargetNotFoundForParent(this.config.relationName),
      this.config.relationName
    );
  }

  private buildCreateArm(known: PlanningKnown): StatementStep {
    const { childScope, childForeignKey, where } = this.config;
    return {
      id: this.createId,
      kind: "write",
      statement: buildInsert(childScope, getTableName(childScope.model), {
        ...this.config.createData,
        [childForeignKey]: this.parentIdValue(known),
      }),
      outputs: {},
      // The missing premise is enforced by the child's unique constraint; its
      // violation is the raceable signal, matched against this pinned target.
      racePin: childRacePin(childScope, where),
    };
  }

  private buildUpdateArm(known: PlanningKnown): StatementStep {
    const { childScope, childForeignKey, where, txMode, relationName } =
      this.config;
    const identitySelect = {
      [this.config.childPrimaryKey]: true,
      [childForeignKey]: true,
    };
    const step: StatementStep = {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(childScope, {
        where,
        data: {
          ...this.config.updateData,
          // global-adopt reparents to the new parent; correlated re-sets the
          // same value (idempotent). Both land the FK the terminal read expects.
          [childForeignKey]: this.parentIdValue(known),
        },
        select: identitySelect,
      }),
      outputs: {},
    };
    if (!txMode) return step;
    // The found premise is pinned (locked probe / exists guard); an
    // affected-row miss here is a not-found, never a race.
    return {
      ...step,
      expects: affectedRows(1, {
        kind: "notFound",
        message: upsertTargetVanished(relationName),
        relation: relationName,
        raceable: false,
      }),
    };
  }

  /**
   * The FK the child arms write, as one cast SQL expression: a `Ref` to the
   * parent create (create context), the located parent id inlined as a literal
   * (update-by-unique context), or a compile-time literal (depth-composed
   * grandchild). All ride in `Sql.values`, so the create INSERT and the update
   * SET consume it identically.
   */
  private parentIdValue(known: PlanningKnown): Sql {
    const source = this.config.parentId;
    const value =
      source.kind === "ref" ? source.ref : this.resolveParentId(known);
    return referenceSql(
      this.config.engine,
      this.config.childScope.model,
      this.config.childForeignKey,
      value
    );
  }

  /** The concrete parent id for the correlated/literal arms (never a `ref`). */
  private resolveParentId(known: PlanningKnown): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned") {
      throw new NestedWriteError(
        `query-engine-v2 correlated upsert for relation '${this.config.relationName}' requires a planned or literal parent id.`,
        this.config.relationName
      );
    }
    const rows = known[planningKey(source.readStep, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 correlated upsert for relation '${this.config.relationName}' could not resolve its parent id.`,
        this.config.relationName
      );
    }
    return (row as Record<string, unknown>)[source.field];
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
  parentPrimaryKey: string,
  correlation: UpsertCorrelation,
  txMode: boolean
): RelationUpsertPart[] {
  if (relationInfo.type !== "oneToMany") {
    throw new QueryEngineError(
      `query-engine-v2 supports only one-to-many nested upsert; received '${relationName}'.`
    );
  }
  return items.map((item) =>
    buildOneUpsertPart(
      scope,
      parentScope,
      engine,
      relationName,
      relationInfo,
      item,
      parentId,
      parentPrimaryKey,
      correlation,
      txMode
    )
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
  parentPrimaryKey: string,
  correlation: UpsertCorrelation,
  txMode: boolean
): RelationUpsertPart {
  const fk = getFkDirection(parentScope, relationInfo);
  if (
    fk.holdsFK ||
    fk.fkFields.length !== 1 ||
    fk.pkFields.length !== 1 ||
    fk.pkFields[0] !== parentPrimaryKey
  ) {
    // The child must hold one FK referencing the parent's primary key — the key
    // the parent-id value (`planned`/`literal`/`ref`) actually carries.
    throw new QueryEngineError(
      `Relation '${relationName}' must expose one child-held foreign key referencing the parent primary key.`
    );
  }
  const childForeignKey = fk.fkFields[0]!;
  const child = createQueryScope(engine.adapter, relationInfo.targetModel);
  const where = requireRecord(item.where, `${relationName}.upsert.where`);
  const create = requireRecord(item.create, `${relationName}.upsert.create`);
  const update = requireRecord(item.update, `${relationName}.upsert.update`);
  const childCreate = separateData(child, create);
  const childUpdate = separateData(child, update);
  if (Object.keys(childCreate.relations).length > 0) {
    // Create-arm nested writes run under a fresh child (no correlation exists
    // yet — the elision case, ATOM §4). Deferred to P2 with the rest of the
    // fresh-parent adopt family; P1 composes depth on the found+correlated arm.
    throw new QueryEngineError(
      `Relation '${relationName}' does not support nested relation mutations in its create payload in query-engine-v2 (nest under update).`
    );
  }
  if (
    Object.hasOwn(childCreate.scalarData, childForeignKey) ||
    Object.hasOwn(childUpdate.scalarData, childForeignKey)
  ) {
    throw new QueryEngineError(
      `Relation '${relationName}' owns '${childForeignKey}'; omit it from nested create and update data.`
    );
  }
  assertMatchingCreateIdentity(
    child,
    where,
    childCreate.scalarData,
    relationName
  );
  const childPrimaryKeys = getPrimaryKeyFields(child.model);
  if (childPrimaryKeys.length !== 1) {
    throw new QueryEngineError(
      `Relation '${relationName}' requires a child with one primary key.`
    );
  }
  const childPrimaryKey = childPrimaryKeys[0]!;

  const updateChildParts = buildUpdateArmChildParts(
    scope,
    child,
    engine,
    relationName,
    childPrimaryKey,
    where,
    childUpdate.relations,
    txMode
  );

  return new RelationUpsertPart(scope, {
    engine,
    childScope: child,
    childName: getStepModelName(relationInfo.targetModel, relationName),
    relationName,
    where,
    createData: childCreate.scalarData,
    updateData: childUpdate.scalarData,
    childForeignKey,
    childPrimaryKey,
    parentId,
    correlation,
    txMode,
    updateChildParts,
  });
}

/**
 * Fold this child's UPDATE-payload upsert relations into deeper parts. Their
 * parent id is this child's own PK — a compile-time literal — so this child must
 * be located by its primary key (its PK is neither produced by a probe nor an
 * insert). That constraint is what keeps depth linear: the grandchild's FK is a
 * known value, not an arm-dependent one.
 */
function buildUpdateArmChildParts(
  scope: StepScope,
  child: QueryScope,
  engine: QueryEngine,
  relationName: string,
  childPrimaryKey: string,
  where: Record<string, unknown>,
  relations: Record<string, RelationMutation>,
  txMode: boolean
): readonly Part[] {
  const entries = Object.entries(relations);
  if (entries.length === 0) return [];
  const pkEntry = getWhereUniqueEntries(child, where).find(
    (entry) => entry.fieldName === childPrimaryKey
  );
  if (pkEntry === undefined) {
    throw new QueryEngineError(
      `Relation '${relationName}' carries nested relation mutations; its upsert must locate the child by its primary key '${childPrimaryKey}' so the deeper foreign key is a known value.`
    );
  }
  const parts: Part[] = [];
  for (const [childRelationName, mutation] of entries) {
    if (getRelationMutationKinds(mutation).join(",") !== "upsert") {
      throw new QueryEngineError(
        `query-engine-v2 supports only nested upsert one level deeper; relation '${childRelationName}' uses '${getRelationMutationKinds(mutation).join(",")}'.`
      );
    }
    parts.push(
      ...buildToManyUpsertParts(
        scope,
        child,
        engine,
        childRelationName,
        mutation.relationInfo,
        normalizeUpsertItems(mutation.upsert, childRelationName),
        literalParentId(pkEntry.value),
        childPrimaryKey,
        "correlated",
        txMode
      )
    );
  }
  return parts;
}

function normalizeUpsertItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
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
      throw new QueryEngineError(
        `Relation '${relation}' requires nested create field '${fieldName}' to match its unique where value.`
      );
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new QueryEngineError(`'${label}' must be an object.`);
}
