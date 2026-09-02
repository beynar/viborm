/**
 * One provider row set of an expected result shape, for the match differentials.
 *
 * Shared by the read fuzz (§13.5 M3) and the write-result fuzz: both need rows
 * a real driver could have returned for one compiled projection — native
 * scalars at the root, JSON carriers for nested rows (as objects on PostgreSQL,
 * as text on SQLite and MySQL), the polymorphic envelopes the read builders
 * emit, and the `_count` / aggregate carriers — so that today's parser and
 * `decodeRows` are handed the identical input.
 */
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { classifyResultColumn } from "@query-engine/result/result-column";
import { getAggregateResultName } from "@query-engine/result-aliases";
import type {
  ExpectedPolymorphicResultShape,
  ExpectedResultShape,
} from "@query-engine/types";
import type { Model } from "@schema/model";
import type { Scalar } from "@schema/scalars";

/**
 * A provider-valid value per scalar. Root rows carry provider-native values;
 * a JSON carrier (a nested row) carries what the read's own transport casts
 * emit (bigint and decimal as text, dates as ISO text).
 */
function scalarValue(scalar: Scalar, nested: boolean): unknown {
  const state = scalar["~"].state;
  if (state.array) return [];
  switch (state.type) {
    case "int":
    case "number":
      return 1;
    case "bigint":
      return nested ? "1" : 1n;
    case "boolean":
      return true;
    case "datetime":
    case "date":
    case "time":
      return nested
        ? "2026-01-01T00:00:00.000Z"
        : new Date(Date.UTC(2026, 0, 1));
    case "decimal":
      return "1.00";
    case "json":
      return { tag: "row" };
    case "blob":
      return nested ? "01" : new Uint8Array([1]);
    case "enum":
      return (
        (scalar as { enumValues?: readonly string[] }).enumValues?.[0] ?? ""
      );
    default:
      return `${state.type}_1`;
  }
}

const carrier = (value: unknown, text: boolean): unknown =>
  text ? JSON.stringify(value) : value;

export function synthesizeRow(
  model: Model<any>,
  shape: ExpectedResultShape,
  nested: boolean,
  text: boolean
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const scalars: Record<string, Scalar> = model["~"].state.scalars;
  for (const key of shape.rawKeys) {
    const column = classifyResultColumn(model, key, shape);
    switch (column.kind) {
      case "empty":
        row[key] = 1;
        break;
      case "distance":
        row[key] = 1.5;
        break;
      case "scalar":
        row[key] = scalarValue(column.scalar, nested);
        break;
      case "relationCounts":
        row[key] = carrier(
          Object.fromEntries([...column.relations].map((name) => [name, 2])),
          text
        );
        break;
      case "relation": {
        const expected = column.expected;
        const one = synthesizeRow(expected.model, expected.shape, true, false);
        row[key] = carrier(
          expected.cardinality === "many"
            ? [one, synthesizeRow(expected.model, expected.shape, true, false)]
            : one,
          text
        );
        break;
      }
      case "polymorphic":
        row[key] = carrier(polymorphicCarrier(column.expected), text);
        break;
      case "aggregate":
        row[key] = aggregateValue(
          column.name,
          column.expected.fields,
          scalars,
          text
        );
        break;
      default:
        row[key] = null;
    }
  }
  return row;
}

function polymorphicCarrier(expected: ExpectedPolymorphicResultShape): unknown {
  const [first] = expected.variants;
  if (expected.cardinality === "one") {
    if (!first) return null;
    const [type, variant] = first;
    return {
      __viborm_state: "linked",
      type,
      data: synthesizeRow(variant.model, variant.shape, true, false),
    };
  }
  const arms: Record<string, unknown> = {};
  for (const [type, variant] of expected.variants) {
    const rows = variant.visible
      ? [
          {
            __viborm_state: "linked",
            type,
            data: synthesizeRow(variant.model, variant.shape, true, false),
          },
        ]
      : null;
    arms[type] = { membership: rows ? 1 : 0, orphans: 0, rows };
  }
  return { __viborm_state: "collection", arms };
}

function aggregateValue(
  name: string,
  fields: ReadonlySet<string> | undefined,
  scalars: Record<string, Scalar>,
  text: boolean
): unknown {
  if (fields === undefined) return 3;
  const object: Record<string, unknown> = {};
  for (const field of fields) {
    if (name === "_count" || field === "_all") {
      object[field] = 2;
      continue;
    }
    const scalar = scalars[field];
    const type = scalar?.["~"].state.type;
    object[field] =
      name === "_min" || name === "_max"
        ? scalar
          ? scalarValue(scalar, true)
          : 1
        : type === "decimal" || type === "bigint"
          ? "1"
          : 1;
  }
  return carrier(object, text);
}

/**
 * The operations whose result is ONE row object rather than an array — today's
 * `isNullableSingleRecordOperation` / `isRequiredSingleRecordOperation`, which
 * is what decides how many rows a provider may return for one shape.
 */
const SINGLE_ROW_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findFirst",
  "create",
  "update",
  "delete",
  "upsert",
  "aggregate",
]);

export function synthesizeRows(
  model: Model<any>,
  operation: string,
  shape: ExpectedResultShape,
  text: boolean
): unknown[] {
  if (shape.carrier === "existence") return [{ [COUNT_RESULT_KEY]: 1 }];
  if (shape.carrier === "count") {
    return [Object.fromEntries(shape.rawKeys.map((key) => [key, 2]))];
  }
  if (operation === "aggregate") {
    const row: Record<string, unknown> = {};
    for (const key of shape.rawKeys) {
      const name = getAggregateResultName(key);
      row[key] = name
        ? aggregateValue(
            name,
            shape.aggregates.get(key)?.fields,
            model["~"].state.scalars,
            text
          )
        : null;
    }
    return [row];
  }
  const one = synthesizeRow(model, shape, false, text);
  return SINGLE_ROW_OPERATIONS.has(operation)
    ? [one]
    : [one, synthesizeRow(model, shape, false, text)];
}
