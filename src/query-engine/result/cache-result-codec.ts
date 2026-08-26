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
  countCodec,
  nullableCodec,
  numberCodec,
  recordCodec,
  taggedRelationCodec,
  type ValueCodec,
} from "./cache-value-codecs";
import { classifyAggregateLeaf } from "./result-aggregate-leaf";
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
  shape: ExpectedResultShape,
  decimalDecode: "string" | "number"
): CacheResultCodec {
  const compiled = compileRootCodec(
    model,
    operation,
    requestedOperation,
    shape,
    decimalDecode
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
  shape: ExpectedResultShape,
  decimalDecode: "string" | "number"
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

  const row = compileRowCodec(model, operation, shape, decimalDecode);
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
  shape: ExpectedResultShape,
  decimalDecode: "string" | "number"
): ValueCodec {
  const fields = new Map<string, ValueCodec>();
  for (const rawKey of shape.rawKeys) {
    const column = classifyResultColumn(model, rawKey, shape);
    switch (column.kind) {
      case "empty":
        break;
      case "vectorDistance":
        addResultField(fields, "_distance", numberCodec());
        break;
      case "scalar":
        addResultField(
          fields,
          column.key,
          compileScalarCodec(column.scalar, decimalDecode)
        );
        break;
      case "relationCounts": {
        const relations = column.relations;
        if (!relations) return invalidCompiledShape();
        const counts = new Map<string, ValueCodec>();
        for (const relation of relations) counts.set(relation, countCodec());
        addResultField(fields, "_count", recordCodec(counts));
        break;
      }
      case "relation":
        if (!column.expected) return invalidCompiledShape();
        addResultField(
          fields,
          column.key,
          compileRelationCodec(column.expected, operation, decimalDecode)
        );
        break;
      case "polymorphic":
        if (!column.expected) return invalidCompiledShape();
        addResultField(
          fields,
          column.key,
          compilePolymorphicCodec(column.expected, operation, decimalDecode)
        );
        break;
      case "aggregate":
        if (!column.expected) return invalidCompiledShape();
        addResultField(
          fields,
          column.name,
          compileAggregateCodec(
            model,
            column.name,
            column.expected,
            decimalDecode
          )
        );
        break;
      case "unknown":
        return invalidCompiledShape();
      default: {
        const exhaustive: never = column;
        return exhaustive;
      }
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
  operation: Operation,
  decimalDecode: "string" | "number"
): ValueCodec {
  const row = compileRowCodec(
    relation.model,
    operation,
    relation.shape,
    decimalDecode
  );
  if (relation.cardinality === "many") return arrayCodec(row);
  return relation.optional ? nullableCodec(row) : row;
}

function compilePolymorphicCodec(
  relation: ExpectedPolymorphicResultShape,
  operation: Operation,
  decimalDecode: "string" | "number"
): ValueCodec {
  const variants = new Map<string, ValueCodec>();
  for (const [type, variant] of relation.variants) {
    if (relation.cardinality === "many" && variant.visible !== true) continue;
    variants.set(
      type,
      compileRowCodec(variant.model, operation, variant.shape, decimalDecode)
    );
  }
  const tagged = taggedRelationCodec(variants);
  if (relation.cardinality === "many") return arrayCodec(tagged);
  return relation.optional ? nullableCodec(tagged) : tagged;
}

function compileAggregateCodec(
  model: Model<any>,
  name: AggregateResultName,
  expected: ExpectedAggregateResultShape,
  decimalDecode: "string" | "number"
): ValueCodec {
  if (name === "_count" && expected.fields === undefined) return countCodec();
  const expectedFields = expected.fields;
  if (!expectedFields) return invalidCompiledShape();
  const fields = new Map<string, ValueCodec>();
  const scalars = model["~"].state.scalars;
  for (const field of expectedFields) {
    const leaf = classifyAggregateLeaf(name, field, scalars);
    if (leaf.kind === "unknown") return invalidCompiledShape();
    const value =
      leaf.kind === "count"
        ? countCodec()
        : leaf.kind === "number"
          ? numberCodec()
          : compileScalarCodec(leaf.scalar, decimalDecode, false);
    fields.set(field, leaf.nullable ? nullableCodec(value) : value);
  }
  return recordCodec(fields);
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
