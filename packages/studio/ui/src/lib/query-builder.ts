// The query page's reads, built from pickers rather than written: what to read (conditions as the rows' filter
// writes them, an order, a page, columns and relations), or what to compute (counts, sums, averages, extremes,
// per group). `argsOf` spells them as the client takes them; a value that cannot be one throws its reason.
import type { QueryOperation, StudioField, StudioModel, Where } from "./api";
import {
  type Combinator,
  type FilterEntry,
  filterWhere,
  parseDraft,
} from "./values";

export const AGGREGATES = [
  { value: "_count", label: "count" },
  { value: "_sum", label: "sum" },
  { value: "_avg", label: "average" },
  { value: "_min", label: "minimum" },
  { value: "_max", label: "maximum" },
] as const;
export type Aggregate = (typeof AGGREGATES)[number]["value"];
/** The function a picker's value names, if it names one. */
export const aggregateOf = (value: string | null | undefined) =>
  AGGREGATES.find((entry) => entry.value === value);

/** One value computed: a function of a column (no column: the rows themselves, counted). */
export interface Computed {
  id: number;
  fn: Aggregate;
  field: string;
}

export interface Sort {
  id: number;
  field: string;
  desc: boolean;
}

export interface QueryDraft {
  conditions: FilterEntry[];
  combinator: Combinator;
  sort: Sort[];
  take: number | null;
  skip: number | null;
  /** The columns read; none chosen, every one. */
  columns: string[];
  /** The relations read with each row. */
  include: string[];
  /** `findUnique`: the unique column and its value. */
  key: { field: string; value: string };
  /** `groupBy`: the columns a group shares. */
  by: string[];
  computed: Computed[];
}

const NUMERIC = new Set<StudioField["type"]>([
  "int",
  "number",
  "decimal",
  "bigint",
]);
const ORDERED = new Set<StudioField["type"]>([
  ...NUMERIC,
  "string",
  "datetime",
  "date",
  "time",
  "enum",
]);

/** The columns a function reads: sums and averages of numbers, extremes of what orders, counts of any column. */
export function aggregatable(model: StudioModel, fn: Aggregate): StudioField[] {
  return model.fields.filter((field) => {
    if (fn === "_count") return true;
    if (field.list) return false;
    if (fn === "_sum" || fn === "_avg") return NUMERIC.has(field.type);
    if (fn === "_min" || fn === "_max") return ORDERED.has(field.type);
    return true;
  });
}

/** Columns one row is found by: the single-column key, and each unique column. */
export const uniqueFields = (model: StudioModel) =>
  model.fields.filter(
    (field) =>
      !field.list &&
      ((field.id && model.key?.fields.length === 1) || field.unique)
  );

/** Columns a group can share, or an order follow: one value each. */
export const scalarFields = (model: StudioModel) =>
  model.fields.filter(
    (field) =>
      !(field.list || ["json", "blob", "vector", "point"].includes(field.type))
  );

export const emptyDraft = (model: StudioModel): QueryDraft => ({
  conditions: [],
  combinator: "AND",
  sort: [],
  take: 20,
  skip: null,
  columns: [],
  include: [],
  key: { field: uniqueFields(model)[0]?.name ?? "", value: "" },
  by: [],
  computed: [{ id: 1, fn: "_count", field: "" }],
});

/** The conditions as one `where`, or none; those still waiting for a value are left out. */
export const whereOf = (
  model: StudioModel,
  models: readonly StudioModel[],
  draft: QueryDraft
): Where | undefined =>
  filterWhere(model, models, draft.conditions, draft.combinator).where;

function computedArgs(draft: QueryDraft): Record<string, unknown> {
  const out: Record<string, Record<string, true> | true> = {};
  for (const { fn, field } of draft.computed) {
    if (fn === "_count" && field === "") {
      const counted = out._count;
      out._count =
        counted === undefined || counted === true
          ? true
          : { ...counted, _all: true };
      continue;
    }
    if (field === "") continue;
    const before = out[fn];
    out[fn] =
      before === true
        ? { _all: true, [field]: true }
        : { ...before, [field]: true };
  }
  return out;
}

