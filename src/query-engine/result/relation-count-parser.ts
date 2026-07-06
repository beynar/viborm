import type { AnyRelation } from "@schema/relation";
import { QueryEngineError } from "../types";

const RELATION_COUNT_PREFIX = "_count_";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getRelationCountName(
  key: string,
  relations: Record<string, AnyRelation>
): string | undefined {
  if (!key.startsWith(RELATION_COUNT_PREFIX)) {
    return undefined;
  }

  const relationName = key.slice(RELATION_COUNT_PREFIX.length);
  return relations[relationName] ? relationName : undefined;
}

export function assignRelationCount(
  result: Record<string, unknown>,
  relationName: string,
  value: unknown
): void {
  const existingCount = result._count;
  const countResult = isRecord(existingCount) ? existingCount : {};

  countResult[relationName] = parseRelationCountValue(relationName, value);
  result._count = countResult;
}

function parseRelationCountValue(relationName: string, value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "string" && value.trim() !== "") {
    const count = Number(value);
    if (Number.isFinite(count)) {
      return count;
    }
  }

  throw new QueryEngineError(
    `Cannot parse relation count result for '${relationName}'.`
  );
}
