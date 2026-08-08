import { ValidationError } from "@errors";
import type { Operation as ValidationOperation } from "@query-engine/types";
import { isRecord } from "@validation/value-guards";
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

function toUniqueValidationOperation(
  operation: Operations
): ValidationOperation {
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
