import type { ExecutableOperation } from "@src/query-engine/write-engine/OperationExecutor";
import type {
  RecordSeriesOperation,
  RoutedExecutableOperation,
} from "@src/query-engine/write-engine/record-series";
import type { constructRoutedOperation } from "@src/query-engine/write-engine/routing";

declare const internalAtom: ExecutableOperation;
declare const internalSeries: RecordSeriesOperation;

// Internal and synthesized execution forms need no public inspection payload.
export const atomWithoutPayload: ExecutableOperation = internalAtom;
export const seriesWithoutPayload: RecordSeriesOperation = internalSeries;

// @ts-expect-error - an internal atom without canonical args is not a routed operation
export const refusedRoutedAtom: RoutedExecutableOperation = internalAtom;
// @ts-expect-error - an internal series without canonical args is not a routed operation
export const refusedRoutedSeries: RoutedExecutableOperation = internalSeries;

type Expect<Value extends true> = Value;
type Constructed = NonNullable<ReturnType<typeof constructRoutedOperation>>;

export type _RoutedConstructionPublishesCanonicalPayload = Expect<
  Constructed["validatedArgs"] extends Record<string, unknown> ? true : false
>;
