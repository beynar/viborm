import { createExecutionContext } from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/types";
import { appendResolvedExtension } from "@extensions/chain";
import {
  type InstrumentationConfig,
  instrumentation,
} from "@src/instrumentation/exports";

/** Build the same trusted context an official-derived client supplies. */
export function createOfficialTestExecutionContext(
  config: InstrumentationConfig,
  values: QueryExecutionContext
): QueryExecutionContext {
  const chain = appendResolvedExtension(undefined, instrumentation(config), {});
  return createExecutionContext(values, undefined, chain);
}