/** The arguments of the operation, as the client takes them. */
export function argsOf(
  model: StudioModel,
  models: readonly StudioModel[],
  operation: QueryOperation,
  draft: QueryDraft
): Record<string, unknown> {
  // Only the operations that filter read the conditions: a lookup by key does not.
  const filtering = () => {
    const where = whereOf(model, models, draft);
    return where ? { where } : {};
  };
  const sorts = draft.sort.filter(
    (sort) =>
      sort.field !== "" &&
      (operation !== "groupBy" || draft.by.includes(sort.field))
  );
  const ordered = sorts.length
    ? {
        orderBy: sorts.map((sort) => ({
          [sort.field]: sort.desc ? "desc" : "asc",
        })),
      }
    : {};
  const taken = draft.take === null ? {} : { take: draft.take };
  const skipped = draft.skip === null ? {} : { skip: draft.skip };
  const related = Object.fromEntries(draft.include.map((name) => [name, true]));
  const shaped = draft.columns.length
    ? {
        select: {
          ...Object.fromEntries(draft.columns.map((name) => [name, true])),
          ...related,
        },
      }
    : draft.include.length
      ? { include: related }
      : {};
  switch (operation) {
    case "findMany":
      return { ...filtering(), ...ordered, ...taken, ...skipped, ...shaped };
    case "findFirst":
      return { ...filtering(), ...ordered, ...skipped, ...shaped };
    case "findUnique": {
      const field = model.fields.find(
        (candidate) => candidate.name === draft.key.field
      );
      if (!field) throw new Error("Choose the column the row is found by");
      if (draft.key.value.trim() === "")
        throw new Error(`Write the ${field.name} of the row to find`);
      return {
        where: { [field.name]: parseDraft(field, draft.key.value.trim()) },
        ...shaped,
      };
    }
    case "count":
      return { ...filtering() };
    case "aggregate":
      return { ...filtering(), ...computedArgs(draft) };
    default:
      if (draft.by.length === 0)
        throw new Error("Choose the columns the groups share");
      return {
        by: draft.by,
        ...filtering(),
        ...computedArgs(draft),
        ...ordered,
        ...taken,
        ...skipped,
      };
  }
}

/**
 * A computed value's column: said as it reads (`_sum.rating` → "sum · rating", `_count` → "count"), and shown as a
 * number, or as the column it is the extreme of (`_max.createdAt` is an instant).
 */
export function computedColumn(
  model: StudioModel | undefined,
  key: string
): { label: string; numeric: boolean; field?: StudioField } | undefined {
  const [name, of] = key.split(".");
  const fn = aggregateOf(name);
  if (!fn) return undefined;
  const said = fn.label;
  const label = of === undefined || of === "_all" ? said : `${said} · ${of}`;
  const field = model?.fields.find((candidate) => candidate.name === of);
  const extreme = fn.value === "_min" || fn.value === "_max";
  if (extreme && field && !NUMERIC.has(field.type))
    return { label, numeric: false, field };
  return { label, numeric: true };
}

const IDENTIFIER = /"([A-Za-z_$][\w$]*)":/g;
/** The call as the application would write it. */
export const codeOf = (
  model: string,
  operation: QueryOperation,
  args: Record<string, unknown>
) =>
  `await client.${model}.${operation}(${
    Object.keys(args).length
      ? JSON.stringify(args, null, 2).replace(IDENTIFIER, "$1:")
      : ""
  });`;

/** A result as table rows: an aggregate's groups flattened (`_sum.karma`), a relation's rows counted. */
export function tableOf(result: unknown): {
  columns: string[];
  rows: Record<string, unknown>[];
} {
  const list = Array.isArray(result)
    ? result
    : result === null || result === undefined
      ? []
      : [result];
  const rows = list.map((entry) => {
    if (typeof entry !== "object" || entry === null) return { value: entry };
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) {
      const nested =
        key.startsWith("_") &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value);
      if (nested) {
        for (const [inner, held] of Object.entries(value))
          row[`${key}.${inner}`] = held;
      } else row[key] = value;
    }
    return row;
  });
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return { columns, rows };
}
