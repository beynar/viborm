import { QueryEngineError, TransactionError } from "@errors";
import type { Model } from "@schema/model";
import type { QueryEngine } from "../query-engine/query-engine";
import type { StepScope } from "./StepScope";

/**
 * How a root operation is reused as one arm of a composing operation (T3c — the
 * top-level `upsert`'s create/update arms compose the create-root / update-root
 * machinery, TO-ONE.md §7.8). A `CreateOperation`/`UpdateOperation` constructed
 * with these options is NOT a standalone operation: it shares the enclosing
 * operation's {@link StepScope} (so no two arms collide on a step id), and it
 * defers the analyses the enclosing operation must run **per-arm** — V1's upsert
 * runs the own-write barrier inside the taken branch only, so a violation in an
 * un-taken arm must not reject the whole tree (`skipOwnWrite` hands that timing to
 * the caller). The absent-row postcondition is dropped for the update arm
 * (`locateNotFoundOptional`): under an upsert a located-miss is the CREATE
 * decision, not a not-found error.
 */
export interface SubOperationOptions {
  /** Share the enclosing operation's id allocator instead of minting a fresh one. */
  readonly scope?: StepScope;
  /** Skip the constructor own-write preflight; the caller runs it per-arm (deferred). */
  readonly skipOwnWrite?: boolean;
  /** Drop the locate's exactly-one-row postcondition (upsert: absent → create arm). */
  readonly locateNotFoundOptional?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ExecutionMode = "transaction" | "batch";

/**
 * Pick the compile-time execution substrate from driver capability. A driver
 * with neither substrate gets the nominal `"transaction"` mode rather than a
 * throw here: a **single-statement** operation (a read, a scalar bulk write)
 * runs directly with no atomic envelope on any driver (V1's statement-atomicity),
 * so it must be constructible. The executor enforces the capability requirement
 * for a **multi-statement** operation, failing closed with V1's byte-identical
 * {@link TransactionError} (see `OperationExecutor.execute`).
 */
export function selectExecutionMode(
  engine: QueryEngine,
  _operation: string
): ExecutionMode {
  if (engine.driver.supportsBatch && !engine.driver.supportsTransactions) {
    return "batch";
  }
  return "transaction";
}

/**
 * V1's byte-identical "no atomic substrate" failure, raised by the executor when
 * a multi-statement operation cannot run (a single-statement one runs directly).
 */
export function noAtomicSubstrateError(
  driverName: string,
  operation: string
): TransactionError {
  return new TransactionError(
    `Driver '${driverName}' supports neither transactions nor atomic batch execution.`,
    { meta: { driver: driverName, operation } }
  );
}

/**
 * Thrown by a concrete operation's constructor when the requested payload shape
 * is outside V2's supported family (a wrong argument key, an unsupported
 * relation kind, a compound key, a to-one upsert, …). It is the routing signal
 * the P2a client proxy switches on: an `UnsupportedOperationError` means "let V1
 * handle this whole tree"; any other construction error (a `ValidationError`,
 * the own-write preflight rejection) is a real failure V1 would also raise and
 * is allowed to propagate. It is never surfaced to end users through the routed
 * path — the proxy converts it into a V1 call.
 */
export class UnsupportedOperationError extends QueryEngineError {}

export function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}
