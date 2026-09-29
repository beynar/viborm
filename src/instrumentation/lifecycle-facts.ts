import type {
  CacheBackendFacts,
  CacheCompletionFacts,
  CacheUnitFacts,
  LifecycleFacts,
  ObservationOutcome,
  OfficialObservationCapability,
  OperationCompletionFacts,
  OperationFacts,
  StatementCompletionFacts,
  StatementFacts,
} from "@extensions/official-facts";
import type { InstrumentationContext } from "./context";
import type { VibORMSpanOptions } from "./tracer";

/**
 * The registered official capability: the neutral surface core reads, plus the
 * instrumentation context only the extension's own presentation reads.
 */
export interface OfficialInstrumentationCapability
  extends OfficialObservationCapability {
  readonly context: InstrumentationContext;
}

export type InstrumentationLifecycleOutcome = ObservationOutcome;

export interface SegmentInstrumentationCompletionFacts {
  readonly kind: "segment";
  readonly spanAttributes: NonNullable<VibORMSpanOptions["attributes"]>;
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
  | OperationFacts
  | SegmentInstrumentationFacts
  | StatementFacts;

export type InstrumentationLifecycleFactsReader = () =>
  | InstrumentationLifecycleFacts
  | undefined;

export type InstrumentationLifecycleCompletionFacts =
  | CacheCompletionFacts
  | OperationCompletionFacts
  | SegmentInstrumentationCompletionFacts
  | StatementCompletionFacts;
