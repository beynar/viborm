import { ValidationError } from "@errors";
import type { Operation as QueryOperation } from "@query-engine/types";
import type { Operations } from "./types";

const UNIQUE_SELECTOR_OPERATIONS: Set<Operations> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "delete",
  "upsert",
]);

export function assertNonEmptyUniqueWhere(
  operation: Operations,
  args: unknown
): void {
  if (!UNIQUE_SELECTOR_OPERATIONS.has(operation)) return;
  if (!isRecord(args)) return;
  const where = args.where;
  if (!isRecord(where)) return;

  const hasDiscriminator = Object.keys(where).some(
    (key) => where[key] !== undefined
  );
  if (hasDiscriminator) return;

  throw new ValidationError(toUniqueValidationOperation(operation), [
    {
      path: "where",
      message: "whereUnique requires at least one unique discriminator.",
    },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toUniqueValidationOperation(operation: Operations): QueryOperation {
  switch (operation) {
    case "findUnique":
    case "update":
    case "delete":
    case "upsert":
      return operation;
    case "findUniqueOrThrow":
      return "findUnique";
    default:
      throw new Error(`Unexpected unique selector operation: ${operation}`);
  }
}
