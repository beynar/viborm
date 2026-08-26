/** Static contract for the neutral E5 protected-observer runner. */

import type { ResolvedExtensionHandler } from "@extensions/chain";
import {
  type CommitCertainty,
  type LifecycleUnit,
  type LifecycleUnitKind,
  type ObservationCompletion,
  type ObservationCompletionFacts,
  type ObservationErrorSummary,
  type ObserveHandler,
  runProtectedObservers,
} from "@extensions/observation";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type KeysOfUnion<Value> = Value extends Value ? keyof Value : never;
type ObserverEntry = ResolvedExtensionHandler<ObserveHandler>;

type _unitSurfaceIsExact = Expect<
  Equal<KeysOfUnion<LifecycleUnit>, "kind" | "model" | "operation">
>;
type _unitKindsAreExact = Expect<
  Equal<
    LifecycleUnitKind,
    | "operation"
    | "statement"
    | "batch"
    | "transaction"
    | "savepoint"
    | "segment"
    | "connection"
    | "cache"
  >
>;
type _completionSurfaceIsExact = Expect<
  Equal<
    keyof ObservationCompletion,
    "status" | "durationMs" | "error" | "commitCertainty"
  >
>;
type _errorSurfaceIsExact = Expect<
  Equal<keyof ObservationErrorSummary, "name" | "message" | "code">
>;
type _completionFactsSurfaceIsExact = Expect<
  Equal<keyof ObservationCompletionFacts, "commitCertainty">
>;
type _observerSurfaceIsExact = Expect<
  Equal<keyof ObserverEntry, "extension" | "handler">
>;
type _commitCertaintyIsExact = Expect<
  Equal<CommitCertainty, "committed" | "may-have-committed">
>;

const observer: ObserverEntry = {
  extension: "readonly-surface",
  handler(unit, proceed) {
    const kind: LifecycleUnitKind = unit.kind;
    const completion: Promise<ObservationCompletion> = proceed();
    // @ts-expect-error - lifecycle identity is readonly
    unit.kind = "cache";
    // @ts-expect-error - model identity is readonly
    unit.model = "other";
    // @ts-expect-error - operation identity is readonly
    unit.operation = "delete";
    // @ts-expect-error - no application result crosses the observer boundary
    unit.result;
    // @ts-expect-error - no provider rows cross the observer boundary
    unit.rows;
    // @ts-expect-error - no ownership token crosses the observer boundary
    unit.token;
    completion.then((summary) => {
      const status: "success" | "failure" = summary.status;
      const durationMs: number = summary.durationMs;
      const certainty: CommitCertainty | undefined = summary.commitCertainty;
      // @ts-expect-error - completion status is readonly
      summary.status = "success";
      // @ts-expect-error - completion duration is readonly
      summary.durationMs = 0;
      // @ts-expect-error - observers never receive the application result
      summary.result;
      // @ts-expect-error - observers never receive mutable application errors
      summary.applicationError;
      if (summary.error !== undefined) {
        const errorName: string = summary.error.name;
        // @ts-expect-error - normalized error metadata is readonly
        summary.error.message = "changed";
        // @ts-expect-error - the mutable Error cause is not exposed
        summary.error.cause;
        return { errorName, status, durationMs, certainty };
      }
      return { status, durationMs, certainty };
    });
    return { fabricatedResult: kind };
  },
};
// @ts-expect-error - resolved extension identity is readonly
observer.extension = "other";
// @ts-expect-error - the snapshotted observer handler is readonly
observer.handler = () => undefined;

const childPromise = Promise.resolve<{ id: "post-1" }>({
  id: "post-1",
});
const applicationPromise = runProtectedObservers(
  { kind: "operation", model: "post", operation: "findUnique" },
  [observer],
  () => childPromise
);
type _applicationResultStaysExact = Expect<
  Equal<typeof applicationPromise, Promise<{ id: "post-1" }>>
>;

runProtectedObservers(
  // @ts-expect-error - operation lifecycle units require an operation name
  { kind: "operation" },
  [observer],
  () => childPromise
);

runProtectedObservers(
  { kind: "operation", operation: "findUnique" },
  [observer],
  () => childPromise,
  // @ts-expect-error - commit certainty has a closed vocabulary
  () => ({
    commitCertainty: "rolled-back",
  })
);
