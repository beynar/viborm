import { getAdapterInternals } from "@adapters/adapter-internals";
import { getModelKeyCatalog } from "@schema/model";
import { getPrimaryKeyFields } from "./builders/correlation-utils";
import { partitionWhereUnique } from "./builders/where-unique-builder";
import { getTableName } from "./context";
import type { QueryScope } from "./types";
import { QueryEngineError } from "./types";
import type { TargetConstraintPin } from "./write-engine/OperationFragment";

/**
 * The unique-conflict target descriptor (P6 pure-leaf extraction, consumed by V2):
 * resolves a `whereUnique` selector into the constraint's fields, columns, table,
 * and physical constraint name so a skippable/adopting write can pin the exact
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
  // Definition validation guarantees that a selector has one meaning here.
  const selectorIsCompoundUnique =
    selector !== undefined &&
    getModelKeyCatalog(ctx.model).addressableKeys.some(
      (key) => key.kind === "compoundUnique" && key.name === selector
    );
  let constraints: string[];
  const constraintsOwner = getAdapterInternals(ctx.adapter).constraints;
  if (isPrimary) {
    constraints = [constraintsOwner.primaryKey(table, columns).name];
  } else if (selectorIsCompoundUnique) {
    constraints = [constraintsOwner.unique(table, selector, columns).name];
  } else {
    const [column] = columns;
    if (!column) {
      throw new QueryEngineError("Unique conflict target has no column.");
    }
    constraints = [constraintsOwner.unique(table, column, columns).name];
  }
  return { fields, table, columns, constraints };
}
