import type {
  CacheCompletionFacts,
  CacheUnitFacts,
} from "@extensions/official-facts";
import type {
  InstrumentationLifecycleCompletionFacts,
  OperationInstrumentationFacts,
  SegmentInstrumentationFacts,
  StatementInstrumentationFacts,
} from "@instrumentation/lifecycle-facts";
import { SPAN_RECORD_SERIES_SEGMENT } from "@instrumentation/spans";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type CompletionKind = InstrumentationLifecycleCompletionFacts["kind"];
type _completionKindsStayCorrelated = Expect<
  Equal<CompletionKind, "operation" | "statement" | "segment" | "cache">
>;
type _operationStartAndCompletionKindsMatch = Expect<
  Equal<
    OperationInstrumentationFacts["kind"],
    NonNullable<ReturnType<OperationInstrumentationFacts["complete"]>>["kind"]
  >
>;
type _statementStartAndCompletionKindsMatch = Expect<
  Equal<
    StatementInstrumentationFacts["kind"],
    NonNullable<ReturnType<StatementInstrumentationFacts["complete"]>>["kind"]
  >
>;
type _segmentStartAndCompletionKindsMatch = Expect<
  Equal<
    SegmentInstrumentationFacts["kind"],
    ReturnType<SegmentInstrumentationFacts["complete"]>["kind"]
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

const _segmentRejectsCacheCompletion: SegmentInstrumentationFacts = {
  kind: "segment",
  spanOptions: { name: SPAN_RECORD_SERIES_SEGMENT },
  // @ts-expect-error - a segment producer publishes only segment completion facts
  complete: () => cacheCompletion,
};

declare const completion: InstrumentationLifecycleCompletionFacts;

if (completion.kind === "operation") {
  completion.errorLogEvent;
  completion.readCacheOutcomes;
  // @ts-expect-error - operation completion cannot be read as segment completion
  completion.spanAttributes;
}

if (completion.kind === "statement") {
  completion.logEvent;
  // @ts-expect-error - statement completion cannot be read as cache completion
  completion.outcomes;
}

if (completion.kind === "segment") {
  completion.spanAttributes;
  // @ts-expect-error - segment completion cannot be read as operation completion
  completion.errorLogEvent;
}

if (completion.kind === "cache") {
  completion.result;
  completion.outcomes;
  // @ts-expect-error - cache completion cannot be read as statement completion
  completion.logEvent;
}
