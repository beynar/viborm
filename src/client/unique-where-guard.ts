import { ValidationError } from "@errors";
import { baseOperation } from "@query-engine/routed-operations";
import type { Operation as ValidationOperation } from "@query-engine/types";
import { isRecord } from "@validation/value-guards";
import type { Operations } from "./types";

/** The unique-selector verbs; an `…OrThrow` verb is refused as its base. */
const UNIQUE_SELECTOR_OPERATIONS: ReadonlySet<string> =
  new Set<ValidationOperation>(["findUnique", "update", "delete", "upsert"]);

export function assertNonEmptyUniqueWhere(
  model: string,
  operation: Operations,
  args: unknown
): void {
  const validationOperation = baseOperation(operation);
  if (!UNIQUE_SELECTOR_OPERATIONS.has(validationOperation)) return;
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
