import { ValidationError } from "@errors";
import type { Operation as ValidationOperation } from "@query-engine/types";
import { isRecord } from "@validation/value-guards";
import type { Operations } from "./types";

/** Each unique-selector operation, mapped to the operation its error names. */
const UNIQUE_SELECTOR_OPERATIONS: ReadonlyMap<Operations, ValidationOperation> =
  new Map([
    ["findUnique", "findUnique"],
    ["findUniqueOrThrow", "findUnique"],
    ["update", "update"],
    ["delete", "delete"],
    ["upsert", "upsert"],
  ]);

export function assertNonEmptyUniqueWhere(
  model: string,
  operation: Operations,
  args: unknown
): void {
  const validationOperation = UNIQUE_SELECTOR_OPERATIONS.get(operation);
  if (validationOperation === undefined) return;
  if (!isRecord(args)) return;
  const where = args.where;
  if (!isRecord(where)) return;

  const hasDiscriminator = Object.keys(where).some(
    (key) => where[key] !== undefined
  );
  if (hasDiscriminator) return;

  throw new ValidationError(
    validationOperation,
    [
      {
        path: "where",
        message: "whereUnique requires at least one unique discriminator.",
      },
    ],
    { meta: { model } }
  );
}
