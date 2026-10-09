import type {
  CacheCompletionFacts,
  CacheUnitFacts,
  LifecycleFacts,
  OfficialLifecycleCompletionFacts,
  OperationFacts,
  StatementFacts,
} from "@extensions/official-facts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type CompletionKind = OfficialLifecycleCompletionFacts["kind"];
type _completionKindsStayCorrelated = Expect<
  Equal<
    CompletionKind,
    "operation" | "statement" | "cache" | "driver-lifecycle"
  >
>;
type _operationStartAndCompletionKindsMatch = Expect<
  Equal<
    OperationFacts["kind"],
    NonNullable<ReturnType<OperationFacts["complete"]>>["kind"]
  >
>;
type _statementStartAndCompletionKindsMatch = Expect<
  Equal<
    StatementFacts["kind"],
    NonNullable<ReturnType<StatementFacts["complete"]>>["kind"]
  >
>;
type _cacheStartAndCompletionKindsMatch = Expect<
  Equal<
    CacheUnitFacts["kind"],
    NonNullable<ReturnType<CacheUnitFacts["complete"]>>["kind"]
  >
>;

const cacheCompletion: CacheCompletionFacts = {
  kind: "cache",
};

const _statementRejectsCacheCompletion: StatementFacts = {
  kind: "statement",
  dispatch: Promise.resolve(undefined),
  // @ts-expect-error - a statement producer publishes only statement completion facts
  complete: () => cacheCompletion,
};

declare const completion: OfficialLifecycleCompletionFacts;

if (completion.kind === "operation") {
  completion.failure;
  completion.readCacheOutcomes;
  // @ts-expect-error - operation completion cannot be read as cache completion
  completion.outcomes;
}

if (completion.kind === "statement") {
  completion.endedAt;
  completion.failure;
  // @ts-expect-error - statement completion cannot be read as cache completion
  completion.outcomes;
}

if (completion.kind === "cache") {
  completion.result;
  completion.outcomes;
  // @ts-expect-error - cache completion cannot be read as statement completion
  completion.endedAt;
}

type _driverLifecycleKindsMatch = Expect<
  Equal<
    LifecycleFacts["kind"],
    NonNullable<ReturnType<LifecycleFacts["complete"]>>["kind"]
  >
>;

if (completion.kind === "driver-lifecycle") {
  completion.failure;
  // @ts-expect-error - lifecycle completion cannot carry cache outcomes
  completion.outcomes;
}
