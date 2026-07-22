import { getPrimaryKeyFields } from "./builders/correlation-utils";
import { getWhereUniqueEntries } from "./builders/where-unique-builder";
import { getTableName } from "./context";
import type { UniqueConflictPin } from "./operation-program";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";

/**
 * The unique-conflict target descriptor (P6 pure-leaf extraction, consumed by V2):
 * resolves a `whereUnique` selector into the constraint's fields, columns, table,
 * and candidate constraint names so a skippable/adopting write can pin the exact
 * constraint it races against.
 */
export function uniqueConflictTarget(
  ctx: QueryScope,
  where: Record<string, unknown>
): UniqueConflictPin["target"] {
  const entries = getWhereUniqueEntries(ctx, where);
  const fields = entries.map(({ fieldName }) => fieldName);
  const columns = entries.map(
    ({ fieldName }) => ctx.model["~"].getFieldName(fieldName).sql
  );
  const table = getTableName(ctx.model);
  const primaryKeys = getPrimaryKeyFields(ctx.model);
  const isPrimary =
    primaryKeys.length === entries.length &&
    primaryKeys.every((field, index) => field === entries[index]?.fieldName);
  const [selector] = Object.keys(where).filter(
    (key) => where[key] !== undefined
  );
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
