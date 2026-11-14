import {
  type GroupByMember,
  groupedColumn,
} from "@validation/model/args/time-step";
import { QueryEngineError } from "../types";

/**
 * The grouped fields of an admitted `by`, those grouped by a time step among
 * them, and the refusal of a duplicate output column.
 */
export function getGroupByFields(value: unknown): {
  readonly fields: string[];
  readonly periods: ReadonlySet<string>;
} {
  const members: readonly GroupByMember[] = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value as GroupByMember];
  const columns = members.map(groupedColumn);
  const fields = columns.map(({ field }) => field);
  if (new Set(fields).size !== fields.length) {
    throw new QueryEngineError(
      "GroupBy operation does not allow duplicate fields in 'by'"
    );
  }
  return {
    fields,
    periods: new Set(
      columns.filter(({ step }) => step !== undefined).map(({ field }) => field)
    ),
  };
}
