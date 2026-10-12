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
  DEFAULT_CONTROL_BASE,
  type MigrationControlRead,
  readControlState,
  refusePartialControl,
} from "./control";
import type { BoundMigrationDriver } from "./drivers";
import type { MigrationGraph } from "./graph";
import { getPushMigrationDriver, type MigrationClient } from "./push/planner";
import { assertEstateTargetMatches } from "./target";
import type { MigrationOperationV1, MigrationStepV1 } from "./v1-types";

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
  const control = await readControlState(
    producer,
    command,
    DEFAULT_CONTROL_BASE,
    { ledger: "open" }
  );
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
 * confirmed: it may have committed, and running it again could repeat it.
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
