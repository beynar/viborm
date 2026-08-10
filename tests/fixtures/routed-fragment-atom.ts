import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import {
  isRecordSeries,
  type RoutedExecutableOperation,
} from "@src/query-engine/write-engine/record-series";

/**
 * The FRAGMENT-ATOM view of a routed operation, for the probes that read a
 * fragment directly (`planning`, `compile`, `parse`).
 *
 * `constructRoutedOperation` answers the wider routed union — one fragment atom,
 * or one transactional record series, which has no fragment to read. A probe that
 * means to read a fragment says so here, once, instead of repeating the question
 * at every call site; a payload that ever starts routing to a series turns the
 * probes that assumed otherwise into a named failure rather than a `TypeError`.
 */
export function fragmentAtom(
  operation: RoutedExecutableOperation | undefined,
  what: string
): ExecutableOperation {
  if (!operation) throw new Error(`'${what}' did not route`);
  if (isRecordSeries(operation)) {
    throw new Error(
      `'${what}' routed to a record series, which has no fragment`
    );
  }
  return operation;
}
