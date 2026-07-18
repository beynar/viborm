// biome-ignore-all lint/style/useFilenamingConvention: RelationUpsertPart is the architecture name.
import { NestedWriteError } from "@errors";
import type { Sql } from "@sql";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getTableName } from "../query-engine/context/query-scope";
import { buildFindUnique, buildUpdate } from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope } from "../query-engine/types";
import {
  affectedRows,
  childRacePin,
  existsGuard,
  referenceSql,
} from "./fragment-builders";
import { validateProbe } from "./FragmentValidator";
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

/**
 * Where the parent id the child FK points at comes from — a first-class value,
 * never the parent object (WHY §4.2). `ref` = the parent write produces it in
 * the same final fragment (create context). `planned` = it was located by a
 * planning read and is inlined as a literal at compile (update-by-unique
 * context; a final-fragment step may not ref a planning step — ATOM §9 inv. 2).
 */
export type ParentIdSource =
  | { readonly kind: "ref"; readonly ref: OperationValueReference }
  | { readonly kind: "planned"; readonly readStep: string; readonly field: string };

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
}

/**
 * The to-many nested-upsert child part (README §5's earned `RelationUpsert`
 * module — two operations now compose it). It contributes one widened probe at
 * planning (ATOM §3 technique 2: one unconditional child read including its FK)
 * and, at compile, constructs exactly one taken arm:
 *
 * - absent → CREATE arm (fk = parent, unique-constraint + `racePin`, no guard);
 * - found + adopt/correlated → UPDATE arm (reparent-and-update / update);
 * - found + uncorrelated (correlated mode only) → typed V7001 throw.
 *
 * It holds no parent — only a `ParentIdSource` value and its FK metadata.
 */
export class RelationUpsertPart implements Part {
  readonly probe: Probe;
  private readonly config: RelationUpsertConfig;
  private readonly probeId: string;
  private readonly createId: string;
  private readonly updateId: string;
  private readonly guardId: string;
  private readonly find: StatementStep;

  constructor(scope: StepScope, config: RelationUpsertConfig) {
    this.config = config;
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

  planning(_scope: StepScope): readonly OperationStep[] {
    return [this.find];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const rows = known[this.probeRowsKey()];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 upsert probe for relation '${this.config.relationName}' did not expose rows.`,
        this.config.relationName
      );
    }
    const arm = this.decide(rows, known);
    if (arm === "create") {
      return [this.buildCreateArm(known)];
    }
    // Found: adopt-and-update (global) or update the correlated child. In batch
    // mode the found premise is pinned first by the exists guard.
    const steps: OperationStep[] = [];
    if (this.probe.pin.whenFound !== "none") {
      steps.push(this.probe.pin.whenFound);
    }
    steps.push(this.buildUpdateArm(known));
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
    const parentId = this.resolvePlannedParentId(known);
    const row = rows[0];
    const childFk =
      row && typeof row === "object"
        ? (row as Record<string, unknown>)[this.config.childForeignKey]
        : undefined;
    if (fkEquals(childFk, parentId)) return "found";
    throw new NestedWriteError(
      `Cannot upsert relation '${this.config.relationName}': target record was not found for this parent.`,
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
        message: `Nested upsert target for relation '${relationName}' vanished before its update.`,
        relation: relationName,
        raceable: false,
      }),
    };
  }

  /**
   * The FK the child arms write, as one cast SQL expression: a `Ref` to the
   * parent create (create context) or the located parent id inlined as a
   * literal (update-by-unique context). Both ride in `Sql.values`, so the
   * create INSERT and the update SET consume it identically.
   */
  private parentIdValue(known: PlanningKnown): Sql {
    const source = this.config.parentId;
    const value =
      source.kind === "ref" ? source.ref : this.resolvePlannedParentId(known);
    return referenceSql(
      this.config.engine,
      this.config.childScope.model,
      this.config.childForeignKey,
      value
    );
  }

  private resolvePlannedParentId(known: PlanningKnown): unknown {
    const source = this.config.parentId;
    if (source.kind !== "planned") {
      throw new NestedWriteError(
        `query-engine-v2 correlated upsert for relation '${this.config.relationName}' requires a planned parent id.`,
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
