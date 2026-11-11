/**
 * The one refusal of a write on Snowflake.
 *
 * Snowflake enforces no `PRIMARY KEY`, `UNIQUE` or `FOREIGN KEY` (only
 * `NOT NULL`), has no savepoint and no `RETURNING`, and charges for every
 * statement a warehouse runs: the guarantees VibORM's writes give — a unique
 * row addressed, a relation that holds, a nested write that rolls back to
 * where it failed — would not hold there. So the driver reads only.
 *
 * Every operation the engine runs gets its context before its first
 * statement — to execute it, to prepare it for a batch, or to publish it as
 * one statement — so a write verb is refused here, by its name, before
 * anything is built or sent. Raw writes have no context: `refuseRawWrite`
 * answers for `$executeRaw`, which the driver asks before it sends one.
 */

import { FeatureNotSupportedError } from "@errors";
import { isReadOperation } from "@query-engine/routed-operations";
import { SqlOperationContext } from "@query-engine/raptor3/shared/sql-operation-context";

const REASON =
  "VibORM only reads Snowflake: it enforces no primary, unique or foreign key, has no savepoint and no RETURNING, so a write's guarantees would not hold there. Write with Snowflake's own tools.";

export function readOnlyRefusal(operation: string): FeatureNotSupportedError {
  return new FeatureNotSupportedError("snowflake", operation, REASON);
}

export class SnowflakeOperationContext extends SqlOperationContext {
  constructor(...args: ConstructorParameters<typeof SqlOperationContext>) {
    const operation = args[3];
    if (!isReadOperation(operation)) throw readOnlyRefusal(operation);
    super(...args);
  }
}

/** `$executeRaw` and `$executeRawUnsafe`, which state a write by their name. */
export function isRawWrite(operation: string | undefined): boolean {
  return operation === "$executeRaw" || operation === "$executeRawUnsafe";
}
