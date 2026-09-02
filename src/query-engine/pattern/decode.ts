/**
 * G — decoding is match backwards (pattern-engine-ideal-state.md §9.2).
 *
 * The pattern IS the expected shape: its projection says which raw keys a
 * provider row must carry, which of them are relation carriers (JSON), which
 * are variant arms selected by the discriminator value in the row, which are
 * counts and aggregates. That shape is derived here from the projection alone
 * and handed to the existing result boundary (`ResultParser`), which owns the
 * scalar codec chains, the carrier decoding, the malformed-row refusals and
 * the container policy. Nothing about a scalar's decoding is restated here.
 *
 * The container policy (identity / reusable / copy) is honoured exactly as
 * today: a consumable row set — a driver fact the caller states — may be
 * decoded in place; a borrowed one is copied.
 */
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import { slotMayBeEmpty } from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import {
  parsePreparedResult,
  prepareResultRows,
  ResultParser,
} from "../result/ResultParser";
import {
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
  type ScopeSource,
} from "../types";
import type { Extension, Pattern, Projection, Row, Variable } from "./pattern";

/** The parse boundary: the adapter, the resolved index, and the driver's middleware. */
export interface DecodeBoundary extends ScopeSource {
  readonly driver?: AnyDriver;
}

export interface DecodeOptions {
  /**
   * The provider rows are this decode's to consume (the immutable driver fact
   * §9.2 names): a natively valid row may pass unchanged and a same-key row may
   * be decoded in place. Absent, every row is borrowed and copied.
   */
  readonly consumable?: boolean;
}

const literalValue = (variable: Variable): unknown =>
  variable.binding.kind === "literal" ? variable.binding.value : undefined;

function rootRow(pattern: Pattern): Row {
  const row = pattern.rows.find((r) => r.id === pattern.root);
  if (!row) throw new QueryEngineError("pattern decode: no root row.");
  return row;
}

const projectionOf = (pattern: Pattern): Projection =>
  pattern.projection ?? { scalars: [], relations: [], relationCounts: [] };

