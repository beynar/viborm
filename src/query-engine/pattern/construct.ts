/**
 * C — construction: a VALIDATED write payload → `Pattern`
 * (pattern-engine-ideal-state.md §5, §13 unit C).
 *
 * The walk reads the operation schemas' OUTPUT (never a schema, never raw
 * input) and emits rows, cells, references and arms in exactly the order ATOM
 * §5/§6 define: the root, its scalar cells, then every relation key — the
 * single-reference families in payload key order, then the payload-bound
 * (variant) families in payload key order — and inside a key the verbs in the
 * fixed order of the sugar table, recursing into nested records. Variables are
 * allocated in that walk order and bound once (D4); a key that changes is a
 * second set of variables on `Row.newKey`.
 *
 * Three rules hold everywhere in this file:
 *
 *  1. No verb name below the sugar table: every verb is a `VerbRow` whose plan
 *     is interpreted by {@link Construction.apply}; the interpreter branches on
 *     PRIMITIVES and on cell-map facts, never on a verb.
 *  2. No storage word: which row holds a reference, in which columns, whether
 *     it is a reference row of its own, whether a discriminator selects the
 *     table — all of it is read from `ReferenceCells` fields. The census test
 *     greps this file.
 *  3. Construction is TOTAL. It throws only `ValidationError`, and only for a
 *     shape the validated payload cannot carry (a missing `data`). Every shape
 *     today's engine refuses at construction is recorded in
 *     `Constructed.deferredRefusals` for the scheduler and packer to raise
 *     after legality (§5 rule 3, §19 order).
 */
import { ValidationError } from "@errors";
import type { Model } from "@schema/model";
import {
  findAddressableKey,
  getColumnName,
  getModelKeyCatalog,
  getTableName,
} from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import type { Operation } from "../types";
import {
  type ReferenceCells,
  type ReferenceFamily,
  referenceCells,
} from "./cells";
import type {
  Arm,
  ArmId,
  Binding,
  Cell,
  Extension,
  Mode,
  Pattern,
  Predicate,
  Projection,
  Reference,
  Row,
  RowId,
  TableRef,
  Variable,
} from "./pattern";
import {
  ABSOLUTE_UPDATE_KEY,
  isVerb,
  locatedBy,
  type PayloadShape,
  referenceRowLabel,
  type Step,
  toOneComposition,
  VERB_ORDER,
  type Verb,
  type VerbItem,
  verbRow,
  writeLabel,
} from "./sugar";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type WriteOperation =
  | "create"
  | "update"
  | "delete"
  | "upsert"
  | "createMany"
  | "createManyAndReturn"
  | "updateMany"
  | "updateManyAndReturn"
  | "deleteMany"
  | "deleteManyAndReturn";

/** The K2 entry point, injected so a harness may wrap or replace the view. */
export type CellsView = (
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string
) => ReferenceFamily;

export interface ConstructInput {
  readonly index: ResolvedRelationIndex;
  readonly model: Model<any>;
  readonly operation: WriteOperation;
  /** The operation schema's OUTPUT for this operation (defaults materialised). */
  readonly validatedArgs: Record<string, unknown>;
  readonly cells?: CellsView;
}

/**
 * A refusal today's engine raises at construction that §5 rule 3 moves after
 * legality. `stage: "legality"` refusals are the two §19 admits before OwnWrite
 * (portable primary key, relation-key legality); `stage: "packing"` refusals
 * are unsupported shapes the packer raises after legality. `error` names the
 * class today's engine throws, so the differential can reproduce it exactly.
 */
export interface DeferredRefusal {
  readonly stage: "legality" | "packing";
  readonly kind: string;
  readonly relation?: string;
  readonly path: string;
  readonly message: string;
  readonly error:
    | "NestedWriteError"
    | "QueryEngineError"
    | "UnsupportedOperationError";
  /**
   * Present when today's text names a fact only execution knows (the number
   * of captured roots): the raiser substitutes it. `message` then carries the
   * smallest count the refusal fires at.
   */
  readonly messageFor?: (recordCount: number) => string;
  /**
   * The merge arm this refusal belongs to. An arm-scoped refusal is raised ONLY
   * when that arm is the one taken: today defers a found arm's admits behind
   * its decision (ATOM §19 — "an upsert found arm runs deferred update legality
   * only when found; a missing create arm does not analyze the untaken update
   * subtree"). Absent means unconditional.
   */
  readonly arm?: ArmId;
}

export interface Constructed {
  readonly pattern: Pattern;
  readonly deferredRefusals: readonly DeferredRefusal[];
}

/** Per-fragment construction (§5 rule 1): one pattern per bulk member. */
export interface MemberConstructInput<Raw> {
  readonly index: ResolvedRelationIndex;
  readonly model: Model<any>;
  readonly operation: Extract<
    WriteOperation,
    "createMany" | "createManyAndReturn" | "updateMany" | "updateManyAndReturn"
  >;
  readonly cells?: CellsView;
  /** The retained RAW members (rows for createMany, captured roots for updateMany). */
  readonly members: readonly Raw[];
  /**
   * The parse boundary for ONE member, run when that member's fragment opens:
   * returns the member's validated `{ data, where?, select? }` with its
   * generated defaults materialised for that member alone — exactly how
   * `CreateManyRecordSeries` hands `CreateOperation` a parsed row and
   * `UpdateManyRecordSeries` hands `UpdateOperation` a captured root.
   */
  readonly parseMember: (raw: Raw, position: number) => Record<string, unknown>;
}

export function constructPattern(input: ConstructInput): Constructed {
  const construction = new Construction(input);
  return construction.run();
}

