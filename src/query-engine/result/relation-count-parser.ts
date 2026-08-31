import { tryParseJsonString } from "@adapters/shared/result-parsing";
import { type Operation, QueryEngineError } from "../types";
import type { ResultParser } from "./ResultParser";
import { parseSafeCountValue } from "./result-count-parser";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * `expectedRelations` was derived from the model's one relation map. Exact-key
 * validation therefore proves every decoded entry is one requested relation;
 * no second model-map lookup can add information here.
 */
export function assignRelationCounts(
  ctx: ResultParser,
  operation: Operation,
  result: Record<string, unknown>,
  value: unknown,
  expectedRelations: ReadonlySet<string>
): void {
  const decoded = typeof value === "string" ? tryParseJsonString(value) : value;
  if (!isRecord(decoded)) {
    throw relationCountError(
      ctx,
      operation,
      undefined,
      "the carrier is not a JSON object"
    );
  }

  const entries = Object.entries(decoded);
  if (
    entries.length !== expectedRelations.size ||
    ![...expectedRelations].every((name) => Object.hasOwn(decoded, name))
  ) {
    throw relationCountError(
      ctx,
      operation,
      undefined,
      "the carrier keys do not match the requested relations"
    );
  }

  const countResult: Record<string, number> = {};
  for (const [relationName, count] of entries) {
    countResult[relationName] = parseRelationCountValue(
      ctx,
      operation,
      relationName,
      count
    );
  }
  result._count = countResult;
}

function parseRelationCountValue(
  ctx: ResultParser,
  operation: Operation,
  relationName: string,
  value: unknown
): number {
  const count = parseSafeCountValue(value);
  if (count === undefined) {
    throw relationCountError(
      ctx,
      operation,
      relationName,
      "the count is not a canonical safe non-negative integer"
    );
  }
  return count;
}

function relationCountError(
  ctx: ResultParser,
  operation: Operation,
  relationName: string | undefined,
  reason: string
): QueryEngineError {
  const driver = ctx.providerName;
  const subject = relationName
    ? `relation count for "${relationName}"`
    : "relation count carrier";
  return new QueryEngineError(
    `Driver "${driver}" returned a malformed ${subject} during operation "${operation}": ${reason}.`,
    {
      meta: {
        driver,
        operation,
        ...(relationName ? { relation: relationName } : {}),
      },
    }
  );
}
