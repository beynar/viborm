import type { InstrumentationContext } from "./context";
import type { VibORMSpanOptions } from "./tracer";
import type { LogEvent } from "./types";

export interface OfficialInstrumentationCapability {
  readonly context: InstrumentationContext;
  readonly observesLifecycle: boolean;
  readonly prewarm?: () => void | Promise<void>;
}

export interface InstrumentationLifecycleOutcome {
  readonly status: "success" | "failure";
  readonly durationMs: number;
  readonly failure?: unknown;
}

export interface OperationInstrumentationCompletionFacts {
  readonly kind: "operation";
  readonly errorLogEvent?: Omit<LogEvent, "level">;
  readonly readCacheLogEvents?: () => readonly Omit<LogEvent, "level">[];
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

export interface CacheInstrumentationCompletionFacts {
  readonly kind: "cache";
  readonly spanAttributes?: NonNullable<VibORMSpanOptions["attributes"]>;
  readonly logEvents?: readonly Omit<LogEvent, "level">[];
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

export interface CacheInstrumentationFacts {
  readonly kind: "cache";
  readonly spanOptions?: VibORMSpanOptions;
  readonly startLogEvents?: readonly Omit<LogEvent, "level">[];
  readonly complete: (
    outcome: InstrumentationLifecycleOutcome
  ) => CacheInstrumentationCompletionFacts | undefined;
}

export type InstrumentationLifecycleFacts =
  | CacheInstrumentationFacts
  | DriverLifecycleInstrumentationFacts
  | OperationInstrumentationFacts
  | SegmentInstrumentationFacts
  | StatementInstrumentationFacts;

export type InstrumentationLifecycleFactsReader = () =>
  | InstrumentationLifecycleFacts
  | undefined;

export type InstrumentationLifecycleCompletionFacts =
  | CacheInstrumentationCompletionFacts
  | OperationInstrumentationCompletionFacts
  | SegmentInstrumentationCompletionFacts
  | StatementInstrumentationCompletionFacts;
