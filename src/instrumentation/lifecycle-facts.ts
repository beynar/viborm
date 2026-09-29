import type { QueryExecutionContext } from "@drivers/types";
import type {
  CacheBackendFacts,
  CacheCompletionFacts,
  CacheOutcome,
  CacheUnitFacts,
  LifecycleFacts,
  ObservationOutcome,
  OfficialObservationCapability,
  StatementCompletionFacts,
  StatementFacts,
} from "@extensions/official-facts";
import type { InstrumentationContext } from "./context";
import type { VibORMSpanOptions } from "./tracer";
import type { LogEvent } from "./types";

/**
 * The registered official capability: the neutral surface core reads, plus the
 * instrumentation context that the presentation still built in core reads
 * until it moves into the extension.
 */
export interface OfficialInstrumentationCapability
  extends OfficialObservationCapability {
  readonly context: InstrumentationContext;
}

export type InstrumentationLifecycleOutcome = ObservationOutcome;

export interface OperationInstrumentationCompletionFacts {
  readonly kind: "operation";
  readonly errorLogEvent?: Omit<LogEvent, "level">;
  /** Close and read the cache-managed execution's outcome list. */
  readonly readCacheOutcomes?: () => readonly CacheOutcome[];
}

export interface SegmentInstrumentationCompletionFacts {
  readonly kind: "segment";
  readonly spanAttributes: NonNullable<VibORMSpanOptions["attributes"]>;
}

export interface OperationInstrumentationFacts {
  readonly kind: "operation";
  readonly context: QueryExecutionContext;
  readonly spanOptions?: VibORMSpanOptions;
  readonly complete: (
    outcome: InstrumentationLifecycleOutcome
  ) => OperationInstrumentationCompletionFacts | undefined;
}

export interface SegmentInstrumentationFacts {
  readonly kind: "segment";
  readonly spanOptions: VibORMSpanOptions;
  readonly complete: (
    outcome: InstrumentationLifecycleOutcome
  ) => SegmentInstrumentationCompletionFacts;
}

export type InstrumentationLifecycleFacts =
  | CacheBackendFacts
  | CacheUnitFacts
  | LifecycleFacts
  | OperationInstrumentationFacts
  | SegmentInstrumentationFacts
  | StatementFacts;

export type InstrumentationLifecycleFactsReader = () =>
  | InstrumentationLifecycleFacts
  | undefined;

export type InstrumentationLifecycleCompletionFacts =
  | CacheCompletionFacts
  | OperationInstrumentationCompletionFacts
  | SegmentInstrumentationCompletionFacts
  | StatementCompletionFacts;
