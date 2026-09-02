/**
 * G — read construction (pattern-engine-ideal-state.md §5, §9.1, §13.3 unit G).
 *
 * Validated read arguments become ONE match-mode pattern: a root row whose
 * predicate is the `where` tree, cells for every projected scalar, a
 * projection whose relation entries EXTEND the pattern along a reference cell
 * (an include, a `_count`, a relation-aggregate order, a relation filter), and a
 * window. Every extension is built from the cell map (`cells.ts`); this module
 * never names how a reference is stored.
 *
 * Row and variable identities are allocated from ONE counter for the whole
 * read, root and sub-patterns alike, so an `Extension.reference` can name the
 * parent row and the child row without ambiguity (K1 leaves that unstated; see
 * the report's proposed contract diffs).
 */
import type { Model } from "@schema/model";
import {
  findAddressableKey,
  getColumnName,
  getModelKeyCatalog,
  getTableName,
} from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { isRecord } from "@validation/value-guards";
import {
  getDefaultScalarFieldNames,
  getScalarFieldNames,
  isRelation,
  isScalarField,
} from "../context";
import { DISTANCE_RESULT_KEY } from "../result-aliases";
import { QueryEngineError } from "../types";
import { type ReferenceCells, referenceCells } from "./cells";
import type {
  Cell,
  Extension,
  OrderTerm,
  Pattern,
  Predicate,
  Projection,
  Reference,
  Row,
  RowId,
  TableRef,
  Variable,
  Window,
} from "./pattern";

// ---------------------------------------------------------------------------
// Read-side refinements of the K1 vocabulary (proposed contract diffs)
// ---------------------------------------------------------------------------

/**
 * An extension as a read builds it. `variant` names the arm of a variant slot
 * this extension realizes; `visible` is false for a collection arm outside the
 * validated `only` allow-list (its integrity is still computed, its rows are
 * not emitted). Both are absent on an ordinary relation.
 */
export interface ReadExtension extends Extension {
  readonly variant?: string;
  readonly visible?: boolean;
}

/** `is: null` / `isNot: null` — a presence test on the reference cells, no sub-pattern. */
export interface PresenceLeaf {
  readonly kind: "relation";
  readonly quantifier: "is" | "isNot";
  readonly extension: ReadExtension;
  readonly inner?: undefined;
  readonly presence: "null";
}

/** Order terms a read needs beyond K1's two (proposed diff on `OrderTerm`). */
export type ReadOrderTerm =
  | OrderTerm
  | {
      /** A scalar of a row reached through a chain of singular references. */
      readonly kind: "relationScalar";
      readonly path: readonly ReadExtension[];
      readonly column: string;
      readonly direction: "asc" | "desc";
      readonly nulls?: "first" | "last";
    }
  | {
      /** A structural order (`_distance`): the raw public order value rides as the operand. */
      readonly kind: "structural";
      readonly column: string;
      readonly form: "distance";
      readonly operand: Variable;
    }
  | {
      /** A groupBy order on an aggregate expression (`{ _count: { _all: "desc" } }`). */
      readonly kind: "aggregate";
      readonly aggregate: "_count" | "_avg" | "_sum" | "_min" | "_max";
      readonly field: string;
      readonly direction: unknown;
    };

export const isPresenceLeaf = (
  predicate: Predicate
): predicate is Predicate & PresenceLeaf =>
  predicate.kind === "relation" && "presence" in predicate;

export type ReadOperation =
  | "findUnique"
  | "findFirst"
  | "findMany"
  | "count"
  | "exist"
  | "aggregate"
  | "groupBy";

// ---------------------------------------------------------------------------
// Identity allocation
// ---------------------------------------------------------------------------

class Ids {
  private row = 0;
  private variable = 0;
  nextRow(): RowId {
    return this.row++;
  }
  nextVariable(): number {
    return this.variable++;
  }
}

/** The rows, cells, references and variables of ONE pattern (root or nested). */
export class PatternBuilder {
  readonly rows: Row[] = [];
  readonly cells: Cell[] = [];
  readonly references: Reference[] = [];
  readonly variables: Variable[] = [];
  readonly ids: Ids;
  readonly index: ResolvedRelationIndex;

  constructor(ids: Ids, index: ResolvedRelationIndex) {
    this.ids = ids;
    this.index = index;
  }

  literal(
    value: unknown,
    scalar?: { readonly model: Model<any>; readonly field: string }
  ): Variable {
    const variable: Variable = {
      id: this.ids.nextVariable(),
      binding: { kind: "literal", value },
      ...(scalar ? { scalar } : {}),
    };
    this.variables.push(variable);
    return variable;
  }

  matched(row: RowId, model: Model<any>, field: string): Variable {
    const variable: Variable = {
      id: this.ids.nextVariable(),
      binding: { kind: "matched", row, column: getColumnName(model, field) },
      scalar: { model, field },
    };
    this.variables.push(variable);
    return variable;
  }

  row(
    model: Model<any>,
    cardinality: Row["cardinality"],
    options: {
      readonly key?: readonly Variable[];
      readonly table?: string;
    } = {}
  ): RowId {
    const id = this.ids.nextRow();
    const table: TableRef = {
      model,
      table: options.table ?? getTableName(model),
    };
    const key =
      options.key ??
      (getModelKeyCatalog(model).rowKey?.fields ?? []).map((field) =>
        this.matched(id, model, field)
      );
    this.rows.push({
      id,
      table,
      mode: "match",
      cardinality,
      key,
      fresh: false,
    });
    return id;
  }

