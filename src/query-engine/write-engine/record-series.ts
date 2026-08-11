import type { ExecutableOperation } from "./OperationExecutor";
import type { PlanningFragment } from "./OperationFragment";

/**
 * A TRANSACTIONAL RECORD SERIES: the second — and only other — execution form the
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
 * - {@link capture} fixes the root set inside the interactive scope. It may be an
 *   empty fragment when the root set is entirely application-known.
 * - {@link compileMembers} returns ordinary {@link ExecutableOperation} instances —
 *   the same shells the routed single-tree path builds. Every member is built
 *   before the first one runs, so a member's construction-time refusal happens
 *   before this scope has any effect to undo. Branch-dependent legality keeps its
 *   existing timing: a found-arm check still runs when that member's planning
 *   selects the arm, and its failure rolls the whole scope back.
 * - {@link compileResultReads} runs only after every member has completed. It
 *   builds ordinary reads for the final root identities when the payload asked for
 *   a returning projection.
 * - {@link parseSeries} produces the public result.
 *
 * The CAPTURED RECORD holds one key per output the fragment returned by
 * {@link capture} declared, and `compileMembers` / `compileResultReads` read
 * exactly those keys. The executor imposes no naming of its own: it hands back
 * whatever that fragment's `outputs` map declared. So every capture MUST build
 * that map with `planningOutputs` (`Part.ts`), which spells each key
 * `planningKey(stepId, output)` — that is `` `${step}.${output}` `` — the stable,
 * collision-free address the rest of the engine already reads planning outputs
 * at. A capture that declares bare names instead is not caught by any gate; it
 * simply lands its members on a different address than they expect.
 *
 * The series is transaction-only BY ITS FORM, not by a mode field:
 * `executionKind: "recordSeries"` alone selects the series executor, which opens
 * an interactive scope unconditionally because member N is planned against the
 * effects member N-1 already applied inside it. There is no atomic-batch
 * lowering, which is why every prepared-statement and prepared-batch seam
 * declines this form before fragment compilation.
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
