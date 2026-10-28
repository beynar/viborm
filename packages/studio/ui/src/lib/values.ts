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

/** A value as its editor shows it: a calendar date as its day, a time of day to the second. */
export function draftOf(field: StudioField, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (editsAsJson(field)) return JSON.stringify(value, null, 2);
  if (field.type === "date" && !field.list) return dayText(value);
  if (field.type === "time" && !field.list) return timeText(value);
  return String(value);
}

// Times as a person reads and picks them. An instant is shown and picked in the browser's own zone, and written
// back as an ISO instant; a calendar date is its stored day (the API spells it as that day's UTC midnight), and a
// time of day has no zone. The pickers hold local `Date`s and seconds since midnight.
const pad = (value: number, width = 2) => String(value).padStart(width, "0");
const dayOfDate = (date: Date) =>
  `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** An instant in the browser's zone, to the second; anything else as it came. */
export function instantText(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${dayOfDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
/** A value as a read-only cell says it: instants in the browser's zone, days and times as the table shows them. */
export function cellText(field: StudioField, value: unknown): string {
  if (value === null || value === undefined || field.list)
    return display(value);
  if (field.type === "datetime") return instantText(value);
  if (field.type === "date") return dayText(value);
  if (field.type === "time") return timeText(value);
  return display(value);
}

/** A calendar date's day, `YYYY-MM-DD`. */
export const dayText = (value: unknown) => String(value).slice(0, 10);
/** A time of day to the second, `HH:mm:ss`. */
export const timeText = (value: unknown) => String(value).slice(0, 8);

/** A stored day as the calendar's local date, and a picked date as the day to store. */
export function dayToDate(day: string): Date | null {
  const [year, month, date] = day.split("-").map(Number);
  return year && month && date ? new Date(year, month - 1, date) : null;
}
export const dateToDay = (date: Date) => dayOfDate(date);

/** `HH:mm:ss` as seconds since midnight, and back. */
export function timeToSeconds(time: string): number | null {
  const [hours, minutes, seconds = 0] = time.split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes)
    ? hours! * 3600 + minutes! * 60 + Math.floor(seconds)
    : null;
}
export const secondsToTime = (seconds: number) =>
  `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;

/** An ISO instant as the local day and the seconds into it, and back. */
export function instantParts(
  instant: string
): { day: Date; seconds: number } | null {
  const date = new Date(instant);
  if (!instant || Number.isNaN(date.getTime())) return null;
  return {
    day: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
    seconds:
      date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds(),
  };
}
export const instantOf = (day: Date, seconds: number) =>
  new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    0,
    0,
    seconds
  ).toISOString();

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
  // A compact identifier's filter compares; it has no substring to search.
  if (field.type === "string" && !field.searchable) {
    return ["equals", "not", "in", ...nulls];
  }
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
  /** A text comparison folds ASCII letters (`mode: "insensitive"`). */
  ignoreCase?: boolean;
}

/** Whether a condition can ignore case: a comparison of a text column (a compact identifier's filter has no mode). */
export const foldsCase = (field: StudioField, operator: Operator) =>
  field.searchable && operator !== "isNull" && operator !== "isNotNull";

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
  const mode =
    condition.ignoreCase && foldsCase(field, operator)
      ? { mode: "insensitive" }
      : {};
  return { [field.name]: { [operator]: value, ...mode } };
}

/** Rows one relation of one row reaches: a model, the `where` that finds them there, and the variant it went through. */
export interface RelatedScope {
  readonly target: string;
  readonly where: Where;
  readonly variant?: string;
}

/** A polymorphic to-one as the API reads it: the variant reached, and that row's key. */
export type Reached = { type: string; data: Record<string, unknown> };

/** Whether a relation's value is a polymorphic to-one as the API reads it. */
export function isReached(value: unknown): value is Reached {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
  );
}

/** A polymorphic to-one as a cell says it: the variant, then that row's key. */
export const reachedText = ({ type, data }: Reached) =>
  `${type} ${Object.values(data).map(display).join(", ")}`;

/**
 * The rows a relation of one row reaches, as a `where` on each model it can
 * reach: through the partner slot when there is one (`is` for a to-one
 * partner, `some` for a to-many one), else through the key the row holds.
 * A polymorphic relation is followed as the client filters it: a member's
 * inverse matches the carrier's `{ type, is }`; a to-one carrier reaches the
 * one row it holds; a collection reaches, per variant, the rows whose inverse
 * holds this row (a variant without an inverse cannot be listed). Undefined
 * when nothing can be followed; empty when a to-one reaches no row.
 */
export function relatedScopes(
  model: StudioModel,
  relation: StudioRelation,
  row: Record<string, unknown>
): RelatedScope[] | undefined {
  if (!model.key) return undefined;
  const self = Object.fromEntries(
    model.key.fields.map((field) => [field, row[field]])
  );
  if (relation.variants && relation.cardinality === "one") {
    const reached = row[relation.name];
    if (!isReached(reached)) return [];
    const variant = relation.variants.find(
      (candidate) => candidate.name === reached.type
    );
    return variant
      ? [{ target: variant.target, where: reached.data, variant: variant.name }]
      : [];
  }
  if (relation.variants) {
    const listed = relation.variants.flatMap((variant) =>
      variant.inverse
        ? [
            {
              target: variant.target,
              variant: variant.name,
              where: {
                [variant.inverse]:
                  variant.inverseCardinality === "one"
                    ? { is: self }
                    : { some: self },
              },
            },
          ]
        : []
    );
    return listed.length > 0 ? listed : undefined;
  }
  const target = relation.targets[0]!;
  if (relation.inverse !== undefined && relation.inverseCardinality) {
    // A member's inverse matches its own variant of the carrier, not any row with this key.
    const member = relation.variant
      ? { type: relation.variant, is: self }
      : undefined;
    const match =
      relation.inverseCardinality === "many"
        ? { some: member ?? self }
        : (member ?? { is: self });
    return [{ target, where: { [relation.inverse]: match } }];
  }
  if (relation.owner && relation.fields.length > 0) {
    const where = Object.fromEntries(
      relation.references.map((reference, index) => [
        reference,
        row[relation.fields[index]!],
      ])
    );
    return [{ target, where }];
  }
  return undefined;
}

/** A value as a table cell's editor holds it: text for what JSON carries as text or structure, else itself. */
export function editable(field: StudioField, value: unknown): unknown {
  if (value === null || value === undefined) return "";
  if (editsAsJson(field)) return JSON.stringify(value);
  // The calendar editor holds a local date.
  if (field.type === "date") return dayToDate(dayText(value));
  if (field.type === "time") return timeText(value);
  if (
    field.type === "int" ||
    field.type === "number" ||
    field.type === "boolean"
  ) {
    return value;
  }
  return String(value);
}

/**
 * What a cell's editor wrote, as the client takes it: emptied text stays an
 * empty string (null is the drawer's checkbox), any other emptied nullable
 * column becomes null; text is typed back by `parseDraft`.
 */
export function written(field: StudioField, value: unknown): unknown {
  if (value === "" && field.searchable) return "";
  if (value === null || value === undefined || value === "") {
    return field.nullable ? null : field.type === "string" ? "" : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return dateToDay(value);
  return parseDraft(field, String(value));
}
