/**
 * The neutral contract between core and the fixed-name official
 * instrumentation extension. Types only: this module emits no runtime code and
 * no package entry re-exports it.
 *
 * Core never names a tracer, a logger, a span name or an attribute key to decide
 * whether to produce an observation fact. It asks the one capability registered
 * for its exact extension chain, at the moment it needs the answer.
 */

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