  withPredicate(row: RowId, predicate: Predicate | undefined): void {
    if (!predicate) return;
    const at = this.rows.findIndex((r) => r.id === row);
    const current = this.rows[at];
    if (!current) return;
    this.rows[at] = { ...current, predicate };
  }

  cell(row: RowId, model: Model<any>, field: string): void {
    this.cells.push({
      row,
      column: getColumnName(model, field),
      value: this.matched(row, model, field),
      mode: "match",
    });
  }

  finish(
    root: RowId,
    operation: string,
    projection: Projection | undefined
  ): Pattern {
    return {
      root,
      rows: this.rows,
      cells: this.cells,
      references: this.references,
      arms: [],
      variables: this.variables,
      ...(projection ? { projection } : {}),
      operation,
    };
  }
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

function slotOf(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string
) {
  return index.get(model)?.get(field);
}

/** A slot the payload selects the target of: one reference per variant. */
function spansVariants(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string
): boolean {
  const resolved = slotOf(index, model, field);
  return (
    resolved !== undefined &&
    resolved.member === undefined &&
    "carrier" in resolved.edge
  );
}

/** Whether a spanning slot stores its reference on the holder row (vs a row of its own per member). */
function spanningSlotStoresOnHolder(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string
): boolean {
  const resolved = slotOf(index, model, field);
  return resolved !== undefined && "storage" in resolved.edge;
}

function slotCardinality(model: Model<any>, field: string): "one" | "many" {
  return model["~"].state.relations[field]?.["~"].state.cardinality === "many"
    ? "many"
    : "one";
}

function variantNames(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string
): readonly string[] {
  const edge = slotOf(index, model, field)?.edge;
  if (edge && "storage" in edge) return edge.members.map((m) => m.variant);
  const family = referenceCells(index, model, field);
  return family.kind === "variants" ? [...family.byVariant.keys()] : [];
}

/**
 * K2 BUG WORKAROUND (proposed cells.ts diff in the report): `referenceCells`
 * resolves a row carrier's private storage columns through `getColumnName`,
 * which knows scalar FIELDS only, so every row-carrier slot throws
 * `Scalar "<id column>" not found`. Until cells.ts reads those columns as the
 * physical names they already are, the same view is built here from the same
 * resolved storage — nothing is decided that cells.ts does not decide.
 */
function rowCarrierCells(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string,
  variant: string | undefined
): ReferenceCells | undefined {
  const resolved = slotOf(index, model, field);
  const edge = resolved?.edge;
  if (!(resolved && edge && "storage" in edge)) return undefined;
  const wanted = variant ?? resolved.member?.variant;
  const member = edge.members.find((m) => m.variant === wanted);
  if (!member) return undefined;
  const holderModel = edge.carrier.source;
  const referencedColumn = getColumnName(
    member.targetModel,
    member.referencedField
  );
  return {
    relation: { model, field },
    holder: {
      model: holderModel,
      table: getTableName(holderModel),
      columns: [edge.storage.idColumn.name],
      fields: [edge.storage.idColumn.name],
    },
    referenced: {
      model: member.targetModel,
      table: getTableName(member.targetModel),
      columns: [referencedColumn],
      fields: [member.referencedField],
    },
    holderIsSource: holderModel === model,
    cells: [{ holderColumn: edge.storage.idColumn.name, referencedColumn }],
    discriminator: {
      column: edge.storage.typeColumn.name,
      storedValue: member.entry.storedValue,
      variant: member.variant,
    },
    unique: edge.uniqueTarget,
    nullable: edge.storage.idColumn.nullable,
    onKeyChange: "none",
    cardinality: slotCardinality(model, field),
  };
}

function cellsFor(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string,
  variant: string | undefined
): ReferenceCells {
  const fallback = rowCarrierCells(index, model, field, variant);
  if (fallback) return fallback;
  const family = referenceCells(index, model, field);
  if (family.kind === "single") return family.cells;
  const cells =
    variant === undefined ? undefined : family.byVariant.get(variant);
  if (!cells) {
    throw new QueryEngineError(
      `Unknown polymorphic target '${variant}' for relation '${field}'.`
    );
  }
  return cells;
}

/**
 * The columns the OWN-ROW reference stores for the asking side. K2 publishes
 * the referenced side's pairing (`cells`) and the two models the own row joins
 * (`viaJunction.source/target` as model sides), but not the own row's columns
 * for the asking side — read from the resolved topology here. Proposed K2 diff:
 * `viaJunction.sourceCells` / `targetCells` pairs.
 */
function askingSidePairs(
  index: ResolvedRelationIndex,
  model: Model<any>,
  field: string,
  variant: string | undefined,
  cells: ReferenceCells
): readonly { holderColumn: string; referencedColumn: string }[] {
  const resolved = slotOf(index, model, field);
  const edge = resolved?.edge;
  if (!edge) return [];
  type Side = {
    model: Model<any>;
    members: readonly { junctionField: string; referencedField: string }[];
  };
  type Topology = { source: Side; target: Side };
  let topology: Topology | undefined;
  if ("topology" in edge) {
    topology = edge.topology as Topology;
  } else if ("members" in edge) {
    const wanted = variant ?? resolved?.member?.variant;
    const member = edge.members.find((m) => m.variant === wanted) as
      | { topology?: Topology }
      | undefined;
    topology = member?.topology;
  }
  if (!topology) return [];
  const side =
    cells.viaJunction?.source.model === model &&
    cells.viaJunction.target.model !== model
      ? topology.source
      : cells.viaJunction?.target.model === model &&
          cells.viaJunction.source.model !== model
        ? topology.target
        : cells.referenced.model === topology.target.model
          ? topology.source
          : topology.target;
  return side.members.map((member) => ({
    holderColumn: member.junctionField,
    referencedColumn: getColumnName(side.model, member.referencedField),
  }));
}

// ---------------------------------------------------------------------------
// The whole read
// ---------------------------------------------------------------------------

export interface ReadArgs {
  readonly where?: Record<string, unknown>;
  readonly select?: Record<string, unknown>;
  readonly include?: Record<string, unknown>;
  readonly orderBy?: Record<string, unknown> | Record<string, unknown>[];
  readonly take?: number;
  readonly skip?: number;
  readonly cursor?: Record<string, unknown>;
  readonly distinct?: string[];
  readonly [key: string]: unknown;
}

/**
 * Validated read args → match-mode pattern. Pure: the same args over the same
 * index build the same pattern.
 */
export function constructRead(
  model: Model<any>,
  operation: ReadOperation,
  args: Record<string, unknown>,
  index: ResolvedRelationIndex
): Pattern {
  const ids = new Ids();
  const b = new PatternBuilder(ids, index);
  const read = args as ReadArgs;

  if (operation === "findUnique") {
    const where = read.where ?? {};
    const { key, filters } = uniqueKey(b, model, where);
    const root = b.row(model, "one", { key });
    b.withPredicate(root, predicateOf(b, root, model, filters));
    const projection = projectionOf(b, root, model, read.select, read.include);
    return b.finish(root, operation, projection);
  }

  if (operation === "findFirst" || operation === "findMany") {
    const root = b.row(model, operation === "findFirst" ? "one" : "set");
    b.withPredicate(root, predicateOf(b, root, model, read.where));
    const base = projectionOf(b, root, model, read.select, read.include);
    const window = windowOf(b, root, model, read, operation === "findFirst");
    return b.finish(root, operation, { ...base, window });
  }

  const root = b.row(model, "set");
  b.withPredicate(root, predicateOf(b, root, model, read.where));
  const window =
    operation === "groupBy"
      ? {
          ...windowOf(b, root, model, { ...read, orderBy: undefined }, false),
          orderBy: groupByOrderTermsOf(
            b,
            model,
            read.orderBy,
            groupByFields(args.by)
          ) as readonly OrderTerm[],
        }
      : windowOf(b, root, model, read, false);
  const projection: Projection = {
    scalars: [],
    relations: [],
    relationCounts: [],
    aggregates: aggregatesOf(operation, args),
    ...(operation === "groupBy"
      ? {
          groupBy: groupByFields(args.by),
          ...(isRecord(args.having)
            ? { having: havingOf(b, model, args.having) }
            : {}),
        }
      : {}),
    window,
  };
  return b.finish(root, operation, projection);
}

// ---------------------------------------------------------------------------
// Unique key
// ---------------------------------------------------------------------------

function uniqueKey(
  b: PatternBuilder,
  model: Model<any>,
  where: Record<string, unknown>
): {
  readonly key: Variable[];
  readonly filters: Record<string, unknown> | undefined;
} {
  const key: Variable[] = [];
  let filters: Record<string, unknown> | undefined;
  for (const [name, value] of Object.entries(where)) {
    if (value === undefined) continue;
    const addressable = findAddressableKey(model, name);
    if (!addressable) {
      filters ??= {};
      filters[name] = value;
      continue;
    }
    if (addressable.name === undefined) {
      key.push(b.literal(value, { model, field: name }));
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new QueryEngineError(
        `Compound whereUnique field '${name}' must be an object.`
      );
    }
    const compound = value as Record<string, unknown>;
    const expected = new Set(addressable.fields);
    for (const field of Object.keys(compound)) {
      if (!expected.has(field)) {
        throw new QueryEngineError(
          `Unknown field '${field}' in compound whereUnique field '${name}'.`
        );
      }
    }
    for (const field of addressable.fields) {
      const member = compound[field];
      if (member === undefined) {
        throw new QueryEngineError(
          `Compound whereUnique field '${name}' requires '${field}'.`
        );
      }
      key.push(b.literal(member, { model, field }));
    }
  }
  if (key.length === 0) {
    throw new QueryEngineError(
      "whereUnique requires at least one unique discriminator."
    );
  }
  return { key, filters };
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

const isPlainList = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value) &&
  value.every((member) => member === null || typeof member !== "object");

const scalarLeaf = (
  b: PatternBuilder,
  model: Model<any>,
  field: string,
  operator: string,
  value: unknown,
  mode: "default" | "insensitive"
): Predicate => ({
  kind: "scalar",
  column: getColumnName(model, field),
  operator,
  operand: isPlainList(value)
    ? value.map((member) => b.literal(member, { model, field }))
    : b.literal(value, { model, field }),
  ...(mode === "insensitive" ? { mode } : {}),
});

const group = (items: readonly Predicate[]): Predicate | undefined =>
  items.length === 0
    ? undefined
    : items.length === 1
      ? items[0]
      : { kind: "and", items };

export function predicateOf(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  where: Record<string, unknown> | undefined
): Predicate | undefined {
  if (!where) return undefined;
  const items: Predicate[] = [];
  for (const key of Object.keys(where)) {
    const value = where[key];
    if (value === undefined) continue;
    if (key === "AND") {
      const children = (Array.isArray(value) ? value : [value])
        .map((item) =>
          predicateOf(b, row, model, item as Record<string, unknown>)
        )
        .filter((p): p is Predicate => p !== undefined);
      if (children.length > 0) items.push({ kind: "and", items: children });
      continue;
    }
    if (key === "OR") {
      if (!Array.isArray(value)) {
        throw new QueryEngineError("Logical OR requires an array value.");
      }
      const children = value
        .map((item) =>
          predicateOf(b, row, model, item as Record<string, unknown>)
        )
        .filter((p): p is Predicate => p !== undefined);
      items.push({ kind: "or", items: children });
      continue;
    }
    if (key === "NOT") {
      const negations = (Array.isArray(value) ? value : [value])
        .map((item) =>
          predicateOf(b, row, model, item as Record<string, unknown>)
        )
        .filter((p): p is Predicate => p !== undefined)
        .map((item): Predicate => ({ kind: "not", item }));
      if (negations.length > 0) items.push({ kind: "and", items: negations });
      continue;
    }
    if (isScalarField(model, key)) {
      items.push(scalarFilter(b, model, key, value));
      continue;
    }
    if (isRelation(model, key)) {
      items.push(relationFilter(b, row, model, key, value));
      continue;
    }
    throw new QueryEngineError(`Unknown where field '${key}'.`);
  }
  return group(items);
}

function scalarFilter(
  b: PatternBuilder,
  model: Model<any>,
  field: string,
  value: unknown
): Predicate {
  if (typeof value !== "object" || value === null) {
    throw new QueryEngineError(
      `Filter for '${field}' must be a filter object (schema validation should have normalized this)`
    );
  }
  const state = model["~"].state.scalars[field]?.["~"].state;
  const filter = value as Record<string, unknown>;
  const column = getColumnName(model, field);
  if (state?.type === "json" && !state.array) {
    return {
      kind: "structural",
      column,
      form: "json",
      operands: [b.literal(filter, { model, field })],
    };
  }
  const mode = filter.mode === "insensitive" ? "insensitive" : "default";
  const leaves: Predicate[] = [];
  for (const [operator, operand] of Object.entries(filter)) {
    if (operand === undefined || operator === "mode") continue;
    if (operator === "distance" || operator === "within") {
      leaves.push({
        kind: "structural",
        column,
        form: operator,
        operands: [b.literal(operand, { model, field })],
      });
      continue;
    }
    leaves.push(scalarLeaf(b, model, field, operator, operand, mode));
  }
  if (leaves.length === 0) {
    throw new QueryEngineError(
      `Filter for field '${field}' must contain at least one operation.`
    );
  }
  return leaves.length === 1 ? leaves[0]! : { kind: "and", items: leaves };
}

function requireObject(
  field: string,
  operator: string,
  value: unknown
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation filter '${field}.${operator}' requires an object.`
    );
  }
  return value;
}

function relationFilter(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  value: unknown
): Predicate {
  if (spansVariants(b.index, model, field)) {
    return spanningFilter(b, row, model, field, value);
  }
  const filter = value as Record<string, unknown>;
  const items: Predicate[] = [];
  if (slotCardinality(model, field) === "many") {
    for (const quantifier of ["some", "every", "none"] as const) {
      const inner = filter[quantifier];
      if (inner === undefined) continue;
      items.push(
        quantified(
          b,
          row,
          model,
          field,
          undefined,
          quantifier,
          requireObject(field, quantifier, inner)
        )
      );
    }
    if (items.length === 0) {
      throw new QueryEngineError(
        `Relation filter '${field}' requires one of: some, every, none.`
      );
    }
    return { kind: "and", items };
  }
  for (const quantifier of ["is", "isNot"] as const) {
    const inner = filter[quantifier];
    if (inner === undefined) continue;
    if (inner === null) {
      items.push(presence(b, row, model, field, undefined, quantifier));
      continue;
    }
    items.push(
      quantified(
        b,
        row,
        model,
        field,
        undefined,
        quantifier,
        requireObject(field, quantifier, inner)
      )
    );
  }
  if (items.length === 0) {
    throw new QueryEngineError(
      `Relation filter '${field}' requires one of: is, isNot.`
    );
  }
  return { kind: "and", items };
}

function presence(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  variant: string | undefined,
  quantifier: "is" | "isNot"
): Predicate {
  const { extension } = extend(b, row, model, field, variant, "one");
  const leaf: PresenceLeaf = {
    kind: "relation",
    quantifier,
    extension,
    presence: "null",
  };
  return leaf as Predicate;
}

function quantified(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  variant: string | undefined,
  quantifier: "some" | "every" | "none" | "is" | "isNot",
  innerWhere: Record<string, unknown> | undefined,
  negateInner = false
): Predicate {
  const { extension, target, targetRow, targetModel } = extend(
    b,
    row,
    model,
    field,
    variant,
    "one"
  );
  const built = predicateOf(target, targetRow, targetModel, innerWhere);
  const inner: Predicate | undefined =
    innerWhere === undefined
      ? undefined
      : built === undefined
        ? { kind: "and", items: [] }
        : negateInner
          ? { kind: "not", item: built }
          : built;
  return {
    kind: "relation",
    quantifier,
    extension,
    ...(inner ? { inner } : {}),
  };
}

function spanningFilter(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  value: unknown
): Predicate {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Polymorphic collection filter '${field}' must be an object.`
    );
  }
  if (spanningSlotStoresOnHolder(b.index, model, field)) {
    const first = variantNames(b.index, model, field)[0];
    if (value.is === null) return presence(b, row, model, field, first, "is");
    if (value.isNot === null) {
      return presence(b, row, model, field, first, "isNot");
    }
    const variant = String(value.type);
    const nested = isRecord(value.is)
      ? value.is
      : isRecord(value.isNot)
        ? value.isNot
        : undefined;
    return quantified(
      b,
      row,
      model,
      field,
      variant,
      Object.hasOwn(value, "is") ? "is" : "isNot",
      nested
    );
  }
  const items: Predicate[] = [];
  for (const quantifier of ["some", "every", "none"] as const) {
    const tagged = value[quantifier];
    if (tagged === undefined) continue;
    if (!isRecord(tagged)) {
      throw new QueryEngineError(
        `Polymorphic collection filter '${field}.${quantifier}' requires an object.`
      );
    }
    const variant = String(tagged.type);
    const nested = isRecord(tagged.is)
      ? tagged.is
      : isRecord(tagged.isNot)
        ? tagged.isNot
        : undefined;
    items.push(
      quantified(
        b,
        row,
        model,
        field,
        variant,
        quantifier,
        nested,
        nested !== undefined && !Object.hasOwn(tagged, "is")
      )
    );
  }
  if (items.length === 0) {
    throw new QueryEngineError(
      `Polymorphic collection filter '${field}' requires one of: some, every, none.`
    );
  }
  return { kind: "and", items };
}

