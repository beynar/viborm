import { groupedColumn } from "@validation/model/args/time-step";

/**
 * The grouped fields of an admitted `by` (a list, duplicates already
 * refused), and those grouped by a time step among them.
 */
export function getGroupByFields(by: unknown): {
  readonly fields: string[];
  readonly periods: ReadonlySet<string>;
} {
  const columns = Array.isArray(by) ? by.map(groupedColumn) : [];
  return {
    fields: columns.map(({ field }) => field),
    periods: new Set(
      columns.filter(({ step }) => step !== undefined).map(({ field }) => field)
    ),
  };
}
