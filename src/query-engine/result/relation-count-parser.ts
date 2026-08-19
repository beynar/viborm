import { tryParseJsonString } from "@adapters/shared/result-parsing";
import type { AnyPolymorphicRelation, AnyRelation } from "@schema/relation";
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

function assignRelationCount(
  ctx: ResultParser,
  operation: Operation,
  result: Record<string, unknown>,
  relationName: string,
  value: unknown
): void {
  const existingCount = result._count;
  let countResult: Record<string, unknown>;
  if (existingCount === undefined) {
    countResult = {};
  } else if (isRecord(existingCount)) {
    countResult = existingCount;
  } else {
    throw relationCountError(
      ctx,
      operation,
      relationName,
      "the existing _count result is not an object"
    );
  }

  countResult[relationName] = parseRelationCountValue(
    ctx,
    operation,
    relationName,
    value
  );
  result._count = countResult;
}

/**
 * @param relations - the model's ordinary relations.
 * @param polymorphicRelations - the model's polymorphic relations. A SECOND
 *   record rather than one merged lookup: a collection joins the count surface
 *   (plan §7.4) while the two namespaces stay provably separate at the check,
 *   which is what keeps a name colliding across them from silently passing.
 */
export function assignRelationCounts(
  ctx: ResultParser,
  operation: Operation,
  result: Record<string, unknown>,
  value: unknown,
  relations: Record<string, AnyRelation>,
  polymorphicRelations: Record<string, AnyPolymorphicRelation>,
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

  for (const [relationName, count] of entries) {
    if (
      !(
        Object.hasOwn(relations, relationName) ||
        Object.hasOwn(polymorphicRelations, relationName)
      )
    ) {
      throw relationCountError(
        ctx,
        operation,
        undefined,
        "the carrier contains an unknown relation"
      );
    }
    assignRelationCount(ctx, operation, result, relationName, count);
  }
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
