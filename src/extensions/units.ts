// The points where a definition decides how a call's unit is sent: whether a
// call that failed and was undone is made again (`retry`), which driver a read
// outside a transaction is sent to (`route`), and what a transaction runs as
// it opens (`transaction`).

import type { AnyDriver } from "@drivers/exports";
import type { Sql } from "@sql";
import type { ExtensionPart, ResolvedExtensionHandler } from "./chain";
import { coordinate, OUTCOMES } from "./coordination";

/** One model operation, as `retry` and `route` are asked about it. */
export interface UnitCall {
  readonly model: string;
  readonly operation: string;
}

/**
 * Asked when a call sent outside a transaction failed and nothing of it was
 * written: `true` makes the call again. `attempt` counts from 1. A call
 * inside a transaction is never asked: its transaction is its caller's to
 * make again. A write that committed, or may have, is never asked either:
 * a write sent as one statement outside a transaction that fails is held to
 * be possibly made, since nothing proves it undone.
 */
export type RetryHandler = (
  error: unknown,
  attempt: number,
  call: UnitCall
) => boolean | Promise<boolean>;

/**
 * Asked before a read outside a transaction is sent: a driver sends the read
 * there instead (a read replica), nothing leaves it where it goes. The driver
 * must be of the client's dialect and schema.
 */
export type RouteHandler = (
  read: UnitCall & { readonly args: Readonly<Record<string, unknown>> }
) => AnyDriver | undefined;

/**
 * Called as each transaction opens, before anything else runs in it: `run`
 * executes a statement there. What it throws fails the transaction. A
 * savepoint is no transaction, and a driver that sends a unit as one batch
 * opens none.
 */
export type TransactionHandler = (
  run: (statement: Sql) => Promise<readonly Record<string, unknown>[]>
) => unknown;

type Notification = (() => Promise<void>) | undefined;

/**
 * One call's execution under the chain's `retry` and `route`: `run` sends it,
 * to the driver a `route` named if the call is a read; where it fails with
 * nothing written, each `retry` is asked in turn.
 */
export async function sendUnit<T>(
  chain: Pick<UnitHandlers, "retry" | "route">,
  call: UnitCall,
  args: () => Readonly<Record<string, unknown>>,
  isWrite: boolean,
  run: (
    driver: AnyDriver | undefined,
    committed: Notification,
    mayBeVisible: Notification
  ) => Promise<T>,
  committed: Notification,
  mayBeVisible: Notification
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let driver: AnyDriver | undefined;
    if (!isWrite)
      for (const { handler } of chain.route ?? []) {
        driver = (handler as RouteHandler)({ ...call, args: args() });
        if (driver) break;
      }
    // What the call wrote, or may have, is told through these: once either
    // is heard, the call is not made again.
    let wrote = false;
    const hearing = (notify: Notification) => async () => {
      wrote = true;
      await notify?.();
    };
    try {
      return await run(
        driver,
        chain.retry ? hearing(committed) : committed,
        chain.retry ? hearing(mayBeVisible) : mayBeVisible
      );
    } catch (error) {
      if (wrote) throw error;
      let again = false;
      for (const { handler } of chain.retry ?? [])
        if (await (handler as RetryHandler)(error, attempt, call)) {
          again = true;
          break;
        }
      if (!again) throw error;
    }
  }
}

/** A chain's `retry` and `route` declarations, and what sends a call under them. */
export interface UnitHandlers {
  readonly retry?: readonly ResolvedExtensionHandler[];
  readonly route?: readonly ResolvedExtensionHandler[];
  readonly send: <T>(
    call: UnitCall,
    args: () => Readonly<Record<string, unknown>>,
    isWrite: boolean,
    run: (
      driver: AnyDriver | undefined,
      committed: Notification,
      mayBeVisible: Notification
    ) => Promise<T>,
    committed: Notification,
    mayBeVisible: Notification
  ) => Promise<T>;
}

/** `retry`, `route` and `transaction`: how a call and a transaction are sent. */
export const unitPart: ExtensionPart = {
  members: ["retry", "route", "transaction"],
  join({ next, chain, definition, owner }) {
    const { retry, route, transaction } = definition;
    const own = (handler: CallableFunction): ResolvedExtensionHandler =>
      Object.freeze({ extension: owner.name, handler });
    if (transaction !== undefined)
      next.transaction = Object.freeze([
        ...(chain?.transaction ?? []),
        own(transaction),
      ]);
    if (retry === undefined && route === undefined) return;
    const lists = {
      retry:
        retry === undefined
          ? chain?.units?.retry
          : Object.freeze([...(chain?.units?.retry ?? []), own(retry)]),
      route:
        route === undefined
          ? chain?.units?.route
          : Object.freeze([...(chain?.units?.route ?? []), own(route)]),
    };
    const units: UnitHandlers = {
      ...(lists.retry === undefined ? {} : { retry: lists.retry }),
      ...(lists.route === undefined ? {} : { route: lists.route }),
      send: (call, args, isWrite, run, committed, mayBeVisible) =>
        sendUnit(lists, call, args, isWrite, run, committed, mayBeVisible),
    };
    next.units = Object.freeze(units);
    coordinate(next, OUTCOMES);
  },
};