function shapeOf(
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

const pagesBackward = (pattern: Pattern): boolean => {
  const take = projectionOf(pattern).window?.take;
  return typeof take === "number" && take < 0;
};

function extensionModel(extension: Extension): Model<any> {
  const target = extension.target;
  const row = target.rows.find((r) => r.id === target.root);
  if (!row)
    throw new QueryEngineError("pattern decode: extension has no root.");
  return row.table.model;
}

/** The expected row shape of one match pattern — the projection, read as keys. */
function modelShape(
  pattern: Pattern,
  source: ScopeSource
): ExpectedResultShape {
  const model = rootRow(pattern).table.model;
  const projection = projectionOf(pattern);
  const rawKeys: string[] = [...projection.scalars];
  const relations = new Map<string, ExpectedRelationResultShape>();
  const polymorphic = new Map<string, ExpectedPolymorphicResultShape>();
  const distance = projection.computed?.find((c) => c.form === "distance");
  const distanceScalar: Scalar | undefined = distance
    ? model["~"].state.scalars[String(literalValue(distance.operands[0]!))]
    : undefined;
  if (distance) rawKeys.push(DISTANCE_RESULT_KEY);

  const entries = projection.relations;
  for (let i = 0; i < entries.length; ) {
    const { field } = entries[i]!;
    let end = i + 1;
    while (end < entries.length && entries[end]!.field === field) end++;
    const arms = entries.slice(i, end);
    i = end;
    const resolved = source.relations.get(model)?.get(field);
    const optional = resolved !== undefined && slotMayBeEmpty(resolved);
    rawKeys.push(field);
    const first = arms[0]!;
    if (first.variant === undefined) {
      const shape = modelShape(first.extension.target, source);
      relations.set(field, {
        model: extensionModel(first.extension),
        shape: pagesBackward(first.extension.target)
          ? { ...shape, reversed: true }
          : shape,
        cardinality: first.cardinality,
        optional,
      });
      continue;
    }
    const variants = new Map<string, ExpectedPolymorphicVariantShape>();
    for (const arm of arms) {
      const { extension } = arm;
      const many = arm.cardinality === "many";
      variants.set(String(arm.variant), {
        model: extensionModel(extension),
        shape: modelShape(extension.target, source),
        ...(many ? { visible: arm.visible !== false } : {}),
        ...(many && pagesBackward(extension.target) ? { reversed: true } : {}),
      });
    }
    polymorphic.set(field, {
      cardinality: first.cardinality,
      optional,
      variants,
    });
  }

  const relationCounts = new Set(projection.relationCounts.map((c) => c.field));
  if (relationCounts.size > 0) rawKeys.push(RELATION_COUNTS_RESULT_KEY);
  if (rawKeys.length === 0) rawKeys.push(EMPTY_ROW_RESULT_KEY);
  return shapeOf(
    rawKeys,
    relations,
    new Map(),
    relationCounts,
    polymorphic,
    distanceScalar
  );
}

function aggregateShape(pattern: Pattern): ExpectedResultShape {
  const projection = projectionOf(pattern);
  const grouped = [...(projection.groupBy ?? [])];
  const rawKeys = [...grouped];
  const selected = new Set(grouped);
  const aggregates = new Map<string, ExpectedAggregateResultShape>();
  const byKind = new Map<string, string[] | true>();
  for (const entry of projection.aggregates ?? []) {
    const name = `_${entry.kind}`;
    if (entry.column === undefined) {
      byKind.set(name, true);
      continue;
    }
    const current = byKind.get(name);
    const fields = Array.isArray(current) ? current : [];
    fields.push(entry.column);
    byKind.set(name, fields);
  }
  for (const name of ["_count", "_avg", "_sum", "_min", "_max"]) {
    const spec = byKind.get(name);
    if (spec === undefined) continue;
    if (selected.has(name)) {
      throw new QueryEngineError(
        `GroupBy cannot return both grouped scalar '${name}' and aggregate '${name}' in one result.`
      );
    }
    const rawKey = getAggregateResultKey(name as "_count");
    rawKeys.push(rawKey);
    selected.add(name);
    aggregates.set(rawKey, spec === true ? {} : { fields: new Set(spec) });
  }
  return shapeOf(rawKeys, new Map(), aggregates);
}

/** The expected result shape one pattern's projection states. */
export function expectedShapeOf(
  pattern: Pattern,
  source: ScopeSource
): ExpectedResultShape {
  switch (pattern.operation) {
    case "count": {
      const fields = (projectionOf(pattern).aggregates ?? []).map(
        (entry) => entry.column ?? "_all"
      );
      return {
        ...shapeOf(fields.length === 0 ? [COUNT_RESULT_KEY] : fields),
        carrier: "count",
      };
    }
    case "exist":
      return { ...shapeOf([COUNT_RESULT_KEY]), carrier: "existence" };
    case "aggregate":
    case "groupBy":
      return aggregateShape(pattern);
    default:
      return modelShape(pattern, source);
  }
}

/**
 * Decode provider rows through the pattern: validate each row against the
 * projection's exact key set, decode scalars through the boundary's codec
 * chains, relation carriers and variant arms through the same walk.
 */
export function decodeRows<T>(
  pattern: Pattern,
  rows: unknown,
  boundary: DecodeBoundary,
  options: DecodeOptions = {}
): T {
  const model = rootRow(pattern).table.model;
  const operation = pattern.operation as Operation;
  const shape = expectedShapeOf(pattern, boundary);
  const parser = new ResultParser(boundary, model, boundary.driver);
  const compiled = options.consumable
    ? prepareResultRows(parser, operation, shape)
    : undefined;
  const parsed =
    compiled && Array.isArray(rows)
      ? parsePreparedResult<T>(
          parser,
          operation,
          rows,
          {},
          shape,
          compiled,
          rows
        )
      : parser.parse<T>(operation, rows, {}, shape);
  return pattern.operation === "findMany" &&
    pagesBackward(pattern) &&
    Array.isArray(parsed)
    ? ([...parsed].reverse() as T)
    : parsed;
}
