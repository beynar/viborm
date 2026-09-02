import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { CacheConfigurationError, QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import { isError } from "../../errors/diagnostic-safety";
import type { AggregateResultName } from "../result-aliases";
import type {
  ExpectedAggregateResultShape,
  ExpectedPolymorphicResultShape,
  ExpectedRelationResultShape,
  ExpectedResultShape,
  Operation,
} from "../types";
import {
  arrayCodec,
  booleanCodec,
  compileScalarCodec,
  compileWidenedSumCodec,
  countCodec,
  nullableCodec,
  numberCodec,
  recordCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "./cache-value-codecs";
import {
  type AggregateLeaf,
  classifyAggregateLeaf,
} from "./result-aggregate-leaf";
import { classifyResultColumn } from "./result-column";

export interface CacheResultCodec {
  snapshot(value: unknown): unknown;
  materialize(snapshot: unknown): unknown;
}

const REQUIRED_SINGLE_OPERATIONS = new Set<Operation>(["aggregate"]);
const ARRAY_OPERATIONS = new Set<Operation>(["findMany", "groupBy"]);

/** Compile the detached cache representation for one exact parsed read result. */
export function compileCacheResultCodec(
  model: Model<any>,
  operation: Operation,
  requestedOperation: string,
  shape: ExpectedResultShape
): CacheResultCodec {
  const compiled = compileRootCodec(
    model,
    operation,
    requestedOperation,
    shape
  );
  return Object.freeze({
    snapshot(value: unknown): unknown {
      try {
        return compiled.snapshot(value, new WeakSet<object>());
      } catch (cause) {
        throw new CacheConfigurationError(
          "The operation result cannot be represented by the cache result codec.",
          {
            cause: cacheBoundaryCause(cause),
            meta: { method: "snapshot", operation: requestedOperation },
          }
        );
      }
    },
    materialize(snapshot: unknown): unknown {
      try {
        return compiled.materialize(snapshot, new WeakSet<object>());
      } catch (cause) {
        throw new CacheConfigurationError(
          "The cached result snapshot is malformed.",
          {
            cause: cacheBoundaryCause(cause),
            meta: { method: "materialize", operation: requestedOperation },
          }
        );
      }
    },
  });
}

function compileRootCodec(
  model: Model<any>,
  operation: Operation,
  requestedOperation: string,
  shape: ExpectedResultShape
): ValueCodec {
  if (shape.carrier === "existence") return booleanCodec();
  if (shape.carrier === "count") {
    if (shape.rawKeys.length === 1 && shape.rawKeys[0] === COUNT_RESULT_KEY) {
      return countCodec();
    }
    const fields = new Map<string, ValueCodec>();
    for (const key of shape.rawKeys) fields.set(key, countCodec());
    return recordCodec(fields);
  }

  const row = compileRowCodec(model, operation, shape);
  if (ARRAY_OPERATIONS.has(operation)) return arrayCodec(row);
  if (operation === "findFirst" || operation === "findUnique") {
    return requestedOperation.endsWith("OrThrow") ? row : nullableCodec(row);
  }
  if (REQUIRED_SINGLE_OPERATIONS.has(operation)) return row;
  return invalidCompiledShape();
}

function compileRowCodec(
  model: Model<any>,
  operation: Operation,
  shape: ExpectedResultShape
): ValueCodec {
  const fields = new Map<string, ValueCodec>();
  for (const rawKey of shape.rawKeys) {
    const column = classifyResultColumn(model, rawKey, shape);
    // biome-ignore lint/style/useDefaultSwitchClause: the classified column union is exhaustive; a default would be dead code.
    switch (column.kind) {
      case "empty":
        break;
      case "distance": {
        const scalar = column.scalar?.["~"].state;
        addResultField(
          fields,
          "_distance",
          scalar?.type === "point" && scalar.nullable === true
            ? nullableCodec(numberCodec())
            : numberCodec()
        );
        break;
      }
      case "scalar":
        addResultField(fields, column.key, compileScalarCodec(column.scalar));
        break;
      case "relationCounts": {
        const relations = column.relations;
        const counts = new Map<string, ValueCodec>();
        for (const relation of relations) counts.set(relation, countCodec());
        addResultField(fields, "_count", recordCodec(counts));
        break;
      }
      case "relation":
        addResultField(
          fields,
          column.key,
          compileRelationCodec(column.expected, operation)
        );
        break;
      case "polymorphic":
        addResultField(
          fields,
          column.key,
          compilePolymorphicCodec(column.expected, operation)
        );
        break;
      case "aggregate":
        addResultField(
          fields,
          column.name,
          compileAggregateCodec(model, column.name, column.expected)
        );
        break;
      case "unknown":
        return invalidCompiledShape();
    }
  }
  return recordCodec(fields);
}

function addResultField(
  fields: Map<string, ValueCodec>,
  key: string,
  codec: ValueCodec
): void {
  if (fields.has(key)) invalidCompiledShape();
  fields.set(key, codec);
}

function compileRelationCodec(
  relation: ExpectedRelationResultShape,
  operation: Operation
): ValueCodec {
  const row = compileRowCodec(relation.model, operation, relation.shape);
  if (relation.cardinality === "many") return arrayCodec(row);
  return relation.optional ? nullableCodec(row) : row;
}

function compilePolymorphicCodec(
  relation: ExpectedPolymorphicResultShape,
  operation: Operation
): ValueCodec {
  const variants = new Map<string, ValueCodec>();
  for (const [type, variant] of relation.variants) {
    if (relation.cardinality === "many" && variant.visible !== true) continue;
    variants.set(
      type,
      compileRowCodec(variant.model, operation, variant.shape)
    );
  }
  const tagged = taggedRelationCodec(variants);
  if (relation.cardinality === "many") return arrayCodec(tagged);
  return relation.optional ? nullableCodec(tagged) : tagged;
}

function compileAggregateCodec(
  model: Model<any>,
  name: AggregateResultName,
  expected: ExpectedAggregateResultShape
): ValueCodec {
  if (name === "_count" && expected.fields === undefined) return countCodec();
  const expectedFields = expected.fields;
  if (!expectedFields) return invalidCompiledShape();
  const fields = new Map<string, ValueCodec>();
  const scalars = model["~"].state.scalars;
  for (const field of expectedFields) {
    const leaf = classifyAggregateLeaf(name, field, scalars);
    if (leaf.kind === "unknown") return invalidCompiledShape();
    const value = compileAggregateLeafCodec(leaf);
    fields.set(field, leaf.nullable ? nullableCodec(value) : value);
  }
  return recordCodec(fields);
}

/**
 * The detached encoding of one classified aggregate leaf.
 *
 * It reads the SAME classification the provider parser reads, which is what
 * makes a cached aggregate materialize identically to a fresh one — a widened
 * sum through the widened codec, every other decimal leaf through the field's.
 */
function compileAggregateLeafCodec(leaf: AggregateLeaf): ValueCodec {
  switch (leaf.kind) {
    case "count":
      return countCodec();
    case "number":
      return numberCodec();
    case "widenedSum":
      return compileWidenedSumCodec(leaf.scalar);
    case "scalar":
      return compileScalarCodec(leaf.scalar, false);
    default:
      return invalidCompiledShape();
  }
}

function cacheBoundaryCause(cause: unknown): Error {
  return isError(cause)
    ? cause
    : new Error("The cache result codec threw a non-Error value.");
}

function invalidCompiledShape(): never {
  throw new QueryEngineError(
    "The compiled read result shape is incomplete for cache materialization."
  );
}
