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
  parseResultRows,
  type RowValueParsers,
} from "./result-parser-contract";

export function parseRelationValueDefault(
  ctx: ResultParser,
  relation: AnyRelation,
  mayBeEmpty: boolean,
  value: unknown,
  operation: Operation,
  shape: ExpectedResultShape | undefined,
  parsers: RowValueParsers
): unknown {
  const relationState = relation["~"].state;
  const isToMany = relationState.cardinality === "many";

  if (value === undefined) {
    return malformedResult(
      ctx,
      operation,
      "an included relation value is absent"
    );
  }

  if (value === null) {
    // Emptiness is a fact of the RESOLVED EDGE (`slotMayBeEmpty`, §8.4), settled
    // once per contextual slot by the caller: a model-target relation carries no
    // declared `optional`, and a to-many slot answers with an array or nothing.
    if (isToMany || !mayBeEmpty) {
      return malformedResult(
        ctx,
        operation,
        "a required included relation returned null"
      );
    }
    return null;
  }

  // `settleTarget` is the one sanctioned getter invocation: settled once per
  // declaration, shared by every schema graph that reuses this terminal.
  const targetModel = relation["~"].settleTarget() as Model<any>;
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
    let keys: readonly string[] | undefined;
    if (shape) {
      for (const row of rows) {
        assertExpectedRowKeys(ctx, operation, row, shape);
      }
    } else {
      keys = Object.keys(first);
      assertUniformRowKeys(ctx, operation, rows, keys);
    }
    const itemParser = parsers.getRowParser(
      targetModel,
      first,
      operation,
      shape,
      keys
    );
    const parsed = parseResultRows(rows, itemParser);
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
  return parsers.getRowParser(targetModel, value, operation, shape)(value);
}
