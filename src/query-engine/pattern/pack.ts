/**
 * E — the packer (pattern-engine-ideal-state.md §7, §8.1, §13.3 unit E).
 *
 * Cell groups (already decided by the scheduler) become statements through the
 * EXISTING adapter methods and lowering helpers: `buildFindUnique` / `buildFind`
 * for matches, `buildUpdate` / `buildCreate` / `buildDelete` for row asserts and
 * retracts, `JunctionStatements` for junction rows, `referenceSql` for reference
 * cells, `compileBindBudgetChunks` for the bulk fold. Premises become the batch
 * guards the current Parts emit; where the pinned guard is not the match re-run
 * the premise carries it explicitly (§8 review, failure 1).
 *
 * Every refusal here is a packing-time refusal (§7.4): it runs after legality
 * and keeps today's class and message.
 */
import { NestedWriteError, NotFoundError } from "@errors";
import type { Model } from "@schema/model";
import { getColumnName } from "@schema/model";
import { compileBindBudgetChunks } from "../bind-budget";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../builders/correlation-utils";
import { bindRelation } from "../builders/relation-data-builder";
import { createQueryScope, lookupRelation } from "../context/query-scope";
import { JunctionStatements } from "../JunctionStatements";
import {
  buildCreate,
  buildDelete,
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../operations";
import type { QueryEngine } from "../query-engine";
import type { QueryScope } from "../types";
import { createRacePin } from "../write-engine/create-race-pin";
import {
  affectedRows,
  exactlyOneRow,
  nestedWriteFailure,
  notFoundFailure,
  presenceGuard,
  queryFailure,
  referenceSql,
} from "../write-engine/fragment-builders";
import { relationTargetNotFound } from "../write-engine/messages";
import {
  type GuardStep,
  type OperationStep,
  ref,
  type StatementStep,
  type WriteStep,
} from "../write-engine/OperationFragment";
import type { PlanningKnown } from "../write-engine/Part";
import { planningKey } from "../write-engine/Part";
import { parseCapturedRows } from "../write-engine/series-result-read";
import {
  capturedSelectorWhere,
  getStepModelName,
  uniqueSelectorConjuncts,
} from "../write-engine/shared";
import type { BoundPremise, Fragment, Premise, Program } from "./fragment";
import { type StepIds, stepLabels } from "./ids";
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
// Row ids — the label scheme, allocated in payload order (§12.3, F17)
// ---------------------------------------------------------------------------

interface RowIds {
  readonly match?: string;
  readonly write?: string;
  readonly guard?: string;
  readonly select?: string;
}

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
  private readonly rootName: string;

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
    this.rootName = getStepModelName(
      this.row(this.pattern.root).table.model,
      "parent"
    );
    this.allocateIds();
  }

  // -- structure ------------------------------------------------------------

  private row(id: RowId): Row {
    const row = this.rows.get(id);
    if (!row)
      throw new Error(`query-engine pattern: unknown row ${id} in pack`);
    return row;
  }

  private holderReferences(row: RowId): Reference[] {
    return this.pattern.references.filter((r) => r.holder === row);
  }

  private referencesTo(row: RowId): Reference[] {
    return this.pattern.references.filter((r) => r.referenced === row);
  }

  /** A fresh row whose only cells are reference cells (D1's junction row). */
  private isJunction(row: Row): boolean {
    if (!row.fresh) return false;
    const references = this.holderReferences(row.id);
    if (references.length < 2) return false;
    const columns = new Set(
      references.flatMap((r) => r.columns.map((c) => c.holderColumn))
    );
    const cells = this.cells.get(row.id) ?? [];
    return cells.length > 0 && cells.every((cell) => columns.has(cell.column));
  }

  private relationField(row: RowId): string {
    const reference =
      this.pattern.references.find(
        (r) =>
          (r.referenced === row || r.holder === row) &&
          r.holder !== r.referenced
      ) ?? undefined;
    return reference?.relation.field ?? this.pattern.operation;
  }

  private childName(row: Row): string {
    return getStepModelName(row.table.model, this.relationField(row.id));
  }

  private node(row: RowId, kind: Node["kind"]): Node | undefined {
    return this.scheduled.nodes.find((n) => n.row === row && n.kind === kind);
  }

  /**
   * The label sequences the current constructors allocate, per row shape, in
   * payload order. See ids.ts for the inventory.
   */
  private allocateIds(): void {
    const root = this.row(this.pattern.root);
    const rootMatch = this.node(root.id, "match");
    const rootIds: {
      match?: string;
      write?: string;
      guard?: string;
      select?: string;
    } = {};
    if (rootMatch)
      rootIds.match = this.ids.allocate(stepLabels.locate(this.rootName));
    if (root.mode === "retract") {
      rootIds.write = this.ids.allocate(stepLabels.delete(this.rootName));
    } else if (root.fresh) {
      rootIds.write = this.ids.allocate(stepLabels.create(this.rootName));
    } else if (this.node(root.id, "assert")) {
      rootIds.write = this.ids.allocate(stepLabels.update(this.rootName));
    }
    if (this.pattern.projection) {
      rootIds.select = this.ids.allocate(stepLabels.select(this.rootName));
    }
    if (rootMatch)
      rootIds.guard = this.ids.allocate(stepLabels.guardExists(this.rootName));
    this.rowIds.set(root.id, rootIds);

    for (const row of this.pattern.rows) {
      if (row.id === root.id || this.isJunction(row)) continue;
      const child = this.childName(row);
      const ids: { match?: string; write?: string; guard?: string } = {};
      const matched = this.node(row.id, "match") !== undefined;
      const referencedByJunction = this.referencesTo(row.id).some((r) =>
        this.isJunction(this.row(r.holder))
      );
      const holdsReference = this.holderReferences(row.id).length > 0;
      if (row.mode === "match" && referencedByJunction) {
        // RelationJunctionPart.buildTargetSlot: find, guard.exists, <kind>, delete.child
        ids.match = this.ids.allocate(stepLabels.find(child));
        ids.guard = this.ids.allocate(stepLabels.guardExists(child));
        ids.write = this.ids.allocate(stepLabels.connect(child));
        this.ids.allocate(stepLabels.deleteChild(child));
      } else if (row.mode === "match") {
        // RecordUpdateCompiler.interpretToOneLink: find, guard.exists (the FK folds)
        ids.match = this.ids.allocate(stepLabels.find(child));
        ids.guard = this.ids.allocate(stepLabels.guardExists(child));
      } else if (row.fresh) {
        ids.write = this.ids.allocate(stepLabels.create(child));
      } else if (matched && holdsReference) {
        // RelationLinkPart: find, connect, guard.exists
        ids.match = this.ids.allocate(stepLabels.find(child));
        ids.write = this.ids.allocate(stepLabels.connect(child));
        ids.guard = this.ids.allocate(stepLabels.guardExists(child));
      } else {
        if (matched) ids.match = this.ids.allocate(stepLabels.find(child));
        ids.write = this.ids.allocate(
          row.mode === "retract"
            ? stepLabels.delete(child)
            : stepLabels.update(child)
        );
        ids.guard = this.ids.allocate(stepLabels.guardExists(child));
      }
      this.rowIds.set(row.id, ids);
    }
  }

  private idOf(row: RowId, which: keyof RowIds): string {
    const id = this.rowIds.get(row)?.[which];
    if (!id) {
      throw new Error(
        `query-engine pattern: row ${row} has no '${which}' step id`
      );
    }
    return id;
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

  private keySelect(row: Row): Record<string, boolean> {
    return Object.fromEntries(
      this.keyFields(row).map((field) => [field, true])
    );
  }

  /** The decoded first row of a match, through the existing captured-row parser. */
  private matchedRow(row: RowId): Record<string, unknown> | undefined {
    if (this.decoded.has(row)) return this.decoded.get(row);
    const target = this.row(row);
    const raw = this.known?.[planningKey(this.idOf(row, "match"), "rows")];
    const rows = Array.isArray(raw)
      ? parseCapturedRows(
          this.engine,
          target.table.model,
          raw,
          this.keySelect(target)
        )
      : [];
    this.decoded.set(row, rows[0]);
    return rows[0];
  }

  private value(variable: Variable): unknown {
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
        const field = this.fieldOf(
          this.row(binding.row).table.model,
          binding.column
        );
        if (!this.known) return ref(this.idOf(binding.row, "match"), field);
        const row = this.matchedRow(binding.row);
        if (!row) {
          throw new NestedWriteError(
            `query-engine-v2 ${this.pattern.operation} for relation '${this.relationField(binding.row)}' could not resolve its parent id.`,
            this.relationField(binding.row)
          );
        }
        return row[field];
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

  private keyValues(
    row: Row,
    key: readonly Variable[] = row.key
  ): Record<string, unknown> {
    const fields = this.keyFields(row);
    const values: Record<string, unknown> = {};
    key.forEach((variable, index) => {
      const field = fields[index];
      if (field !== undefined) values[field] = this.value(variable);
    });
    return values;
  }

  private keyWhere(
    row: Row,
    key: readonly Variable[] = row.key
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      row.table.model,
      this.keyValues(row, key)
    );
  }

  // -- predicates -----------------------------------------------------------

  private whereOf(
    model: Model<any>,
    predicate: Predicate | undefined
  ): Record<string, unknown> {
    if (!predicate) return {};
    switch (predicate.kind) {
      case "scalar": {
        const field = this.fieldOf(model, predicate.column);
        const operand = Array.isArray(predicate.operand)
          ? (predicate.operand as readonly Variable[]).map((v) => this.value(v))
          : this.value(predicate.operand as Variable);
        if (predicate.operator === "equals" && predicate.mode === undefined) {
          return { [field]: operand };
        }
        return {
          [field]: {
            [predicate.operator]: operand,
            ...(predicate.mode ? { mode: predicate.mode } : {}),
          },
        };
      }
      case "and": {
        const items = predicate.items.map((item) => this.whereOf(model, item));
        const merged: Record<string, unknown> = {};
        for (const item of items) {
          for (const [key, value] of Object.entries(item)) {
            if (Object.hasOwn(merged, key)) return { AND: items };
            merged[key] = value;
          }
        }
        return merged;
      }
      case "or":
        return { OR: predicate.items.map((item) => this.whereOf(model, item)) };
      case "not":
        return { NOT: this.whereOf(model, predicate.item) };
      default:
        throw new Error(
          `query-engine pattern: predicate kind '${predicate.kind}' is not packable yet`
        );
    }
  }

  private isUniqueSelector(
    scope: QueryScope,
    where: Record<string, unknown>
  ): boolean {
    try {
      uniqueSelectorConjuncts(scope, where);
      return true;
    } catch {
      return false;
    }
  }

  // -- matches --------------------------------------------------------------

  private matchStep(node: Node): StatementStep {
    const row = this.row(node.row);
    const cached = this.matchSteps.get(row.id);
    if (cached) return cached;
    const model = row.table.model;
    const scope = this.scope(model);
    const where = this.whereOf(model, row.predicate);
    const select = this.keySelect(row);
    const isRoot = row.id === this.pattern.root;
    const statement = this.isUniqueSelector(scope, where)
      ? buildFindUnique(scope, { where, select, forUpdate: this.txMode })
      : buildFind(
          scope,
          { where, select, forUpdate: this.txMode },
          { limit: 1 }
        );
    const step: StatementStep = {
      id: this.idOf(row.id, "match"),
      kind: "read",
      ...(isRoot ? {} : { model: getStepModelName(model, "record") }),
      statement,
      outputs: {
        rows: { kind: "rows" },
        ...(node.required
          ? Object.fromEntries(
              this.keyFields(row).map((field) => [
                field,
                { kind: "firstRowField", field },
              ])
            )
          : {}),
      },
      ...(node.required ? { expects: exactlyOneRow(this.rootNotFound()) } : {}),
    };
    this.matchSteps.set(row.id, step);
    return step;
  }

  private rootNotFound() {
    return notFoundFailure(
      `query-engine-v2 ${this.pattern.operation} located no '${this.rootName}' row for its unique where.`
    );
  }

  private relationRefOf(reference: Reference) {
    const scope = this.scope(reference.relation.model);
    const relationRef = lookupRelation(scope, reference.relation.field);
    if (!relationRef) {
      throw new Error(
        `query-engine pattern: relation '${reference.relation.field}' is not addressable`
      );
    }
    return { scope, relationRef };
  }

  /** The reference through which a matched target hangs (the holder's edge to it). */
  private incomingReference(row: RowId): Reference | undefined {
    return this.referencesTo(row)[0];
  }

  private targetFailure(row: RowId) {
    const reference = this.incomingReference(row);
    if (!reference) return this.rootNotFound();
    const { relationRef } = this.relationRefOf(reference);
    return nestedWriteFailure(
      relationTargetNotFound(relationRef, "connect"),
      relationRef.name,
      false
    );
  }

  /** The match phase's refusals: a decision that found nothing, a required locate that did. */
  private requireMatched(node: Node): void {
    if (!this.known) return;
    const row = this.row(node.row);
    if (!node.taken) return;
    const found = this.matchedRow(row.id) !== undefined;
    if (found) return;
    if (node.premise?.kind === "notExists") return;
    if (node.required) {
      throw new NotFoundError(
        getStepModelName(row.table.model, "record"),
        this.pattern.operation
      );
    }
    const reference = this.incomingReference(row.id);
    if (!reference) return;
    const { relationRef } = this.relationRefOf(reference);
    throw new NestedWriteError(
      relationTargetNotFound(relationRef, "connect"),
      relationRef.name
    );
  }

  // -- premises and guards (§8.1) -------------------------------------------

  private premiseOf(node: Node, match: StatementStep): BoundPremise {
    const premise = this.refinePremise(node);
    if (this.txMode) return { premise, match };
    return { premise, match, guard: this.guardOf(node, match) };
  }

  private refinePremise(node: Node): Premise {
    const premise = node.premise ?? {
      kind: "exists",
      row: node.row,
      raceable: false,
    };
    if (premise.kind !== "notExists") return premise;
    const row = this.row(node.row);
    const race = createRacePin(
      this.scope(row.table.model),
      this.whereOf(row.table.model, row.predicate)
    );
    return race
      ? { kind: "notExists", row: node.row, raceable: true, pin: race.pin }
      : premise;
  }

  private guardOf(node: Node, match: StatementStep): GuardStep {
    const row = this.row(node.row);
    const model = row.table.model;
    const scope = this.scope(model);
    const where = this.whereOf(model, row.predicate);
    const id = this.idOf(row.id, "guard");
    if (node.required) {
      // UpdateOperation.buildRootPresenceGuard.
      const named = new Set(Object.keys(where));
      const namesKey = this.keyFields(row).every((field) => named.has(field));
      const captured = this.keyValues(row);
      const statement = namesKey
        ? buildFindUnique(scope, { where, select: this.keySelect(row) })
        : buildFind(
            scope,
            {
              where: {
                AND: [
                  ...uniqueSelectorConjuncts(scope, where),
                  Object.fromEntries(
                    Object.entries(captured).map(([field, value]) => [
                      field,
                      { equals: value },
                    ])
                  ),
                ],
              },
              select: this.keySelect(row),
            },
            { limit: 1 }
          );
      return presenceGuard(id, statement, this.rootNotFound());
    }
    const referencedByJunction = this.referencesTo(row.id).some((r) =>
      this.isJunction(this.row(r.holder))
    );
    if (referencedByJunction) {
      // RelationJunctionPart.capturedSelectorRead — the pinned guard is not the
      // match re-run (split-witness correlation on the captured key).
      return presenceGuard(
        id,
        buildFind(
          scope,
          {
            where: capturedSelectorWhere(scope, where, this.keyValues(row)),
            select: this.keySelect(row),
          },
          { limit: 1 }
        ),
        this.targetFailure(row.id)
      );
    }
    // The match re-run: RecordUpdateCompiler.compileToOneConnect / RelationLinkPart.
    return presenceGuard(id, match.statement, this.targetFailure(row.id));
  }

  // -- writes (§7.1–§7.3) ---------------------------------------------------

  private assignmentData(
    row: Row,
    cells: readonly Cell[]
  ): Record<string, unknown> {
    const model = row.table.model;
    const referenceColumns = new Set(
      this.holderReferences(row.id).flatMap((r) =>
        r.columns.map((c) => c.holderColumn)
      )
    );
    // Scalar assignments first, derived reference assignments after them
    // (ATOM §10: "Derived FK parameters follow user scalar parameters").
    const ordered = [
      ...cells.filter((cell) => !referenceColumns.has(cell.column)),
      ...cells.filter((cell) => referenceColumns.has(cell.column)),
    ];
    const data: Record<string, unknown> = {};
    for (const cell of ordered) {
      const field = this.fieldOf(model, cell.column);
      if (cell.mode === "retract") {
        data[field] = { set: null };
        continue;
      }
      if (cell.relative) {
        data[field] = {
          [cell.relative.operation]: this.value(cell.relative.operand),
        };
        continue;
      }
      const value = this.value(cell.value);
      if (referenceColumns.has(cell.column)) {
        data[field] = referenceSql(this.engine, model, field, value);
        continue;
      }
      // The set builder consumes the validated update vocabulary (`{ set }`);
      // the insert builder consumes plain values.
      data[field] = row.fresh ? value : { set: value };
    }
    return data;
  }

  private assertStep(node: Node): WriteStep {
    const row = this.row(node.row);
    const model = row.table.model;
    const scope = this.scope(model);
    const isRoot = row.id === this.pattern.root;
    const id = this.idOf(row.id, "write");
    const data = this.assignmentData(row, node.cells);
    if (row.fresh) {
      return {
        id,
        kind: "write",
        model: getStepModelName(model, "record"),
        statement: buildCreate(scope, { data, select: this.keySelect(row) }),
        outputs: {},
      };
    }
    const where =
      isRoot || !row.predicate
        ? this.keyWhere(row)
        : this.whereOf(model, row.predicate);
    const enforce =
      isRoot &&
      this.txMode &&
      this.engine.adapter.capabilities.supportsReturning;
    return {
      id,
      kind: "write",
      model: getStepModelName(model, isRoot ? "parent" : "record"),
      statement: buildUpdate(scope, {
        where,
        data,
        select: this.keySelect(row),
      }),
      outputs: {},
      ...(enforce ? { expects: affectedRows(1, this.rootNotFound()) } : {}),
    };
  }

  private retractStep(node: Node): WriteStep {
    const row = this.row(node.row);
    const scope = this.scope(row.table.model);
    return {
      id: this.idOf(row.id, "write"),
      kind: "write",
      model: getStepModelName(row.table.model, "record"),
      statement: buildDelete(scope, { where: this.keyWhere(row) }),
      outputs: {},
    };
  }

  /** §7.2: consecutive junction rows of one edge pack into one chunked INSERT. */
  private junctionSteps(run: readonly Node[]): WriteStep[] {
    const first = this.row(run[0]!.row);
    const references = this.holderReferences(first.id);
    const source = references.find(
      (r) => this.row(r.referenced).table.model === r.relation.model
    );
    const target = references.find((r) => r !== source);
    if (!(source && target)) {
      throw new Error(
        "query-engine pattern: a junction row needs two references"
      );
    }
    const { scope, relationRef } = this.relationRefOf(source);
    const bound = bindRelation(scope, relationRef);
    if (bound.position !== "junction") {
      throw new Error(
        `query-engine pattern: relation '${relationRef.name}' is not stored in a junction`
      );
    }
    const statements = new JunctionStatements(scope, this.txMode);
    const sideValues = (
      row: RowId,
      members: readonly { junctionField: string; referencedField: string }[]
    ) => {
      const cells = this.cells.get(row) ?? [];
      return Object.fromEntries(
        members.map((member) => {
          const cell = cells.find((c) => c.column === member.junctionField);
          if (!cell) {
            throw new Error(
              `query-engine pattern: junction row ${row} lacks column '${member.junctionField}'`
            );
          }
          return [member.referencedField, this.value(cell.value)];
        })
      );
    };
    const parentValue = sideValues(first.id, bound.membership.source.members);
    const targetValues = run.map((node) =>
      sideValues(node.row, bound.membership.target.members)
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
    return chunks.map((chunk) => ({
      id: this.idOf(this.targetRowOf(run[chunk.start]!.row, source), "write"),
      kind: "write",
      statement: chunk.statement,
      outputs: {},
    }));
  }

  private targetRowOf(junction: RowId, source: Reference): RowId {
    const target = this.holderReferences(junction).find((r) => r !== source);
    if (!target)
      throw new Error("query-engine pattern: junction row without a target");
    return target.referenced;
  }

  private sameJunctionEdge(a: Node, b: Node): boolean {
    const rowA = this.row(a.row);
    const rowB = this.row(b.row);
    if (rowA.table.table !== rowB.table.table) return false;
    const sourceA = this.holderReferences(rowA.id).find(
      (r) => this.row(r.referenced).table.model === r.relation.model
    );
    const sourceB = this.holderReferences(rowB.id).find(
      (r) => this.row(r.referenced).table.model === r.relation.model
    );
    return (
      sourceA !== undefined &&
      sourceB !== undefined &&
      sourceA.referenced === sourceB.referenced &&
      sourceA.relation.field === sourceB.relation.field
    );
  }

  private terminalStep(): StatementStep {
    const root = this.row(this.pattern.root);
    const projection = this.pattern.projection;
    const select = Object.fromEntries(
      (projection?.scalars ?? this.keyFields(root)).map((field) => [
        field,
        true,
      ])
    );
    return {
      id: this.idOf(root.id, "select"),
      kind: "read",
      statement: buildFindUnique(this.scope(root.table.model), {
        where: this.keyWhere(root, root.newKey ?? root.key),
        select,
      }),
      outputs: { result: { kind: "rows" } },
      ...(this.txMode
        ? {
            expects: exactlyOneRow(
              queryFailure(
                `query-engine-v2 ${this.pattern.operation} terminal read expected exactly one row.`
              )
            ),
          }
        : {}),
    };
  }

  private writeSteps(nodes: readonly Node[]): OperationStep[] {
    const steps: OperationStep[] = [];
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (!node.taken) continue;
      switch (node.kind) {
        case "assert": {
          const row = this.row(node.row);
          if (this.isJunction(row)) {
            const run = [node];
            while (
              index + 1 < nodes.length &&
              nodes[index + 1]!.kind === "assert" &&
              nodes[index + 1]!.taken &&
              this.isJunction(this.row(nodes[index + 1]!.row)) &&
              this.sameJunctionEdge(node, nodes[index + 1]!)
            ) {
              run.push(nodes[++index]!);
            }
            steps.push(...this.junctionSteps(run));
            break;
          }
          steps.push(this.assertStep(node));
          break;
        }
        case "retract":
          steps.push(this.retractStep(node));
          break;
        case "terminal":
          steps.push(this.terminalStep());
          break;
        case "cascade":
        case "unreferenced":
        case "match":
          break;
        default:
          break;
      }
    }
    return steps;
  }

  // -- program --------------------------------------------------------------

  private fragment(scheduled: ScheduledFragment): Fragment {
    const matches = scheduled.matches.map((level) =>
      level.map((node) => this.matchStep(node))
    );
    for (const node of scheduled.matches.flat()) this.requireMatched(node);
    const premises: BoundPremise[] = [];
    for (const node of scheduled.matches.flat()) {
      if (!node.taken) continue;
      premises.push(this.premiseOf(node, this.matchStep(node)));
    }
    return {
      matches,
      writes: this.writeSteps(scheduled.writes),
      premises,
      inherited: [],
      boundary: scheduled.boundary,
    };
  }

  program(): Program {
    const fragments = this.scheduled.fragments.map((fragment) =>
      this.fragment(fragment)
    );
    const root = this.row(this.pattern.root);
    const rootIds = this.rowIds.get(root.id);
    // K3 spells a published output as `<step>.<output>` (the executor's
    // `planningKey` address); the existing fragment contract carries the same
    // address as an `OperationValueReference`. The differential compares the
    // two modulo that spelling — see the K3 note in the report.
    const producer = rootIds?.select ?? rootIds?.write;
    return {
      fragments,
      outputs: producer ? { result: `${producer}.result` } : {},
      model: getStepModelName(root.table.model, "record"),
      operation: this.pattern.operation,
    };
  }
}

/** The flat step list an atomic-batch executor runs: guards first, then writes. */
export function fragmentSteps(fragment: Fragment): OperationStep[] {
  const guards = fragment.premises.flatMap((premise) =>
    premise.guard ? [premise.guard] : []
  );
  return [...guards, ...fragment.writes];
}
