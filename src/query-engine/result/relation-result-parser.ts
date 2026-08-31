import type { Model } from "@schema/model";
import type { AnyRelation } from "@schema/relation";
import type { ExpectedResultShape, Operation } from "../types";
import type { ResultParser } from "./ResultParser";
import {
  assertExpectedRowKeys,
  decodeRelationCarrier,
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
  shape: ExpectedResultShape,
  parsers: RowValueParsers
): unknown {
  const relationState = relation["~"].state;
  const isToMany = relationState.cardinality === "many";

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

  const ownsCarrierRows = typeof value === "string";
  const carrier = decodeRelationCarrier(value);

  // `settleTarget` is the one sanctioned getter invocation: settled once per
  // declaration, shared by every schema graph that reuses this terminal.
  const targetModel = relation["~"].settleTarget() as Model<any>;
  if (isToMany) {
    if (!Array.isArray(carrier)) {
      return malformedResult(
        ctx,
        operation,
        "a to-many included relation must return a row array"
      );
    }

    const rows = normalizeResultRows(ctx, operation, carrier);
    const [first] = rows;
    if (!first) {
      return [];
    }
    for (const row of rows) {
      assertExpectedRowKeys(ctx, operation, row, shape);
    }
    const compiled = parsers.getRowParser(targetModel, first, operation, shape);
    const parsed = parseResultRows(rows, compiled, ownsCarrierRows);
    // A negative nested `take` was executed as a reversed window — restore the
    // logical order here, exactly as the top level does for its own rows.
    return shape.reversed ? parsed.reverse() : parsed;
  }

  if (!isResultRow(carrier)) {
    return malformedResult(
      ctx,
      operation,
      "a to-one included relation must return one row object"
    );
  }
  assertExpectedRowKeys(ctx, operation, carrier, shape);
  const compiled = parsers.getRowParser(targetModel, carrier, operation, shape);
  return ownsCarrierRows && compiled.containerPolicy !== "copy"
    ? compiled(carrier, carrier)
    : compiled(carrier);
}
