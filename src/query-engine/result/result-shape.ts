import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import type { Model } from "@schema/model";
import {
  type AnyRelation,
  isVariantRelationState,
  slotMayBeEmpty,
} from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { projectableScalarNames } from "@validation/model/core/projection";
import type { NormalizedRecurrence } from "@validation/relations/recurrence";
import { isRecord } from "@validation/value-guards";
import {
  type AggregateResultName,
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  getAggregateResultKey,
  RELATION_COUNTS_RESULT_KEY,
} from "../result-aliases";
import {
  type ExpectedAggregateResultShape,
  type ExpectedPolymorphicResultShape,
  type ExpectedPolymorphicVariantShape,
  type ExpectedRelationResultShape,
  type ExpectedResultShape,
  type Operation,
  QueryEngineError,
} from "../types";
import { getGroupByFields } from "./groupby-fields";

const MODEL_ROW_OPERATIONS = new Set<Operation>([
  "findFirst",
  "findMany",
  "findUnique",
  "create",
  "createManyAndReturn",
  "update",
  "updateManyAndReturn",
  "delete",
  "deleteManyAndReturn",
  "upsert",
]);

/**
 * The registered sentence for the output key `_distance` claimed twice, stated
 * once for both result views: this schema-only shape and Raptor 3's prepared
 * projection (`raptor3/shared/query.ts`) raise it.
 */
export const DISTANCE_NAME_COLLISION =
  "A distance result cannot be selected together with a model field named '_distance'.";

/** The registered refusal for a second `_distance` in one select, shared the same way. */
export const DISTANCE_SELECTED_TWICE =
  "Distance select supports only one _distance field per select.";

/**
 * The registered refusal for a written `select` that keeps nothing, stated once
 * for both result views like {@link DISTANCE_NAME_COLLISION}: this schema-only
 * shape and Raptor 3's prepared projection name the model by its schema key.
 */
export function emptySelectRefusal(model: Model<any>): string {
  return `The 'select' statement for model '${model["~"].names.ts ?? "unknown"}' needs at least one truthy value.`;
}

/**
 * The node one arm of a variant slot is read with, or `undefined` when the
 * selection leaves that arm out of the result. One rule for both result views:
 * this schema-only shape and Raptor 3's prepared projection
 * (`raptor3/shared/query.ts`).
 *
 * Only a collection's `only` narrows the arms; admission deduplicates it and
 * refuses a `variants` key outside it. A singular slot has no such key: its row
 * belongs to exactly one arm, so every arm is read and an arm the selection
 * leaves unnamed is read at its model's default projection (`true`), which
 * keeps the result union exhaustive
 * (docs/content/docs/schema/relations/polymorphic.mdx). An admitted arm is
 * `true` or a relation node; admission has no `false` arm.
 */
export function selectedArm(
  selection: unknown,
  many: boolean,
  variant: string
): unknown {
  const configuration = isRecord(selection) ? selection : undefined;
  if (!many) return getOwnValue(configuration, variant) ?? true;
  const only = getOwnValue(configuration, "only");
  if (Array.isArray(only) && !only.includes(variant)) return undefined;
  const arms = getOwnValue(configuration, "variants");
  return (isRecord(arms) ? getOwnValue(arms, variant) : undefined) ?? true;
}

const AGGREGATE_NAMES: readonly AggregateResultName[] = [
  "_count",
  "_avg",
  "_sum",
  "_min",
  "_max",
];

function getOwnValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function createShape(
  rawKeys: string[],
  relations = new Map<string, ExpectedRelationResultShape>(),
  aggregates = new Map<string, ExpectedAggregateResultShape>(),
  relationCounts = new Set<string>(),
  polymorphic = new Map<string, ExpectedPolymorphicResultShape>(),
  distanceScalar?: Scalar
): ExpectedResultShape {
  if (new Set(rawKeys).size !== rawKeys.length) {
    throw new QueryEngineError(
      "The requested result shape contains colliding output columns."
    );
  }
  return {
    carrier: "rows",
    rawKeys,
    ...(distanceScalar ? { distanceScalar } : {}),
    relations,
    polymorphic,
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
  args: Record<string, unknown>,
  index: ResolvedRelationIndex
): ExpectedResultShape {
  const rawKeys: string[] = [];
  const relations = new Map<string, ExpectedRelationResultShape>();
  const polymorphic = new Map<string, ExpectedPolymorphicResultShape>();
  const selectedOutputKeys = new Set<string>();
  const scalars: Record<string, Scalar> = model["~"].state.scalars;
  const modelRelations = model["~"].state.relations;
  const selectValue = getOwnValue(args, "select");
  const includeValue = getOwnValue(args, "include");
  const select = isRecord(selectValue) ? selectValue : undefined;
  const include = isRecord(includeValue) ? includeValue : undefined;
  let hasDistance = false;
  let distanceScalar: Scalar | undefined;

  if (select) {
    for (const [fieldName, value] of Object.entries(select)) {
      const scalar: Scalar | undefined = getOwnValue(scalars, fieldName);
      if (!scalar) continue;
      if (value === true) {
        rawKeys.push(fieldName);
        selectedOutputKeys.add(fieldName);
        continue;
      }
      if (isRecord(value) && Object.hasOwn(value, "_distance")) {
        if (hasDistance) {
          throw new QueryEngineError(DISTANCE_SELECTED_TWICE);
        }
        hasDistance = true;
        distanceScalar = scalar;
        rawKeys.push(DISTANCE_RESULT_KEY);
      }
    }
  } else {
    for (const fieldName of projectableScalarNames(model)) {
      rawKeys.push(fieldName);
      selectedOutputKeys.add(fieldName);
    }
  }

  addSelectedRelations(
    model,
    modelRelations,
    select,
    rawKeys,
    relations,
    selectedOutputKeys,
    index
  );
  addSelectedPolymorphicRelations(
    model,
    select,
    rawKeys,
    polymorphic,
    selectedOutputKeys,
    index
  );

  addSelectedRelations(
    model,
    modelRelations,
    include,
    rawKeys,
    relations,
    selectedOutputKeys,
    index
  );
  addSelectedPolymorphicRelations(
    model,
    include,
    rawKeys,
    polymorphic,
    selectedOutputKeys,
    index
  );
  // The output key `_distance` has ONE producer: the distance, or a model
  // field of that name — scalar or relation, selected or included. The guard
  // sits after every producer has been gathered so an included relation named
  // `_distance` is refused exactly as a selected one is.
  if (hasDistance && selectedOutputKeys.has("_distance")) {
    throw new QueryEngineError(DISTANCE_NAME_COLLISION);
  }
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
      const relation: AnyRelation | undefined = getOwnValue(
        modelRelations,
        relationName
      );
      if (!relation) continue;
      // ONE map, one rule: a variant COLLECTION joins the count surface
      // (plan §7.4); a variant SINGULAR slot has no collection to count, and
      // its `countFilter` family is a named refusal for the same reason.
      const state = relation["~"].state;
      if (isVariantRelationState(state) && state.cardinality !== "many") {
        continue;
      }
      relationCounts.add(relationName);
    }
  }

  if (relationCounts.size > 0) {
    rawKeys.push(RELATION_COUNTS_RESULT_KEY);
  }

  if (rawKeys.length === 0) {
    if (select) {
      throw new QueryEngineError(emptySelectRefusal(model));
    }
    rawKeys.push(EMPTY_ROW_RESULT_KEY);
  }

  return createShape(
    rawKeys,
    relations,
    new Map(),
    relationCounts,
    polymorphic,
    distanceScalar
  );
}

/**
 * The recurrence admission normalized onto this relation node. Admission
 * (`validation/relations/recurrence.ts`) is its only producer, so the admitted
 * value is read, never re-parsed; a node without `recurse` answers `undefined`.
 */
