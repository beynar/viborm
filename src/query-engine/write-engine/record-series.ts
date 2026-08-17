import type { ExecutableOperation } from "./OperationExecutor";
import type { PlanningFragment } from "./OperationFragment";

/** The only per-member root-conflict policy understood by record-series execution. */
export type SeriesRootConflictDisposition = {
  readonly kind: "skipDuplicate";
  readonly rootWriteId: string;
};

/**
 * A RECORD SERIES: the second — and only other — execution form the
 * engine has (plan §4.4).
 *
 * The fragment atom is one planning phase followed by one final compilation. That
 * shape cannot truthfully represent a data-dependent NUMBER of record operations
 * when every one of them owns its own planning: the count is only known after the
 * capture has run, and each member's own branch selection needs a read that the
 * single planning phase has already spent. A series says exactly that and nothing
 * more — it is an execution fact, not a mutation language, and it adds no step
 * kind, no adapter method, and no strategy table.
 *
 * A SERIES MEMBER is one record operation the series runs — a distinct sense from
 * relation membership (CONTEXT.md), which never appears here. `compileMembers` is
 * named by plan §4.4; prose about this form says "series member".
 *
 * The phases:
 *
 * - {@link capture} fixes the root set before members run. It may be an empty
 *   fragment when the root set is entirely application-known.
 * - {@link compileMembers} returns ordinary {@link ExecutableOperation} instances —
 *   the same shells the routed single-tree path builds. Every member is built
 *   before the first one runs, so statically knowable refusals happen before any
 *   member effect. Branch-dependent legality keeps its existing timing: a found-arm
 *   check still runs when that member's planning selects the arm. An interactive
 *   transaction rolls the series back on failure; progressive execution reports and
 *   preserves an already committed prefix.
 * - {@link compileResultReads} runs only after every member has completed. It
 *   builds ordinary reads for the final root identities when the payload asked for
 *   a returning projection.
 * - {@link parseSeries} produces the public result.
 *
 * The CAPTURED RECORD holds one key per declared output of every capture step,
 * DERIVED by the executor under `planningKey(stepId, output)` — that is
 * `` `${step}.${output}` `` — the stable, collision-free address the rest of
 * the engine reads planning outputs at (Phase 9.1: planning publication has no
 * hand-built map to mis-spell, so the old bare-names hazard is structurally
 * gone). `compileMembers` / `compileResultReads` read exactly those keys.
 *
 * `executionKind: "recordSeries"` alone selects the series executor. Interactive
 * drivers run it in one transaction. A no-transaction driver with native atomic
 * batches runs members as ordered segments; normalized successful return is the
 * boundary for the next segment, while an optional committed-batch notification
 * makes post-commit decoding failures precisely attributable. A nested placement
 * additionally carries the exact parent/membership guard every later write segment
 * re-asserts; a compiler that cannot provide that proof marks the placement
 * unsupported. Prepared statement/batch seams still decline this dynamic form
 * before fragment compilation.
 */
export interface RecordSeriesOperation {
  readonly executionKind: "recordSeries";

  capture(): PlanningFragment;

  compileMembers(
    captured: Readonly<Record<string, unknown>>
  ): readonly ExecutableOperation[];

  compileResultReads(
    captured: Readonly<Record<string, unknown>>,
    memberResults: readonly unknown[]
  ): readonly ExecutableOperation[];

  parseSeries(input: {
    readonly captured: Readonly<Record<string, unknown>>;
    readonly memberResults: readonly unknown[];
    readonly resultReadResults: readonly unknown[];
  }): unknown;
}

/** The executor's exact result for a duplicate-skippable create member. */
export type SkippableCreateMemberResult =
  | { readonly kind: "inserted"; readonly value: unknown }
  | { readonly kind: "skipped" };

export function isSkippableCreateMemberResult(
  value: unknown
): value is SkippableCreateMemberResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (value.kind === "skipped") return keys.length === 1;
  return (
    value.kind === "inserted" &&
    keys.length === 2 &&
    Object.hasOwn(value, "value")
  );
}

/** What a routed payload may resolve to: one fragment atom, or one series. */
export type RoutedExecutableOperation =
  | ExecutableOperation
  | RecordSeriesOperation;

/**
 * Is this routed operation a series? `executionKind` exists on no fragment atom,
 * so its presence is the discriminant — the single question every seam asks
 * before it reaches for a planning phase the series does not have.
 */
export function isRecordSeries(
  operation: RoutedExecutableOperation
): operation is RecordSeriesOperation {
  return "executionKind" in operation;
}
