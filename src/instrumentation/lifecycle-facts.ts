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

/**
 * The registered official capability: the neutral surface core reads, plus the
 * instrumentation context only the extension's own presentation reads.
 */
export interface OfficialInstrumentationCapability
  extends OfficialObservationCapability {
  readonly context: InstrumentationContext;
}

export type InstrumentationLifecycleOutcome = ObservationOutcome;

export type InstrumentationLifecycleFacts =
  | CacheBackendFacts
  | CacheUnitFacts
  | LifecycleFacts
  | OperationFacts
  | StatementFacts;

export type InstrumentationLifecycleFactsReader = () =>
  | InstrumentationLifecycleFacts
  | undefined;

export type InstrumentationLifecycleCompletionFacts =
  | CacheCompletionFacts
  | OperationCompletionFacts
  | StatementCompletionFacts;
