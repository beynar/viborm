/**
 * E — the packer (pattern-engine-ideal-state.md §7, §8.1, §13.3 unit E).
 *
 * Cell groups (already decided by the scheduler) become statements through the
 * EXISTING adapter methods and lowering helpers: `buildFindUnique` / `buildFind`
 * for matches, `buildUpdate` / `buildInsert` / `buildDelete` / the bulk builders
 * for row asserts and retracts, `JunctionStatements` for reference rows,
 * `referenceSql` for reference cells, `compileBindBudgetChunks` for the bulk
 * fold, `buildMutationProjectionFold` for the returning-dialect create folds.
 * Premises become the batch guards the current Parts emit; where the pinned
 * guard is not the match re-run the premise carries it explicitly (§8 review).
 *
 * The packer's one table is {@link Packing.edgeOf}: which row holds the
 * reference (the parent, the target, or a reference row of its own). Every
 * statement shape below is keyed by that storage fact plus what the row does
 * (matches, asserts, retracts, at a fresh or a bound key). `Row.verb` is read
 * for LABELS and MESSAGES only, as K1 permits.
 *
 * Every refusal here is a packing-time refusal (§7.4): it runs after legality
 * and keeps today's class and message.
 */
import { getAdapterInternals } from "@adapters/adapter-internals";
import { NestedWriteError, NotFoundError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { getColumnName, getTableName } from "@schema/model";
import { isSql, type Sql } from "@sql";
import { compileBindBudgetChunks } from "../bind-budget";
import {
  buildPolymorphicMembershipPredicate,
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import {
  bindMemberJunction,
  bindRelation,
  buildConnectSubqueryForField,
  hasPolymorphicMembership,
  type JunctionBoundRelation,
} from "../builders/relation-data-builder";
import { buildInsert } from "../builders/values-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  lookupRelation,
  memberRef,
  resolvedSlot,
  variantCarrier,
} from "../context/query-scope";
import { JunctionStatements } from "../JunctionStatements";
import {
  buildCreate,
  buildCreateManyPlan,
  buildDelete,
  buildDeleteMany,
  buildFind,
  buildFindUnique,
  buildInsertStatement,
  buildUpdate,
  buildUpdateMany,
  buildUpdateStatement,
  buildUpsert,
  compileMutationDependencyFold,
} from "../operations";
import type { QueryEngine } from "../query-engine";
import type { QueryScope, RelationRef } from "../types";
import { createRacePin } from "../write-engine/create-race-pin";
import {
  affectedRows,
  exactlyOneRow,
  nestedWriteFailure,
  notFoundFailure,
  presenceGuard,
  queryFailure,
  referenceScalarSql,
  referenceSql,
} from "../write-engine/fragment-builders";
import { linkGroupSelector } from "../write-engine/link-target-groups";
import {
  nestedReplacement,
  relationTargetNotFound,
  upsertPremiseChanged,
} from "../write-engine/messages";
import {
  type Failure,
  type GuardStep,
  type OperationStep,
  type OperationValueReference,
  ref,
  type StatementOutputSource,
  type StatementStep,
  type WriteStep,
} from "../write-engine/OperationFragment";
import type { PlanningKnown } from "../write-engine/Part";
import { planningKey } from "../write-engine/Part";
import { parseCapturedRows } from "../write-engine/series-result-read";
import {
  capturedSelectorWhere,
  getStepModelName,
  projectionReadsAnyTable,
  projectionReadsMutatedModel,
  setCanFireReferentialAction,
} from "../write-engine/shared";
import type {
  BoundPremise,
  Fragment,
  GuardShape,
  Premise,
  Program,
} from "./fragment";
import { StepIds, stepLabels } from "./ids";
import { lowerPredicate, matchWriteResult } from "./match";
import type {
  Cell,
  Pattern,
  Predicate,
  Reference,
  Row,
  RowId,
  Variable,
  VariableId,
} from "./pattern";
import type { Node, Scheduled, ScheduledFragment } from "./schedule";

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Pack a schedule into a program. With `known` (the match phase's rows, keyed
 * `<step>.rows` exactly as the executor publishes them) matched variables lower
 * to literals, which is today's "planning values cross into final compilation as
 * known values"; without it they lower to backward references.
 */
export function pack(
  scheduled: Scheduled,
  engine: QueryEngine,
  ids: StepIds,
  known?: PlanningKnown
): Program {
  return new Packing(scheduled, engine, ids, known).program();
}

// ---------------------------------------------------------------------------
// Row facts
// ---------------------------------------------------------------------------

/** Which row stores the reference a target hangs from (the one storage fact). */
interface Edge {
  readonly kind: "parentHeld" | "childHeld" | "junction";
  /** The reference between the target and its parent (for a junction: to the target). */
  readonly reference: Reference;
  readonly parent: RowId;
  readonly target: RowId;
  /** A junction's reference row and its reference to the parent. */
  readonly junction?: RowId;
  readonly toParent?: Reference;
}

interface RowIds {
  match?: string;
  write?: string;
  guard?: string;
  select?: string;
  /** Extra labelled steps a family emits beside the row's own three. */
  extra: Record<string, string>;
}

type Where = Record<string, unknown>;

// ---------------------------------------------------------------------------
// The packer
// ---------------------------------------------------------------------------

class Packing {
  private readonly pattern: Pattern;
  private readonly rows = new Map<RowId, Row>();
  private readonly cells = new Map<RowId, Cell[]>();
  private readonly txMode: boolean;
  private readonly rowIds = new Map<RowId, RowIds>();
  private readonly decoded = new Map<
    RowId,
    Record<string, unknown> | undefined
  >();
  private readonly generated = new Map<VariableId, unknown>();
  private readonly matchSteps = new Map<RowId, StatementStep>();
  private readonly edges = new Map<RowId, Edge>();
  private readonly rootName: string;
  private readonly root: Row;
  /** Rows folded into an earlier row's statement (a group probe, a set clear). */
  private readonly folded = new Set<RowId>();

  private readonly scheduled: Scheduled;
  private readonly engine: QueryEngine;
  private readonly ids: StepIds;
  private readonly known: PlanningKnown | undefined;

  constructor(
    scheduled: Scheduled,
    engine: QueryEngine,
    ids: StepIds,
    known: PlanningKnown | undefined
  ) {
    this.scheduled = scheduled;
    this.engine = engine;
    this.ids = ids;
    this.known = known;
    this.pattern = scheduled.pattern;
    for (const row of this.pattern.rows) {
      this.rows.set(row.id, row);
      this.cells.set(row.id, []);
    }
    for (const cell of this.pattern.cells) this.cells.get(cell.row)?.push(cell);
    this.txMode = scheduled.substrate.supportsTransactions;
    this.root = this.row(this.pattern.root);
    this.rootName = getStepModelName(this.root.table.model, "parent");
    for (const row of this.pattern.rows) {
      const edge = this.computeEdge(row);
      if (edge) this.edges.set(row.id, edge);
    }
    this.allocateIds();
  }

  // -- structure ------------------------------------------------------------

  private row(id: RowId): Row {
    const row = this.rows.get(id);
    if (!row)
      throw new Error(`query-engine pattern: unknown row ${id} in pack`);
    return row;
  }

  private cellsOf(id: RowId): readonly Cell[] {
    return this.cells.get(id) ?? [];
  }

  private isJunction(row: Row): boolean {
    return row.table.referenceRow === true;
  }

  private isRoot(row: Row): boolean {
    return row.id === this.pattern.root;
  }

  private get capabilities() {
    return this.engine.adapter.capabilities;
  }

  private get returning(): boolean {
    return this.capabilities.supportsReturning;
  }

  /**
   * The edge a target row hangs from. A junction row's two references name the
   * parent (constructed first, the smaller id) and the target.
   */
  private computeEdge(row: Row): Edge | undefined {
    if (this.isRoot(row) || this.isJunction(row)) return undefined;
    for (const reference of this.pattern.references) {
      if (reference.holder === reference.referenced) continue;
      const holder = this.row(reference.holder);
      if (this.isJunction(holder)) {
        if (reference.referenced !== row.id) continue;
        const other = this.pattern.references.find(
          (r) => r.holder === holder.id && r !== reference
        );
        if (!other || other.referenced === row.id) continue;
        // The parent is the endpoint constructed first.
        if (other.referenced > row.id) continue;
        return {
          kind: "junction",
          reference,
          parent: other.referenced,
          target: row.id,
          junction: holder.id,
          toParent: other,
        };
      }
      if (reference.holder === row.id && reference.referenced < row.id) {
        return {
          kind: "childHeld",
          reference,
          parent: reference.referenced,
          target: row.id,
        };
      }
      if (reference.referenced === row.id && reference.holder < row.id) {
        return {
          kind: "parentHeld",
          reference,
          parent: reference.holder,
          target: row.id,
        };
      }
    }
    return undefined;
  }

  /** A junction row whose target is absent (a set's clear, an untargeted retract). */
  private junctionParentEdge(junction: Row): Reference | undefined {
    const references = this.pattern.references.filter(
      (r) => r.holder === junction.id
    );
    if (references.length === 0) return undefined;
    return references.reduce((a, b) => (a.referenced <= b.referenced ? a : b));
  }

  private edge(row: RowId): Edge | undefined {
    return this.edges.get(row);
  }

  private childName(row: Row): string {
    const edge = this.edge(row.id);
    return getStepModelName(
      row.table.model,
      edge?.reference.relation.field ?? this.pattern.operation
    );
  }

  private node(row: RowId, kind: Node["kind"]): Node | undefined {
    return this.scheduled.nodes.find((n) => n.row === row && n.kind === kind);
  }

  private verb(row: Row): string {
    return row.verb ?? "";
  }

  private retractCells(row: Row): readonly Cell[] {
    return this.cellsOf(row.id).filter((cell) => cell.mode === "retract");
  }

  private matchCells(row: Row): readonly Cell[] {
    return this.cellsOf(row.id).filter((cell) => cell.mode === "match");
  }

  private stepModel(model: Model<any>): string {
    return getStepModelName(model, "record");
  }

  /** Same parent, same relation: one Part's worth of targets. */
  private sameEdgeGroup(a: Row, b: Row): boolean {
    const ea = this.edge(a.id);
    const eb = this.edge(b.id);
    return (
      ea !== undefined &&
      eb !== undefined &&
      ea.kind === eb.kind &&
      ea.parent === eb.parent &&
      ea.reference.relation.field === eb.reference.relation.field &&
      this.verb(a) === this.verb(b) &&
      a.arm === b.arm
    );
  }

  // -- ids (payload order, the label scheme — §12.3) ----------------------

  private extra(row: RowId, key: string, label: string): void {
    const ids = this.rowIds.get(row) ?? { extra: {} };
    ids.extra[key] = this.ids.allocate(label);
    this.rowIds.set(row, ids);
  }

  private allocateIds(): void {
    const root = this.root;
    const rootIds: RowIds = { extra: {} };
    const op = this.pattern.operation;
    const name = this.rootName;
    if (op === "create") {
      rootIds.select = this.ids.allocate(stepLabels.select(name));
      rootIds.write = this.ids.allocate(stepLabels.create(name));
    } else if (op === "update") {
      rootIds.match = this.ids.allocate(stepLabels.locate(name));
      rootIds.write = this.ids.allocate(stepLabels.update(name));
      rootIds.select = this.ids.allocate(stepLabels.select(name));
      rootIds.guard = this.ids.allocate(stepLabels.guardExists(name));
    } else if (op === "delete") {
      rootIds.match = this.ids.allocate(stepLabels.locate(name));
      rootIds.extra.read = this.ids.allocate(`${name}.read`);
      rootIds.write = this.ids.allocate(stepLabels.delete(name));
      rootIds.guard = this.ids.allocate(stepLabels.guardExists(name));
    } else if (op === "upsert") {
      rootIds.match = this.ids.allocate(stepLabels.locate(name));
      rootIds.write = this.ids.allocate(`${name}.upsert`);
      rootIds.select = this.ids.allocate(stepLabels.select(name));
      rootIds.guard = this.ids.allocate(stepLabels.guardExists(name));
    } else if (op === "updateMany" || op === "deleteMany") {
      if (op === "updateMany" && this.hasNestedRows()) {
        rootIds.match = this.ids.allocate(`${name}.updateManySeries.capture`);
      }
      rootIds.write = this.ids.allocate(op);
    } else if (op === "updateManyAndReturn" || op === "deleteManyAndReturn") {
      rootIds.write = this.ids.allocate(
        `${name}.${op === "updateManyAndReturn" ? "updateManyReturn" : "deleteManyReturn"}`
      );
    }
    this.rowIds.set(root.id, rootIds);
    if (op.startsWith("createMany")) {
      // Every member row of the bulk create shares the root's statements.
      for (const member of this.createManyRows()) {
        if (member.id !== root.id) this.folded.add(member.id);
      }
    }

    const done = new Set<RowId>();
    for (const row of this.pattern.rows) {
      if (this.isRoot(row) || this.isJunction(row) || done.has(row.id)) {
        continue;
      }
      const edge = this.edge(row.id);
      if (!edge) {
        // A top-level fresh row beside the root (createMany's members).
        this.rowIds.set(row.id, { extra: {} });
        continue;
      }
      const verb = this.verb(row);
      if (verb === "set") {
        // Targets first, then the departure row (today's Part allocation).
        const members = this.pattern.rows.filter(
          (r) =>
            !(this.isJunction(r) || done.has(r.id)) &&
            this.edge(r.id)?.parent === edge.parent &&
            this.edge(r.id)?.reference.relation.field ===
              edge.reference.relation.field &&
            this.verb(r) === "set"
        );
        const departing = members.filter((r) => r.cardinality === "set");
        const targets = members.filter((r) => r.cardinality !== "set");
        for (const target of targets) {
          this.allocateTarget(target, this.edge(target.id)!);
          done.add(target.id);
        }
        for (const departure of departing) {
          const child = this.childName(departure);
          if (edge.kind === "junction") {
            this.extra(departure.id, "clear", stepLabels.setClear(child));
            this.extra(departure.id, "insert", stepLabels.setInsert(child));
          } else {
            this.extra(departure.id, "departing", `${child}.departing`);
            this.extra(
              departure.id,
              "departingGuard",
              `${child}.guard.departing`
            );
            this.extra(departure.id, "orphan", `${child}.orphan`);
          }
          done.add(departure.id);
        }
        continue;
      }
      if (
        edge.kind === "childHeld" &&
        verb === "connect" &&
        row.mode === "match"
      ) {
        // One Part per key-shape group: find, connect, guard.exists × N.
        const group = this.pattern.rows.filter(
          (r) => !done.has(r.id) && this.sameEdgeGroup(row, r)
        );
        const child = this.childName(row);
        const ids: RowIds = { extra: {} };
        ids.match = this.ids.allocate(stepLabels.find(child));
        ids.write = this.ids.allocate(stepLabels.connect(child));
        this.rowIds.set(row.id, ids);
        for (const member of group) {
          const memberIds =
            member.id === row.id ? ids : ({ extra: {} } as RowIds);
          memberIds.guard = this.ids.allocate(stepLabels.guardExists(child));
          if (member.id !== row.id) {
            memberIds.match = ids.match;
            memberIds.write = ids.write;
            this.folded.add(member.id);
            this.rowIds.set(member.id, memberIds);
          }
          done.add(member.id);
        }
        continue;
      }
      this.allocateTarget(row, edge);
      done.add(row.id);
    }
  }

  private allocateTarget(row: Row, edge: Edge): void {
    const child = this.childName(row);
    const verb = this.verb(row);
    const ids: RowIds = { extra: {} };
    const matched = row.mode !== "assert" || this.node(row.id, "match");
    const untargeted = row.predicate === undefined;
    if (edge.kind === "junction") {
      switch (verb) {
        case "connect":
        case "set":
        case "delete":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          ids.write = this.ids.allocate(`${child}.${verb}`);
          ids.extra.child = this.ids.allocate(stepLabels.deleteChild(child));
          break;
        case "update":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.write = this.ids.allocate(stepLabels.update(child));
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          ids.extra.child = this.ids.allocate(stepLabels.deleteChild(child));
          break;
        case "disconnect":
          ids.write = this.ids.allocate(stepLabels.disconnect(child));
          break;
        case "deleteMany":
          ids.match = this.ids.allocate(`${child}.members`);
          ids.extra.added = this.ids.allocate(`${child}.guard.added`);
          ids.extra.removed = this.ids.allocate(`${child}.guard.removed`);
          ids.extra.junctionDelete = this.ids.allocate(
            stepLabels.junctionDelete(child)
          );
          ids.write = this.ids.allocate(`${child}.deleteMany`);
          break;
        case "updateMany":
          ids.write = this.ids.allocate(`${child}.updateMany`);
          break;
        case "connectOrCreate":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.extra.create = this.ids.allocate(stepLabels.create(child));
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          ids.write = this.ids.allocate(stepLabels.junctionInsert(child));
          break;
        case "upsert":
          ids.extra.member = this.ids.allocate(`${child}.member`);
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.extra.create = this.ids.allocate(stepLabels.create(child));
          ids.extra.update = this.ids.allocate(stepLabels.update(child));
          ids.guard = this.ids.allocate(`${child}.guard.member`);
          ids.write = this.ids.allocate(stepLabels.junctionInsert(child));
          break;
        default:
          // create / createMany: the fresh target, then its reference row.
          ids.write = this.ids.allocate(stepLabels.create(child));
          ids.extra.join = this.ids.allocate(stepLabels.junctionInsert(child));
          break;
      }
    } else if (edge.kind === "parentHeld") {
      switch (verb) {
        case "connect":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          break;
        case "delete":
          this.extra(edge.parent, "fknull", "parent.fknull");
          ids.write = this.ids.allocate(stepLabels.delete(child));
          break;
        case "update":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.write = this.ids.allocate(stepLabels.update(child));
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          break;
        case "upsert":
          if (row.fresh) {
            ids.write = this.ids.allocate(stepLabels.create(child));
          } else {
            ids.match = this.ids.allocate(stepLabels.find(child));
            ids.write = this.ids.allocate(stepLabels.update(child));
            ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          }
          break;
        case "connectOrCreate":
          if (row.fresh) {
            ids.write = this.ids.allocate(stepLabels.create(child));
          } else {
            ids.match = this.ids.allocate(stepLabels.find(child));
            ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          }
          break;
        case "create":
          ids.write = this.ids.allocate(stepLabels.create(child));
          break;
        default:
          break;
      }
    } else {
      switch (verb) {
        case "disconnect":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.write = this.ids.allocate(stepLabels.disconnect(child));
          if (!untargeted) {
            ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          }
          break;
        case "delete":
          if (untargeted) {
            ids.match = this.ids.allocate(stepLabels.find(child));
            ids.write = this.ids.allocate(`${child}.deleteMany`);
            ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          } else {
            ids.match = this.ids.allocate(stepLabels.find(child));
            ids.write = this.ids.allocate(stepLabels.delete(child));
            ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          }
          break;
        case "update":
        case "deleteMany":
        case "updateMany":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.write = this.ids.allocate(`${child}.${verb}`);
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          break;
        case "set":
          ids.match = this.ids.allocate(stepLabels.find(child));
          ids.write = this.ids.allocate(`${child}.set`);
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          break;
        case "connectOrCreate":
        case "upsert":
          if (row.fresh) {
            ids.write = this.ids.allocate(stepLabels.create(child));
          } else {
            ids.match = this.ids.allocate(stepLabels.find(child));
            // The missing arm's fresh row is allocated by its own row.
            ids.write = this.ids.allocate(stepLabels.update(child));
            ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          }
          break;
        case "createMany":
          ids.write = this.ids.allocate(`${child}.createMany`);
          break;
        case "create":
          ids.write = this.ids.allocate(stepLabels.create(child));
          break;
        default:
          if (matched) ids.match = this.ids.allocate(stepLabels.find(child));
          ids.write = this.ids.allocate(stepLabels.update(child));
          ids.guard = this.ids.allocate(stepLabels.guardExists(child));
          break;
      }
    }
    // Total by construction: a row the families above did not spell still
    // gets every id its own nodes need, so no shape can reach a missing id.
    if (!ids.match && this.node(row.id, "match")) {
      ids.match = this.ids.allocate(stepLabels.find(child));
    }
    if (
      !ids.write &&
      (this.node(row.id, "assert") || this.node(row.id, "retract"))
    ) {
      ids.write = this.ids.allocate(
        row.fresh
          ? stepLabels.create(child)
          : row.mode === "retract"
            ? stepLabels.delete(child)
            : stepLabels.update(child)
      );
    }
    if (!ids.guard && ids.match) {
      ids.guard = this.ids.allocate(stepLabels.guardExists(child));
    }
    // A merge's arms share one match: the fresh (missing) row reads the
    // decision row's ids.
    this.rowIds.set(row.id, ids);
  }

  /**
   * Whether a row's match is EMITTED as a statement. Today's owners allocate a
   * probe id for families that never send one (a correlated bulk verb, a
   * targetless disconnect, a parent-held delete), so allocation and emission
   * are two questions: the label keeps the `#n` sequence, this decides the SQL.
   */
  private packsMatch(row: Row): boolean {
    if (this.isRoot(row)) {
      const op = this.pattern.operation;
      if (op === "create" || op.startsWith("createMany")) return false;
      if (op.startsWith("updateMany") || op.startsWith("deleteMany")) {
        // A scalar-only bulk write is one statement and needs no capture; a
        // relation-bearing one captures its roots first, because member N
        // observes what member N-1 wrote (AGENTS core rule 7).
        return op.startsWith("updateMany") && this.hasNestedRows();
      }
      if (op === "delete" && this.deleteFolds()) return false;
      if (op === "update" && this.updateFolds()) return false;
      return true;
    }
    const edge = this.edge(row.id);
    if (!edge) return false;
    const verb = this.verb(row);
    if (row.fresh) return false;
    if (verb === "create" || verb === "createMany") return false;
    if (edge.kind === "junction") {
      // A junction disconnect deletes by target subquery; a bulk verb rides
      // its own membership predicate.
      return verb !== "disconnect" && verb !== "updateMany";
    }
    if (edge.kind === "parentHeld") {
      // Only a target named by its own selector, or a member the arm must
      // decide on, is probed; a delete/disconnect inlines the parent's cells.
      return (
        verb === "connect" ||
        verb === "connectOrCreate" ||
        verb === "update" ||
        verb === "upsert"
      );
    }
    // child-held: the bulk verbs correlate inline, an untargeted disconnect
    // needs no probe, and a `set` departure is read only when it cannot be
    // nulled (the required-FK orphan refusal).
    if (verb === "updateMany" || verb === "deleteMany") return false;
    if (verb === "disconnect" && !row.predicate) return false;
    if (verb === "set" && row.cardinality === "set") {
      return !edge.reference.nullable;
    }
    if (verb === "delete" && !row.predicate) return false;
    return true;
  }

  /** The terminal read is the root's own step only where today emits one. */
  private packsTerminal(): boolean {
    const op = this.pattern.operation;
    if (op === "delete") return false;
    if (op.startsWith("createMany") || op.startsWith("updateMany"))
      return false;
    if (op.startsWith("deleteMany")) return false;
    if (op === "create") return !this.createFolds();
    if (op === "update") return !this.updateFolds();
    if (op === "upsert") return false;
    return true;
  }

  private idOf(
    row: RowId,
    which: "match" | "write" | "guard" | "select"
  ): string {
    const id = this.rowIds.get(row)?.[which];
    if (!id) {
      throw new Error(
        `query-engine pattern: row ${row} has no '${which}' step id`
      );
    }
    return id;
  }

  private extraId(row: RowId, key: string): string {
    const id = this.rowIds.get(row)?.extra[key];
    if (!id) {
      throw new Error(
        `query-engine pattern: row ${row} has no '${key}' step id`
      );
    }
    return id;
  }

  /** The decision row a merge arm's row shares its match with. */
  private decisionOf(row: Row): Row | undefined {
    if (row.arm === undefined) return undefined;
    const arm = this.pattern.arms.find((a) => a.id === row.arm);
    return arm ? this.row(arm.decision) : undefined;
  }

  // -- values ---------------------------------------------------------------

  private scope(model: Model<any>): QueryScope {
    return createQueryScope(this.engine, model);
  }

  private fieldOf(model: Model<any>, column: string): string {
    for (const field of Object.keys(model["~"].state.scalars)) {
      if (getColumnName(model, field) === column) return field;
    }
    return column;
  }

  private keyFields(row: Row): readonly string[] {
    return getPrimaryKeyFields(row.table.model);
  }

  private select(fields: readonly string[]): Record<string, boolean> {
    return Object.fromEntries(fields.map((field) => [field, true]));
  }

  private keySelect(row: Row): Record<string, boolean> {
    return this.select(this.keyFields(row));
  }

  /** The fields a row's match publishes: its key plus the parent's fields it binds. */
  private matchFields(row: Row): readonly string[] {
    const fields = [...this.keyFields(row)];
    for (const cell of this.matchCells(row)) {
      const field = this.fieldOf(row.table.model, cell.column);
      if (!fields.includes(field)) fields.push(field);
    }
    return fields;
  }

  /** The row a variable's `matched` binding reads, and the field on it. */
  private matchSource(
    variable: Variable
  ): { row: Row; field: string } | undefined {
    const { binding } = variable;
    if (binding.kind !== "matched") return undefined;
    const row = this.row(binding.row);
    return { row, field: this.fieldOf(row.table.model, binding.column) };
  }

  /**
   * Where a matched variable is PUBLISHED: the row's own match step, or — for a
   * row matched through the parent's reference cells (a parent-held target) —
   * the parent's locate, which selects those cells.
   */
  private publisher(row: Row): { step: string; row: Row } | undefined {
    const own = this.rowIds.get(row.id)?.match;
    if (own && this.node(row.id, "match")) return { step: own, row };
    const edge = this.edge(row.id);
    if (edge?.kind === "parentHeld") {
      const parent = this.row(edge.parent);
      const parentStep = this.rowIds.get(parent.id)?.match;
      if (parentStep) return { step: parentStep, row: parent };
    }
    return undefined;
  }

  /**
   * WHAT A MATCH SELECTS — one owner, read by the statement that asks for it and
   * by the decode that reads its answer back. A row's answer must be decoded
   * against the columns its own statement requested: reading it against some
   * other projection asks the parser for columns the provider was never told to
   * return, which it reports as a malformed result.
   */
  private matchSelect(row: Row): Record<string, boolean> {
    if (this.isRoot(row)) return this.select(this.matchFields(row));
    const edge = this.edge(row.id);
    const model = row.table.model;
    const verb = this.verb(row);
    const selector = this.selectorWhere(row);
    if (edge?.kind === "parentHeld" && selector) {
      // A target named by its own selector publishes the columns the reference
      // stores, not its key.
      return this.select(
        edge.reference.columns.map((c) =>
          this.fieldOf(model, c.referencedColumn)
        )
      );
    }
    if (edge?.kind === "childHeld" && this.matchCells(row).length === 0) {
      // A merge also reads the reference columns it decides on.
      const extraFields =
        verb === "connectOrCreate" || (verb === "upsert" && selector)
          ? edge.reference.columns.map((c) =>
              this.fieldOf(model, c.holderColumn)
            )
          : [];
      return this.select([...this.keyFields(row), ...extraFields]);
    }
    return this.keySelect(row);
  }

  /** The decoded first row of a match, read through that match's own projection. */
  private matchedRow(row: Row): Record<string, unknown> | undefined {
    if (this.decoded.has(row.id)) return this.decoded.get(row.id);
    const source = this.publisher(row);
    const raw = source ? this.known?.[planningKey(source.step, "rows")] : [];
    const published = (source ?? { row }).row;
    const rows = Array.isArray(raw)
      ? parseCapturedRows(
          this.engine,
          published.table.model,
          raw,
          this.matchSelect(published)
        )
      : [];
    this.decoded.set(row.id, rows[0]);
    return rows[0];
  }

  /** The value at the parent's reference cell for a parent-held target. */
  private parentHeldValue(row: Row, field: string, planning: boolean): unknown {
    const edge = this.edge(row.id);
    if (edge?.kind !== "parentHeld") return undefined;
    const parent = this.row(edge.parent);
    const pair = edge.reference.columns.find(
      (c) => this.fieldOf(row.table.model, c.referencedColumn) === field
    );
    if (!pair) return undefined;
    const parentField = this.fieldOf(parent.table.model, pair.holderColumn);
    const step = this.rowIds.get(parent.id)?.match;
    if (!step) return undefined;
    if (planning || !this.known) return ref(step, parentField);
    return this.matchedRow(parent)?.[parentField];
  }

  /**
   * Where a database-bound variable is actually PUBLISHED, when the row it
   * belongs to sends no match of its own: some outer row's match carries it as
   * one of its columns (a parent's locate selects the foreign key its child is
   * addressed by). One rule over cells — no storage kind, no edge walk.
   */
  private publishedBy(
    variable: Variable
  ): { row: Row; field: string } | undefined {
    for (const cell of this.pattern.cells) {
      if (cell.mode !== "match" || cell.value.id !== variable.id) continue;
      const row = this.row(cell.row);
      if (!this.packsMatch(row)) continue;
      return { row, field: this.fieldOf(row.table.model, cell.column) };
    }
    return;
  }

  private value(variable: Variable, planning = false): unknown {
    const { binding } = variable;
    switch (binding.kind) {
      case "literal":
        return binding.value;
      case "generated": {
        if (!this.generated.has(variable.id)) {
          this.generated.set(variable.id, binding.materialize());
        }
        return this.generated.get(variable.id);
      }
      case "matched": {
        const source = this.matchSource(variable)!;
        if (!this.packsMatch(source.row)) {
          const published = this.publishedBy(variable);
          if (published) {
            const step = this.idOf(published.row.id, "match");
            if (planning || !this.known) return ref(step, published.field);
            return this.matchedRow(published.row)?.[published.field];
          }
          const inherited = this.parentHeldValue(
            source.row,
            source.field,
            planning
          );
          if (inherited !== undefined) return inherited;
        }
        if (planning || !this.known) {
          return ref(this.idOf(source.row.id, "match"), source.field);
        }
        const row = this.matchedRow(source.row);
        if (!row) {
          const field = this.edge(source.row.id)?.reference.relation.field;
          throw new NestedWriteError(
            `query-engine-v2 ${this.pattern.operation} for relation '${field ?? this.pattern.operation}' could not resolve its parent id.`,
            field ?? this.pattern.operation
          );
        }
        return row[source.field];
      }
      case "returned":
        return ref(
          this.idOf(binding.row, "write"),
          this.fieldOf(this.row(binding.row).table.model, binding.column)
        );
      default:
        return undefined;
    }
  }

  /**
   * A located row is re-addressed by the key its own match CAPTURED, never by
   * the value the payload spelled (ATOM §15's wrong-row protection: a selector
   * may name an alternate unique, and a concurrent write may move it). The two
   * agree whenever the selector pins the key, so only execution tells them
   * apart.
   */
  private capturedKeyValue(
    row: Row,
    field: string,
    planning: boolean
  ): unknown {
    if (row.fresh || !this.packsMatch(row)) return;
    const step = this.rowIds.get(row.id)?.match;
    if (!step) return;
    if (planning || !this.known) return ref(step, field);
    return this.matchedRow(row)?.[field];
  }

  private keyValues(
    row: Row,
    key: readonly Variable[] = row.key,
    planning = false
  ): Record<string, unknown> {
    const fields = this.keyFields(row);
    const values: Record<string, unknown> = {};
    const addressed = key === row.key;
    key.forEach((variable, index) => {
      const field = fields[index];
      if (field === undefined) return;
      const captured = addressed
        ? this.capturedKeyValue(row, field, planning)
        : undefined;
      values[field] =
        captured === undefined ? this.value(variable, planning) : captured;
    });
    return values;
  }

  private keyWhere(row: Row, key: readonly Variable[] = row.key): Where {
    return buildPrimaryKeyWhereUnique(
      row.table.model,
      this.keyValues(row, key)
    );
  }

  // -- predicates -----------------------------------------------------------

  private literalLeaves(
    model: Model<any>,
    predicate: Predicate | undefined,
    out: Record<string, unknown>
  ): boolean {
    if (!predicate) return true;
    if (predicate.kind === "scalar") {
      if (predicate.operator !== "equals" || Array.isArray(predicate.operand)) {
        return false;
      }
      out[this.fieldOf(model, predicate.column)] = this.value(
        predicate.operand as Variable
      );
      return true;
    }
    if (predicate.kind === "and") {
      return predicate.items.every((item) =>
        this.literalLeaves(model, item, out)
      );
    }
    return false;
  }

  /**
   * A row's unique selector as the public `whereUnique` object — exactly the
   * spelling the caller wrote (bare values, compound keys nested under their
   * constraint name), which is what keeps `buildFindUnique` byte-identical.
   */
  private selectorWhere(row: Row): Where | undefined {
    const values: Record<string, unknown> = {};
    if (!this.literalLeaves(row.table.model, row.predicate, values)) {
      return undefined;
    }
    const fields = Object.keys(values);
    if (fields.length === 0) return undefined;
    const keys = this.keyFields(row);
    if (
      keys.length > 1 &&
      keys.every((field) => fields.includes(field)) &&
      fields.length === keys.length
    ) {
      return buildPrimaryKeyWhereUnique(row.table.model, values);
    }
    return values;
  }

  /** The selector as equality conjuncts (`{ id: { equals } }` each). */
  private selectorConjuncts(row: Row): Where[] {
    const values: Record<string, unknown> = {};
    this.literalLeaves(row.table.model, row.predicate, values);
    return Object.entries(values).map(([field, value]) => ({
      [field]: { equals: value },
    }));
  }

  /** A non-unique filter, in the validated operation-object spelling. */
  private filterWhere(
    model: Model<any>,
    predicate: Predicate | undefined
  ): Where | undefined {
    if (!predicate) return undefined;
    switch (predicate.kind) {
      case "scalar": {
        const field = this.fieldOf(model, predicate.column);
        const operand = Array.isArray(predicate.operand)
          ? (predicate.operand as readonly Variable[]).map((v) => this.value(v))
          : this.value(predicate.operand as Variable);
        return {
          [field]: {
            [predicate.operator]: operand,
            ...(predicate.mode ? { mode: predicate.mode } : {}),
          },
        };
      }
      case "and": {
        const items = predicate.items.map((item) =>
          this.filterWhere(model, item)
        );
        if (items.some((item) => item === undefined)) return undefined;
        const merged: Where = {};
        for (const item of items as Where[]) {
          for (const [key, value] of Object.entries(item)) {
            if (Object.hasOwn(merged, key)) return { AND: items };
            merged[key] = value;
          }
        }
        return merged;
      }
      case "or": {
        const items = predicate.items.map((item) =>
          this.filterWhere(model, item)
        );
        return items.some((item) => item === undefined)
          ? undefined
          : { OR: items };
      }
      case "not": {
        const item = this.filterWhere(model, predicate.item);
        return item === undefined ? undefined : { NOT: item };
      }
      default:
        return undefined;
    }
  }

  private hasRelationLeaf(predicate: Predicate | undefined): boolean {
    if (!predicate) return false;
    switch (predicate.kind) {
      case "relation":
      case "structural":
        return true;
      case "and":
      case "or":
        return predicate.items.some((item) => this.hasRelationLeaf(item));
      case "not":
        return this.hasRelationLeaf(predicate.item);
      default:
        return false;
    }
  }

  /** Membership conjuncts: the target's reference cells equal the parent's key. */
  /** Does the model expose this physical column as a public scalar field? */
  private isPublicColumn(model: Model<any>, column: string): boolean {
    const field = this.fieldOf(model, column);
    return Object.hasOwn(model["~"].state.scalars, field);
  }

  /**
   * The membership as public filters — the ordinary foreign key's columns.
   * A DISCRIMINATED reference stores a private `(type, id)` pair that no public
   * field names, so it is spelled as SQL instead
   * ({@link Packing.membershipPredicate}); it must never reach a `where`.
   */
  private membershipFilters(row: Row, planning: boolean): Where[] {
    const edge = this.edge(row.id);
    if (!edge || edge.kind !== "childHeld") return [];
    return this.matchCells(row)
      .filter((cell) => this.isPublicColumn(row.table.model, cell.column))
      .map((cell) => ({
        [this.fieldOf(row.table.model, cell.column)]: {
          equals: this.value(cell.value, planning),
        },
      }));
  }

  /**
   * The membership of a DISCRIMINATED reference, as the one exact `(type, id)`
   * predicate its owner already spells (`buildPolymorphicMembershipPredicate`).
   * `undefined` whenever the reference's columns are public — then the filters
   * above carry it.
   */
  private membershipPredicate(
    row: Row,
    alias: string,
    planning: boolean
  ): Sql | undefined {
    const edge = this.edge(row.id);
    if (!edge || edge.kind !== "childHeld") return;
    const cells = this.matchCells(row).filter(
      (cell) => !this.isPublicColumn(row.table.model, cell.column)
    );
    if (cells.length === 0) return;
    const scope = this.scope(edge.reference.relation.model);
    const relationRef = lookupRelation(scope, edge.reference.relation.field);
    if (!relationRef) return;
    const bound = bindRelation(scope, relationRef);
    if (bound.position !== "childHeld" || !hasPolymorphicMembership(bound)) {
      return;
    }
    const { membership } = bound;
    const idCell = cells.find(
      (cell) => cell.column === membership.storage.idColumn.name
    );
    if (!idCell) return;
    return buildPolymorphicMembershipPredicate(
      this.scope(row.table.model),
      bound,
      alias,
      referenceScalarSql(
        this.engine,
        membership.storage.idColumn.scalar,
        membership.storage.idColumn.name,
        this.value(idCell.value, planning)
      )
    );
  }

  // -- matches --------------------------------------------------------------

  private matchStep(node: Node): StatementStep {
    const row = this.row(node.row);
    const cached = this.matchSteps.get(row.id);
    if (cached) return cached;
    const step = this.isRoot(row)
      ? this.rootMatch(row)
      : this.targetMatch(row, node);
    this.matchSteps.set(row.id, step);
    return step;
  }

  private rootNotFound(): Failure {
    return notFoundFailure(
      `query-engine-v2 ${this.pattern.operation} located no '${this.rootName}' row for its unique where.`
    );
  }

  private rootMatch(row: Row): StatementStep {
    const scope = this.scope(row.table.model);
    if (row.cardinality === "set") {
      // The series capture: every root the filter names, locked, so the members
      // that follow address rows this operation already holds.
      const filter = this.filterWhere(row.table.model, row.predicate);
      return {
        id: this.idOf(row.id, "match"),
        kind: "read",
        statement: buildFind(scope, {
          ...(filter ? { where: filter } : {}),
          select: this.keySelect(row),
          forUpdate: this.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      };
    }
    const where = this.selectorWhere(row) ?? {};
    const fields = this.matchFields(row);
    const upsert = this.pattern.operation === "upsert";
    const isDelete = this.pattern.operation === "delete";
    return {
      id: this.idOf(row.id, "match"),
      kind: "read",
      statement: buildFindUnique(scope, {
        where,
        select: this.select(fields),
        forUpdate: this.txMode,
      }),
      outputs: {
        rows: { kind: "rows" },
        ...(isDelete
          ? {}
          : Object.fromEntries(
              fields.map((field) => [
                field,
                {
                  kind: "firstRowField",
                  field,
                  ...(upsert ? { optional: true } : {}),
                },
              ])
            )),
      },
      ...(upsert ? {} : { expects: exactlyOneRow(this.rootNotFound()) }),
    };
  }

  private targetMatch(row: Row, node: Node): StatementStep {
    const edge = this.edge(row.id)!;
    const model = row.table.model;
    const scope = this.scope(model);
    const verb = this.verb(row);
    const selector = this.selectorWhere(row);
    const membership = this.membershipFilters(row, true);
    const id = this.idOf(row.id, "match");
    const base = { id, kind: "read" as const, model: this.stepModel(model) };
    const rows: Record<string, StatementOutputSource> = {
      rows: { kind: "rows" },
    };
    if (edge.kind === "junction") {
      if (verb === "delete" || verb === "update" || verb === "deleteMany") {
        const { statements, bound } = this.junctionFor(
          edge.reference,
          edge.junction === undefined
            ? undefined
            : this.row(edge.junction).table.table
        );
        const membershipRead = statements.materialize(bound, "membershipRead", {
          parentValue: this.keyValues(this.row(edge.parent), undefined, true),
          ...(selector ? { whereUnique: selector, take: 1 } : {}),
          ...(verb === "deleteMany"
            ? { where: this.filterWhere(model, row.predicate) ?? {} }
            : {}),
          select: this.keySelect(row),
          ...(this.txMode ? { lock: "transaction" } : {}),
        });
        return { ...base, statement: membershipRead, outputs: rows };
      }
      return {
        ...base,
        statement: buildFindUnique(scope, {
          where: selector ?? {},
          select: this.keySelect(row),
          forUpdate: this.txMode,
        }),
        outputs: rows,
      };
    }
    if (edge.kind === "parentHeld") {
      if (selector) {
        // connect / connectOrCreate: the target by its own unique.
        const referencedFields = edge.reference.columns.map((c) =>
          this.fieldOf(model, c.referencedColumn)
        );
        return {
          ...base,
          statement: buildFindUnique(scope, {
            where: selector,
            select: this.matchSelect(row),
            forUpdate: this.txMode,
          }),
          outputs: rows,
        };
      }
      // update / upsert: the current member, by the parent's reference cells.
      const correlation: Where[] = edge.reference.columns.map((c) => ({
        [this.fieldOf(model, c.referencedColumn)]: {
          equals: this.parentHeldValue(
            row,
            this.fieldOf(model, c.referencedColumn),
            true
          ),
        },
      }));
      return {
        ...base,
        statement: buildFind(
          scope,
          {
            where:
              correlation.length === 1 ? correlation[0]! : { AND: correlation },
            select: this.keySelect(row),
            forUpdate: this.txMode,
          },
          { limit: 1 }
        ),
        outputs: {
          ...rows,
          ...(verb === "upsert"
            ? Object.fromEntries(
                this.keyFields(row).map((field) => [
                  field,
                  { kind: "firstRowField", field, optional: true },
                ])
              )
            : {}),
        },
      };
    }
    // child-held
    const group = this.groupOf(row);
    const membershipSql = this.membershipPredicate(row, scope.rootAlias, true);
    if (this.matchCells(row).length === 0) {
      // connect / set / connectOrCreate / upsert-by-selector: the target globally.
      const select = this.matchSelect(row);
      const statement =
        group.length > 1
          ? buildFind(scope, {
              where: linkGroupSelector(
                scope,
                group.map((r) => this.selectorWhere(r) ?? {})
              ),
              select,
              forUpdate: this.txMode,
            })
          : buildFindUnique(scope, {
              where: selector ?? {},
              select,
              forUpdate: this.txMode,
            });
      return {
        ...base,
        statement,
        outputs: {
          ...rows,
          ...(verb === "upsert"
            ? Object.fromEntries(
                this.keyFields(row).map((field) => [
                  field,
                  { kind: "firstRowField", field, optional: true },
                ])
              )
            : {}),
        },
      };
    }
    // A current member: selector (when any) and membership, limit 1.
    const conjuncts = [...this.selectorConjuncts(row), ...membership];
    const statement = buildFind(
      scope,
      {
        ...(conjuncts.length > 0 ? { where: { AND: conjuncts } } : {}),
        select: this.keySelect(row),
        forUpdate: this.txMode,
      },
      { limit: 1, ...(membershipSql ? { predicate: membershipSql } : {}) }
    );
    const required = verb === "update" && node.required;
    const failure = this.targetFailure(row, "update");
    return {
      ...base,
      statement,
      outputs: {
        ...rows,
        ...(required || verb === "upsert"
          ? Object.fromEntries(
              this.keyFields(row).map((field) => [
                field,
                {
                  kind: "firstRowField",
                  field,
                  ...(verb === "upsert" ? { optional: true } : {}),
                },
              ])
            )
          : {}),
      },
      ...(required ? { expects: exactlyOneRow(failure) } : {}),
    };
  }

  /** The rows a group probe covers (child-held connect groups). */
  private groupOf(row: Row): Row[] {
    const id = this.rowIds.get(row.id)?.match;
    if (!id) return [row];
    return this.pattern.rows.filter(
      (r) => this.rowIds.get(r.id)?.match === id && this.edge(r.id)
    );
  }

  private relationRef(
    field: string,
    model: Model<any>,
    junctionTable?: string
  ): RelationRef {
    const scope = this.scope(model);
    const direct = lookupRelation(scope, field);
    if (direct) return direct;
    const carrier = variantCarrier(scope, field);
    if (carrier?.edge.kind === "variantJunctionCarrier") {
      const member =
        carrier.edge.members.find(
          (candidate) => candidate.topology.table === junctionTable
        ) ?? carrier.edge.members[0];
      if (member) return memberRef(carrier, member);
    }
    return {
      name: field,
      targetModel: model,
      cardinality: "many",
    } as RelationRef;
  }

  private targetFailure(
    row: Row,
    operation: "connect" | "delete" | "disconnect" | "set" | "update"
  ): Failure {
    const edge = this.edge(row.id);
    const field = edge?.reference.relation.field ?? this.pattern.operation;
    const relationRef = this.relationRef(
      field,
      edge?.reference.relation.model ?? row.table.model,
      edge?.junction === undefined
        ? undefined
        : this.row(edge.junction).table.table
    );
    return nestedWriteFailure(
      relationTargetNotFound(relationRef, operation),
      relationRef.name,
      false
    );
  }

  private replacementFailure(row: Row): Failure {
    const verb = this.verb(row);
    const field = this.edge(row.id)?.reference.relation.field ?? "";
    if (verb === "upsert") {
      return nestedWriteFailure(upsertPremiseChanged(field), field, false);
    }
    return nestedWriteFailure(
      nestedReplacement("connectOrCreate"),
      field,
      false
    );
  }

  /** The match phase's refusals: a decision that found nothing, a required locate that did. */
  private requireMatched(node: Node): void {
    if (!this.known) return;
    const row = this.row(node.row);
    if (!node.taken) return;
    // The root's own not-found is raised HERE, after the whole match phase —
    // today refuses from `compile`, so the level's other matches still run and
    // a nested refusal cannot pre-empt it.
    if (this.isRoot(row) && this.pattern.operation === "upsert") return;
    // A match the packer does not send answers nothing, so it refuses nothing:
    // its family's premise is the correlated write's own predicate.
    if (!this.packsMatch(row)) return;
    if (this.matchedRow(row) !== undefined) return;
    if (node.premise?.kind === "notExists") return;
    if (this.isRoot(row)) {
      throw new NotFoundError(
        this.stepModel(row.table.model),
        this.pattern.operation
      );
    }
    const verb = this.verb(row);
    // A merge's decision refuses nothing: the missing arm IS the answer.
    if (
      this.pattern.arms.some((a) => a.decision === row.id) &&
      (verb === "connectOrCreate" || verb === "upsert")
    ) {
      return;
    }
    const operation =
      verb === "delete" ||
      verb === "disconnect" ||
      verb === "update" ||
      verb === "set"
        ? verb
        : "connect";
    const failure = this.targetFailure(row, operation);
    throw new NestedWriteError(failure.message, failure.relation ?? "");
  }

  // -- premises and guards (§8.1) -------------------------------------------

  private premiseOf(node: Node, match: StatementStep): BoundPremise {
    const premise = this.refinePremise(node);
    const guard = this.guardOf(node, match);
    // ATOM §12's Pin Rule: a MISSING arm's premise is the constraint its own
    // INSERT violates — closer and stronger than a guard, and today emits none.
    const shape = this.guardShape(this.row(node.row));
    if (this.txMode || premise.kind === "notExists") {
      return { premise, shape, match, failure: guard.failure };
    }
    return { premise, shape, match, guard, failure: guard.failure };
  }

  private refinePremise(node: Node): Premise {
    let premise = node.premise ?? {
      kind: "exists",
      row: node.row,
      raceable: false,
    };
    const row = this.row(node.row);
    // A merge's premise follows the arm the world TOOK, not the mere existence
    // of a missing arm: found means the row is there (a guard pins it), missing
    // means the target's own unique constraint is the premise.
    if (this.known && this.pattern.arms.some((a) => a.decision === node.row)) {
      premise =
        this.matchedRow(row) === undefined
          ? { kind: "notExists", row: node.row, raceable: false }
          : { kind: "exists", row: node.row, raceable: false };
    }
    if (premise.kind !== "notExists") return premise;
    const where = this.selectorWhere(row);
    const race = where
      ? createRacePin(this.scope(row.table.model), where)
      : undefined;
    return race
      ? { kind: "notExists", row: node.row, raceable: true, pin: race.pin }
      : premise;
  }

  private capturedKeyFilter(row: Row): Where {
    return Object.fromEntries(
      Object.entries(this.keyValues(row)).map(([field, value]) => [
        field,
        { equals: value },
      ])
    );
  }

  /**
   * Is this row's identity CORRELATED — does a match-mode cell anywhere hold
   * its key, or does the row itself carry membership cells? That is the fact
   * behind the `membership` guard shape, and it is one rule over cells: a
   * child-held target carries its own membership, a parent-held one is held by
   * the enclosing row's columns, a junction one by its reference row.
   */
  private isCorrelated(row: Row): boolean {
    if (this.matchCells(row).length > 0) return true;
    // Variable IDENTITY, not bindingness: a selector that pins the key makes it
    // a literal, and the membership cell holding that same literal is still a
    // correlation.
    const key = new Set(row.key.map((variable) => variable.id));
    return this.pattern.cells.some(
      (cell) =>
        cell.mode === "match" && cell.row !== row.id && key.has(cell.value.id)
    );
  }

  /**
   * Which of K3's three shapes re-asserts this premise (§6, D6). The public
   * verb decides nothing here: a correlated identity is re-read as membership,
   * a row the write re-addresses by its CAPTURED key needs the split witness
   * (the captured row must still satisfy the selector), and anything else is
   * the match run again.
   */
  private guardShape(row: Row): GuardShape {
    if (this.isRoot(row)) {
      const where = this.selectorWhere(row) ?? {};
      const named = new Set(Object.keys(where));
      const namesKey = this.keyFields(row).every((field) => named.has(field));
      return namesKey || this.pattern.operation === "delete"
        ? "matchRerun"
        : "capturedSelector";
    }
    if (this.isCorrelated(row)) return "membership";
    const edge = this.edge(row.id);
    if (edge?.kind === "parentHeld") {
      // A discriminated target is named by a stored value the guard must
      // re-read; an ordinary one is the probe again.
      return edge.reference.discriminator ? "capturedSelector" : "matchRerun";
    }
    // A plain `connect` writes by the selector it was handed, so its guard is
    // that read again; every other membership-adding verb re-addresses the
    // captured key. (The one verb test left in this file's guard path.)
    return this.verb(row) === "connect" && edge?.kind !== "junction"
      ? "matchRerun"
      : "capturedSelector";
  }

  /** The failure a violated premise raises — the verb's own sentence. */
  private guardFailure(row: Row): Failure {
    const verb = this.verb(row);
    if (this.isRoot(row)) {
      if (this.pattern.operation === "upsert") {
        return notFoundFailure(
          `query-engine-v2 upsert located no '${this.rootName}' row for its unique where before the atomic batch.`
        );
      }
      if (this.pattern.operation === "delete") {
        return notFoundFailure(
          `query-engine-v2 delete located no '${this.stepModel(this.root.table.model)}' row for its unique where.`
        );
      }
      return this.rootNotFound();
    }
    if (verb === "connectOrCreate" || verb === "upsert") {
      return this.replacementFailure(row);
    }
    const operation =
      verb === "delete" ||
      verb === "disconnect" ||
      verb === "update" ||
      verb === "set"
        ? verb
        : "connect";
    return this.targetFailure(row, operation);
  }

  /**
   * The guard statement for one shape. Every spelling here is today's, and the
   * shape — not the verb — chooses between them.
   */
  private guardOf(node: Node, match: StatementStep): GuardStep {
    const row = this.row(node.row);
    const model = row.table.model;
    const scope = this.scope(model);
    const id = this.idOf(row.id, "guard");
    const shape = this.guardShape(row);
    const failure = this.guardFailure(row);
    const selector = this.selectorWhere(row) ?? {};
    const edge = this.edge(row.id);

    if (shape === "matchRerun") {
      if (this.isRoot(row) || edge?.kind === "childHeld") {
        return presenceGuard(
          id,
          buildFindUnique(scope, {
            where: selector,
            select: this.keySelect(row),
          }),
          failure
        );
      }
      return presenceGuard(id, match.statement, failure);
    }

    if (shape === "membership") {
      if (edge?.kind === "junction") {
        const { statements, bound } = this.junctionFor(
          edge.reference,
          edge.junction === undefined
            ? undefined
            : this.row(edge.junction).table.table
        );
        return presenceGuard(
          id,
          statements.materialize(bound, "membershipRead", {
            parentValue: this.keyValues(this.row(edge.parent)),
            whereUnique: selector,
            where: this.capturedKeyFilter(row),
            take: 1,
            select: this.keySelect(row),
          }),
          failure
        );
      }
      if (edge?.kind === "parentHeld") {
        const referencedFields = edge.reference.columns.map((c) =>
          this.fieldOf(model, c.referencedColumn)
        );
        return presenceGuard(
          id,
          buildFind(
            scope,
            {
              where: {
                AND: [
                  ...referencedFields.map((field) => ({
                    [field]: {
                      equals: this.parentHeldValue(row, field, false),
                    },
                  })),
                  this.capturedKeyFilter(row),
                ],
              },
              select: this.keySelect(row),
            },
            { limit: 1 }
          ),
          failure
        );
      }
      const conjuncts: Where[] = [
        ...this.selectorConjuncts(row),
        ...this.membershipFilters(row, false),
      ];
      if (this.verb(row) !== "disconnect") {
        conjuncts.push(this.capturedKeyFilter(row));
      }
      const membershipSql = this.membershipPredicate(
        row,
        scope.rootAlias,
        false
      );
      return presenceGuard(
        id,
        buildFind(
          scope,
          { where: { AND: conjuncts }, select: this.keySelect(row) },
          { limit: 1, ...(membershipSql ? { predicate: membershipSql } : {}) }
        ),
        failure
      );
    }

    // capturedSelector — the split witness: the captured row must STILL be the
    // one the selector names.
    if (this.isRoot(row)) {
      return presenceGuard(
        id,
        buildFind(
          scope,
          {
            where: {
              AND: [
                ...this.selectorConjuncts(row),
                this.capturedKeyFilter(row),
              ],
            },
            select: this.keySelect(row),
          },
          { limit: 1 }
        ),
        failure
      );
    }
    if (edge?.kind === "parentHeld") {
      return presenceGuard(
        id,
        buildFind(
          scope,
          {
            where: capturedSelectorWhere(scope, selector, this.keyValues(row)),
            select: this.select(
              edge.reference.columns.map((c) =>
                this.fieldOf(model, c.referencedColumn)
              )
            ),
            forUpdate: true,
          },
          { limit: 1 }
        ),
        failure
      );
    }
    if (edge?.kind === "junction") {
      return presenceGuard(
        id,
        buildFind(
          scope,
          {
            where: capturedSelectorWhere(scope, selector, this.keyValues(row)),
            select: this.keySelect(row),
          },
          { limit: 1 }
        ),
        failure
      );
    }
    // child-held: a merge also publishes the reference columns it decided on.
    const extraFields =
      this.verb(row) === "connectOrCreate" && edge
        ? edge.reference.columns.map((c) => this.fieldOf(model, c.holderColumn))
        : [];
    return presenceGuard(
      id,
      buildFind(
        scope,
        {
          where: {
            AND: [...this.selectorConjuncts(row), this.capturedKeyFilter(row)],
          },
          select: this.select([...this.keyFields(row), ...extraFields]),
        },
        { limit: 1 }
      ),
      failure
    );
  }

  // -- assignments (§7.1) ---------------------------------------------------

  /**
   * A row's assignment data and its private polymorphic storage: scalar cells
   * first, reference cells after them (ATOM §10), a discriminated reference as
   * one atomic `(type, id)` pair through the adapter's polymorphic storage.
   */
  private assignment(
    row: Row,
    cells: readonly Cell[]
  ): {
    data: Record<string, unknown>;
    polymorphicStorage: PolymorphicStorageValue<unknown>[];
  } {
    const model = row.table.model;
    const references = this.pattern.references.filter(
      (r) => r.holder === row.id
    );
    const referenceColumns = new Map<string, Reference>();
    for (const reference of references) {
      for (const pair of reference.columns) {
        referenceColumns.set(pair.holderColumn, reference);
      }
      if (reference.discriminator) {
        referenceColumns.set(reference.discriminator.column, reference);
      }
    }
    const ordered = [
      ...cells.filter((cell) => !referenceColumns.has(cell.column)),
      ...cells.filter((cell) => referenceColumns.has(cell.column)),
    ];
    const data: Record<string, unknown> = {};
    const polymorphicStorage: PolymorphicStorageValue<unknown>[] = [];
    const seenDiscriminated = new Set<Reference>();
    for (const cell of ordered) {
      const reference = referenceColumns.get(cell.column);
      if (reference?.discriminator) {
        if (seenDiscriminated.has(reference)) continue;
        seenDiscriminated.add(reference);
        polymorphicStorage.push(this.polymorphicValue(reference, cells));
        continue;
      }
      const field = this.fieldOf(model, cell.column);
      if (cell.mode === "retract") {
        data[field] = row.fresh ? null : { set: null };
        continue;
      }
      if (cell.relative) {
        data[field] = {
          [cell.relative.operation]: this.value(cell.relative.operand),
        };
        continue;
      }
      if (reference) {
        data[field] = referenceSql(
          this.engine,
          model,
          field,
          this.referenceValue(row, reference, cell)
        );
        continue;
      }
      const value = this.value(cell.value);
      data[field] = row.fresh ? value : { set: value };
    }
    return { data, polymorphicStorage };
  }

  /**
   * The value a reference cell stores: the referenced row's key. A target named
   * by a unique the reference does not store is looked up in place (today's
   * `toOneFkAssign` subquery) when the row itself holds the reference.
   */
  private referenceValue(row: Row, reference: Reference, cell: Cell): unknown {
    const target = this.row(reference.referenced);
    const variable = cell.value;
    if (
      variable.binding.kind === "matched" &&
      variable.binding.row === target.id &&
      this.edge(target.id)?.kind === "parentHeld" &&
      !this.isJunction(target)
    ) {
      const selector = this.selectorWhere(target);
      const field = this.fieldOf(target.table.model, variable.binding.column);
      if (selector && !Object.hasOwn(selector, field)) {
        const scope = {
          ...this.scope(row.table.model),
          mutationTable: getTableName(row.table.model),
        };
        return buildConnectSubqueryForField(
          scope,
          this.relationRef(reference.relation.field, reference.relation.model),
          selector,
          field
        );
      }
    }
    return this.value(variable);
  }

  private polymorphicValue(
    reference: Reference,
    cells: readonly Cell[]
  ): PolymorphicStorageValue<unknown> {
    const slot = resolvedSlot(
      this.scope(reference.relation.model),
      reference.relation.field
    );
    if (slot?.edge.kind !== "variantRowCarrier") {
      throw new QueryEngineError(
        `query-engine pattern: relation '${reference.relation.field}' has no row carrier for its discriminator.`
      );
    }
    const carrier = { slot: slot.edge.carrier, edge: slot.edge };
    const idCell = cells.find(
      (cell) => cell.column === reference.columns[0]?.holderColumn
    );
    if (!idCell || idCell.mode === "retract") {
      return {
        kind: "empty",
        carrier: carrier.slot,
        storage: carrier.edge.storage,
      };
    }
    const storage = carrier.edge.storage;
    const referencedField = this.fieldOf(
      this.row(reference.referenced).table.model,
      reference.columns[0]!.referencedColumn
    );
    return {
      kind: "linked",
      carrier: carrier.slot,
      storage,
      storedType: String(this.value(reference.discriminator!.value)),
      referencedField,
      id: referenceScalarSql(
        this.engine,
        storage.idColumn.scalar,
        storage.idColumn.name,
        this.value(idCell.value)
      ),
    };
  }

  // -- writes ----------------------------------------------------------------

  private projectionSelect(): Record<string, boolean> | undefined {
    const projection = this.pattern.projection;
    if (!projection) return undefined;
    return this.select(projection.scalars);
  }

  /**
   * The projection as the PUBLIC select shape the fold gates ask about: they
   * only test whether a key names a relation or `_count`, so the nested value
   * need not be the traversal's own arguments.
   */
  private publicSelect(): Record<string, unknown> | undefined {
    const projection = this.pattern.projection;
    if (!projection) return undefined;
    const select: Record<string, unknown> = this.select(projection.scalars);
    for (const relation of projection.relations) {
      select[relation.field] = { select: {} };
    }
    if (projection.relationCounts.length > 0) {
      select._count = {
        select: this.select(projection.relationCounts.map((c) => c.field)),
      };
    }
    return select;
  }

  private projectionIsScalarOnly(): boolean {
    const projection = this.pattern.projection;
    return (
      !projection ||
      (projection.relations.length === 0 &&
        projection.relationCounts.length === 0)
    );
  }

  private defaultSelect(
    model: Model<any>
  ): Record<string, boolean> | undefined {
    const fields = getDefaultScalarFieldNames(model);
    return fields.length === 0 ? undefined : this.select(fields);
  }

  private terminalFailure(): Failure {
    return queryFailure(
      `query-engine-v2 ${this.pattern.operation} terminal read expected exactly one row.`
    );
  }

  /** The root row's write: create, update, delete or a bulk form. */
  private rootWrite(node: Node): OperationStep[] {
    const row = this.root;
    const op = this.pattern.operation;
    if (op === "createMany" || op === "createManyAndReturn") {
      return this.createManyRoot();
    }
    if (op.startsWith("updateMany") || op.startsWith("deleteMany")) {
      return this.bulkRoot(node);
    }
    if (op === "delete") return this.deleteRoot();
    if (op === "upsert") return this.upsertRoot(node);
    if (row.fresh) return this.createRoot(node);
    return [this.updateRoot(node)];
  }

  /** The one-statement create (CreateOperation.foldStep). */
  private createFolds(): boolean {
    if (this.pattern.operation !== "create") return false;
    if (!this.returning || this.hasNestedRows()) return false;
    if (this.pattern.arms.some((a) => a.decision === this.root.id))
      return false;
    const scope = this.scope(this.root.table.model);
    return (
      this.projectionIsScalarOnly() ||
      (this.capabilities.supportsCteWithMutations &&
        !projectionReadsMutatedModel(scope, this.publicSelect(), undefined))
    );
  }

  /** The one-statement update (UpdateOperation.directWrite). */
  private updateFolds(): boolean {
    if (this.pattern.operation !== "update") return false;
    if (!this.returning || this.hasNestedRows()) return false;
    const node = this.node(this.root.id, "assert");
    if (!node || node.cells.length === 0) return false;
    const scope = this.scope(this.root.table.model);
    if (this.projectionIsScalarOnly()) return true;
    return (
      this.capabilities.supportsCteWithMutations &&
      !projectionReadsMutatedModel(scope, this.publicSelect(), undefined) &&
      !setCanFireReferentialAction(
        this.root.table.model,
        this.assignment(this.root, node.cells).data
      )
    );
  }

  /** The one-statement delete (DeleteOperation.foldStep). */
  private deleteFolds(): boolean {
    return (
      this.pattern.operation === "delete" &&
      this.returning &&
      this.projectionIsScalarOnly()
    );
  }

  private updateRoot(node: Node): WriteStep {
    const row = this.root;
    const model = row.table.model;
    const scope = this.scope(model);
    const { data, polymorphicStorage } = this.assignment(row, node.cells);
    const fknull = this.rowIds.get(row.id)?.extra.fknull;
    const onlyFkNull =
      fknull !== undefined &&
      node.cells.every((cell) => cell.mode === "retract");
    if (this.updateFolds()) {
      // One `UPDATE … WHERE <selector> RETURNING <select>`: no locate, no
      // terminal read, and the row is addressed by the caller's own selector.
      const scalarOnly = this.projectionIsScalarOnly();
      const where = this.selectorWhere(row) ?? {};
      return {
        id: this.idOf(row.id, "write"),
        kind: "write",
        statement: matchWriteResult(scope, {
          pattern: this.terminalPattern(),
          form: scalarOnly ? "returning" : "fold",
          mutation: buildUpdateStatement(scope, {
            where,
            data,
            polymorphicStorage,
          }),
        }),
        outputs: { result: { kind: "rows" } },
        ...(this.txMode
          ? { expects: affectedRows(1, this.rootNotFound()) }
          : {}),
      };
    }
    return {
      id: onlyFkNull ? fknull : this.idOf(row.id, "write"),
      kind: "write",
      model: getStepModelName(model, "parent"),
      statement: buildUpdate(scope, {
        where: this.keyWhere(row),
        data,
        polymorphicStorage,
        select: this.keySelect(row),
      }),
      outputs: {},
      ...(this.txMode && this.returning
        ? { expects: affectedRows(1, this.rootNotFound()) }
        : {}),
    };
  }

  private deleteRoot(): OperationStep[] {
    const row = this.root;
    const model = row.table.model;
    const scope = this.scope(model);
    const select = this.projectionSelect() ?? this.defaultSelect(model);
    const selector = this.selectorWhere(row) ?? {};
    if (this.returning && this.projectionIsScalarOnly()) {
      return [
        {
          id: this.idOf(row.id, "write"),
          kind: "write",
          statement: buildDelete(scope, {
            where: selector,
            ...(select ? { select } : {}),
          }),
          outputs: { result: { kind: "rows" } },
          ...(this.txMode
            ? { expects: affectedRows(1, this.rootNotFound()) }
            : {}),
        },
      ];
    }
    const where = this.txMode ? this.keyWhere(row) : selector;
    return [
      {
        id: this.extraId(row.id, "read"),
        kind: "read",
        statement: buildFindUnique(scope, {
          where,
          ...(select ? { select } : {}),
          forUpdate: this.txMode && this.projectionIsScalarOnly(),
        }),
        outputs: { result: { kind: "rows" } },
      },
      {
        id: this.idOf(row.id, "write"),
        kind: "write",
        statement: buildDelete(scope, { where }),
        outputs: {},
        ...(this.txMode
          ? { expects: affectedRows(1, this.rootNotFound()) }
          : {}),
      },
    ];
  }

  private bulkRoot(node: Node): OperationStep[] {
    const row = this.root;
    const model = row.table.model;
    const op = this.pattern.operation;
    const scope = this.scope(model);
    const table = getTableName(model);
    const predicate = lowerPredicate(
      { ...scope, mutationTable: table },
      row.predicate,
      table,
      true
    );
    const limit = this.pattern.projection?.window?.take;
    const args = {
      ...(predicate ? { predicate } : {}),
      ...(limit === undefined ? {} : { limit }),
    };
    const id = this.idOf(row.id, "write");
    if (op === "deleteMany") {
      return [
        {
          id,
          kind: "write",
          statement: buildDeleteMany(scope, args),
          outputs: { count: { kind: "rowCount" } },
        },
      ];
    }
    if (op === "deleteManyAndReturn") {
      return [
        {
          id,
          kind: "write",
          statement: matchWriteResult(scope, {
            pattern: this.terminalPattern("set"),
            form: "returning",
            mutation: buildDeleteMany(scope, args),
          }),
          outputs: { result: { kind: "rows" } },
        },
      ];
    }
    const { data } = this.assignment(row, node.cells);
    if (op === "updateMany") {
      return [
        {
          id,
          kind: "write",
          statement: buildUpdateMany(scope, { ...args, data }),
          outputs: { count: { kind: "rowCount" } },
        },
      ];
    }
    return [
      {
        id,
        kind: "write",
        statement: matchWriteResult(scope, {
          pattern: this.terminalPattern("set"),
          form: "returning",
          mutation: buildUpdateMany(scope, { ...args, data }),
        }),
        outputs: { result: { kind: "rows" } },
      },
    ];
  }

  /** Every top-level fresh row of the root's model with no incoming reference. */
  private createManyRows(): Row[] {
    return this.pattern.rows.filter(
      (r) =>
        r.fresh &&
        r.table.model === this.root.table.model &&
        !this.isJunction(r) &&
        !this.edge(r.id)
    );
  }

  private createManyRoot(): OperationStep[] {
    const rows = this.createManyRows();
    const scope = this.scope(this.root.table.model);
    const data = rows.map((r) => this.assignment(r, this.cellsOf(r.id)).data);
    const skipDuplicates = this.pattern.arms.some((arm) =>
      rows.some((r) => r.id === arm.decision)
    );
    const returnRows = this.pattern.operation === "createManyAndReturn";
    const select = this.projectionSelect();
    const plan = buildCreateManyPlan(
      scope,
      { data, skipDuplicates, ...(select ? { select } : {}) },
      returnRows,
      undefined,
      this.engine.maxBindParametersPerStatement
    );
    const recoverUnique =
      skipDuplicates &&
      this.engine.adapter.mutations.skipDuplicatesStrategy ===
        "recoverableUniqueError";
    const label = returnRows
      ? `${this.rootName}.createManyReturn`
      : `${this.rootName}.createMany`;
    return plan.statements.map(
      (statement): WriteStep => ({
        id: this.ids.allocate(label),
        kind: "write",
        statement: statement.sql,
        outputs: returnRows
          ? { result: { kind: "rows" } }
          : { count: { kind: "rowCount" } },
        ...(recoverUnique ? { onUniqueConflict: "skip" } : {}),
      })
    );
  }

  private upsertRoot(node: Node): OperationStep[] {
    // The scalar `ON CONFLICT` fold: no nested rows at all.
    const row = this.root;
    const missing = this.pattern.rows.find(
      (r) =>
        r.fresh &&
        r.arm !== undefined &&
        r.table.model === row.table.model &&
        !this.edge(r.id)
    );
    const others = this.pattern.rows.filter(
      (r) => r.id !== row.id && r.id !== missing?.id
    );
    if (
      !missing ||
      others.length > 0 ||
      !this.capabilities.supportsTargetedUpsert
    ) {
      throw new QueryEngineError(
        "query-engine pattern: upsert with nested rows is not packable yet"
      );
    }
    const scope = this.scope(row.table.model);
    const create = this.assignment(missing, this.cellsOf(missing.id)).data;
    const update = this.assignment(row, node.cells).data;
    return [
      {
        id: this.idOf(row.id, "write"),
        kind: "write",
        statement: buildUpsert(scope, {
          where: this.selectorWhere(row) ?? {},
          create,
          update,
          select: this.projectionSelect(),
        } as never),
        outputs: { result: { kind: "rows" } },
      },
    ];
  }

  /**
   * Whether the payload named any relation at all — today's fold gate
   * (`relations.length === 0` / `isPureScalar`). A parent-held verb writes no
   * row of its own but still puts a reference cell on the root, so both halves
   * are asked: any row beside the root, or any reference cell on it.
   */
  private hasNestedRows(): boolean {
    if (this.pattern.rows.some((r) => r.id !== this.root.id)) return true;
    if (this.pattern.references.some((r) => r.holder === this.root.id))
      return true;
    // A parent-held `disconnect` writes no row and pushes no reference: its one
    // trace is a RETRACT cell on the root (a scalar `null` is an assert cell).
    return this.retractCells(this.root).length > 0;
  }

  private createRoot(node: Node): OperationStep[] {
    const row = this.root;
    const model = row.table.model;
    const scope = this.scope(model);
    const { data, polymorphicStorage } = this.assignment(row, node.cells);
    const select = this.projectionSelect();
    const scalarOnly = this.projectionIsScalarOnly();
    const id = this.idOf(row.id, "write");
    const skipDuplicates = this.pattern.arms.some((a) => a.decision === row.id);
    const foldsCte =
      !scalarOnly &&
      this.capabilities.supportsCteWithMutations &&
      !projectionReadsMutatedModel(scope, select, undefined);
    if (
      !(this.hasNestedRows() || skipDuplicates) &&
      (scalarOnly || foldsCte) &&
      this.returning
    ) {
      return [
        {
          id,
          kind: "write",
          model: this.stepModel(model),
          statement: matchWriteResult(scope, {
            pattern: this.terminalPattern(),
            form: foldsCte ? "fold" : "returning",
            mutation: buildInsertStatement(scope, data, polymorphicStorage),
          }),
          outputs: { result: { kind: "rows" } },
          ...(this.txMode
            ? { expects: exactlyOneRow(this.terminalFailure()) }
            : {}),
        },
      ];
    }
    return [this.insertStep(row, id, data, polymorphicStorage, true)];
  }

  /** A generated key member of a fresh row, when the database assigns one. */
  private generatedField(row: Row): string | undefined {
    const fields = this.keyFields(row);
    const generated = row.key
      .map((variable, index) =>
        variable.binding.kind === "returned" ? fields[index] : undefined
      )
      .filter((field): field is string => field !== undefined);
    return generated.length === 1 ? generated[0] : undefined;
  }

  /**
   * One record INSERT (CreateOperation.buildInsertStep): plain when nothing
   * downstream needs a database-produced value; otherwise it publishes the
   * generated key through RETURNING or the driver's insert id.
   */
  private insertStep(
    row: Row,
    id: string,
    data: Record<string, unknown>,
    polymorphicStorage: readonly PolymorphicStorageValue<unknown>[],
    terminal: boolean
  ): WriteStep {
    const model = row.table.model;
    const scope = this.scope(model);
    const generated = this.generatedField(row);
    const demanded =
      generated !== undefined &&
      (terminal ||
        this.scheduled.nodes.some(
          (n) =>
            n.row !== row.id &&
            n.consumes.some((v) => {
              const variable = this.pattern.variables.find((x) => x.id === v);
              return (
                variable?.binding.kind === "returned" &&
                variable.binding.row === row.id
              );
            })
        ));
    const racePin = this.racePinOf(row);
    if (!demanded) {
      return {
        id,
        kind: "write",
        model: this.stepModel(model),
        statement: buildInsert(
          scope,
          getTableName(model),
          data,
          polymorphicStorage
        ),
        outputs: {},
        ...(racePin ? { racePin } : {}),
      };
    }
    const byReturning =
      this.returning &&
      (this.txMode ||
        !getAdapterInternals(this.engine.adapter).batchRefs.storeLastInsertId);
    if (byReturning) {
      return {
        id,
        kind: "write",
        model: this.stepModel(model),
        statement: buildCreate(scope, {
          data,
          ...(polymorphicStorage.length ? { polymorphicStorage } : {}),
          select: { [generated!]: true },
        } as never),
        outputs: { id: { kind: "firstRowField", field: generated! } },
        ...(racePin ? { racePin } : {}),
      };
    }
    return {
      id,
      kind: "write",
      model: this.stepModel(model),
      statement: buildInsert(
        scope,
        getTableName(model),
        data,
        polymorphicStorage
      ),
      outputs: { id: { kind: "insertId" } },
      ...(racePin ? { racePin } : {}),
    };
  }

  /** The missing arm's race pin: the decision selector's unique target. */
  private racePinOf(row: Row) {
    const decision = this.decisionOf(row);
    if (!(decision && row.fresh)) return undefined;
    const arm = this.pattern.arms.find((a) => a.id === row.arm);
    if (arm?.taken !== "missing") return undefined;
    const where = this.selectorWhere(decision);
    if (!where) return undefined;
    const race = createRacePin(this.scope(decision.table.model), where);
    if (!race) return undefined;
    const data = this.assignment(row, this.cellsOf(row.id)).data;
    const spells = race.values.every(({ fieldName, value }) =>
      Object.is(data[fieldName], value)
    );
    return spells ? race.pin : undefined;
  }

  /**
   * The row key the terminal read addresses, as LITERAL variables: the created
   * row's produced identity (a `Ref` lowered through the destination cast), or
   * the root's post-transition key.
   */
  private terminalKey(): Variable[] {
    const root = this.root;
    const model = root.table.model;
    const fields = this.keyFields(root);
    const key = root.newKey ?? root.key;
    return key.map((variable, index) => {
      const field = fields[index]!;
      const value =
        variable.binding.kind === "returned"
          ? referenceSql(
              this.engine,
              model,
              field,
              ref(this.idOf(root.id, "write"), "id")
            )
          : this.value(variable);
      return {
        id: -1 - index,
        binding: { kind: "literal", value },
        scalar: { model, field },
      };
    });
  }

  /**
   * The pattern the write's result is projected through: the asserted row at
   * its FINAL key, carrying this operation's projection. One value for all
   * three forms of {@link matchWriteResult}.
   */
  private terminalPattern(
    cardinality: "one" | "set" = "one",
    /** Only a reselect addresses the row: the other forms answer with the
     *  mutation's own rows, so their key need not be resolvable at all (a
     *  folded update by an alternate unique never located the row). */
    addressed = false
  ): Pattern {
    const root = this.root;
    return {
      root: root.id,
      rows: [
        {
          ...root,
          mode: "match",
          fresh: false,
          cardinality,
          key: addressed ? this.terminalKey() : (root.newKey ?? root.key),
          predicate: undefined,
          arm: undefined,
        } as Row,
      ],
      cells: [],
      references: [],
      arms: [],
      variables: [],
      ...(this.pattern.projection
        ? { projection: this.pattern.projection }
        : {}),
      operation: cardinality === "one" ? "findUnique" : "findMany",
    };
  }

  /**
   * The reselect's `WHERE` when the packer must spell it: a key member bound by
   * EXECUTION (a generated identity) is a value K1 cannot carry, so the row is
   * addressed by the reference the write published instead.
   */
  private terminalSelector(scope: QueryScope): Sql | undefined {
    const root = this.root;
    const key = root.newKey ?? root.key;
    if (!key.some((variable) => variable.binding.kind === "returned")) {
      return undefined;
    }
    const model = root.table.model;
    const fields = this.keyFields(root);
    const { adapter } = scope;
    return adapter.operators.and(
      ...key.map((variable, index) => {
        const field = fields[index]!;
        const value =
          variable.binding.kind === "returned"
            ? ref(this.idOf(root.id, "write"), "id")
            : this.value(variable);
        return adapter.operators.eq(
          adapter.identifiers.column(
            scope.rootAlias,
            getColumnName(model, field)
          ),
          referenceSql(this.engine, model, field, value)
        );
      })
    );
  }

  /**
   * The terminal read is the write's own result projection (§8, §9.1), lowered
   * by stream G in the `reselect` form: a relation projection, a `_count` and a
   * nested window are that traversal's bytes, never a second spelling here.
   */
  private terminalStep(): StatementStep | undefined {
    const root = this.root;
    const op = this.pattern.operation;
    const model = root.table.model;
    const scope = this.scope(model);
    const selector = this.terminalSelector(scope);
    return {
      id: this.idOf(root.id, "select"),
      kind: "read",
      ...(op === "create" ? { model: this.stepModel(model) } : {}),
      statement: matchWriteResult(scope, {
        pattern: this.terminalPattern("one", true),
        form: "reselect",
        ...(selector ? { selector } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(this.txMode
        ? { expects: exactlyOneRow(this.terminalFailure()) }
        : {}),
    };
  }

  // -- nested writes ---------------------------------------------------------

  /**
   * The public reference behind one K1 reference, with the VARIANT bound.
   *
   * A slot that spans several targets is not addressable by name — that is what
   * `lookupRelation` answering `undefined` means — so the member is chosen by
   * the fact that distinguishes it: a member junction by its own table, a
   * row-held variant by the discriminator's stored value. The member's
   * variant-qualified name (`items.post`) is what today's messages and step
   * labels carry.
   */
  private referenceOf(
    reference: Reference,
    junctionTable?: string
  ): { scope: QueryScope; relationRef: RelationRef | undefined } {
    const scope = this.scope(reference.relation.model);
    const direct = lookupRelation(scope, reference.relation.field);
    if (direct) return { scope, relationRef: direct };
    const carrier = variantCarrier(scope, reference.relation.field);
    if (carrier?.edge.kind === "variantJunctionCarrier") {
      const member =
        carrier.edge.members.find(
          (candidate) => candidate.topology.table === junctionTable
        ) ?? carrier.edge.members[0];
      if (member) return { scope, relationRef: memberRef(carrier, member) };
    }
    return { scope, relationRef: undefined };
  }

  private junctionFor(
    reference: Reference,
    junctionTable?: string
  ): {
    scope: QueryScope;
    bound: JunctionBoundRelation;
    statements: JunctionStatements;
  } {
    const { scope, relationRef } = this.referenceOf(reference, junctionTable);
    if (!relationRef) {
      throw new QueryEngineError(
        `query-engine pattern: relation '${reference.relation.field}' is not addressable`
      );
    }
    const carrier = variantCarrier(scope, reference.relation.field);
    const member =
      carrier?.edge.kind === "variantJunctionCarrier"
        ? (carrier.edge.members.find(
            (candidate) => candidate.topology.table === junctionTable
          ) ?? carrier.edge.members[0])
        : undefined;
    const bound =
      carrier?.edge.kind === "variantJunctionCarrier" && member
        ? bindMemberJunction(scope, relationRef, member, "owner")
        : bindRelation(scope, relationRef);
    if (bound.position !== "junction") {
      throw new QueryEngineError(
        `query-engine pattern: relation '${relationRef.name}' is not stored in a junction`
      );
    }
    return {
      scope,
      bound,
      statements: new JunctionStatements(scope, this.txMode),
    };
  }

  /** A junction row's target key, keyed by the target's referenced fields. */
  private junctionTargetValue(
    junction: Row,
    edge: Edge
  ): Record<string, unknown> {
    const target = this.row(edge.target);
    const cells = this.cellsOf(junction.id);
    return Object.fromEntries(
      edge.reference.columns.map((pair) => {
        const cell = cells.find((c) => c.column === pair.holderColumn);
        return [
          this.fieldOf(target.table.model, pair.referencedColumn),
          cell ? this.value(cell.value) : undefined,
        ];
      })
    );
  }

  private junctionInsertMany(
    run: readonly { junction: Row; edge: Edge }[],
    idForChunk: (start: number, index: number) => string
  ): WriteStep[] {
    const first = run[0]!;
    const { statements, bound } = this.junctionFor(
      first.edge.reference,
      this.row(first.junction.id).table.table
    );
    const parentValue = this.keyValues(this.row(first.edge.parent));
    const targetValues = run.map(({ junction, edge }) =>
      this.junctionTargetValue(junction, edge)
    );
    const chunks = compileBindBudgetChunks(
      targetValues.length,
      this.engine.maxBindParametersPerStatement,
      (start, end) =>
        statements.materialize(bound, "junctionInsertMany", {
          parentValue,
          targetValues: targetValues.slice(start, end),
        })
    );
    return chunks.map((chunk, index) => ({
      id: idForChunk(chunk.start, index),
      kind: "write",
      statement: chunk.statement,
      outputs: {},
    }));
  }

  private junctionWrite(junction: Row): OperationStep[] {
    const references = this.pattern.references.filter(
      (r) => r.holder === junction.id
    );
    const toParent = this.junctionParentEdge(junction)!;
    const toTarget = references.find((r) => r !== toParent);
    const target = toTarget ? this.row(toTarget.referenced) : undefined;
    const edge = target ? this.edge(target.id) : undefined;
    const { statements, bound } = this.junctionFor(
      toParent,
      junction.table.table
    );
    const parentValue = this.keyValues(this.row(toParent.referenced));
    const verb = this.verb(junction);
    if (junction.mode === "retract") {
      if (!target) {
        // set's clear-all, or an untargeted disconnect.
        const ids = this.rowIds.get(junction.id);
        const id = ids?.extra.clear;
        if (!id) return [];
        return [
          {
            id,
            kind: "write",
            statement: statements.materialize(bound, "junctionDelete", {
              parentValue,
            }),
            outputs: {},
          },
        ];
      }
      if (verb === "disconnect") {
        return [
          {
            id: this.idOf(target.id, "write"),
            kind: "write",
            statement: statements.materialize(bound, "junctionDelete", {
              parentValue,
              targetWhere: this.selectorWhere(target) ?? {},
            }),
            outputs: {},
          },
        ];
      }
      // delete: the reference rows of the captured target.
      return [
        {
          id: this.idOf(target.id, "write"),
          kind: "write",
          statement: statements.materialize(bound, "junctionDeleteTargets", {
            parentValue,
            targetValues: [this.keyValues(target)],
          }),
          outputs: {},
        },
      ];
    }
    if (!(target && edge)) return [];
    // assert: one membership row for one target (the multi-row fold is the caller's).
    const targetValue = this.junctionTargetValue(junction, edge);
    const insert = statements.materializeJunctionInsert(bound, {
      parentValue,
      targetValue,
    });
    const id =
      verb === "create" || verb === "createMany"
        ? this.extraId(target.id, "join")
        : this.idOf(target.id, "write");
    return [
      {
        id,
        kind: "write",
        statement: insert.statement,
        outputs: {},
        ...(insert.racePin ? { racePin: insert.racePin } : {}),
      },
    ];
  }

  private targetAssert(node: Node): OperationStep[] {
    const row = this.row(node.row);
    const edge = this.edge(row.id);
    const model = row.table.model;
    const scope = this.scope(model);
    const verb = this.verb(row);
    if (!edge) {
      // A createMany member beside the root: packed by the root.
      return [];
    }
    const { data, polymorphicStorage } = this.assignment(row, node.cells);
    if (row.fresh) {
      if (verb === "createMany" && edge.kind === "childHeld") {
        const group = this.pattern.rows.filter(
          (r) => r.fresh && this.sameEdgeGroup(row, r) && !this.folded.has(r.id)
        );
        if (group[0]?.id !== row.id) return [];
        for (const member of group.slice(1)) this.folded.add(member.id);
        const rows = group.map(
          (r) => this.assignment(r, this.cellsOf(r.id)).data
        );
        const skipDuplicates = this.pattern.arms.some((a) =>
          group.some((r) => r.id === a.decision)
        );
        const plan = buildCreateManyPlan(
          scope,
          { data: rows, skipDuplicates },
          false,
          undefined,
          this.engine.maxBindParametersPerStatement
        );
        const recoverUnique =
          skipDuplicates &&
          this.engine.adapter.mutations.skipDuplicatesStrategy ===
            "recoverableUniqueError";
        return plan.statements.map(
          (statement, index): WriteStep => ({
            id:
              index === 0
                ? this.idOf(row.id, "write")
                : this.ids.allocate(`${this.childName(row)}.createMany`),
            kind: "write",
            model: this.stepModel(model),
            statement: statement.sql,
            outputs: {},
            ...(recoverUnique ? { onUniqueConflict: "skip" } : {}),
          })
        );
      }
      const id =
        this.rowIds.get(row.id)?.write ??
        this.rowIds.get(this.decisionOf(row)?.id ?? -1)?.extra.create;
      if (!id) {
        throw new Error(
          `query-engine pattern: row ${row.id} has no 'write' step id`
        );
      }
      const skipDuplicates =
        verb === "createMany" &&
        this.pattern.arms.some((a) => a.decision === row.id);
      if (skipDuplicates) {
        const plan = buildCreateManyPlan(
          scope,
          { data: [data], skipDuplicates: true },
          false
        );
        return plan.statements.map((statement) => ({
          id,
          kind: "write" as const,
          model: this.stepModel(model),
          statement: statement.sql,
          outputs: {},
        }));
      }
      return [this.insertStep(row, id, data, polymorphicStorage, false)];
    }
    // Asserted at a bound key.
    const selector = this.selectorWhere(row);
    if (edge.kind === "childHeld") {
      if (verb === "connect" && !this.folded.has(row.id)) {
        const group = this.groupOf(row);
        if (group.length > 1) {
          return [
            {
              id: this.idOf(row.id, "write"),
              kind: "write",
              model: this.stepModel(model),
              statement: buildUpdateMany(scope, {
                where: linkGroupSelector(
                  scope,
                  group.map((r) => this.selectorWhere(r) ?? {})
                ),
                data,
                ...(polymorphicStorage.length ? { polymorphicStorage } : {}),
              }),
              outputs: {},
            },
          ];
        }
        return [
          {
            id: this.idOf(row.id, "write"),
            kind: "write",
            model: this.stepModel(model),
            statement: buildUpdate(scope, {
              where: selector ?? this.keyWhere(row),
              data,
              ...(polymorphicStorage.length ? { polymorphicStorage } : {}),
              select: this.keySelect(row),
            }),
            outputs: {},
          },
        ];
      }
      if (verb === "connect") return [];
      if (verb === "set") {
        if (row.cardinality === "set") {
          // The departures: null the reference for N \ S.
          const targets = this.pattern.rows.filter(
            (r) => r.cardinality !== "set" && this.sameEdgeGroup(row, r)
          );
          const membership = this.membershipFilters(row, false);
          const exclusions = targets.map((r) => this.selectorConjuncts(r));
          const where: Where = {
            AND: [
              ...membership,
              ...(exclusions.length > 0
                ? [
                    {
                      NOT: {
                        OR: exclusions.map((conjuncts) =>
                          conjuncts.length === 1
                            ? conjuncts[0]!
                            : { AND: conjuncts }
                        ),
                      },
                    },
                  ]
                : []),
            ],
          };
          return [
            {
              id: this.extraId(row.id, "orphan"),
              kind: "write",
              model: this.stepModel(model),
              statement: buildUpdateMany(scope, { where, data }),
              outputs: {},
            },
          ];
        }
        const group = this.pattern.rows.filter(
          (r) => r.cardinality !== "set" && this.sameEdgeGroup(row, r)
        );
        if (group[0]?.id !== row.id) return [];
        return [
          {
            id: this.idOf(row.id, "write"),
            kind: "write",
            model: this.stepModel(model),
            statement: buildUpdateMany(scope, {
              where: linkGroupSelector(
                scope,
                group.map((r) => this.selectorWhere(r) ?? {})
              ),
              data,
            }),
            outputs: {},
          },
        ];
      }
      if (verb === "disconnect") {
        if (!selector) {
          return [
            {
              id: this.idOf(row.id, "write"),
              kind: "write",
              model: this.stepModel(model),
              statement: buildUpdateMany(scope, {
                ...this.memberSet(row),
                data,
              }),
              outputs: {},
            },
          ];
        }
        return [
          {
            id: this.idOf(row.id, "write"),
            kind: "write",
            model: this.stepModel(model),
            statement: buildUpdate(scope, {
              where: selector,
              data,
              select: this.keySelect(row),
            }),
            outputs: {},
          },
        ];
      }
      if (verb === "updateMany") {
        return [
          {
            id: this.idOf(row.id, "write"),
            kind: "write",
            model: this.stepModel(model),
            statement: buildUpdateMany(scope, {
              ...this.memberSet(row),
              data,
            }),
            outputs: {},
          },
        ];
      }
      // update / connectOrCreate found / upsert found: by the captured key.
      const extraFields =
        verb === "connectOrCreate"
          ? edge.reference.columns.map((c) =>
              this.fieldOf(model, c.holderColumn)
            )
          : [];
      return [
        {
          id: this.idOf(row.id, "write"),
          kind: "write",
          model: this.stepModel(model),
          statement: buildUpdate(scope, {
            where: this.keyWhere(row),
            data,
            ...(polymorphicStorage.length ? { polymorphicStorage } : {}),
            select: this.select([...this.keyFields(row), ...extraFields]),
          }),
          outputs: {},
        },
      ];
    }
    if (edge.kind === "parentHeld") {
      // update / upsert found: the located member by its captured key.
      return [
        {
          id: this.idOf(row.id, "write"),
          kind: "write",
          model: this.stepModel(model),
          statement: buildUpdate(scope, {
            where: this.keyWhere(row),
            data,
            select: this.keySelect(row),
          }),
          outputs: {},
        },
      ];
    }
    // junction target update
    return [
      {
        id: this.idOf(row.id, "write"),
        kind: "write",
        model: this.stepModel(model),
        statement: buildUpdate(scope, {
          where: this.keyWhere(row),
          data,
          select: this.keySelect(row),
        }),
        outputs: {},
      },
    ];
  }

  /** Membership ∧ filter for a bulk verb under a parent. */
  private memberSet(row: Row): { where?: Where; predicate?: Sql } {
    const model = row.table.model;
    const membership = this.membershipFilters(row, false);
    const membershipSql = this.membershipPredicate(
      row,
      getTableName(model),
      false
    );
    if (this.hasRelationLeaf(row.predicate)) {
      const table = getTableName(model);
      const predicate = lowerPredicate(
        { ...this.scope(model), mutationTable: table },
        row.predicate,
        table,
        true
      );
      return {
        ...(membership.length ? { where: { AND: membership } } : {}),
        ...(predicate ? { predicate } : {}),
      };
    }
    const filter = this.filterWhere(model, row.predicate);
    const conjuncts = [...membership, ...(filter ? [filter] : [])];
    return {
      ...(conjuncts.length ? { where: { AND: conjuncts } } : {}),
      ...(membershipSql ? { predicate: membershipSql } : {}),
    };
  }

  private targetRetract(node: Node): OperationStep[] {
    const row = this.row(node.row);
    const edge = this.edge(row.id);
    if (!edge) return [];
    const model = row.table.model;
    const scope = this.scope(model);
    const verb = this.verb(row);
    if (edge.kind === "parentHeld") {
      return [
        {
          id: this.idOf(row.id, "write"),
          kind: "write",
          model: this.stepModel(model),
          statement: buildDeleteMany(scope, {
            where: {
              AND: Object.entries(this.keyValues(row)).map(
                ([field, value]) => ({
                  [field]: { equals: value },
                })
              ),
            },
          }),
          outputs: {},
        },
      ];
    }
    if (edge.kind === "junction") {
      // The reference row's delete is packed with the reference row; the child follows.
      if (verb === "deleteMany") {
        return [
          {
            id: this.idOf(row.id, "write"),
            kind: "write",
            model: this.stepModel(model),
            statement: buildDeleteMany(scope, {
              where: {
                AND: [
                  {
                    [this.keyFields(row)[0]!]: {
                      in: [this.keyValues(row)[this.keyFields(row)[0]!]],
                    },
                  },
                ],
              },
            }),
            outputs: {},
          },
        ];
      }
      return [
        {
          id: this.extraId(row.id, "child"),
          kind: "write",
          model: this.stepModel(model),
          statement: buildDelete(scope, {
            where: this.keyWhere(row),
            ...(this.defaultSelect(model)
              ? { select: this.defaultSelect(model) }
              : {}),
          }),
          outputs: {},
        },
      ];
    }
    // child-held
    if (verb === "deleteMany" || !row.predicate) {
      return [
        {
          id: this.idOf(row.id, "write"),
          kind: "write",
          model: this.stepModel(model),
          statement: buildDeleteMany(scope, this.memberSet(row)),
          outputs: {},
        },
      ];
    }
    const select = this.defaultSelect(model);
    return [
      {
        id: this.idOf(row.id, "write"),
        kind: "write",
        model: this.stepModel(model),
        statement: buildDelete(scope, {
          where: this.selectorWhere(row) ?? this.keyWhere(row),
          ...(select ? { select } : {}),
        }),
        outputs: {},
      },
    ];
  }

  // -- the write phase ------------------------------------------------------

  private writeSteps(nodes: readonly Node[]): OperationStep[] {
    const steps: OperationStep[] = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (!node.taken) continue;
      const row = this.row(node.row);
      switch (node.kind) {
        case "assert": {
          if (this.isJunction(row)) {
            const edge = this.junctionEdge(row);
            const verb = this.verb(row);
            if (edge && (verb === "connect" || verb === "set")) {
              const run = [{ junction: row, edge }];
              while (index + 1 < nodes.length) {
                const next = nodes[index + 1]!;
                const nextRow = this.row(next.row);
                const nextEdge = this.junctionEdge(nextRow);
                if (
                  next.kind !== "assert" ||
                  !next.taken ||
                  !this.isJunction(nextRow) ||
                  !nextEdge ||
                  nextEdge.parent !== edge.parent ||
                  nextEdge.reference.relation.field !==
                    edge.reference.relation.field ||
                  this.verb(nextRow) !== verb
                ) {
                  break;
                }
                run.push({ junction: nextRow, edge: nextEdge });
                index++;
              }
              const setInsert =
                verb === "set"
                  ? this.pattern.rows.find(
                      (r) =>
                        this.isJunction(r) &&
                        r.mode === "retract" &&
                        this.rowIds.get(r.id)?.extra.insert !== undefined
                    )
                  : undefined;
              steps.push(
                ...this.junctionInsertMany(run, (start, chunk) =>
                  setInsert && chunk === 0
                    ? this.extraId(setInsert.id, "insert")
                    : this.idOf(run[start]!.edge.target, "write")
                )
              );
              break;
            }
            steps.push(...this.junctionWrite(row));
            break;
          }
          if (this.isRoot(row)) {
            steps.push(...this.rootWrite(node));
            break;
          }
          steps.push(...this.targetAssert(node));
          break;
        }
        case "retract":
          if (this.isJunction(row)) steps.push(...this.junctionWrite(row));
          else if (this.isRoot(row)) steps.push(...this.rootWrite(node));
          else steps.push(...this.targetRetract(node));
          break;
        case "terminal": {
          if (!this.packsTerminal()) break;
          const terminal = this.terminalStep();
          if (terminal) steps.push(terminal);
          break;
        }
        default:
          break;
      }
    }
    return steps;
  }

  /** The target edge of a junction row (its reference to the row that is not the parent). */
  private junctionEdge(junction: Row): Edge | undefined {
    const toParent = this.junctionParentEdge(junction);
    const toTarget = this.pattern.references.find(
      (r) => r.holder === junction.id && r !== toParent
    );
    if (!toTarget) return undefined;
    return this.edge(toTarget.referenced);
  }

  /** Create-tree fold: one CTE statement when every write is a plain arm (CreateOperation.buildTreeFold). */
  private foldCreateTree(
    matches: readonly StatementStep[],
    guards: readonly GuardStep[],
    writes: readonly OperationStep[]
  ): OperationStep[] | undefined {
    if (this.pattern.operation !== "create") return undefined;
    if (!(this.capabilities.supportsCteWithMutations && this.returning))
      return undefined;
    if (matches.length > 0 || guards.length > 0) return undefined;
    const statementWrites = writes.filter(
      (step): step is WriteStep => step.kind === "write"
    );
    const terminal = writes.find((step) => step.kind === "read");
    const rootId = this.idOf(this.root.id, "write");
    if (statementWrites.length < 2 || statementWrites[0]?.id !== rootId) {
      return undefined;
    }
    if (writes.length !== statementWrites.length + (terminal ? 1 : 0))
      return undefined;
    if (this.pattern.arms.some((a) => a.decision === this.root.id))
      return undefined;
    if (
      !statementWrites.every(
        (step) =>
          isSql(step.statement) && !(step.expects || step.onUniqueConflict)
      )
    ) {
      return undefined;
    }
    const scope = this.scope(this.root.table.model);
    const mutated = new Set(
      statementWrites.map((step) => {
        const row = this.pattern.rows.find(
          (r) => this.rowIds.get(r.id)?.write === step.id
        );
        return row ? getTableName(row.table.model) : "";
      })
    );
    if (projectionReadsAnyTable(scope, this.publicSelect(), undefined, mutated))
      return undefined;
    const siblings = compileMutationDependencyFold(scope, statementWrites);
    if (!siblings) return undefined;
    const rootNode = this.node(this.root.id, "assert")!;
    const { data, polymorphicStorage } = this.assignment(
      this.root,
      rootNode.cells
    );
    const racePin = statementWrites[0]?.racePin;
    return [
      {
        id: rootId,
        kind: "write",
        model: this.stepModel(this.root.table.model),
        statement: matchWriteResult(scope, {
          pattern: this.terminalPattern(),
          form: "fold",
          mutation: buildInsertStatement(scope, data, polymorphicStorage),
          siblings,
        }),
        outputs: { result: { kind: "rows" } },
        ...(racePin ? { racePin } : {}),
        ...(this.txMode
          ? { expects: exactlyOneRow(this.terminalFailure()) }
          : {}),
      },
    ];
  }

  // -- program --------------------------------------------------------------

  private fragment(scheduled: ScheduledFragment): Fragment {
    const matches = scheduled.matches.map((level) =>
      level
        .filter(
          (node) =>
            !this.folded.has(node.row) && this.packsMatch(this.row(node.row))
        )
        .map((node) => this.matchStep(node))
    );
    for (const node of scheduled.matches.flat()) this.requireMatched(node);
    const premises: BoundPremise[] = [];
    for (const node of scheduled.matches.flat()) {
      if (!node.taken) continue;
      const row = this.row(node.row);
      // A premise protects the bindings a PACKED match produced; a family whose
      // probe today's engine never sends states none.
      if (!(this.packsMatch(row) || this.foldGuards(row))) continue;
      if (!this.rowIds.get(node.row)?.guard) continue;
      premises.push(this.premiseOf(node, this.matchStep(node)));
    }
    let writes = this.writeSteps(scheduled.writes);
    if (this.folded.has(this.root.id)) writes = [];
    const guards = premises.flatMap((p) => (p.guard ? [p.guard] : []));
    const folded = this.foldCreateTree(matches.flat(), guards, writes);
    if (folded) writes = folded;
    return {
      matches,
      writes,
      premises,
      pack: (known) => {
        const repacked = new Packing(
          this.scheduled,
          this.engine,
          new StepIds(),
          known
        ).fragment(scheduled);
        return { writes: repacked.writes, premises: repacked.premises };
      },
      inherited: [],
      boundary: scheduled.boundary,
    };
  }

  /**
   * A folded root keeps its batch premise even though its match is not packed:
   * the guard IS the fold's presence premise inside the atomic unit.
   */
  private foldGuards(row: Row): boolean {
    return (
      this.isRoot(row) &&
      !this.txMode &&
      (this.deleteFolds() || this.updateFolds())
    );
  }

  program(): Program {
    const fragments = this.scheduled.fragments.map((fragment) =>
      this.fragment(fragment)
    );
    return {
      fragments,
      outputs: this.programOutputs(fragments),
      model: this.stepModel(this.root.table.model),
      operation: this.pattern.operation,
    };
  }

  private programOutputs(
    fragments: readonly Fragment[]
  ): Record<
    string,
    OperationValueReference | readonly OperationValueReference[]
  > {
    const op = this.pattern.operation;
    const steps = fragments.flatMap((f) => f.writes);
    if (op === "createMany" || op === "createManyAndReturn") {
      const name = op === "createMany" ? "count" : "result";
      return {
        [name]: steps
          .filter((s): s is WriteStep => s.kind === "write")
          .map((s) => ref(s.id, name)),
      };
    }
    if (op === "updateMany" || op === "deleteMany") {
      const id = this.idOf(this.root.id, "write");
      return { count: ref(id, "count") };
    }
    if (op === "updateManyAndReturn" || op === "deleteManyAndReturn") {
      return { result: ref(this.idOf(this.root.id, "write"), "result") };
    }
    // The last step publishing `result` owns the program's result.
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index]!;
      if (
        step.kind !== "guard" &&
        step.kind !== "recordSeries" &&
        step.outputs.result
      ) {
        return { result: ref(step.id, "result") };
      }
    }
    const producer =
      this.rowIds.get(this.root.id)?.select ??
      this.rowIds.get(this.root.id)?.write;
    return producer ? { result: ref(producer, "result") } : {};
  }
}

/** The flat step list an atomic-batch executor runs: guards first, then writes. */
export function fragmentSteps(fragment: Fragment): OperationStep[] {
  const guards = fragment.premises.flatMap((premise) =>
    premise.guard ? [premise.guard] : []
  );
  return [...guards, ...fragment.writes];
}
