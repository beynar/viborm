/**
 * The neutral contract between core and the fixed-name official
 * instrumentation extension. Types only: this module emits no runtime code and
 * no package entry re-exports it.
 *
 * Core never names a tracer, a logger, a span name or an attribute key to decide
 * whether to produce an observation fact. It asks the one capability registered
 * for its exact extension chain, at the moment it needs the answer.
 */

import type { DriverIdentity } from "@drivers/driver-identity";
import type { QueryExecutionContext } from "@drivers/types";
import type { DiagnosticDisclosure } from "@errors";

/**
 * One enablement question core asks. Each answer is read at call time, never
 * cached: tracer readiness and ignored span types belong to the extension.
 *
 * - `statement`, `transaction`, `savepoint`, `connect`, `disconnect`: whether
 *   the extension presents that boundary, so core publishes its deferred
 *   provider handoff.
 * - `cache`: whether the extension presents cache units.
 * - `cache-outcomes`: whether cache outcome facts are wanted.
 * - `parameters`: whether a logging or tracing channel discloses parameters,
 *   so core takes the one pre-dispatch parameter snapshot.
 * - `query-log` / `error-log`: whether a statement or operation log is wanted;
 *   core still selects the failure and marks it logged.
 */
export type ObservationNeed =
  | "statement"
  | "transaction"
  | "savepoint"
  | "connect"
  | "disconnect"
  | "cache"
  | "cache-outcomes"
  | "parameters"
  | "query-log"
  | "error-log";

/** One warning core decided to raise, for the extension to present. */
export interface WarningNotice {
  readonly model: string;
  readonly operation: string;
  readonly correlationId?: string | undefined;
  readonly message: string;
}

/** What core reads from the official extension; nothing else. */
export interface OfficialObservationCapability {
  /** Whether the extension joins the lifecycle observer onion at all. */
  readonly observesLifecycle: boolean;
  /** One-shot readiness core awaits before a coordinated array starts. */
  readonly prewarm?: () => void | Promise<void>;
  /** Thrown-error SQL/parameter disclosure: an input to core's error authority. */
  readonly diagnostics: DiagnosticDisclosure;
  wants(need: ObservationNeed): boolean;
  /** Present the warning; `false` tells core to fall back to `console.warn`. */
  warn(notice: WarningNotice): boolean;
}

/** How one observed child settled, as the rail hands it to a fact producer. */
export interface ObservationOutcome {
  readonly status: "success" | "failure";
  readonly durationMs: number;
  readonly failure?: unknown;
}

/**
 * One cache decision of a logical execution, recorded when the capability
 * wants cache outcomes. It never carries a cache key or suffix; `at` is the
 * instant core decided it.
 */
export interface CacheOutcome {
  readonly event: "bypass" | "hit" | "miss" | "revalidate";
  readonly status?: string | undefined;
  readonly at: number;
  readonly error?: unknown;
}

/** What one cache unit's settled child adds for the extension. */
export interface CacheCompletionFacts {
  readonly kind: "cache";
  /** get: what the backend returned. */
  readonly result?: "hit" | "miss" | "stale";
  /** set: a background failure no open execution list took; revalidate: its terminal outcome. */
  readonly outcomes?: readonly CacheOutcome[];
}

/** Start facts of a cache get, set, invalidate, or actual revalidation. */
export interface CacheUnitFacts {
  readonly kind: "cache";
  readonly context: QueryExecutionContext | undefined;
  /** get, set, invalidate: the cache backend. */
  readonly driverName?: string;
  /** set: the entry TTL in milliseconds. */
  readonly ttl?: number;
  /** revalidate: the replayed read, a root operation of its own. */
  readonly read?: {
    readonly model: string;
    readonly operation: string;
    readonly identity: DriverIdentity | undefined;
  };
  readonly complete: (
    outcome: ObservationOutcome
  ) => CacheCompletionFacts | undefined;
}

/**
 * A backend delete or clear inside an invalidation. Only the trusted handler
 * receives it (`selectTrustedObservers`); its public unit reuses the
 * `invalidate` shape so the public union does not grow.
 */
export interface CacheBackendFacts {
  readonly kind: "cache-backend";
  readonly boundary: "clear" | "delete";
  readonly driverName: string;
  readonly complete: () => undefined;
}
