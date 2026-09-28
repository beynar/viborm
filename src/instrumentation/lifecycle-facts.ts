import type { QueryExecutionContext } from "@drivers/types";
import type {
  CacheBackendFacts,
  CacheCompletionFacts,
  CacheOutcome,
  CacheUnitFacts,
  ObservationOutcome,
  OfficialObservationCapability,
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

export interface StatementInstrumentationCompletionFacts {
  readonly kind: "statement";
  readonly logEvent?: {
    readonly event: Omit<LogEvent, "level">;
    readonly level: "error" | "query";
  };
}

export interface SegmentInstrumentationCompletionFacts {
  readonly kind: "segment";
  readonly spanAttributes: NonNullable<VibORMSpanOptions["attributes"]>;
}

export interface InstrumentationExecutionPresentation {
  readonly spanOptions?: VibORMSpanOptions;
  readonly startExecution: () => void;
}

export interface StatementInstrumentationFacts {
  readonly kind: "statement";
  readonly presentation: Promise<
    InstrumentationExecutionPresentation | undefined
  >;
  readonly complete: (
    outcome: InstrumentationLifecycleOutcome
  ) => StatementInstrumentationCompletionFacts | undefined;
}

export interface DriverLifecycleInstrumentationFacts {
  readonly kind: "driver-lifecycle";
  readonly presentation: Promise<
    InstrumentationExecutionPresentation | undefined
  >;
  readonly complete: (outcome: InstrumentationLifecycleOutcome) => undefined;
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
  | DriverLifecycleInstrumentationFacts
  | OperationInstrumentationFacts
  | SegmentInstrumentationFacts
  | StatementInstrumentationFacts;

export type InstrumentationLifecycleFactsReader = () =>
  | InstrumentationLifecycleFacts
  | undefined;

export type InstrumentationLifecycleCompletionFacts =
  | CacheCompletionFacts
  | OperationInstrumentationCompletionFacts
  | SegmentInstrumentationCompletionFacts
  | StatementInstrumentationCompletionFacts;
