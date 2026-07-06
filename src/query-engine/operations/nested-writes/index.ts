import type { Sql } from "@sql";
import type { TransactionContext } from "./create";

export type {
  NestedCreateResult,
  TransactionContext,
} from "./create";
export { executeNestedCreate } from "./create";
export type { NestedUpdateResult } from "./update";
export { executeNestedUpdate } from "./update";

export interface TransactionStep {
  sql: Sql;
  resultHandler?: (
    result: Record<string, unknown>[],
    context: TransactionContext
  ) => void;
}
