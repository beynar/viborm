/**
 * The steps the operator commands and reset share: the command prologue, the
 * control read with its presence policy, and resuming an unfinished attempt
 * from its confirmed prefix (plan S3). Each caller keeps its own event filter:
 * which ledger rows confirm a step is its own rule.
 */

import type { AnyDriver } from "../drivers/driver";
import { MigrationError, VibORMErrorCode } from "../errors";
import {
  admitLiveMigrationCapability,
  type MigrationLiveRequirement,
} from "./admission";
import {
  type MigrationControlRead,
  readControlState,
  refusePartialControl,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import type { MigrationGraph } from "./graph";
import type { Sha256 } from "./identity";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { assertEstateTargetMatches } from "./target";
import type {
  LedgerEventV1,
  MigrationOperationV1,
  MigrationStepV1,
} from "./v1-types";

/** The client's migration driver, proven to address this estate's target. */
export function openCommand(
  client: MigrationClient,
  graph: MigrationGraph,
  requirement: MigrationLiveRequirement,
  label: string
): BoundMigrationDriver {
  const driver = getPushMigrationDriver(client);
  assertEstateTargetMatches(graph.descriptor.target, driver.target);
  admitLiveMigrationCapability(driver, requirement, label);
  return driver;
}

/**
 * The marker and the open ledger, partial control refused; `bootstrap`
 * admits what bootstrapping completes (both tables absent, or the log lost
 * after an interrupted bootstrap).
 */
export async function readCommandControl(
  producer: AnyDriver,
  command: BoundMigrationDriver,
  bootstrap = false
): Promise<MigrationControlRead> {
  const control = await readControlState(producer, command, { ledger: "open" });
  if (!bootstrap || control.presence.kind === "missing-table") {
    refusePartialControl(control.presence);
  }
  return control;
}

/** The length of the confirmed prefix; a confirmed step past a gap is refused. */
export function confirmedPrefix(
  confirmed: ReadonlySet<number>,
  refusal: string
): number {
  let length = 0;
  while (confirmed.has(length)) length += 1;
  if ([...confirmed].some((index) => index >= length)) {
    throw new MigrationError(refusal, VibORMErrorCode.MIGRATION_CORRUPTION);
  }
  return length;
}

/**
 * Refuses to resume at an opaque stepwise dispatch announced and never
 * answered (confirmed, or its refusal recorded): it may have committed, and
 * running it again could repeat it.
 */
export function refuseAmbiguousNext(
  next: MigrationStepV1 | undefined,
  boundary: "transactional" | "stepwise" | undefined,
  announced: boolean,
  refusal: string
): void {
  if (!(next?.retry === "opaque" && boundary === "stepwise" && announced)) {
    return;
  }
  throw new MigrationError(
    refusal,
    VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    {
      meta: {
        lastConfirmedStep: next.execute.dispatchId,
        effectState: "may-have-committed",
        partial: true,
      },
    }
  );
}

/**
 * Counts one step's `step-confirmed` event into `unanswered`, per `key`: each
 * announcement (effect `none`) counts one, and each recorded refusal (`none`
 * with its `failure`: the server refused the statement whole) answers one. A
 * positive count is a dispatch occurrence that may have committed.
 */
export function countUnanswered<K>(
  unanswered: Map<K, number>,
  key: K,
  event: LedgerEventV1
): void {
  if (event.effectState !== "none") return;
  unanswered.set(key, (unanswered.get(key) ?? 0) + (event.failure ? -1 : 1));
}

/** `operations` without their first `skip` steps. */
export function sliceOperations(
  operations: readonly MigrationOperationV1[],
  skip: number
): MigrationOperationV1[] {
  let remaining = skip;
  return operations.flatMap((operation) => {
    if (remaining >= operation.steps.length) {
      remaining -= operation.steps.length;
      return [];
    }
    const steps = operation.steps.slice(remaining);
    remaining = 0;
    return [{ ...operation, steps }];
  });
}

/** The authenticated edge an attempt's `step-confirmed` events must name. */
export interface AttemptEdge {
  readonly direction: "forward" | "rollback";
  readonly estateHash: Sha256;
  readonly fromState: Sha256 | null;
  readonly toState: Sha256 | null;
  readonly transitionHash: Sha256;
  readonly sqlHash: Sha256;
  readonly operations: readonly MigrationOperationV1[];
  readonly boundary: "transactional" | "stepwise";
}

/**
 * What an unfinished attempt left to run of `edge`: its confirmed prefix of
 * steps, read from the attempt's own `step-confirmed` events, and the
 * operations past it. Progress naming another edge or an unknown dispatch, a
 * confirmed step past a gap, and an announced opaque stepwise step neither
 * confirmed nor answered by its recorded refusal (the server refused it
 * whole: it left nothing) are refused. `noun` names the direction in each
 * refusal.
 */
export function remainingSteps(
  ledger: readonly LedgerEventV1[],
  attempt: LedgerEventV1,
  edge: AttemptEdge,
  noun: "Forward" | "Rollback"
): { readonly completed: number; readonly operations: MigrationOperationV1[] } {
  const steps = edge.operations.flatMap((operation) =>
    operation.steps.map((step) => ({ operation, step }))
  );
  const byDispatch = new Map(
    steps.map(({ step }, index) => [step.execute.dispatchId, index])
  );
  const committed = new Set<number>();
  // Announcements not answered by a recorded refusal, per step.
  const unanswered = new Map<number, number>();
  for (const event of ledger) {
    if (
      event.attemptId !== attempt.attemptId ||
      event.kind !== "step-confirmed"
    )
      continue;
    if (
      event.direction !== edge.direction ||
      event.estateHash !== edge.estateHash ||
      event.fromState !== edge.fromState ||
      event.toState !== edge.toState ||
      event.transitionHash !== edge.transitionHash ||
      event.sqlHash !== edge.sqlHash ||
      !event.dispatchId
    ) {
      throw new MigrationError(
        `${noun} progress does not match its authenticated edge`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    const index = byDispatch.get(event.dispatchId);
    if (
      index === undefined ||
      steps[index]!.operation.id !== event.operationId
    ) {
      throw new MigrationError(
        `${noun} progress names an unknown dispatch`,
        VibORMErrorCode.MIGRATION_CORRUPTION
      );
    }
    if (event.effectState === "committed") committed.add(index);
    countUnanswered(unanswered, index, event);
  }
  const completed = confirmedPrefix(
    committed,
    `${noun} progress is not a contiguous dispatch prefix`
  );
  refuseAmbiguousNext(
    steps[completed]?.step,
    edge.boundary,
    (unanswered.get(completed) ?? 0) > 0,
    `The next ${noun.toLowerCase()} dispatch has an ambiguous commit outcome`
  );
  return { completed, operations: sliceOperations(edge.operations, completed) };
}
