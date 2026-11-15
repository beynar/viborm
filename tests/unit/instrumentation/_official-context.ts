import { createExecutionContext } from "@drivers/execution-context";
import type { QueryExecutionContext } from "@drivers/types";
import {
  type InstrumentationConfig,
  instrumentation,
} from "@src/instrumentation/exports";
import { appendExtension } from "@tests/fixtures/extension-chain";

/** Build the same trusted context an official-derived client supplies. */
export function createOfficialTestExecutionContext(
  config: InstrumentationConfig,
  values: QueryExecutionContext
): QueryExecutionContext {
  const chain = appendExtension(undefined, instrumentation(config), {});
  return createExecutionContext(values, undefined, chain);
}
