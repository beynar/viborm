/**
 * The `admit` hooks of a chain whose parts concern a member of
 * `$transaction([...])`. Where `around` parts may wrap a member, before the
 * one executor (`@client/array-transaction`) sends anything, every member's
 * handlers start and the array waits until each reached `run()` or failed: a
 * refusal, a second `run()`, a late detached one or a handler that throws
 * aborts the array, and nothing is sent. Where parts only hear a member's
 * writes, nothing waits: each member's registration is staged and its child
 * handed what tells it of the commit (`stageArray`).
 */
import {
  type ArraySlot,
  createArrayDeferred,
  memberValue,
} from "@client/array-transaction";
import {
  type TransactionOperationCapability,
  transactionOperationOwner,
} from "@query-engine/transaction-operation";
import {
  type AroundExecutionControl,
  type executePreparedQuery,
  executeRegisteredQuery,
  type TransactionScope,
  type WriteOutcomeNotifications,
} from "./query";

/** What admission reads and writes of a slot. */
export type AdmissionSlot = Omit<ArraySlot, "operation" | "owner">;

/** Whether a part intercepts one of the members, once they are prepared. */
export function interceptsArray(
  operations: readonly TransactionOperationCapability[]
): boolean {
  return operations.some((operation) => {
    const { handlers, registration } =
      transactionOperationOwner(operation).interception(operation);
    return handlers?.length || registration;
  });
}

/**
 * The hook of a chain whose parts hear writes and wrap no call: a member with
 * a registration runs under it, its child reached at once, so the array has
 * nothing to wait for. Its value is then the registration's run, whose
 * rejection the array reads in member order.
 */
export async function stageArray(
  slots: readonly ArraySlot[],
  scope: TransactionScope
): Promise<undefined> {
  for (const slot of slots) {
    const { write, registration } = slot.owner.interception(slot.operation);
    if (registration === undefined) continue;
    const child = (notifications?: WriteOutcomeNotifications) => {
      slot.notifications = notifications;
      return slot.child.promise;
    };
    const query = executeRegisteredQuery(
      undefined,
      undefined,
      child,
      write,
      scope,
      undefined,
      registration
    );
    slot.query = query;
    // Read by the array in member order; one the array never reaches (it
    // failed before) is settled here.
    query.catch(ignore);
  }
  return undefined;
}

const ignore = (): undefined => undefined;

/**
 * The hook: each member's package listener staged, then its handlers started
 * by `execute` (the chain's runner of a prepared call); a member with
 * nothing to intercept is admitted at once.
 */
export function admitArray(
  slots: readonly ArraySlot[],
  scope: TransactionScope,
  execute: typeof executePreparedQuery
): Promise<readonly unknown[] | undefined> {
  const facts = slots.map((slot) => {
    const interception = slot.owner.interception(slot.operation);
    if (interception.registration)
      scope.outcomes?.stage(interception.registration);
    return interception;
  });
  return admitArrayQueries(slots, (slot, child, control) => {
    const { context, handlers, write, registration } =
      facts[slots.indexOf(slot)]!;
    return handlers?.length || registration
      ? execute(context, handlers, child, write, scope, control, registration)
      : child();
  });
}

/**
 * Start every member's handlers and release the array only after each has
 * reached its child. On a failure, every child rejects with the first one,
 * and the distinct failures each member reported return in member order.
 */
export async function admitArrayQueries<Slot extends AdmissionSlot>(
  slots: readonly Slot[],
  start: (
    slot: Slot,
    child: (notifications?: WriteOutcomeNotifications) => Promise<unknown>,
    control: AroundExecutionControl
  ) => Promise<unknown>
): Promise<readonly unknown[] | undefined> {
  let failed: { readonly failure: unknown } | undefined;
  let remaining = slots.length;
  const signal = createArrayDeferred<void>();
  if (remaining === 0) signal.resolve();

  for (const slot of slots) {
    const reportAdmissionFailure = (failure: unknown): void => {
      const failures = (slot.admissionFailures ??= []);
      if (!failures.includes(failure)) failures.push(failure);
      failed ??= { failure };
      signal.reject(failure);
    };
    let query: Promise<unknown>;
    try {
      query = start(
        slot,
        (notifications) => {
          slot.notifications = notifications;
          if (!slot.admitted) {
            slot.admitted = true;
            remaining -= 1;
            if (remaining === 0) signal.resolve();
          }
          return slot.child.promise;
        },
        {
          reportAdmissionFailure,
          readCommitCertainty: () => slot.certainty,
        }
      );
    } catch (error) {
      reportAdmissionFailure(error);
      query = Promise.reject(error);
    }
    slot.query = query;
    query.catch(reportAdmissionFailure);
  }

  try {
    await signal.promise;
    // A handler that fails in the turn its member was admitted still aborts.
    await Promise.resolve();
    if (failed) throw failed.failure;
    return undefined;
  } catch (failure) {
    for (const slot of slots) slot.child.reject(failure);
    await Promise.allSettled(slots.map(memberValue));
    const reported: unknown[] = [];
    for (const slot of slots)
      for (const failure of slot.admissionFailures ?? [])
        if (!reported.includes(failure)) reported.push(failure);
    return reported;
  }
}
