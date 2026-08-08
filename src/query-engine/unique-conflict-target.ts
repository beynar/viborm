import { getPrimaryKeyFields } from "./builders/correlation-utils";
import { partitionWhereUnique } from "./builders/where-unique-builder";
import { getTableName } from "./context";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";
import type { TargetConstraintPin } from "./write-engine/OperationFragment";

/**
 * The unique-conflict target descriptor (P6 pure-leaf extraction, consumed by V2):
 * resolves a `whereUnique` selector into the constraint's fields, columns, table,
 * and candidate constraint names so a skippable/adopting write can pin the exact
 * constraint it races against.
 */
export function uniqueConflictTarget(
  ctx: QueryScope,
  where: Record<string, unknown>
): TargetConstraintPin {
  // DISCRIMINATOR ONLY. An extended `where`'s extra filters narrow which row the
  // statement touches; they name no constraint, so they must not enter the
  // conflict target a `racePin` is attributed against (a violation matched to a
  // filter-derived target would classify a genuine conflict as a retryable race).
  const { entries, discriminator } = partitionWhereUnique(ctx, where);
  const fields = entries.map(({ fieldName }) => fieldName);
  const columns = entries.map(
    ({ fieldName }) => ctx.model["~"].getFieldName(fieldName).sql
  );
  const table = getTableName(ctx.model);
  const primaryKeys = getPrimaryKeyFields(ctx.model);
  const isPrimary =
    primaryKeys.length === entries.length &&
    primaryKeys.every((field, index) => field === entries[index]?.fieldName);
  const [selector] = Object.keys(discriminator);
  let constraints: string[];
  if (isPrimary) {
    constraints = [`${table}_pkey`, "PRIMARY"];
  } else if (selector && ctx.model["~"].state.compoundUniques?.[selector]) {
    constraints = [`${table}_${selector}_key`];
  } else {
    const [column] = columns;
    if (!column) {
      throw new QueryEngineError("Unique conflict target has no column.");
    }
    constraints = [`${table}_${column}_key`];
  }
  return { fields, table, columns, constraints };
}