function admittedRecurrence(value: unknown): NormalizedRecurrence | undefined {
  if (!isRecord(value)) return undefined;
  return getOwnValue(value, "recurse") as NormalizedRecurrence | undefined;
}

function addSelectedRelations(
  model: Model<any>,
  modelRelations: Model<any>["~"]["state"]["relations"],
  selection: Record<string, unknown> | undefined,
  rawKeys: string[],
  relations: Map<string, ExpectedRelationResultShape>,
  selectedOutputKeys: Set<string>,
  index: ResolvedRelationIndex
): void {
  for (const [relationName, value] of selectedEntries(selection)) {
    const relation: AnyRelation | undefined = getOwnValue(
      modelRelations,
      relationName
    );
    // ONE relation map, split here by TARGET KIND: a variant slot produces a
    // tagged carrier, which the polymorphic pass below shapes instead.
    if (!relation || isVariantRelationState(relation["~"].state)) continue;
    const targetModel = relation["~"].settleTarget() as Model<any>;
    rawKeys.push(relationName);
    selectedOutputKeys.add(relationName);
    const shape = buildModelShape(
      targetModel,
      getNestedSelection(value),
      index
    );
    const resolved = index.get(model)?.get(relationName);
    const recurrence = admittedRecurrence(value);
    // A recursive `_distance` slot whose repeated node selects a distance
    // gives that node's key two producers (`Queries.relationShape` refuses
    // the same pair for the engine).
    if (recurrence && relationName === "_distance" && shape.distanceScalar) {
      throw new QueryEngineError(DISTANCE_NAME_COLLISION);
    }
    relations.set(relationName, {
      model: targetModel,
      shape,
      cardinality: relation["~"].state.cardinality,
      optional: resolved !== undefined && slotMayBeEmpty(resolved),
      ...(recurrence ? { recurrence } : {}),
    });
  }
}

/**
 * The expected shape of one polymorphic projection. It records exactly the arms
 * {@link selectedArm} reads, each with the node it reads it with.
 */
function addSelectedPolymorphicRelations(
  model: Model<any>,
  selection: Record<string, unknown> | undefined,
  rawKeys: string[],
  polymorphic: Map<string, ExpectedPolymorphicResultShape>,
  selectedOutputKeys: Set<string>,
  index: ResolvedRelationIndex
): void {
  const modelRelations = model["~"].state.relations;
  for (const [relationName, value] of selectedEntries(selection)) {
    const relation: AnyRelation | undefined = getOwnValue(
      modelRelations,
      relationName
    );
    if (!relation) continue;
    const state = relation["~"].state;
    if (!isVariantRelationState(state)) continue;

    const many = state.cardinality === "many";
    const variants = new Map<string, ExpectedPolymorphicVariantShape>();
    for (const publicType of Object.keys(state.target.entries)) {
      const arm = selectedArm(value, many, publicType);
      if (arm === undefined) continue;
      const targetModel = relation["~"].settleTarget(publicType) as Model<any>;
      variants.set(publicType, {
        model: targetModel,
        shape: buildModelShape(targetModel, getNestedSelection(arm), index),
      });
    }

    rawKeys.push(relationName);
    selectedOutputKeys.add(relationName);
    const resolved = index.get(model)?.get(relationName);
    polymorphic.set(relationName, {
      // CARDINALITY is the declaration's own fact — the slot the factory was
      // spelled with. EMPTINESS is not: it is the resolved edge's answer, which
      // for a row carrier IS the nullability of its private `(type, id)` pair
      // (§8.4).
      cardinality: state.cardinality,
      optional: resolved !== undefined && slotMayBeEmpty(resolved),
      variants,
    });
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
  operation: Operation,
  args: Record<string, unknown>,
  relations: ResolvedRelationIndex
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
    return buildModelShape(model, args, relations);
  }
  return undefined;
}
