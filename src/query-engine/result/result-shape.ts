import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import type { Model } from "@schema/model";
import { getDefaultScalarFieldNames } from "../context";
import type { ProgramReadOperation } from "../operation-program";
import { getGroupByFields } from "../operations/groupby-fields";
import {
  type AggregateResultName,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "../result-aliases";
import {
  type ExpectedAggregateResultShape,
  type ExpectedResultShape,
  type Operation,
  QueryEngineError,
} from "../types";

const MODEL_ROW_OPERATIONS = new Set<Operation>([
  "findFirst",
  "findMany",
  "findUnique",
  "create",
  "createManyAndReturn",
  "update",
  "updateManyAndReturn",
  "delete",
  "upsert",
]);

const AGGREGATE_NAMES: readonly AggregateResultName[] = [
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOwnValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function createShape(
  rawKeys: string[],
  relations = new Map<string, ExpectedResultShape>(),
  aggregates = new Map<string, ExpectedAggregateResultShape>(),
  relationCounts = new Set<string>()
): ExpectedResultShape {
  if (new Set(rawKeys).size !== rawKeys.length) {
    throw new QueryEngineError(
      "The requested result shape contains colliding output columns."
    );
  }
  return {
    carrier: "rows",
    rawKeys,
    relations,
    aggregates,
    relationCounts,
  };
}

function selectedEntries(value: unknown): [string, unknown][] {
  if (!isRecord(value)) return [];
  return Object.entries(value).filter(
    ([, selected]) => selected !== false && selected !== undefined
  );
}

function getNestedSelection(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const nested: Record<string, unknown> = {};
  const select = getOwnValue(value, "select");
  const include = getOwnValue(value, "include");
  if (isRecord(select)) nested.select = select;
  if (isRecord(include)) nested.include = include;
  return nested;
}

function buildModelShape(
  model: Model<any>,
  args: Record<string, unknown>
): ExpectedResultShape {
  const rawKeys: string[] = [];
  const relations = new Map<string, ExpectedResultShape>();
  const selectedOutputKeys = new Set<string>();
  const scalars = model["~"].state.scalars;
  const modelRelations = model["~"].state.relations;
  const selectValue = getOwnValue(args, "select");
  const includeValue = getOwnValue(args, "include");
  const select = isRecord(selectValue) ? selectValue : undefined;
  const include = isRecord(includeValue) ? includeValue : undefined;
  let hasVectorDistance = false;

  if (select) {
    for (const [fieldName, value] of Object.entries(select)) {
      const scalar = getOwnValue(scalars, fieldName);
      if (!scalar) continue;
      if (value === true) {
        rawKeys.push(fieldName);
        selectedOutputKeys.add(fieldName);
        continue;
      }
      if (isRecord(value) && Object.hasOwn(value, "_distance")) {
        if (hasVectorDistance) {
          throw new QueryEngineError(
            "Vector distance select supports only one _distance field per select."
          );
        }
        hasVectorDistance = true;
        rawKeys.push(VECTOR_DISTANCE_RESULT_KEY);
      }
    }
  } else {
    for (const fieldName of getDefaultScalarFieldNames(model)) {
      rawKeys.push(fieldName);
      selectedOutputKeys.add(fieldName);
    }
  }

  addSelectedRelations(
    modelRelations,
    select,
    rawKeys,
    relations,
    selectedOutputKeys
  );

  if (hasVectorDistance && selectedOutputKeys.has("_distance")) {
    throw new QueryEngineError(
      "A vector distance result cannot be selected together with a model field named '_distance'."
    );
  }
  addSelectedRelations(
    modelRelations,
    include,
    rawKeys,
    relations,
    selectedOutputKeys
  );

  const relationCountSelections = [
    getOwnValue(select, "_count"),
    getOwnValue(include, "_count"),
  ];
  const relationCounts = new Set<string>();
  for (const countSelection of relationCountSelections) {
    if (!isRecord(countSelection)) continue;
    const countSelect = getOwnValue(countSelection, "select");
    if (!isRecord(countSelect)) continue;
    for (const [relationName] of selectedEntries(countSelect)) {
      if (!Object.hasOwn(modelRelations, relationName)) continue;
      relationCounts.add(relationName);
    }
  }

  if (relationCounts.size > 0 && selectedOutputKeys.has("_count")) {
    throw new QueryEngineError(
      "Relation counts cannot be selected together with a model field named '_count'."
    );
  }
  if (relationCounts.size > 0) rawKeys.push(RELATION_COUNTS_RESULT_KEY);

  if (rawKeys.length === 0) {
    if (select) {
      throw new QueryEngineError(
        `The 'select' statement for model '${model["~"].state.name}' needs at least one truthy value.`
      );
    }
    rawKeys.push(EMPTY_ROW_RESULT_KEY);
  }

  return createShape(rawKeys, relations, new Map(), relationCounts);
}

/**
 * A negative nested `take` runs the relation subquery in reversed order with an
 * absolute limit; the rows therefore arrive last-first and the shape carries the
 * instruction to restore the logical order (top-level parity, `ReadOperation`).
 */
function pagesBackward(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const take = getOwnValue(value, "take");
  return typeof take === "number" && take < 0;
}

function addSelectedRelations(
  modelRelations: Model<any>["~"]["state"]["relations"],
  selection: Record<string, unknown> | undefined,
  rawKeys: string[],
  relations: Map<string, ExpectedResultShape>,
  selectedOutputKeys: Set<string>
): void {
  for (const [relationName, value] of selectedEntries(selection)) {
    const relation = getOwnValue(modelRelations, relationName);
    if (!relation) continue;
    const targetModel = relation["~"].state.getter();
    rawKeys.push(relationName);
    selectedOutputKeys.add(relationName);
    const shape = buildModelShape(targetModel, getNestedSelection(value));
    relations.set(
      relationName,
      pagesBackward(value) ? { ...shape, reversed: true } : shape
    );
  }
}

function buildAggregateShape(
  args: Record<string, unknown>,
  groupedFields: readonly string[] = []
): ExpectedResultShape {
  const rawKeys = [...groupedFields];
  const selectedOutputKeys = new Set(groupedFields);
  const aggregates = new Map<string, ExpectedAggregateResultShape>();

  for (const aggregateName of AGGREGATE_NAMES) {
    const spec = getOwnValue(args, aggregateName);
    if (spec === undefined || spec === false) continue;

    let fields: ReadonlySet<string> | undefined;
    if (!(aggregateName === "_count" && spec === true)) {
      const entries = selectedEntries(spec);
      if (entries.length === 0) continue;
      fields = new Set(entries.map(([fieldName]) => fieldName));
    }

    if (selectedOutputKeys.has(aggregateName)) {
      throw new QueryEngineError(
        `GroupBy cannot return both grouped scalar '${aggregateName}' and aggregate '${aggregateName}' in one result.`
      );
    }

    const rawKey = getAggregateResultKey(aggregateName);
    rawKeys.push(rawKey);
    selectedOutputKeys.add(aggregateName);
    aggregates.set(rawKey, {
      ...(fields ? { fields } : {}),
    });
  }

  return createShape(rawKeys, new Map(), aggregates);
}

function buildCountShape(args: Record<string, unknown>): ExpectedResultShape {
  const fields = selectedEntries(getOwnValue(args, "select")).map(
    ([fieldName]) => fieldName
  );
  return {
    ...createShape(fields.length === 0 ? [COUNT_RESULT_KEY] : fields),
    carrier: "count",
  };
}

export function buildExpectedResultShape(
  model: Model<any>,
  operation: ProgramReadOperation,
  args: Record<string, unknown>
): ExpectedResultShape;
export function buildExpectedResultShape(
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>
): ExpectedResultShape | undefined;
export function buildExpectedResultShape(
  model: Model<any>,
  operation: Operation,
  args: Record<string, unknown>
): ExpectedResultShape | undefined {
  if (operation === "count") return buildCountShape(args);
  if (operation === "exist") {
    return {
      ...createShape([COUNT_RESULT_KEY]),
      carrier: "existence",
    };
  }
  if (operation === "aggregate") return buildAggregateShape(args);
  if (operation === "groupBy") {
    const groupedFields = getGroupByFields(getOwnValue(args, "by"));
    return buildAggregateShape(args, groupedFields);
  }
  if (MODEL_ROW_OPERATIONS.has(operation)) {
    return buildModelShape(model, args);
  }
  return undefined;
}
