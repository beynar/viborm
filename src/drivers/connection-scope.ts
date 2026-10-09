import type { AsyncLocalStorage } from "node:async_hooks";
import { type QueueWaitBound, SavepointQueue } from "./savepoint-queue";
import {
  type TransactionOptionContext,
  transactionMaxWaitError,
} from "./shared/transaction-options";

// A supplied physical connection may have several VibORM wrappers. The handle,
// rather than a wrapper, owns serialization; weak keys retain no transports.
const physicalQueues = new WeakMap<object, SavepointQueue>();
interface ConnectionScope {
  readonly queue: SavepointQueue;
  active: boolean;
}
let scope: AsyncLocalStorage<ConnectionScope> | null | undefined;
let scopeInitialization: Promise<void> | undefined;

export function physicalConnectionQueue(handle: object): SavepointQueue {
  let queue = physicalQueues.get(handle);
  if (!queue) {
    queue = new SavepointQueue();
    physicalQueues.set(handle, queue);
  }
  return queue;
}

export function isConnectionScope(queue: SavepointQueue): boolean {
  const current = scope?.getStore();
  return current !== undefined && current.queue === queue && current.active;
}

export function connectionQueueWait(
  queueMaxWaitMs: number | undefined,
  context: TransactionOptionContext
): QueueWaitBound | undefined {
  // Browsers lack async-context proof. Their queue still preserves isolation;
  // a finite wait prevents a same-client reentry from deadlocking the lease.
  const maxWaitMs = queueMaxWaitMs ?? (scope === null ? 5000 : undefined);
  return maxWaitMs === undefined
    ? undefined
    : {
        maxWaitMs,
        onMaxWaitExceeded: () => transactionMaxWaitError(maxWaitMs, context),
      };
}

export async function withConnectionScope<T>(
  queue: SavepointQueue,
  body: () => Promise<T>
): Promise<T> {
  // Only interactive single-connection transports reach this path. Stateless
  // HTTP/Workers paths neither load nor depend on the Node implementation.
  scopeInitialization ??= import("node:async_hooks")
    .then(({ AsyncLocalStorage }) => {
      scope = new AsyncLocalStorage<ConnectionScope>();
    })
    .catch(() => {
      scope = null;
    });
  await scopeInitialization;
  if (scope === null) return body();
  if (!scope) throw new Error("Connection scope failed to initialize");
  const current = { queue, active: true };
  return scope.run(current, async () => {
    try {
      return await body();
    } finally {
      current.active = false;
    }
  });
}