export function constructMemberPatterns<Raw>(
  input: MemberConstructInput<Raw>
): readonly Constructed[] {
  const operation: WriteOperation = input.operation.startsWith("create")
    ? "create"
    : "update";
  return input.members.map((raw, position) =>
    constructPattern({
      index: input.index,
      model: input.model,
      operation,
      validatedArgs: input.parseMember(raw, position),
      ...(input.cells ? { cells: input.cells } : {}),
    })
  );
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

interface RowDraft {
  readonly id: RowId;
  readonly table: TableRef;
  mode: Mode;
  cardinality: "one" | "set";
  key: readonly Variable[];
  newKey?: readonly Variable[];
  readonly fresh: boolean;
  arm?: ArmId;
  predicate?: Predicate;
  matchIsDecision?: boolean;
  /** The public verb that produced the row (message-only, K1 `Row.verb`). */
  verb?: string;
  /** K1 `Row.located`: how this row's identity is obtained. */
  located?: "probe" | "correlated" | "none";
  /** K1 `Row.label`: the step label its statements carry. */
  label?: string;
}

interface Context {
  readonly parent: RowDraft;
  /** The whole family the edge resolves to (every variant, for a set-wide clear). */
  readonly family: ReferenceFamily;
  /** The one reference the item binds. */
  readonly cells: ReferenceCells;
  readonly item: VerbItem;
  readonly shape: PayloadShape;
  readonly path: string;
  /** The public verb whose plan is running — stamped on the rows it creates, for messages only. */
  readonly verb?: string;
  readonly arm?: ArmId;
  /** The target row a previous step bound. */
  target?: RowDraft;
  /** The reference row a membership match bound (retracted with the target). */
  referenceRow?: RowDraft;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The root operations whose one statement carries the whole set (§7.2). */
const BULK_OPERATIONS: ReadonlySet<string> = new Set([
  "createMany",
  "updateMany",
  "deleteMany",
]);

const RELATION_QUANTIFIERS = ["some", "every", "none", "is", "isNot"] as const;
type Quantifier = (typeof RELATION_QUANTIFIERS)[number];
const BOOLEAN_KEYS = new Set(["AND", "OR", "NOT"]);
const ARITHMETIC_UPDATE_KEYS = [
  "set",
  "increment",
  "decrement",
  "multiply",
  "divide",
] as const;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

class Construction {
  private readonly index: ResolvedRelationIndex;
  private readonly model: Model<any>;
  private readonly operation: WriteOperation;
  private readonly args: Record<string, unknown>;
  private readonly view: CellsView;

  private readonly rows: RowDraft[] = [];
  private readonly cellList: Cell[] = [];
  private readonly references: Reference[] = [];
  private readonly arms: Arm[] = [];
  private readonly variables: Variable[] = [];
  private readonly deferred: DeferredRefusal[] = [];
  private projection: Projection | undefined;

  constructor(input: ConstructInput) {
    this.index = input.index;
    this.model = input.model;
    this.operation = input.operation;
    this.args = input.validatedArgs;
    this.view = input.cells ?? referenceCells;
  }

  run(): Constructed {
    const root = this.root();
    // Every row a verb plan created is already stamped; what is left is the
    // root and its arms, whose public verb is the operation itself.
    for (const row of this.rows) {
      row.verb ??= this.operation;
      // A fresh row needs no identity; anything else the plan did not classify
      // is addressed by its own selector — the root's `where`, and the rows a
      // bulk statement carries its predicate for (the packer folds those two
      // probes into the write, which is a shape decision, not a verb one).
      row.located ??= row.fresh ? "none" : "probe";
      this.stampLabel(row, row.verb, row.id === root.id);
    }
    this.projection = this.projectionFrom(
      this.model,
      this.args.select,
      this.args.include,
      root
    );
    return {
      pattern: this.pattern(root.id, this.projection),
      deferredRefusals: this.deferred,
    };
  }

  // ---- the root ----------------------------------------------------------

  private root(): RowDraft {
    switch (this.operation) {
      case "create":
        return this.freshRow(this.model, this.requireRecord("data"), "data");
      case "update": {
        const root = this.matchedRow(this.model, {
          selector: this.requireRecord("where"),
          cardinality: "one",
          decision: false,
          path: "where",
        });
        this.portablePrimaryKey(this.args.data, "data");
        this.record(root, this.requireRecord("data"), "atKey", "data");
        return root;
      }
      case "delete": {
        const root = this.matchedRow(this.model, {
          selector: this.requireRecord("where"),
          cardinality: "one",
          decision: false,
          path: "where",
        });
        root.mode = "retract";
        return root;
      }
      case "upsert": {
        const decision = this.matchedRow(this.model, {
          selector: this.requireRecord("where"),
          cardinality: "one",
          decision: true,
          path: "where",
        });
        const found = this.arm(decision, "found");
        const missing = this.arm(decision, "missing");
        const update = this.requireRecord("update");
        // Today runs an upsert's §19 admits inside ONE deferred thunk that the
        // FOUND arm calls, and builds that thunk only when the update arm has
        // relation work of its own. Both halves are reproduced: the refusal is
        // tagged with the found arm, and a scalar-only update arm records none.
        if (this.writesRelations(this.model, update)) {
          this.portablePrimaryKey(update, "update", found);
        }
        this.record(decision, update, "atKey", "update", found);
        this.freshRow(
          this.model,
          this.requireRecord("create"),
          "create",
          missing
        );
        return decision;
      }
      case "createMany":
      case "createManyAndReturn": {
        const data = this.args.data;
        const rows = Array.isArray(data) ? data.filter(isRecord) : [];
        const skip = this.args.skipDuplicates === true;
        let first: RowDraft | undefined;
        for (const [position, row] of rows.entries()) {
          const fresh = this.freshRow(this.model, row, `data.${position}`);
          if (skip) this.skipDuplicates(fresh);
          first ??= fresh;
        }
        return first ?? this.newRow(this.model, "assert", "set", true);
      }
      case "updateMany":
      case "updateManyAndReturn": {
        // The set-valued key variable (§7.2): one match over the predicate.
        const root = this.matchedRow(this.model, {
          ...(isRecord(this.args.where) ? { filter: this.args.where } : {}),
          cardinality: "set",
          decision: false,
          path: "",
        });
        this.portablePrimaryKey(this.args.data, "data");
        this.record(root, this.requireRecord("data"), "atKey", "data");
        return root;
      }
      case "deleteMany":
      case "deleteManyAndReturn": {
        const root = this.matchedRow(this.model, {
          ...(isRecord(this.args.where) ? { filter: this.args.where } : {}),
          cardinality: "set",
          decision: false,
          path: "",
        });
        root.mode = "retract";
        return root;
      }
      default: {
        const exhaustive: never = this.operation;
        throw new ValidationError(String(exhaustive) as Operation, [
          { path: "root", message: `Unknown write operation '${exhaustive}'.` },
        ]);
      }
    }
  }

  private requireRecord(key: string): Record<string, unknown> {
    const value = this.args[key];
    if (isRecord(value)) return value;
    throw new ValidationError(this.operation as Operation, [
      { path: key, message: `Expected '${key}' to be an object.` },
    ]);
  }

  // ---- rows, variables, cells ------------------------------------------

  private variable(
    binding: Binding,
    scalar?: { readonly model: Model<any>; readonly field: string }
  ): Variable {
    const variable: Variable = {
      id: this.variables.length,
      binding,
      ...(scalar ? { scalar } : {}),
    };
    this.variables.push(variable);
    return variable;
  }

  private literal(
    value: unknown,
    scalar?: { readonly model: Model<any>; readonly field: string }
  ): Variable {
    return this.variable({ kind: "literal", value }, scalar);
  }

  private newRow(
    model: Model<any>,
    mode: Mode,
    cardinality: "one" | "set",
    fresh: boolean,
    arm?: ArmId,
    table: string = getTableName(model),
    referenceRow = false
  ): RowDraft {
    const row: RowDraft = {
      id: this.rows.length,
      table: { model, table, ...(referenceRow ? { referenceRow: true } : {}) },
      mode,
      cardinality,
      key: [],
      fresh,
      ...(arm === undefined ? {} : { arm }),
    };
    this.rows.push(row);
    return row;
  }

  /**
   * The step name a model's statements carry: its declared name, as the write
   * engine's own `getStepModelName` reads it. Inlined rather than imported so
   * construction keeps no dependency on the engine it replaces.
   */
  private stepName(model: Model<any>): string {
    const names = model["~"].names;
    return names.ts ?? names.sql ?? getTableName(model);
  }

  /**
   * Stamp K1's `label` on a row: `<model>.<write label>`, the id today's engine
   * gives that row's statements. A BULK root is the one shape with no model
   * half — today names it by the operation alone (`updateMany`).
   */
  private stampLabel(row: RowDraft, verb: string, isRoot = false): void {
    if (row.label !== undefined) return;
    const name = this.stepName(row.table.model);
    if (isRoot && BULK_OPERATIONS.has(verb)) {
      // A bulk root that PROJECTS rows is routed to the returning arm, which
      // today names with the model; the plain form is the operation alone.
      const projects =
        this.args.select !== undefined || this.args.include !== undefined;
      row.label = projects
        ? `${name}.${verb}Return`
        : verb === "createMany"
          ? `${name}.${verb}`
          : verb;
      return;
    }
    // The ROOT is named by its operation, whatever its arms write: an upsert's
    // statement is `<name>.upsert` even where the found arm's update is a
    // second, separately named statement.
    row.label = `${name}.${isRoot ? verb : writeLabel(verb, row.fresh)}`;
  }

  private arm(decision: RowDraft, taken: Arm["taken"]): ArmId {
    const arm: Arm = { id: this.arms.length, decision: decision.id, taken };
    this.arms.push(arm);
    return arm.id;
  }

  private keyFields(model: Model<any>): readonly string[] {
    return getModelKeyCatalog(model).rowKey?.fields ?? [];
  }

  private cell(
    row: RowDraft,
    column: string,
    value: Variable,
    mode: Mode,
    arm?: ArmId,
    relative?: Cell["relative"]
  ): Cell {
    const cell: Cell = {
      row: row.id,
      column,
      value,
      mode,
      ...(relative ? { relative } : {}),
      ...(arm === undefined ? {} : { arm }),
    };
    this.cellList.push(cell);
    return cell;
  }

  /**
   * A row asserted at a fresh key: every key member the payload spells is a
   * literal; every other member is bound by the database when the row is
   * asserted (`returned`). Then its record, recursively.
   */
  private freshRow(
    model: Model<any>,
    data: Record<string, unknown>,
    path: string,
    arm?: ArmId
  ): RowDraft {
    const row = this.newRow(model, "assert", "one", true, arm);
    row.key = this.keyFields(model).map((field) =>
      data[field] === undefined
        ? this.variable(
            {
              kind: "returned",
              row: row.id,
              column: getColumnName(model, field),
            },
            { model, field }
          )
        : this.literal(data[field], { model, field })
    );
    this.record(row, data, "fresh", path, arm);
    return row;
  }

  /**
   * A row located by a match. A key member the selector pins is a literal
   * (the row is selected); every other member is bound by the match.
   */
  private matchedRow(
    model: Model<any>,
    options: {
      readonly selector?: Record<string, unknown>;
      readonly filter?: Record<string, unknown>;
      readonly cardinality: "one" | "set";
      readonly decision: boolean;
      readonly path: string;
      readonly arm?: ArmId;
    }
  ): RowDraft {
    const row = this.newRow(
      model,
      "match",
      options.cardinality,
      false,
      options.arm
    );
    const pinned = this.pinnedKeyValues(model, options.selector);
    row.key = this.keyFields(model).map((field) =>
      pinned.has(field)
        ? this.literal(pinned.get(field), { model, field })
        : this.variable(
            {
              kind: "matched",
              row: row.id,
              column: getColumnName(model, field),
            },
            { model, field }
          )
    );
    const predicates = [
      this.predicateFrom(model, options.selector, options.path),
      this.predicateFrom(model, options.filter, `${options.path}.where`),
    ].filter((p): p is Predicate => p !== undefined);
    row.predicate = this.allOf(predicates);
    if (options.decision) row.matchIsDecision = true;
    return row;
  }

  /** The key members a unique selector spells as literals, compound keys expanded. */
  private pinnedKeyValues(
    model: Model<any>,
    selector: Record<string, unknown> | undefined
  ): ReadonlyMap<string, unknown> {
    const pinned = new Map<string, unknown>();
    if (!selector) return pinned;
    const keyFields = new Set(this.keyFields(model));
    for (const [key, value] of Object.entries(selector)) {
      if (value === undefined) continue;
      if (keyFields.has(key) && !isRecord(value)) {
        pinned.set(key, value);
        continue;
      }
      if (keyFields.has(key) && isRecord(value) && !isRecord(value.equals)) {
        if (value.equals !== undefined) pinned.set(key, value.equals);
        continue;
      }
      const grouped = findAddressableKey(model, key);
      if (grouped?.name === key && isRecord(value)) {
        for (const member of grouped.fields) {
          if (keyFields.has(member) && value[member] !== undefined) {
            pinned.set(member, value[member]);
          }
        }
      }
    }
    return pinned;
  }

  private skipDuplicates(row: RowDraft): void {
    // A merge whose decision is the fresh row itself: the found arm is empty
    // (the row is left alone), the missing arm asserts it. Both arms exist;
    // the row belongs to the missing one.
    this.arm(row, "found");
    const missing = this.arm(row, "missing");
    row.arm = missing;
  }

  // ---- records -----------------------------------------------------------

  /**
   * One record's cells: scalars, then relations in the §5 collection order —
   * single-reference families in payload key order, then payload-bound
   * (variant) families in payload key order.
   */
  private record(
    row: RowDraft,
    data: Record<string, unknown>,
    mode: "fresh" | "atKey",
    path: string,
    arm?: ArmId
  ): void {
    const model = row.table.model;
    const scalars = model["~"].state.scalars as Record<string, unknown>;
    const relations = model["~"].state.relations as Record<string, unknown>;
    const scalarData: Record<string, unknown> = {};
    const single: [string, ReferenceFamily, unknown][] = [];
    const bound: [string, ReferenceFamily, unknown][] = [];
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (key in scalars) {
        scalarData[key] = value;
        continue;
      }
      if (!(key in relations)) continue;
      const family = this.view(this.index, model, key);
      (family.kind === "single" ? single : bound).push([key, family, value]);
    }
    const keyColumns = new Set(
      this.keyFields(model).map((field) => getColumnName(model, field))
    );
    for (const [field, value] of Object.entries(scalarData)) {
      const column = getColumnName(model, field);
      if (mode === "fresh") {
        const keyIndex = this.keyFields(model).indexOf(field);
        const variable =
          keyIndex >= 0 && row.key[keyIndex]
            ? row.key[keyIndex]!
            : this.literal(value, { model, field });
        this.cell(row, column, variable, "assert", arm);
        continue;
      }
      this.updateCell(row, model, field, column, value, arm);
    }
    for (const [field, family, value] of [...single, ...bound]) {
      this.relation(row, family, value, `${path}.${field}`, arm);
    }
    if (mode === "atKey") {
      this.relationKeyLegality(
        model,
        scalarData,
        [...single, ...bound],
        path,
        arm
      );
      this.keyTransition(row, keyColumns, arm);
    }
  }

  /** A scalar update: `{ set: v }` is an absolute cell; any other spelling is relative. */
  private updateCell(
    row: RowDraft,
    model: Model<any>,
    field: string,
    column: string,
    value: unknown,
    arm?: ArmId
  ): void {
    const scalar = { model, field };
    if (!isRecord(value)) {
      this.cell(row, column, this.literal(value, scalar), "assert", arm);
      return;
    }
    const operations = Object.entries(value).filter(
      ([, operand]) => operand !== undefined
    );
    const absolute = operations.find(([key]) => key === ABSOLUTE_UPDATE_KEY);
    if (absolute && operations.length === 1) {
      this.cell(row, column, this.literal(absolute[1], scalar), "assert", arm);
      return;
    }
    const [operation, operand] = operations.find(
      ([key]) => key !== ABSOLUTE_UPDATE_KEY
    ) ?? [ABSOLUTE_UPDATE_KEY, absolute?.[1]];
    const operandVariable = this.literal(operand, scalar);
    this.cell(row, column, operandVariable, "assert", arm, {
      operation,
      operand: operandVariable,
    });
  }

  /**
   * A row whose key cells are asserted holds two keys: `key` (k) for every
   * match that observes it, `newKey` (k′) for every cell that must carry the
   * new value — a scalar SET of a key member, or a reference the row itself
   * holds whose columns are its key (the shared-key fold, ATOM §14).
   */
  private keyTransition(
    row: RowDraft,
    keyColumns: ReadonlySet<string>,
    arm?: ArmId
  ): void {
    if (keyColumns.size === 0) return;
    const model = row.table.model;
    const columns = this.keyFields(model).map((field) =>
      getColumnName(model, field)
    );
    let moved = false;
    const next = columns.map((column, position) => {
      const asserted = this.cellList.filter(
        (cell) =>
          cell.row === row.id &&
          cell.mode === "assert" &&
          cell.column === column &&
          cell.relative === undefined &&
          (cell.arm === undefined || cell.arm === arm)
      );
      const last = asserted.at(-1);
      const current = row.key[position]!;
      if (!last || last.value === current) return current;
      moved = true;
      return last.value;
    });
    if (moved) row.newKey = next;
  }

  // ---- relations ---------------------------------------------------------

  private shapeOf(family: ReferenceFamily): PayloadShape {
    if (family.kind === "single") {
      return { cardinality: family.cells.cardinality, tagged: false };
    }
    const first = family.byVariant.values().next().value;
    return { cardinality: first?.cardinality ?? "many", tagged: true };
  }

  private cellsFor(
    family: ReferenceFamily,
    variant: string | undefined,
    path: string
  ): ReferenceCells {
    if (family.kind === "single") return family.cells;
    if (variant !== undefined) {
      const cells = family.byVariant.get(variant);
      if (cells) return cells;
      const first = family.byVariant.values().next().value!;
      this.defer({
        stage: "packing",
        kind: "unknownVariant",
        relation: first.relation.field,
        path,
        // `selectVariantRow` on a singular edge; the collection's item binder otherwise.
        error:
          first.cardinality === "one" ? "QueryEngineError" : "NestedWriteError",
        message: `Unknown polymorphic target '${variant}' for relation '${first.relation.field}'.`, // census: error-text
      });
      return first;
    }
    // An untargeted item (a targetless disconnect, an empty set) addresses the
    // family's shared cells; every variant occupies the same holder columns.
    return family.byVariant.values().next().value!;
  }

  private relation(
    parent: RowDraft,
    family: ReferenceFamily,
    payload: unknown,
    path: string,
    arm?: ArmId
  ): void {
    if (!isRecord(payload)) return;
    const shape = this.shapeOf(family);
    const verbs = VERB_ORDER.filter((verb) => payload[verb] !== undefined);
    this.relationRefusals(parent, family, verbs, path);
    const composition =
      shape.cardinality === "one" ? toOneComposition(verbs) : undefined;
    if (!composition) {
      for (const verb of verbs) {
        for (const item of verbRow(verb).read(payload[verb], shape)) {
          this.apply(verbRow(verb).plan, {
            parent,
            family,
            verb,
            cells: this.cellsFor(family, item.variant, `${path}.${verb}`),
            item,
            shape,
            path: `${path}.${verb}`,
            ...(arm === undefined ? {} : { arm }),
          });
        }
      }
      return;
    }
    // (vacate?, supplier, modify?): the modify addresses the supplier's row in
    // every arm the supplier produced, never the outgoing member.
    if (composition.vacate) {
      this.applyVerb(
        parent,
        family,
        shape,
        composition.vacate,
        payload,
        path,
        arm
      );
    }
    const supplied = this.applyVerb(
      parent,
      family,
      shape,
      composition.supplier,
      payload,
      path,
      arm
    );
    if (composition.modify) {
      const row = verbRow(composition.modify);
      for (const item of row.read(payload[composition.modify], shape)) {
        for (const { target, arm: targetArm } of supplied) {
          const modify = row.plan.filter((step) => step.primitive !== "match");
          this.apply(modify, {
            parent,
            family,
            verb: composition.modify,
            cells: this.cellsFor(
              family,
              item.variant,
              `${path}.${composition.modify}`
            ),
            item,
            shape,
            path: `${path}.${composition.modify}`,
            target,
            ...(targetArm === undefined ? {} : { arm: targetArm }),
          });
        }
      }
    }
  }

  /** Apply one verb's plan to every item; answer the target rows it bound, per arm. */
  private applyVerb(
    parent: RowDraft,
    family: ReferenceFamily,
    shape: PayloadShape,
    verb: Verb,
    payload: Record<string, unknown>,
    path: string,
    arm?: ArmId
  ): readonly { readonly target: RowDraft; readonly arm?: ArmId }[] {
    const bound: { readonly target: RowDraft; readonly arm?: ArmId }[] = [];
    const row = verbRow(verb);
    for (const item of row.read(payload[verb], shape)) {
      const context: Context = {
        parent,
        family,
        verb,
        cells: this.cellsFor(family, item.variant, `${path}.${verb}`),
        item,
        shape,
        path: `${path}.${verb}`,
        ...(arm === undefined ? {} : { arm }),
      };
      bound.push(...this.apply(row.plan, context));
    }
    return bound;
  }

  /**
   * The plan interpreter: six primitives, no verb. Answers every target row a
   * step bound (one per arm), which the to-one composition consumes.
   */
  private apply(
    steps: readonly Step[],
    context: Context
  ): readonly { readonly target: RowDraft; readonly arm?: ArmId }[] {
    const bound: { readonly target: RowDraft; readonly arm?: ArmId }[] = [];
    for (const step of steps) {
      const before = this.rows.length;
      this.step(step, context, bound);
      if (context.verb !== undefined) {
        for (const row of this.rows.slice(before)) row.verb ??= context.verb;
      }
    }
    return bound;
  }

  /** One step of a plan. */
  private step(
    step: Step,
    context: Context,
    bound: { readonly target: RowDraft; readonly arm?: ArmId }[]
  ): void {
    switch (step.primitive) {
      case "match": {
        const target = this.matchStep(step, context);
        if (target)
          bound.push({
            target,
            ...(context.arm === undefined ? {} : { arm: context.arm }),
          });
        break;
      }
      case "assertFresh": {
        if (step.from === "rows") {
          for (const [position, data] of (context.item.rows ?? []).entries()) {
            const target = this.freshRow(
              this.targetModel(context.cells),
              data,
              `${context.path}.data.${position}`,
              context.arm
            );
            if (context.item.skipDuplicates) this.skipDuplicates(target);
            this.membership(context, target, "assert", target.arm);
            bound.push({
              target,
              ...(target.arm === undefined ? {} : { arm: target.arm }),
            });
          }
          context.target = undefined;
          break;
        }
        const data = context.item[step.from] ?? {};
        const target = this.freshRow(
          this.targetModel(context.cells),
          data,
          `${context.path}.${step.from}`,
          context.arm
        );
        context.target = target;
        bound.push({
          target,
          ...(context.arm === undefined ? {} : { arm: context.arm }),
        });
        break;
      }
      case "assertAtKey": {
        if (step.what === "reference") {
          if (context.target) {
            this.membership(context, context.target, "assert", context.arm);
          }
          break;
        }
        if (!context.target) break;
        this.record(
          context.target,
          context.item[step.from ?? "data"] ?? {},
          "atKey",
          `${context.path}.${step.from ?? "data"}`,
          context.arm
        );
        break;
      }
      case "retract": {
        this.retractStep(step, context);
        break;
      }
      case "merge": {
        const decision = this.matchStep(step.decision, context);
        if (!decision) break;
        const found = this.arm(decision, "found");
        const missing = this.arm(decision, "missing");
        // The found arm's row IS the decision row: a composed modify lands there.
        bound.push({ target: decision, arm: found });
        bound.push(
          ...this.apply(step.found, {
            ...context,
            target: decision,
            referenceRow: undefined,
            arm: found,
          }),
          ...this.apply(step.missing, {
            ...context,
            target: undefined,
            referenceRow: undefined,
            arm: missing,
          })
        );
        break;
      }
      case "setDifference": {
        this.setDifference(context);
        break;
      }
      default: {
        const exhaustive: never = step;
        throw new TypeError(
          `construct: unknown step ${JSON.stringify(exhaustive)}`
        );
      }
    }
  }

  private matchStep(
    step: Extract<Step, { readonly primitive: "match" }>,
    context: Context
  ): RowDraft | undefined {
    const { cells, item } = context;
    const untargeted = item.selector === undefined && item.filter === undefined;
    if (
      step.need === "unlessHolderIsParent" &&
      untargeted &&
      cells.holderIsSource &&
      !cells.viaJunction
    ) {
      return undefined;
    }
    const cardinality: "one" | "set" =
      item.current &&
      item.selector === undefined &&
      context.shape.cardinality === "many"
        ? "set"
        : "one";
    const target = this.matchedRow(this.targetModel(cells), {
      ...(item.selector ? { selector: item.selector } : {}),
      ...(item.filter ? { filter: item.filter } : {}),
      cardinality,
      decision: step.decision,
      path: context.path,
      ...(context.arm === undefined ? {} : { arm: context.arm }),
    });
    context.target = target;
    if (context.verb !== undefined && isVerb(context.verb)) {
      target.located = locatedBy({
        verb: context.verb,
        fresh: false,
        targeted: !untargeted,
        parentHoldsReference: cells.holderIsSource,
        ownReferenceRow: cells.viaJunction !== undefined,
        clearable: cells.nullable,
        setValued: cardinality === "set",
      });
    }
    if (step.locate === "membership") {
      context.referenceRow = this.membership(
        context,
        target,
        "match",
        context.arm
      );
    }
    return target;
  }

  private retractStep(
    step: Extract<Step, { readonly primitive: "retract" }>,
    context: Context
  ): void {
    const { cells, target } = context;
    if (step.what === "row") {
      if (target) target.mode = "retract";
      if (context.referenceRow) context.referenceRow.mode = "retract";
      // A reference the parent itself holds must be cleared before the row it
      // names ceases; the scheduler orders the two.
      if (cells.holderIsSource && !cells.viaJunction) {
        this.retractHolderCells(context.parent, cells, context.arm);
      }
      return;
    }
    if (cells.viaJunction) {
      if (context.referenceRow) {
        context.referenceRow.mode = "retract";
        return;
      }
      // Untargeted: every reference row of the parent along this edge.
      const referenceRow = this.referenceRow(
        context,
        undefined,
        "retract",
        context.arm
      );
      referenceRow.cardinality = "set";
      return;
    }
    const holder = cells.holderIsSource ? context.parent : target;
    if (!holder) return;
    if (holder === context.parent) {
      this.retractHolderCells(holder, cells, context.arm);
      return;
    }
    // The target holds the reference: its cells are cleared, the row stays.
    this.retractHolderCells(holder, cells, context.arm);
  }

  private retractHolderCells(
    holder: RowDraft,
    cells: ReferenceCells,
    arm?: ArmId
  ): void {
    for (const pair of cells.cells) {
      this.cell(holder, pair.holderColumn, this.literal(null), "retract", arm);
    }
    if (cells.discriminator) {
      this.cell(
        holder,
        cells.discriminator.column,
        this.literal(null),
        "retract",
        arm
      );
    }
  }

  /**
   * `set S`: retract the reference for N \ S, assert it for S \ N. Over a
   * reference row of its own the retract covers all of N and the assert all of
   * S (the pinned form, §7.4 failure 3); over a nullable reference cell the
   * departures are the members not in S.
   */
  private setDifference(context: Context): void {
    const { cells } = context;
    const selectors = context.item.selectors ?? [];
    if (cells.viaJunction) {
      // Every reference row of the parent along this edge — for a payload-bound
      // family, along EVERY variant's reference, whether the payload named it
      // or not (that is what "clears unmentioned variants" means).
      const wholeFamily =
        context.family.kind === "variants"
          ? [...context.family.byVariant.values()]
          : [cells];
      for (const member of wholeFamily) {
        const departures = this.referenceRow(
          { ...context, cells: member },
          undefined,
          "retract",
          context.arm
        );
        departures.cardinality = "set";
      }
    } else {
      const departing = this.matchedRow(this.targetModel(cells), {
        cardinality: "set",
        decision: false,
        path: context.path,
        ...(context.arm === undefined ? {} : { arm: context.arm }),
      });
      const exclusions = selectors
        .map((s) =>
          this.predicateFrom(departing.table.model, s.selector, context.path)
        )
        .filter((p): p is Predicate => p !== undefined);
      departing.predicate = this.allOf([
        ...(exclusions.length > 0
          ? [{ kind: "not" as const, item: this.anyOf(exclusions)! }]
          : []),
      ]);
      this.membership(context, departing, "match", context.arm);
      const holder = cells.holderIsSource ? context.parent : departing;
      this.retractHolderCells(holder, cells, context.arm);
    }
    for (const [position, selector] of selectors.entries()) {
      const target = this.matchedRow(this.targetModel(cells), {
        selector: selector.selector,
        cardinality: "one",
        decision: false,
        path: `${context.path}.${position}`,
        ...(context.arm === undefined ? {} : { arm: context.arm }),
      });
      const variantCells =
        selector.variant === undefined
          ? cells
          : this.cellsFor(
              this.view(this.index, cells.relation.model, cells.relation.field),
              selector.variant,
              `${context.path}.${position}`
            );
      this.membership(
        { ...context, cells: variantCells },
        target,
        "assert",
        context.arm
      );
    }
  }

  // ---- references --------------------------------------------------------

  private targetModel(cells: ReferenceCells): Model<any> {
    if (cells.viaJunction) return cells.referenced.model;
    return cells.holderIsSource ? cells.referenced.model : cells.holder.model;
  }

  /**
   * THE one composition: extend the parent along the reference to the target,
   * in `mode`. The holder row's reference cells take the referenced row's key
   * variables; a reference row of its own is a fresh row holding two
   * references. A discriminator is a literal cell on the holder — bound from
   * the payload's variant or fixed by the inverse, the same cell either way.
   */
  private membership(
    context: Context,
    target: RowDraft,
    mode: Mode,
    arm?: ArmId
  ): RowDraft | undefined {
    const { cells, parent } = context;
    if (cells.viaJunction) {
      return this.referenceRow(context, target, mode, arm);
    }
    const holder = cells.holderIsSource ? parent : target;
    const referenced = cells.holderIsSource ? target : parent;
    // MEASURED, twice: a merge that supplies a reference whose columns ARE the
    // record's own key is NOT refused today — the corpus payload
    // `create:calibration:shared-key.connectOrCreate` (12/12 cells `ok`), and
    // the same shape over a key carrying a materialized `.id()` default, where
    // the default and the two arms are three contributions today's final
    // assignment ledger reconciles (ATOM §20.1). Today refuses only when the
    // value cannot be resolved at compile, which is a SUBSTRATE fact
    // (`bindsGeneratedKey`) construction does not have. So nothing is deferred
    // here; the refusal belongs to packing, which knows the substrate:
    //   `query-engine-v2 create does not support a shared-primary-key <verb> on
    //    relation '<f>' whose foreign key '<cols>' (this record's primary key)
    //    does not resolve to one final value.`
    const discriminator = cells.discriminator
      ? {
          column: cells.discriminator.column,
          value: this.literal(cells.discriminator.storedValue),
        }
      : undefined;
    const reference: Reference = {
      holder: holder.id,
      referenced: referenced.id,
      columns: cells.cells,
      ...(discriminator ? { discriminator } : {}),
      onKeyChange: cells.onKeyChange,
      nullable: cells.nullable,
      unique: cells.unique,
      relation: cells.relation,
      ...(arm === undefined ? {} : { arm }),
    };
    this.references.push(reference);
    for (const pair of cells.cells) {
      this.cell(
        holder,
        pair.holderColumn,
        this.keyVariable(referenced, pair.referencedColumn),
        mode,
        arm
      );
    }
    if (discriminator) {
      this.cell(holder, discriminator.column, discriminator.value, mode, arm);
    }
    return undefined;
  }

  /**
   * A reference row of its own: a fresh key whose only cells are two
   * references — to the parent (the asking side) and to the target.
   */
  private referenceRow(
    context: Context,
    target: RowDraft | undefined,
    mode: Mode,
    arm?: ArmId
  ): RowDraft {
    const { cells, parent } = context;
    const via = cells.viaJunction!;
    const row = this.newRow(
      cells.holder.model,
      mode,
      "one",
      mode === "assert",
      arm,
      via.table,
      true
    );
    // A retracted row's cells are its identity (matched), never cleared cells.
    const cellMode: Mode = mode === "retract" ? "match" : mode;
    // A reference row's statement is named for what it does to the REFERENCE,
    // not for the target it points at.
    row.label = `${this.stepName(cells.referenced.model)}.${referenceRowLabel({
      verb: context.verb,
      freshTarget: target?.fresh === true,
      retracting: mode === "retract",
      uniqueReference: cells.unique,
    })}`;
    // K2 publishes both pairings of a reference row: toward the asking side
    // (the parent) and toward the referenced side (`cells`).
    const toParent = via.askingCells;
    this.references.push({
      holder: row.id,
      referenced: parent.id,
      columns: toParent,
      onKeyChange: cells.onKeyChange,
      nullable: false,
      unique: false,
      relation: cells.relation,
      ...(arm === undefined ? {} : { arm }),
    });
    for (const pair of toParent) {
      this.cell(
        row,
        pair.holderColumn,
        this.keyVariable(parent, pair.referencedColumn),
        cellMode,
        arm
      );
    }
    if (target) {
      this.references.push({
        holder: row.id,
        referenced: target.id,
        columns: cells.cells,
        onKeyChange: cells.onKeyChange,
        nullable: false,
        unique: cells.unique,
        relation: cells.relation,
        ...(arm === undefined ? {} : { arm }),
      });
      for (const pair of cells.cells) {
        this.cell(
          row,
          pair.holderColumn,
          this.keyVariable(target, pair.referencedColumn),
          cellMode,
          arm
        );
      }
    }
    return row;
  }

  /**
   * The variable holding `row`'s value in `column`: its key member, an
   * asserted scalar cell (a fresh row's referenced unique), or a match.
   */
  private keyVariable(row: RowDraft, column: string): Variable {
    const model = row.table.model;
    const keyColumns = this.keyFields(model).map((f) =>
      getColumnName(model, f)
    );
    const position = keyColumns.indexOf(column);
    if (position >= 0 && row.key[position]) return row.key[position]!;
    const cell = this.cellList.find(
      (c) => c.row === row.id && c.column === column && c.mode === "assert"
    );
    if (cell) return cell.value;
    return this.variable({ kind: "matched", row: row.id, column });
  }

  // ---- predicates --------------------------------------------------------

  private allOf(items: readonly Predicate[]): Predicate | undefined {
    if (items.length === 0) return undefined;
    return items.length === 1 ? items[0] : { kind: "and", items };
  }

  private anyOf(items: readonly Predicate[]): Predicate | undefined {
    if (items.length === 0) return undefined;
    return items.length === 1 ? items[0] : { kind: "or", items };
  }

  private predicateFrom(
    model: Model<any>,
    where: unknown,
    path: string
  ): Predicate | undefined {
    if (!isRecord(where)) return undefined;
    const scalars = model["~"].state.scalars as Record<string, unknown>;
    const relations = model["~"].state.relations as Record<string, unknown>;
    const items: Predicate[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (BOOLEAN_KEYS.has(key)) {
        const parts = (Array.isArray(value) ? value : [value])
          .map((part, i) =>
            this.predicateFrom(model, part, `${path}.${key}.${i}`)
          )
          .filter((p): p is Predicate => p !== undefined);
        if (key === "AND") items.push(...parts);
        else if (key === "OR") {
          const or = this.anyOf(parts);
          if (or) items.push(or);
        } else {
          const inner = this.allOf(parts);
          if (inner) items.push({ kind: "not", item: inner });
        }
        continue;
      }
      if (key in scalars) {
        items.push(...this.scalarPredicates(model, key, value));
        continue;
      }
      if (key in relations) {
        const relation = this.relationPredicate(
          model,
          key,
          value,
          `${path}.${key}`
        );
        if (relation) items.push(relation);
        continue;
      }
      const grouped = findAddressableKey(model, key);
      if (grouped?.name === key && isRecord(value)) {
        for (const member of grouped.fields) {
          if (value[member] !== undefined) {
            items.push(...this.scalarPredicates(model, member, value[member]));
          }
        }
        continue;
      }
      items.push(...this.scalarPredicates(model, key, value));
    }
    return this.allOf(items);
  }

  private scalarPredicates(
    model: Model<any>,
    field: string,
    value: unknown
  ): readonly Predicate[] {
    // A key the model does not declare (a shape validation would have refused)
    // is its own column: construction stays total.
    const column =
      field in (model["~"].state.scalars as Record<string, unknown>)
        ? getColumnName(model, field)
        : field;
    const scalar = { model, field };
    if (!isRecord(value)) {
      return [
        {
          kind: "scalar",
          column,
          operator: "equals",
          operand: this.literal(value, scalar),
        },
      ];
    }
    const mode = value.mode === "insensitive" ? "insensitive" : undefined;
    const items: Predicate[] = [];
    for (const [operator, operand] of Object.entries(value)) {
      if (operand === undefined || operator === "mode") continue;
      if (operator === "not" && isRecord(operand)) {
        const inner = this.allOf(this.scalarPredicates(model, field, operand));
        if (inner) items.push({ kind: "not", item: inner });
        continue;
      }
      items.push({
        kind: "scalar",
        column,
        operator,
        operand: Array.isArray(operand)
          ? operand.map((v) => this.literal(v, scalar))
          : this.literal(operand, scalar),
        ...(mode ? { mode } : {}),
      });
    }
    return items;
  }

  private relationPredicate(
    model: Model<any>,
    field: string,
    value: unknown,
    path: string
  ): Predicate | undefined {
    if (!isRecord(value)) return undefined;
    const family = this.view(this.index, model, field);
    const items: Predicate[] = [];
    for (const quantifier of RELATION_QUANTIFIERS) {
      const inner = value[quantifier];
      if (inner === undefined) continue;
      const innerWhere = isRecord(inner) ? inner : undefined;
      const tagged =
        family.kind === "variants" &&
        innerWhere !== undefined &&
        typeof innerWhere.type === "string";
      const variant = tagged ? String(innerWhere.type) : undefined;
      const { type: _type, ...untagged } = innerWhere ?? {};
      const cells = this.cellsFor(family, variant, `${path}.${quantifier}`);
      items.push(
        this.quantified(
          model,
          cells,
          quantifier,
          tagged ? untagged : innerWhere,
          `${path}.${quantifier}`
        )
      );
    }
    return this.allOf(items);
  }

  private quantified(
    model: Model<any>,
    cells: ReferenceCells,
    quantifier: Quantifier,
    where: Record<string, unknown> | undefined,
    path: string
  ): Predicate {
    const outer = this.rows.at(-1);
    const extension = this.extension(model, cells, where, path, outer);
    return { kind: "relation", quantifier, extension };
  }

  /**
   * Extend the pattern along a reference in match mode: a sub-pattern rooted at
   * the target, correlated through the reference. Its rows are moved out of the
   * enclosing pattern so a walk of the outer rows sees only the outer rows.
   */
  private extension(
    model: Model<any>,
    cells: ReferenceCells,
    where: Record<string, unknown> | undefined,
    path: string,
    outer: RowDraft | undefined
  ): Extension {
    const parent = outer ?? this.newRow(model, "match", "one", false);
    const mark = {
      rows: this.rows.length,
      cells: this.cellList.length,
      references: this.references.length,
      arms: this.arms.length,
    };
    const target = this.matchedRow(this.targetModel(cells), {
      ...(where ? { filter: where } : {}),
      cardinality: cells.cardinality === "many" ? "set" : "one",
      decision: false,
      path,
    });
    const context: Context = {
      parent,
      family: { kind: "single", cells },
      cells,
      item: { current: true },
      shape: { cardinality: cells.cardinality, tagged: false },
      path,
    };
    this.membership(context, target, "match");
    const reference = this.references.at(-1)!;
    const sub: Pattern = {
      root: target.id,
      rows: this.rows.splice(mark.rows).map(freeze),
      cells: this.cellList.splice(mark.cells),
      references: this.references.splice(mark.references),
      arms: this.arms.splice(mark.arms),
      variables: [],
      operation: "findMany",
    };
    return { reference, target: sub };
  }

  // ---- projection --------------------------------------------------------

  private projectionFrom(
    model: Model<any>,
    select: unknown,
    include: unknown,
    row: RowDraft
  ): Projection | undefined {
    const scalarNames = model["~"].scalarFieldNames as readonly string[];
    const relations = model["~"].state.relations as Record<string, unknown>;
    const scalars = isRecord(select)
      ? scalarNames.filter((name) => select[name] === true)
      : [...scalarNames];
    const projected: Projection["relations"][number][] = [];
    const counts: Projection["relationCounts"][number][] = [];
    for (const source of [select, include]) {
      if (!isRecord(source)) continue;
      for (const [key, value] of Object.entries(source)) {
        if (value === undefined || value === false) continue;
        if (key === "_count" && isRecord(value) && isRecord(value.select)) {
          for (const [field, wanted] of Object.entries(value.select)) {
            if (wanted && field in relations) {
              const cells = this.cellsFor(
                this.view(this.index, model, field),
                undefined,
                `select._count.${field}`
              );
              counts.push({
                field,
                extension: this.extension(
                  model,
                  cells,
                  undefined,
                  `select._count.${field}`,
                  row
                ),
              });
            }
          }
          continue;
        }
        if (!(key in relations)) continue;
        const args = isRecord(value) ? value : {};
        const family = this.view(this.index, model, key);
        const cells = this.cellsFor(family, undefined, `select.${key}`);
        const extension = this.extension(
          model,
          cells,
          isRecord(args.where) ? args.where : undefined,
          `select.${key}`,
          row
        );
        projected.push({
          field: key,
          extension,
          cardinality: cells.cardinality,
        });
      }
    }
    const limit = this.args.limit;
    const window =
      typeof limit === "number" ? { orderBy: [], take: limit } : undefined;
    if (
      scalars.length === 0 &&
      projected.length === 0 &&
      counts.length === 0 &&
      !window
    ) {
      return undefined;
    }
    return {
      scalars,
      relations: projected,
      relationCounts: counts,
      ...(window ? { window } : {}),
    };
  }

  // ---- deferred refusals -------------------------------------------------

  private defer(refusal: DeferredRefusal): void {
    this.deferred.push(refusal);
  }

  /** Whether a record writes any relation of its model. */
  private writesRelations(
    model: Model<any>,
    record: Record<string, unknown>
  ): boolean {
    const relations = model["~"].state.relations as Record<string, unknown>;
    return Object.keys(record).some(
      (key) => key in relations && record[key] !== undefined
    );
  }

  /** ATOM §19's first two legality checks, recorded for the scheduler to raise first. */
  private portablePrimaryKey(data: unknown, path: string, arm?: ArmId): void {
    if (!isRecord(data)) return;
    for (const field of this.keyFields(this.model)) {
      const value = data[field];
      if (!isRecord(value)) continue;
      const type = (this.model["~"].state.scalars as Record<string, any>)[
        field
      ]?.["~"].state.type;
      const named = ARITHMETIC_UPDATE_KEYS.filter(
        (op) => value[op] !== undefined
      );
      if (named.length !== 1) {
        this.defer({
          stage: "legality",
          kind: "portablePrimaryKey",
          path: `${path}.${field}`,
          error: "QueryEngineError",
          message: `Primary key field '${field}' accepts exactly one update operation; received ${named.join(", ") || "none"}.`,
          ...(arm === undefined ? {} : { arm }),
        });
        continue;
      }
      const arithmetic = named.find((op) => op !== ABSOLUTE_UPDATE_KEY);
      if (
        arithmetic !== undefined &&
        (type === "number" || type === "decimal")
      ) {
        this.defer({
          stage: "legality",
          kind: "portablePrimaryKey",
          path: `${path}.${field}`,
          error: "QueryEngineError",
          message: `Arithmetic updates are not portable for ${type} primary key field '${field}'. Use an explicit set value.`,
          ...(arm === undefined ? {} : { arm }),
        });
      }
    }
  }

  private relationKeyLegality(
    model: Model<any>,
    scalarData: Record<string, unknown>,
    written: readonly [string, ReferenceFamily, unknown][],
    path: string,
    arm?: ArmId
  ): void {
    const keyFields = new Set(this.keyFields(model));
    for (const [field, family] of written) {
      if (family.kind !== "single" || family.cells.viaJunction) continue;
      const cells = family.cells;
      const members = cells.holderIsSource
        ? cells.holder.fields
        : cells.referenced.fields;
      for (const member of members) {
        const value = scalarData[member];
        if (value === undefined) continue;
        if (keyFields.has(member) && !cells.holderIsSource) continue;
        const resolved =
          !isRecord(value) ||
          (Object.keys(value).filter((k) => value[k] !== undefined).length ===
            1 &&
            value[ABSOLUTE_UPDATE_KEY] !== undefined);
        if (!resolved) {
          this.defer({
            stage: "legality",
            kind: "relationKeyNonLiteral",
            relation: field,
            path: `${path}.${member}`,
            error: "NestedWriteError",
            message: `Cannot update relation key field '${member}' with a non-literal operation while mutating relation '${field}'. Use a literal value or '{ set: ... }'.`,
            ...(arm === undefined ? {} : { arm }),
          });
          continue;
        }
        const literal = isRecord(value) ? value[ABSOLUTE_UPDATE_KEY] : value;
        if (literal === null) {
          this.defer({
            stage: "packing",
            kind: "nullRelationKey",
            relation: field,
            path: `${path}.${member}`,
            error: "NestedWriteError",
            message: `Cannot update relation key field '${member}' to null while mutating relation '${field}'. A null reference names no row for that relation to point at.`,
            ...(arm === undefined ? {} : { arm }),
          });
        }
      }
    }
  }

  private relationRefusals(
    parent: RowDraft,
    family: ReferenceFamily,
    verbs: readonly Verb[],
    path: string
  ): void {
    const shape = this.shapeOf(family);
    const field =
      family.kind === "single"
        ? family.cells.relation.field
        : family.byVariant.values().next().value!.relation.field;
    if (shape.cardinality === "one") {
      for (const verb of verbs) {
        if (verbRow(verb).stage === 2 && verb !== "set") {
          this.defer({
            stage: "packing",
            kind: "toOneBulkVerb",
            relation: field,
            path: `${path}.${verb}`,
            error: "NestedWriteError",
            message: `Nested operation '${verb}' is not supported for to-one relation '${field}'.`,
          });
        }
      }
    }
    const bulkRoot =
      parent.cardinality === "set" &&
      (this.operation === "updateMany" ||
        this.operation === "updateManyAndReturn");
    // Today refuses the two storages where N roots would steal one target:
    // the target row holds the membership, or the reference row's slot is
    // unique to the target. A reference row that admits many parents is fine.
    const targetHeld =
      family.kind === "single" &&
      !family.cells.holderIsSource &&
      !family.cells.viaJunction;
    const singularSlot =
      family.kind === "single" &&
      family.cells.viaJunction !== undefined &&
      family.cells.unique;
    if (bulkRoot && (targetHeld || singularSlot)) {
      for (const verb of verbs) {
        const row = verbRow(verb);
        // A verb moves an EXISTING row's membership when its plan asserts the
        // reference on a matched row: a fresh row carries its own membership.
        const [first] = row.plan;
        if (first?.primitive === "assertFresh") continue;
        const moves = row.plan.some(
          (step) =>
            (step.primitive === "assertAtKey" && step.what === "reference") ||
            step.primitive === "setDifference" ||
            (step.primitive === "merge" &&
              step.found.some(
                (s) => s.primitive === "assertAtKey" && s.what === "reference"
              ))
        );
        if (!moves) continue;
        const where = singularSlot
          ? "that target's member-junction slot can belong to only one of them" // census: error-text
          : "that membership is stored on the target row, which can belong to only one of them";
        const messageFor = (recordCount: number): string =>
          `updateMany matched ${recordCount} rows, so it cannot apply '${verb}' to relation '${field}': ${where} — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`;
        this.defer({
          stage: "packing",
          kind: "bulkRootMembershipMove",
          relation: field,
          path: `${path}.${verb}`,
          error: "UnsupportedOperationError",
          message: messageFor(2),
          messageFor,
        });
      }
    }
  }

  // ---- output ------------------------------------------------------------

  private pattern(root: RowId, projection: Projection | undefined): Pattern {
    return {
      root,
      rows: this.rows.map(freeze),
      cells: this.cellList,
      references: this.references,
      arms: this.arms,
      variables: this.variables,
      ...(projection ? { projection } : {}),
      operation: this.operation,
    };
  }
}

function freeze(draft: RowDraft): Row {
  return {
    id: draft.id,
    table: draft.table,
    mode: draft.mode,
    cardinality: draft.cardinality,
    key: draft.key,
    ...(draft.newKey ? { newKey: draft.newKey } : {}),
    fresh: draft.fresh,
    ...(draft.arm === undefined ? {} : { arm: draft.arm }),
    ...(draft.predicate ? { predicate: draft.predicate } : {}),
    ...(draft.matchIsDecision ? { matchIsDecision: true } : {}),
    ...(draft.verb === undefined ? {} : { verb: draft.verb }),
    ...(draft.located === undefined ? {} : { located: draft.located }),
    ...(draft.label === undefined ? {} : { label: draft.label }),
  };
}
