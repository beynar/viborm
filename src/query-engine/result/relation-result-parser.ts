import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import type { ExpectedResultShape, Operation } from "../types";
import type { ResultParser } from "./ResultParser";
import {
  assertExpectedRowKeys,
  assertUniformRowKeys,
  isResultRow,
  malformedResult,
  normalizeResultRows,
  type RowValueParsers,
} from "./result-parser-contract";
import { createRowParser } from "./result-row-parser";

export function parseRelationValueDefault(
  ctx: ResultParser,
  relation: AnyRelation,
  value: unknown,
  operation: Operation,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): unknown {
  const relationState = relation["~"].state;
  const isToMany =
    relationState.type === "oneToMany" || relationState.type === "manyToMany";

  if (value === undefined) {
    return malformedResult(
      ctx,
      operation,
      "an included relation value is absent"
    );
  }

  if (value === null) {
    if (isToMany || relationState.optional !== true) {
      return malformedResult(
        ctx,
        operation,
        "a required included relation returned null"
      );
    }
    return null;
  }

  // Get target model from relation thunk
  const targetModel = relationState.getter();
  if (isToMany) {
    if (!Array.isArray(value)) {
      return malformedResult(
        ctx,
        operation,
        "a to-many included relation must return a row array"
      );
    }

    const rows = normalizeResultRows(ctx, operation, value);
    const [first] = rows;
    if (!first) {
      return [];
    }
    const keys = Object.keys(first);
    if (shape) {
      for (const row of rows) assertExpectedRowKeys(ctx, operation, row, shape);
    } else {
      assertUniformRowKeys(ctx, operation, rows, keys);
    }
    const itemParser = createRowParser(
      ctx,
      operation,
      keys,
      targetModel,
      shape,
      parsers
    );
    const parsed = rows.map(itemParser);
    // A negative nested `take` was executed as a reversed window — restore the
    // logical order here, exactly as the top level does for its own rows.
    return shape?.reversed ? parsed.reverse() : parsed;
  }

  if (!isResultRow(value)) {
    return malformedResult(
      ctx,
      operation,
      "a to-one included relation must return one row object"
    );
  }
  if (shape) assertExpectedRowKeys(ctx, operation, value, shape);
  return deserializeWithSchema(
    ctx,
    operation,
    value,
    targetModel,
    shape,
    parsers
  );
}

function deserializeWithSchema(
  ctx: ResultParser,
  operation: Operation,
  obj: Record<string, unknown>,
  model: Model<any>,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): Record<string, unknown> {
  const keys = Object.keys(obj);
  return createRowParser(
    ctx,
    operation,
    keys,
    model,
    shape,
    parsers
  )(obj);
}
