/**
 * The two transaction-option bounds are timers, and a timer is the one thing a
 * test cannot assert about by waiting: waiting proves only that the machine was
 * not too busy. These probes drive the helpers directly on an injected clock,
 * so "the bound expired" and "the bound did not expire" are both stated rather
 * than raced — including the case a sleeping test can never reach at all, where
 * the work never finishes and only the bound can end it.
 *
 * `transaction-options-behavior.test.ts` proves the same bounds through real
 * drivers on the default clock; this file proves the timers themselves.
 */

import {
  acquireWithMaxWait,
  runWithTransactionTimeout,
  type TransactionOptionContext,
} from "@drivers/shared";
import { createTestClock } from "@tests/fixtures/test-clock";
import { describe, expect, test } from "vitest";

const context: TransactionOptionContext = {
  driverName: "probe",
  form: "callback",
};

const NAMED_BOUND = /timeout of 250ms/;

/** A promise this test settles by hand, standing in for unfinished work. */
function held<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle: (value: T) => settle?.(value) };
}

describe("runWithTransactionTimeout reads its clock", () => {
  test("a body still running when the bound arrives is rejected with V5002", async () => {
    const clock = createTestClock();
    const body = held<string>();

    const raced = runWithTransactionTimeout(
      () => body.promise,
      25,
      context,
      clock
    );
    // The bound is armed on THIS clock, so nothing but this clock can end it:
    // the body has not finished and no host time has passed.
    expect(clock.pendingCount()).toBe(1);
    clock.advance(25);

    await expect(raced).rejects.toMatchObject({
      code: "V5002",
      name: "TransactionError",
    });
    body.settle("abandoned");
  });

  test("a body that finishes before the bound keeps its result, and the timer is cancelled", async () => {
    const clock = createTestClock();
    const body = held<string>();

    const raced = runWithTransactionTimeout(
      () => body.promise,
      25,
      context,
      clock
    );
    expect(clock.pendingCount()).toBe(1);
    clock.advance(24);
    body.settle("committed");

    await expect(raced).resolves.toBe("committed");
    // The winning path must disarm the loser, or a long-lived process collects
    // one live timer per transaction it ran.
    expect(clock.pendingCount()).toBe(0);
  });

  test("the message names the bound the caller asked for", async () => {
    const clock = createTestClock();
    const body = held<string>();

    const raced = runWithTransactionTimeout(
      () => body.promise,
      250,
      context,
      clock
    );
    expect(clock.pendingCount()).toBe(1);
    clock.advance(250);

    await expect(raced).rejects.toThrow(NAMED_BOUND);
    body.settle("abandoned");
  });
});

describe("acquireWithMaxWait reads its clock", () => {
  test("an acquisition still pending at the bound is rejected, and released when it lands", async () => {
    const clock = createTestClock();
    const pool = held<{ id: string }>();
    const released: Array<{ id: string }> = [];

    const acquiring = acquireWithMaxWait(
      () => pool.promise,
      (resource) => released.push(resource),
      20,
      context,
      clock
    );
    expect(clock.pendingCount()).toBe(1);
    clock.advance(20);

    await expect(acquiring).rejects.toMatchObject({ code: "V5002" });
    expect(released).toEqual([]);

    // The pool eventually honors the request we walked away from. That
    // connection is checked out and must go straight back.
    pool.settle({ id: "connection" });
    await pool.promise;
    expect(released).toEqual([{ id: "connection" }]);
  });

  test("an acquisition that lands before the bound is handed over, not released", async () => {
    const clock = createTestClock();
    const pool = held<{ id: string }>();
    const released: Array<{ id: string }> = [];

    const acquiring = acquireWithMaxWait(
      () => pool.promise,
      (resource) => released.push(resource),
      20,
      context,
      clock
    );
    expect(clock.pendingCount()).toBe(1);
    clock.advance(19);
    pool.settle({ id: "connection" });

    await expect(acquiring).resolves.toEqual({ id: "connection" });
    expect(released).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });

  test("no bound means no timer at all", async () => {
    const clock = createTestClock();
    const pool = held<{ id: string }>();
    pool.settle({ id: "connection" });

    await expect(
      acquireWithMaxWait(
        () => pool.promise,
        () => undefined,
        undefined,
        context,
        clock
      )
    ).resolves.toEqual({ id: "connection" });
    expect(clock.pendingCount()).toBe(0);
  });
});