// ---------------------------------------------------------------------------
// Extension along a reference
// ---------------------------------------------------------------------------

interface Extended {
  readonly extension: ReadExtension;
  readonly target: PatternBuilder;
  readonly targetRow: RowId;
  readonly targetModel: Model<any>;
  finish(projection: Projection | undefined): Pattern;
}

function extend(
  b: PatternBuilder,
  parentRow: RowId,
  model: Model<any>,
  field: string,
  variant: string | undefined,
  cardinality: Row["cardinality"],
  options: { readonly visible?: boolean; readonly allVariants?: boolean } = {}
): Extended {
  const cells = cellsFor(b.index, model, field, variant);
  const target = new PatternBuilder(b.ids, b.index);
  // The row the reference reaches from the asking side: the referenced row when
  // the asking row (or an own row) stores the reference, the holder otherwise.
  const targetModel =
    cells.viaJunction || cells.holderIsSource
      ? cells.referenced.model
      : cells.holder.model;
  const targetRow = target.row(targetModel, cardinality);
  const relation = { model, field };
  const common = {
    relation,
    onKeyChange: cells.onKeyChange,
    nullable: cells.nullable,
    unique: cells.unique,
  } as const;

  let reference: Reference;
  if (cells.viaJunction) {
    const ownRow = target.row(targetModel, "set", {
      key: [],
      table: cells.viaJunction.table,
    });
    target.references.push({
      holder: ownRow,
      referenced: targetRow,
      columns: cells.cells,
      ...common,
    });
    reference = {
      holder: ownRow,
      referenced: parentRow,
      columns: askingSidePairs(b.index, model, field, variant, cells),
      ...common,
    };
  } else {
    const discriminator = cells.discriminator
      ? {
          column: cells.discriminator.column,
          value: target.literal(cells.discriminator.storedValue),
        }
      : undefined;
    reference = cells.holderIsSource
      ? {
          holder: parentRow,
          referenced: targetRow,
          columns: cells.cells,
          ...(discriminator ? { discriminator } : {}),
          ...common,
        }
      : {
          holder: targetRow,
          referenced: parentRow,
          columns: cells.cells,
          ...(discriminator ? { discriminator } : {}),
          ...common,
        };
  }

  const pattern: { current?: Pattern } = {};
  const extension: ReadExtension = {
    reference,
    get target(): Pattern {
      pattern.current ??= target.finish(targetRow, "match", undefined);
      return pattern.current;
    },
    ...(variant !== undefined && !options.allVariants ? { variant } : {}),
    ...(options.visible === false ? { visible: false } : {}),
  };
  return {
    extension,
    target,
    targetRow,
    targetModel,
    finish(projection) {
      pattern.current = target.finish(targetRow, "match", projection);
      return pattern.current;
    },
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const isDistanceSelect = (value: unknown): value is { _distance: unknown } =>
  isRecord(value) && Object.hasOwn(value, "_distance");

type RelationEntry = Projection["relations"][number];
type CountEntry = Projection["relationCounts"][number];

function projectionOf(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined
): Projection {
  const scalars: string[] = [];
  const relations: RelationEntry[] = [];
  const relationCounts: CountEntry[] = [];
  const computed: NonNullable<Projection["computed"]>[number][] = [];
  const scalarFields = getScalarFieldNames(model);

  if (select) {
    let hasDistanceSelect = false;
    let hasDistanceOutputField = false;
    for (const field of scalarFields) {
      if (select[field] === true) {
        if (field === "_distance") hasDistanceOutputField = true;
        scalars.push(field);
        b.cell(row, model, field);
        continue;
      }
      const value = select[field];
      if (isDistanceSelect(value)) {
        if (hasDistanceSelect) {
          throw new QueryEngineError(
            "Distance select supports only one _distance field per select."
          );
        }
        hasDistanceSelect = true;
        computed.push({
          name: DISTANCE_RESULT_KEY,
          form: "distance",
          operands: [
            b.literal(field, { model, field }),
            b.literal(value._distance, { model, field }),
          ],
        });
      }
    }
    for (const [key, value] of Object.entries(select)) {
      if (value === undefined || value === false) continue;
      if (!isRelation(model, key)) continue;
      if (key === "_distance") hasDistanceOutputField = true;
      if (spansVariants(b.index, model, key)) {
        relations.push(...spanningProjection(b, row, model, key, value));
        continue;
      }
      if (typeof value === "object" && value !== null) {
        relations.push(
          relationProjection(
            b,
            row,
            model,
            key,
            value as Record<string, unknown>
          )
        );
      }
    }
    if (hasDistanceSelect && hasDistanceOutputField) {
      throw new QueryEngineError(
        "A distance result cannot be selected together with a model field named '_distance'."
      );
    }
  } else {
    for (const field of getDefaultScalarFieldNames(model)) {
      scalars.push(field);
      b.cell(row, model, field);
    }
  }

  const selectCount =
    select && Object.hasOwn(select, "_count") ? select._count : undefined;
  if (isRecord(selectCount) && isRecord(selectCount.select)) {
    relationCounts.push(...countProjection(b, row, model, selectCount.select));
  }

  if (include) {
    const includeCount = Object.hasOwn(include, "_count")
      ? include._count
      : undefined;
    const includeCountSelect =
      isRecord(includeCount) && Object.hasOwn(includeCount, "select")
        ? includeCount.select
        : undefined;
    if (
      getDefaultScalarFieldNames(model).includes("_count") &&
      isRecord(includeCountSelect) &&
      Object.values(includeCountSelect).some(
        (selected) => selected !== false && selected !== undefined
      )
    ) {
      throw new QueryEngineError(
        "Relation counts cannot be selected together with a model field named '_count'."
      );
    }
    for (const [key, value] of Object.entries(include)) {
      if (value === undefined || value === false) continue;
      if (key === "_count") {
        if (isRecord(value) && isRecord(value.select)) {
          relationCounts.push(...countProjection(b, row, model, value.select));
        }
        continue;
      }
      if (!isRelation(model, key)) continue;
      if (spansVariants(b.index, model, key)) {
        relations.push(...spanningProjection(b, row, model, key, value));
        continue;
      }
      relations.push(
        relationProjection(
          b,
          row,
          model,
          key,
          value === true ? {} : (value as Record<string, unknown>)
        )
      );
    }
  }

  if (
    scalars.length === 0 &&
    relations.length === 0 &&
    relationCounts.length === 0 &&
    computed.length === 0 &&
    select !== undefined
  ) {
    throw new QueryEngineError(
      `The 'select' statement for model '${model["~"].state.name}' needs at least one truthy value.`
    );
  }

  return {
    scalars,
    relations,
    relationCounts,
    ...(computed.length > 0 ? { computed } : {}),
  };
}

function relationProjection(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  args: Record<string, unknown>
): RelationEntry {
  const cardinality = slotCardinality(model, field);
  const extended = extend(
    b,
    row,
    model,
    field,
    undefined,
    cardinality === "many" ? "set" : "one"
  );
  extended.finish(nestedProjection(extended, args));
  return { field, extension: extended.extension, cardinality };
}

/** The projection of an extended row: its own select/include, where and window. */
function nestedProjection(
  extended: Extended,
  args: Record<string, unknown>
): Projection {
  const { target, targetRow, targetModel } = extended;
  const read = args as ReadArgs;
  target.withPredicate(
    targetRow,
    predicateOf(target, targetRow, targetModel, read.where)
  );
  const base = projectionOf(
    target,
    targetRow,
    targetModel,
    isRecord(read.select) ? read.select : undefined,
    isRecord(read.include) ? read.include : undefined
  );
  const window = windowOf(target, targetRow, targetModel, read, false);
  return { ...base, window };
}

function spanningProjection(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  value: unknown
): RelationEntry[] {
  const entries: RelationEntry[] = [];
  const onHolder = spanningSlotStoresOnHolder(b.index, model, field);
  const projection = isRecord(value) ? value : undefined;
  const only = Array.isArray(projection?.only)
    ? projection.only.filter((v): v is string => typeof v === "string")
    : undefined;
  const arms = isRecord(projection?.variants) ? projection.variants : undefined;
  for (const variant of variantNames(b.index, model, field)) {
    if (onHolder) {
      const member = isRecord(projection?.[variant])
        ? projection[variant]
        : undefined;
      const extended = extend(b, row, model, field, variant, "one");
      extended.finish(
        projectionOf(
          extended.target,
          extended.targetRow,
          extended.targetModel,
          isRecord(member?.select) ? member.select : undefined,
          isRecord(member?.include) ? member.include : undefined
        )
      );
      entries.push({
        field,
        extension: extended.extension,
        cardinality: "one",
      });
      continue;
    }
    const visible = only ? only.includes(variant) : true;
    const extended = extend(b, row, model, field, variant, "set", { visible });
    const arm = isRecord(arms?.[variant]) ? arms[variant] : {};
    extended.finish(nestedProjection(extended, arm));
    entries.push({ field, extension: extended.extension, cardinality: "many" });
  }
  return entries;
}

function countProjection(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  countSelect: Record<string, unknown>
): CountEntry[] {
  const entries: CountEntry[] = [];
  for (const [field, config] of Object.entries(countSelect)) {
    if (config === undefined || config === false) continue;
    if (!isRelation(model, field)) continue;
    if (spansVariants(b.index, model, field)) {
      if (spanningSlotStoresOnHolder(b.index, model, field)) continue;
      const where =
        isRecord(config) && isRecord(config.where) ? config.where : undefined;
      if (where) {
        const variant = String(where.type);
        const nested = isRecord(where.is)
          ? where.is
          : isRecord(where.isNot)
            ? where.isNot
            : undefined;
        const extended = extend(b, row, model, field, variant, "set");
        const built = predicateOf(
          extended.target,
          extended.targetRow,
          extended.targetModel,
          nested
        );
        extended.target.withPredicate(
          extended.targetRow,
          built && nested !== undefined && !Object.hasOwn(where, "is")
            ? { kind: "not", item: built }
            : built
        );
        extended.finish(undefined);
        entries.push({ field, extension: extended.extension });
        continue;
      }
      const [first] = variantNames(b.index, model, field);
      const extended = extend(b, row, model, field, first, "set", {
        allVariants: true,
      });
      extended.finish(undefined);
      entries.push({ field, extension: extended.extension });
      continue;
    }
    const extended = extend(b, row, model, field, undefined, "set");
    if (isRecord(config) && "where" in config) {
      if (!isRecord(config.where)) {
        throw new QueryEngineError(
          "Relation count where clause must be an object"
        );
      }
      extended.target.withPredicate(
        extended.targetRow,
        predicateOf(
          extended.target,
          extended.targetRow,
          extended.targetModel,
          config.where
        )
      );
    }
    extended.finish(undefined);
    entries.push({ field, extension: extended.extension });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function windowOf(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  args: ReadArgs,
  unitLimit: boolean
): Window {
  const orderBy = orderTermsOf(b, row, model, args.orderBy);
  const take = args.take;
  const cursor = args.cursor ? uniqueKey(b, model, args.cursor).key : undefined;
  return {
    orderBy: orderBy as readonly OrderTerm[],
    ...(unitLimit
      ? { take: take === undefined ? 1 : Math.sign(take) }
      : take !== undefined
        ? { take }
        : {}),
    ...(args.skip !== undefined ? { skip: args.skip } : {}),
    ...(cursor ? { cursor: { key: cursor } } : {}),
    ...(args.distinct ? { distinct: args.distinct } : {}),
  };
}

const MAX_RELATION_ORDER_DEPTH = 8;

function orderTermsOf(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  orderBy: ReadArgs["orderBy"]
): ReadOrderTerm[] {
  if (!orderBy) return [];
  const terms: ReadOrderTerm[] = [];
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const item of items) {
    for (const [field, value] of Object.entries(item)) {
      if (value === undefined) continue;
      if (isScalarField(model, field)) {
        terms.push(scalarOrder(b, model, field, value));
        continue;
      }
      if (!isRelation(model, field)) {
        throw new QueryEngineError(`Unknown orderBy field '${field}'.`);
      }
      if (spansVariants(b.index, model, field)) {
        if (spanningSlotStoresOnHolder(b.index, model, field)) {
          throw new QueryEngineError(`Unknown orderBy field '${field}'.`);
        }
        terms.push(
          countOrder(
            b,
            row,
            model,
            field,
            value,
            variantNames(b.index, model, field)[0]
          )
        );
        continue;
      }
      if (!isRecord(value)) {
        throw new QueryEngineError(
          `Relation orderBy '${field}' must be an object.`
        );
      }
      if (slotCardinality(model, field) === "one") {
        terms.push(...chainOrders(b, row, model, field, value, [], field, 1));
        continue;
      }
      terms.push(countOrder(b, row, model, field, value, undefined));
    }
  }
  return terms;
}

function scalarOrder(
  b: PatternBuilder,
  model: Model<any>,
  field: string,
  value: unknown
): ReadOrderTerm {
  const column = getColumnName(model, field);
  if (value === "asc" || value === "desc") {
    return { kind: "scalar", column, direction: value };
  }
  if (isRecord(value)) {
    if (value._distance !== undefined) {
      return {
        kind: "structural",
        column,
        form: "distance",
        operand: b.literal(value, { model, field }),
      };
    }
    const { sort, nulls } = value;
    if (sort !== "asc" && sort !== "desc") {
      throw new QueryEngineError(
        "OrderBy object requires sort: 'asc' or 'desc'."
      );
    }
    if (nulls !== undefined && nulls !== "first" && nulls !== "last") {
      throw new QueryEngineError(
        "OrderBy object nulls must be 'first' or 'last'."
      );
    }
    return {
      kind: "scalar",
      column,
      direction: sort,
      ...(nulls ? { nulls } : {}),
    };
  }
  if (typeof value === "string") {
    throw new QueryEngineError(`Unsupported sort direction '${value}'.`);
  }
  throw new QueryEngineError("OrderBy value must be a sort direction object.");
}

function chainOrders(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  orderBy: Record<string, unknown>,
  path: readonly ReadExtension[],
  relationPath: string,
  depth: number
): ReadOrderTerm[] {
  if (depth > MAX_RELATION_ORDER_DEPTH) {
    throw new QueryEngineError(
      `Relation orderBy path '${relationPath}' exceeds maximum depth of ${MAX_RELATION_ORDER_DEPTH} relation hops.`
    );
  }
  const extended = extend(b, row, model, field, undefined, "one");
  extended.finish(undefined);
  const chain = [...path, extended.extension];
  const targetModel = extended.targetModel;
  const terms: ReadOrderTerm[] = [];
  for (const [nested, value] of Object.entries(orderBy)) {
    if (value === undefined) continue;
    const fieldPath = `${relationPath}.${nested}`;
    if (
      isRelation(targetModel, nested) &&
      !spansVariants(b.index, targetModel, nested)
    ) {
      if (slotCardinality(targetModel, nested) === "many") {
        throw new QueryEngineError(
          `Relation orderBy '${fieldPath}' cannot order through a to-many relation; use '_count'.`
        );
      }
      if (!isRecord(value)) {
        throw new QueryEngineError(
          `Relation orderBy '${fieldPath}' must be an object.`
        );
      }
      terms.push(
        ...chainOrders(
          extended.target,
          extended.targetRow,
          targetModel,
          nested,
          value,
          chain,
          fieldPath,
          depth + 1
        )
      );
      continue;
    }
    if (!isScalarField(targetModel, nested)) {
      throw new QueryEngineError(
        `Unknown relation orderBy field '${fieldPath}'.`
      );
    }
    const term = scalarOrder(b, targetModel, nested, value);
    if (term.kind === "scalar") {
      terms.push({
        kind: "relationScalar",
        path: chain,
        column: term.column,
        direction: term.direction,
        ...(term.nulls ? { nulls: term.nulls } : {}),
      });
    } else {
      terms.push(term);
    }
  }
  if (terms.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationPath}' requires at least one scalar field.`
    );
  }
  return terms;
}

function countOrder(
  b: PatternBuilder,
  row: RowId,
  model: Model<any>,
  field: string,
  value: unknown,
  variant: string | undefined
): ReadOrderTerm {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation orderBy '${field}' must be an object.`
    );
  }
  const defined = Object.entries(value).filter(([, v]) => v !== undefined);
  if (defined.length === 0) {
    throw new QueryEngineError(`Relation orderBy '${field}' requires _count.`);
  }
  for (const [key] of defined) {
    if (key !== "_count") {
      throw new QueryEngineError(
        `Relation orderBy '${field}.${key}' is not supported. Use '${field}._count' instead.`
      );
    }
  }
  const direction = value._count;
  if (direction !== "asc" && direction !== "desc") {
    throw new QueryEngineError(
      `Relation orderBy '${field}._count' must be 'asc' or 'desc'.`
    );
  }
  const extended = extend(b, row, model, field, variant, "set", {
    allVariants: variant !== undefined,
  });
  extended.finish(undefined);
  return {
    kind: "relationAggregate",
    extension: extended.extension,
    aggregate: "count",
    direction,
  };
}

// ---------------------------------------------------------------------------
// Aggregates, groupBy, having
// ---------------------------------------------------------------------------

type AggregateEntry = NonNullable<Projection["aggregates"]>[number];

function aggregatesOf(
  operation: ReadOperation,
  args: Record<string, unknown>
): AggregateEntry[] {
  const entries: AggregateEntry[] = [];
  if (operation === "count" || operation === "exist") {
    const select = isRecord(args.select) ? args.select : undefined;
    if (!select) return entries;
    for (const [field, include] of Object.entries(select)) {
      if (!include) continue;
      entries.push({ kind: "count", column: field });
    }
    return entries;
  }
  for (const name of ["_count", "_avg", "_sum", "_min", "_max"] as const) {
    const spec = args[name];
    if (spec === undefined || spec === false) continue;
    const kind = name.slice(1) as AggregateEntry["kind"];
    if (spec === true) {
      entries.push({ kind });
      continue;
    }
    if (!isRecord(spec)) continue;
    for (const [field, include] of Object.entries(spec)) {
      if (!include) continue;
      entries.push({ kind, column: field });
    }
  }
  return entries;
}

const AGGREGATE_ORDER_KEYS = new Set([
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
]);

/** groupBy orders: grouped scalars and aggregate expressions only. */
function groupByOrderTermsOf(
  b: PatternBuilder,
  model: Model<any>,
  orderBy: ReadArgs["orderBy"],
  byFields: readonly string[]
): ReadOrderTerm[] {
  if (!orderBy) return [];
  const terms: ReadOrderTerm[] = [];
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue;
      if (AGGREGATE_ORDER_KEYS.has(key)) {
        if (typeof value !== "object" || value === null) {
          throw new QueryEngineError(
            `GroupBy orderBy '${key}' requires an object mapping fields to sort directions.`
          );
        }
        for (const [field, direction] of Object.entries(value)) {
          if (direction === undefined) continue;
          terms.push({
            kind: "aggregate",
            aggregate: key as "_count",
            field,
            direction,
          });
        }
        continue;
      }
      if (!byFields.includes(key)) {
        throw new QueryEngineError(
          `GroupBy orderBy field '${key}' must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max).`
        );
      }
      terms.push(scalarOrder(b, model, key, value));
    }
  }
  return terms;
}

function groupByFields(by: unknown): readonly string[] {
  if (typeof by === "string") return [by];
  return Array.isArray(by)
    ? by.filter((v): v is string => typeof v === "string")
    : [];
}

/** HAVING keeps the public grammar as structural leaves; the packer spells it through the having owner. */
function havingOf(
  b: PatternBuilder,
  model: Model<any>,
  having: Record<string, unknown>
): Predicate {
  const items: Predicate[] = [];
  for (const [key, value] of Object.entries(having)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR" || key === "NOT") {
      const children = (Array.isArray(value) ? value : [value]).map((item) =>
        havingOf(b, model, item as Record<string, unknown>)
      );
      if (key === "AND") {
        items.push({ kind: "and", items: children });
      } else if (key === "OR") {
        items.push({ kind: "or", items: children });
      } else {
        items.push({
          kind: "and",
          items: children.map((item): Predicate => ({ kind: "not", item })),
        });
      }
      continue;
    }
    items.push({
      kind: "structural",
      column: isScalarField(model, key) ? getColumnName(model, key) : key,
      form: "having",
      operands: [b.literal(key), b.literal(value)],
    });
  }
  return { kind: "and", items };
}
