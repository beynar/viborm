// How a column's values are shown, typed and filtered. The API carries
// bigints and decimals as text, bytes as base64 and instants as ISO text; the
// client validates whatever the studio sends back.
import type { StudioField, StudioModel, StudioRelation, Where } from "./api";

export const TYPE_LABELS: Record<StudioField["type"], string> = {
  string: "String",
  int: "Int",
  number: "Float",
  decimal: "Decimal",
  boolean: "Boolean",
  datetime: "DateTime",
  date: "Date",
  time: "Time",
  bigint: "BigInt",
  json: "Json",
  blob: "Blob",
  vector: "Vector",
  point: "Point",
  enum: "Enum",
};

export const typeLabel = (field: StudioField) =>
  `${TYPE_LABELS[field.type]}${field.list ? "[]" : ""}${field.nullable ? "?" : ""}`;

/** A cell's text. */
export function display(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Fields edited as JSON text: structures, lists and points. */
export const editsAsJson = (field: StudioField) =>
  field.list ||
  field.type === "json" ||
  field.type === "point" ||
  field.type === "vector";

/** A value as its editor shows it. */
export function draftOf(field: StudioField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (editsAsJson(field)) return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * A draft typed back into the value the API takes. Throws a readable message
 * when the text cannot be one; everything else is the client's to refuse.
 */
export function parseDraft(field: StudioField, draft: string): unknown {
  if (editsAsJson(field)) {
    try {
      return JSON.parse(draft);
    } catch {
      throw new Error(`${field.name}: not valid JSON`);
    }
  }
  switch (field.type) {
    case "int":
    case "number": {
      const number = Number(draft.trim());
      if (draft.trim() === "" || !Number.isFinite(number)) {
        throw new Error(`${field.name}: not a number`);
      }
      return number;
    }
    case "boolean":
      return draft === "true";
    case "bigint":
    case "decimal":
      return draft.trim();
    default:
      return draft;
  }
}

export type Operator =
  | "equals"
  | "not"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "in"
  | "isNull"
  | "isNotNull";

export const OPERATOR_LABELS: Record<Operator, string> = {
  equals: "=",
  not: "≠",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  lt: "<",
  lte: "≤",
  gt: ">",
  gte: "≥",
  in: "in",
  isNull: "is null",
  isNotNull: "is not null",
};

const NUMERIC = new Set(["int", "number", "bigint", "decimal"]);
const TEMPORAL = new Set(["datetime", "date", "time"]);

export function operatorsOf(field: StudioField): Operator[] {
  const nulls: Operator[] = field.nullable ? ["isNull", "isNotNull"] : [];
  if (field.list) return nulls;
  if (field.type === "string") {
    return [
      "contains",
      "equals",
      "not",
      "startsWith",
      "endsWith",
      "in",
      ...nulls,
    ];
  }
  if (NUMERIC.has(field.type)) {
    return ["equals", "not", "lt", "lte", "gt", "gte", "in", ...nulls];
  }
  if (TEMPORAL.has(field.type)) {
    return ["equals", "lt", "lte", "gt", "gte", ...nulls];
  }
  if (field.type === "boolean") return ["equals", ...nulls];
  if (field.type === "enum") return ["equals", "not", "in", ...nulls];
  return nulls;
}

export interface Condition {
  id: number;
  field: string;
  operator: Operator;
  value: string;
}

/** One condition as the client's `where` spells it. */
export function conditionWhere(
  field: StudioField,
  condition: Condition
): Where {
  const { operator } = condition;
  if (operator === "isNull") return { [field.name]: null };
  if (operator === "isNotNull") return { [field.name]: { not: null } };
  const value =
    operator === "in"
      ? condition.value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "")
          .map((entry) => parseDraft(field, entry))
      : parseDraft(field, condition.value);
  return { [field.name]: { [operator]: value } };
}

/**
 * The rows a relation of one row reaches, as a `where` on its target: through
 * the partner slot when there is one (`is` for a to-one partner, `some` for a
 * to-many one), else through the key the row holds.
 */
export function relatedWhere(
  model: StudioModel,
  relation: StudioRelation,
  row: Record<string, unknown>
): Where | undefined {
  if (
    !model.key ||
    relation.storage === "variant" ||
    relation.targets.length !== 1
  ) {
    return undefined;
  }
  if (relation.inverse !== undefined && relation.inverseCardinality) {
    const self = Object.fromEntries(
      model.key.fields.map((field) => [field, row[field]])
    );
    return {
      [relation.inverse]:
        relation.inverseCardinality === "many" ? { some: self } : { is: self },
    };
  }
  if (relation.owner && relation.fields.length > 0) {
    return Object.fromEntries(
      relation.references.map((reference, index) => [
        reference,
        row[relation.fields[index]!],
      ])
    );
  }
  return undefined;
}
